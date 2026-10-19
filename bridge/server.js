#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.2.0';
const HOST = '127.0.0.1';
const PORT = Number(process.env.GIWI_BRIDGE_PORT || 10087);
const EXTENSION_ID = process.env.GIWI_EXTENSION_ID || null;
// Lets the extension keep a separate "current tab" for each agent chat sharing the browser.
const SESSION_ID = randomUUID().slice(0, 8);
const AGENT_HEADER = 'x-giwi-bridge-agent';
const TOOL_TIMEOUT_MS = 90_000;
const RELAY_TIMEOUT_MS = TOOL_TIMEOUT_MS + 15_000;
const CONNECT_WAIT_MS = 10_000;
const HEARTBEAT_MS = 15_000;
const ELECTION_RETRY_MS = 3000;
const EXTENSION_DIR = fileURLToPath(new URL('../extension', import.meta.url));

const NOT_CONNECTED =
  'No browser is connected to GiwiBridge. Open Chrome or Edge with the GiwiBridge extension loaded ' +
  `(chrome://extensions > Developer mode > Load unpacked > ${EXTENSION_DIR}). ` +
  'The extension reconnects every 30 seconds; clicking its toolbar icon reconnects immediately.';

// stdout carries MCP protocol frames, so all logging goes to stderr.
const log = (...args) => console.error('[giwi-bridge]', ...args);

// ---------------------------------------------------------------------------
// Roles: the first GiwiBridge to bind the port hosts the browser connection;
// bridges started by other agent chats relay their tool calls through it.
// ---------------------------------------------------------------------------

let role = 'starting';
let roleProblem = null;
const roleWaiters = new Set();

function setRole(next) {
  role = next;
  roleProblem = null;
  for (const resolve of roleWaiters) resolve();
  roleWaiters.clear();
}

function waitForRole() {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      roleWaiters.delete(done);
      reject(new Error(roleProblem ?? 'GiwiBridge is still starting up; try again in a moment.'));
    }, CONNECT_WAIT_MS);
    roleWaiters.add(done);
  });
}

async function callBrowser(name, args) {
  if (role === 'starting') await waitForRole();
  return role === 'host' ? callExtension(name, args) : relayToHost(name, args);
}

// ---------------------------------------------------------------------------
// Host: HTTP status, the extension's WebSocket, and other chats' relay sockets
// ---------------------------------------------------------------------------

let extension = null;
const pending = new Map();
const connectWaiters = new Set();
const agents = new Set();

function isLocalHost(host) {
  // Rejects DNS-rebinding requests that reach us under a foreign hostname.
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

function isExtensionOrigin(origin) {
  // Web pages can open sockets to localhost too, but cannot forge an extension origin.
  const match = /^(?:chrome-)?extension:\/\/([a-p]{32})$/.exec(origin ?? '');
  return Boolean(match) && (!EXTENSION_ID || match[1] === EXTENSION_ID);
}

function isAgentRequest(req) {
  // Browsers always send Origin and cannot add custom headers to a WebSocket handshake.
  return !req.headers.origin && Boolean(req.headers[AGENT_HEADER]);
}

const httpServer = http.createServer((req, res) => {
  if (!isLocalHost(req.headers.host)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: 'giwi-bridge',
        version: VERSION,
        extensionConnected: Boolean(extension),
        extensionVersion: extension?.version ?? null,
        sharingChats: agents.size,
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);
  const local = isLocalHost(req.headers.host);
  if (local && pathname === '/ws' && isExtensionOrigin(req.headers.origin)) {
    wss.handleUpgrade(req, socket, head, onExtensionConnected);
  } else if (local && pathname === '/agent' && isAgentRequest(req)) {
    wss.handleUpgrade(req, socket, head, onAgentConnected);
  } else {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

function onExtensionConnected(ws) {
  if (extension) {
    ws.close(4409, 'GiwiBridge is already connected to another browser');
    return;
  }
  const conn = { ws, version: null, alive: true };
  extension = conn;

  ws.on('pong', () => {
    conn.alive = true;
  });
  ws.on('message', (raw) => {
    conn.alive = true;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      conn.version = msg.payload?.extensionVersion ?? null;
      ws.send(JSON.stringify({ type: 'hello_ack', payload: { bridgeVersion: VERSION } }));
      log(`browser extension connected (v${conn.version})`);
      for (const resolve of connectWaiters) resolve();
      connectWaiters.clear();
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    } else if (msg.type === 'tool_result') {
      const entry = pending.get(msg.responseToRequestId);
      if (!entry) return;
      pending.delete(msg.responseToRequestId);
      clearTimeout(entry.timer);
      if (msg.payload?.error) entry.reject(new Error(msg.payload.error));
      else entry.resolve(msg.payload?.data ?? null);
    }
  });
  ws.on('close', () => {
    if (extension !== conn) return;
    extension = null;
    log('browser extension disconnected');
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('The browser extension disconnected before answering.'));
    }
    pending.clear();
  });
  ws.on('error', (err) => log('extension socket error:', err.message));
}

function onAgentConnected(ws) {
  agents.add(ws);
  log(`another agent chat is sharing this browser (${agents.size} sharing)`);
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'tool_call') return;
    let payload;
    try {
      payload = { data: await callExtension(msg.payload?.name, msg.payload?.args ?? {}) };
    } catch (err) {
      payload = { error: err.message };
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tool_result', responseToRequestId: msg.requestId, payload }));
    }
  });
  ws.on('close', () => agents.delete(ws));
  ws.on('error', (err) => log('agent socket error:', err.message));
}

setInterval(() => {
  const conn = extension;
  if (!conn) return;
  if (!conn.alive) {
    log('browser extension stopped responding');
    conn.ws.terminate();
    return;
  }
  conn.alive = false;
  conn.ws.ping();
}, HEARTBEAT_MS).unref();

function waitForExtension() {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      connectWaiters.delete(done);
      reject(new Error(NOT_CONNECTED));
    }, CONNECT_WAIT_MS);
    connectWaiters.add(done);
  });
}

async function callExtension(name, args) {
  if (!extension) await waitForExtension();
  const conn = extension;
  if (!conn) throw new Error(NOT_CONNECTED);
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`The browser did not answer ${name} within ${TOOL_TIMEOUT_MS / 1000}s.`));
    }, TOOL_TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });
    conn.ws.send(JSON.stringify({ type: 'tool_call', requestId, payload: { name, args } }));
  });
}

// ---------------------------------------------------------------------------
// Follower: relay tool calls through the bridge that hosts the browser
// ---------------------------------------------------------------------------

let hostSocket = null;
const relayPending = new Map();

function followHost() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/agent`, { headers: { [AGENT_HEADER]: VERSION } });
  let refused = false;
  ws.on('open', () => {
    hostSocket = ws;
    setRole('follower');
    log(`sharing the browser through the GiwiBridge already running on port ${PORT}`);
  });
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'tool_result') return;
    const entry = relayPending.get(msg.responseToRequestId);
    if (!entry) return;
    relayPending.delete(msg.responseToRequestId);
    clearTimeout(entry.timer);
    if (msg.payload?.error) entry.reject(new Error(msg.payload.error));
    else entry.resolve(msg.payload?.data ?? null);
  });
  ws.on('error', (err) => {
    if (/Unexpected server response/.test(err.message)) refused = true;
  });
  ws.on('close', () => {
    if (hostSocket === ws) {
      hostSocket = null;
      log('the GiwiBridge hosting the browser exited; taking over');
    }
    for (const entry of relayPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('The GiwiBridge hosting the browser connection exited before answering. Try again.'));
    }
    relayPending.clear();
    role = 'starting';
    if (refused) {
      const problem =
        `Another GiwiBridge owns port ${PORT} but is an older version that cannot share the browser. ` +
        'Reconnect giwi-bridge in the chat that started it, or close that chat.';
      if (problem !== roleProblem) log(problem);
      roleProblem = problem;
      setTimeout(elect, ELECTION_RETRY_MS).unref();
    } else {
      // Jitter so that several orphaned followers do not all race for the port at once.
      setTimeout(elect, 200 + Math.random() * 800).unref();
    }
  });
}

function relayToHost(name, args) {
  const ws = hostSocket;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Lost the connection to the GiwiBridge hosting the browser. Try again.'));
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      relayPending.delete(requestId);
      reject(new Error(`The browser did not answer ${name} within ${RELAY_TIMEOUT_MS / 1000}s.`));
    }, RELAY_TIMEOUT_MS);
    relayPending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: 'tool_call', requestId, payload: { name, args } }));
  });
}

// ---------------------------------------------------------------------------
// Election
// ---------------------------------------------------------------------------

async function isGiwiBridgeOnPort() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/status`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).name === 'giwi-bridge';
  } catch {
    return false;
  }
}

function elect() {
  httpServer.listen(PORT, HOST);
}

httpServer.on('listening', () => {
  setRole('host');
  log(`hosting the browser connection on ws://${HOST}:${PORT}/ws`);
});

httpServer.on('error', async (err) => {
  if (role === 'host') {
    log('server error:', err.message);
    return;
  }
  if (err.code === 'EADDRINUSE' && (await isGiwiBridgeOnPort())) {
    followHost();
    return;
  }
  const problem =
    err.code === 'EADDRINUSE'
      ? `Port ${PORT} is in use by another program (not GiwiBridge). Free it, or set GIWI_BRIDGE_PORT and the extension's bridgeUrl to another port.`
      : `GiwiBridge could not listen on ${HOST}:${PORT}: ${err.message}`;
  if (problem !== roleProblem) log(problem);
  roleProblem = problem;
  setTimeout(elect, ELECTION_RETRY_MS).unref();
});

// ---------------------------------------------------------------------------
// MCP tools (each forwards to the extension tool of the same name, minus "browser_")
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'giwi-bridge', version: VERSION });

const tabId = z.number().int().optional().describe('Tab to act on. Defaults to the tab this chat used last, then the active tab.');
const ref = z.string().optional().describe('Element ref from browser_snapshot, e.g. "e12".');
const selector = z.string().optional().describe('CSS selector, used when no ref is given.');

const asText = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });

function defineTool(name, description, inputSchema, readOnly = false) {
  server.registerTool(
    `browser_${name}`,
    { description, inputSchema, annotations: { readOnlyHint: readOnly, openWorldHint: true } },
    async (args) => {
      try {
        const data = await callBrowser(name, { ...args, _session: SESSION_ID });
        if (data?.image) {
          const { image, ...info } = data;
          return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }, asText(info)] };
        }
        return { content: [asText(data)] };
      } catch (err) {
        return { content: [asText(err.message)], isError: true };
      }
    },
  );
}

defineTool('list_tabs', 'List open browser tabs with their tabId, title, URL, which one is active and which one this chat used last.', {}, true);

defineTool(
  'navigate',
  'Open a URL and wait for it to load. Reuses this chat\'s own tab (or the given tabId); otherwise opens a new background tab in the "Giwi" tab group. It never takes over the user\'s tab unless you pass that tabId.',
  {
    url: z.string().describe('Absolute URL; "example.com" is treated as https://example.com.'),
    newTab: z.boolean().optional().describe('Always open a new tab.'),
    tabId,
  },
);

defineTool(
  'snapshot',
  'Accessibility-tree outline of the page. Elements get [ref=eN] handles to use with browser_click, browser_fill, browser_hover, browser_select_option and browser_scroll. Refs are invalidated by navigation, so take a new snapshot after the page changes.',
  { tabId },
  true,
);

defineTool(
  'click',
  'Click an element with real mouse events. Reports when another element (such as a cookie banner) covered the target.',
  { ref, selector, doubleClick: z.boolean().optional(), tabId },
);

defineTool('hover', 'Move the mouse over an element, e.g. to open a hover menu.', { ref, selector, tabId });

defineTool(
  'fill',
  'Replace the contents of a text field (input, textarea or contenteditable) with text, optionally pressing Enter afterwards.',
  { ref, selector, text: z.string(), submit: z.boolean().optional().describe('Press Enter after filling.'), tabId },
);

defineTool(
  'type',
  'Insert text wherever the keyboard focus currently is, e.g. after clicking into an editor.',
  { text: z.string(), submit: z.boolean().optional().describe('Press Enter after typing.'), tabId },
);

defineTool(
  'press_key',
  'Press a key or key combination: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, any single character, or combinations such as Control+a or Shift+Tab.',
  { key: z.string(), tabId },
);

defineTool(
  'select_option',
  'Choose option(s) in a <select> element by value or visible label.',
  { ref, selector, values: z.array(z.string()).min(1), tabId },
);

defineTool(
  'scroll',
  'Scroll the page, or the scrollable container that holds ref/selector. Defaults to 80% of the visible height.',
  {
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.number().positive().optional().describe('Distance in CSS pixels.'),
    ref,
    selector,
    tabId,
  },
);

defineTool(
  'screenshot',
  'Capture a PNG of the tab. The tab is brought to the front first, because background tabs do not render.',
  { fullPage: z.boolean().optional().describe('Capture the whole scrollable page (up to 16000px tall).'), tabId },
  true,
);

defineTool(
  'read_page',
  'Return the page title, URL and visible text (innerText). Cheaper than a screenshot for reading content.',
  { maxChars: z.number().int().positive().optional().describe('Default 20000.'), tabId },
  true,
);

defineTool(
  'evaluate',
  'Run a JavaScript expression in the page and return its JSON-serialisable result. Promises are awaited. The page runs with the user\'s logged-in session.',
  { expression: z.string(), tabId },
);

defineTool(
  'wait_for',
  'Wait until text appears and/or disappears on the page. With neither, simply wait timeoutMs.',
  {
    text: z.string().optional(),
    textGone: z.string().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional().describe('Default 15000.'),
    tabId,
  },
  true,
);

defineTool('history', 'Go back, go forward or reload.', { action: z.enum(['back', 'forward', 'reload']), tabId });

defineTool(
  'dialog',
  'Accept or dismiss an open alert, confirm, prompt or beforeunload dialog. Other tools fail while one is open.',
  { accept: z.boolean().optional().describe('Default true.'), promptText: z.string().optional(), tabId },
);

defineTool('activate_tab', 'Bring a tab to the front and focus its window so the user can watch.', { tabId: z.number().int() });

defineTool('close_tab', 'Close a tab.', { tabId: z.number().int() });

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

elect();

// The HTTP listener would otherwise keep the process alive after the agent exits.
const shutdown = () => process.exit(0);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
