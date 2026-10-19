const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:10087/ws';
const RECONNECT_ALARM = 'giwi-reconnect';
const RETRY_MS = 3000;
const KEEPALIVE_MS = 20_000;
const CDP_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 30_000;
const SNAPSHOT_MAX_CHARS = 40_000;
const GROUP_TITLE = 'Giwi';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Bridge connection (extension is the WebSocket client, the MCP bridge is the server)
// ---------------------------------------------------------------------------

let socket = null;
let connecting = false;
let keepaliveTimer = null;
let retryTimer = null;

async function connect() {
  if (connecting || (socket && socket.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try {
    const { bridgeUrl } = await chrome.storage.local.get('bridgeUrl');
    openSocket(bridgeUrl || DEFAULT_BRIDGE_URL);
  } catch (err) {
    console.error('[giwi] cannot open bridge connection:', err);
  } finally {
    connecting = false;
  }
}

function openSocket(url) {
  clearTimeout(retryTimer);
  const ws = new WebSocket(url);
  socket = ws;
  ws.addEventListener('open', () => {
    send({ type: 'hello', payload: { extensionVersion: chrome.runtime.getManifest().version } });
    clearInterval(keepaliveTimer);
    // Message traffic is what keeps an MV3 service worker (and its socket) alive.
    keepaliveTimer = setInterval(() => send({ type: 'ping' }), KEEPALIVE_MS);
    setBadge(true);
  });
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'ping') send({ type: 'pong' });
    else if (msg.type === 'tool_call') handleToolCall(msg);
  });
  ws.addEventListener('close', (event) => {
    if (socket !== ws) return;
    socket = null;
    clearInterval(keepaliveTimer);
    if (event.code === 4409) {
      // Another browser owns the bridge; retry only on the slow alarm cadence.
      setBadge(false, 'another browser is connected to the bridge');
      return;
    }
    setBadge(false);
    retryTimer = setTimeout(connect, RETRY_MS);
  });
}

function send(msg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function setBadge(connected, detail = 'waiting for bridge') {
  chrome.action.setBadgeText({ text: connected ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' });
  chrome.action.setTitle({ title: connected ? 'GiwiBridge: connected' : `GiwiBridge: ${detail}` });
}

async function handleToolCall({ requestId, payload }) {
  const { name, args = {} } = payload ?? {};
  try {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}`);
    const data = await tool(args);
    send({ type: 'tool_result', responseToRequestId: requestId, payload: { data: data ?? null } });
  } catch (err) {
    send({ type: 'tool_result', responseToRequestId: requestId, payload: { error: err?.message ?? String(err) } });
  }
}

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
chrome.runtime.onStartup.addListener(() => connect());
chrome.action.onClicked.addListener(() => connect());
connect();

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol plumbing via chrome.debugger
// ---------------------------------------------------------------------------

// Each agent chat sharing the bridge sends its own _session id and gets its own "current tab".
const lastTabBySession = new Map();
const lastTab = (session) => lastTabBySession.get(session ?? 'default') ?? null;
const rememberTab = (session, tabId) => lastTabBySession.set(session ?? 'default', tabId);
const attachedTabs = new Set();
const attaching = new Map();
const refsByTab = new Map();
const openDialogs = new Map();
const dialogWaiters = new Map();

chrome.debugger.onDetach.addListener(({ tabId }) => {
  attachedTabs.delete(tabId);
  openDialogs.delete(tabId);
});

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === 'Page.javascriptDialogOpening') {
    const dialog = { type: params.type, message: params.message ?? '' };
    openDialogs.set(tabId, dialog);
    for (const notify of dialogWaiters.get(tabId) ?? []) notify(dialog);
  } else if (method === 'Page.javascriptDialogClosed') {
    openDialogs.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  refsByTab.delete(tabId);
  openDialogs.delete(tabId);
  dialogWaiters.delete(tabId);
  for (const [session, id] of lastTabBySession) if (id === tabId) lastTabBySession.delete(session);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') refsByTab.delete(tabId);
});

function attach(tabId) {
  if (attachedTabs.has(tabId)) return Promise.resolve();
  if (!attaching.has(tabId)) {
    const pending = (async () => {
      // A session left over from a previous service-worker lifetime would block attach.
      await chrome.debugger.detach({ tabId }).catch(() => {});
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch (err) {
        throw new Error(
          `Cannot control tab ${tabId}: ${err.message}. Browser-internal pages (chrome://, edge://, the extension store) cannot be automated.`,
        );
      }
      attachedTabs.add(tabId);
      await Promise.allSettled([
        chrome.debugger.sendCommand({ tabId }, 'Page.enable'),
        chrome.debugger.sendCommand({ tabId }, 'Accessibility.enable'),
        // Lets background tabs receive focus and keyboard input.
        chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }),
      ]);
    })().finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return attaching.get(tabId);
}

function dialogError(dialog, causedByAction) {
  const what = `a JavaScript ${dialog.type} dialog ("${dialog.message.slice(0, 200)}")`;
  return new Error(
    causedByAction
      ? `The action ran and opened ${what}, which blocks the page. Use browser_dialog to accept or dismiss it.`
      : `The page is blocked by ${what}. Use browser_dialog to accept or dismiss it first.`,
  );
}

async function cdp(tabId, method, params = {}) {
  await attach(tabId);
  const open = openDialogs.get(tabId);
  if (open && method !== 'Page.handleJavaScriptDialog') throw dialogError(open, false);

  let timer;
  let notify;
  // A dialog opened by this command would otherwise leave it hanging until the timeout.
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${method} timed out after ${CDP_TIMEOUT_MS / 1000}s; the tab may have crashed or been closed.`)),
      CDP_TIMEOUT_MS,
    );
    notify = (dialog) => reject(dialogError(dialog, true));
  });
  if (!dialogWaiters.has(tabId)) dialogWaiters.set(tabId, new Set());
  const waiters = dialogWaiters.get(tabId);
  waiters.add(notify);
  try {
    return await Promise.race([chrome.debugger.sendCommand({ tabId }, method, params), interrupted]);
  } finally {
    clearTimeout(timer);
    waiters.delete(notify);
  }
}

async function evaluate(tabId, expression) {
  const res = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value ?? res.result.description ?? null;
}

async function callOn(tabId, backendNodeId, functionDeclaration, args = []) {
  let object;
  try {
    ({ object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId }));
  } catch {
    throw new Error('That element no longer exists. Take a fresh browser_snapshot.');
  }
  try {
    const res = await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value;
  } finally {
    cdp(tabId, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tabs, elements and input helpers
// ---------------------------------------------------------------------------

async function getTab(tabId, session) {
  if (tabId != null) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(`Tab ${tabId} does not exist. Use browser_list_tabs.`);
    rememberTab(session, tab.id);
    return tab;
  }
  const last = lastTab(session);
  if (last != null) {
    const tab = await chrome.tabs.get(last).catch(() => null);
    if (tab) return tab;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No browser tab is available. Use browser_navigate to open one.');
  rememberTab(session, tab.id);
  return tab;
}

async function pageInfo(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { tabId: tab.id, title: tab.title, url: tab.url };
}

async function waitForLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  await sleep(150);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(`Tab ${tabId} was closed while loading.`);
    if (tab.status === 'complete') return true;
    await sleep(200);
  }
  return false;
}

async function settle(tabId) {
  await sleep(300);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === 'loading') await waitForLoad(tabId, 15_000);
}

async function addToGroup(tabId) {
  try {
    const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE });
    if (group) {
      await chrome.tabs.group({ groupId: group.id, tabIds: [tabId] });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple' });
    }
  } catch {
    // Grouping is cosmetic.
  }
}

async function resolveElement(tabId, { ref, selector }) {
  if (ref) {
    const backendNodeId = refsByTab.get(tabId)?.get(ref.replace(/^@/, ''));
    if (backendNodeId == null) throw new Error(`Unknown ref "${ref}" for tab ${tabId}. Take a fresh browser_snapshot.`);
    return backendNodeId;
  }
  if (selector) {
    const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`No element matches selector ${selector}`);
    const { node } = await cdp(tabId, 'DOM.describeNode', { nodeId });
    return node.backendNodeId;
  }
  throw new Error('Provide either ref (from browser_snapshot) or selector.');
}

const POINT_FN = `function () {
  this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = this.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  let coveredBy = null;
  if (hit && hit !== this && !this.contains(hit) && !hit.contains(this)) {
    const cls = typeof hit.className === 'string' ? hit.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    coveredBy = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (cls ? '.' + cls : '');
  }
  return { x, y, width: r.width, height: r.height, coveredBy };
}`;

async function elementPoint(tabId, backendNodeId) {
  const point = await callOn(tabId, backendNodeId, POINT_FN);
  if (!point.width || !point.height) throw new Error('The element has no visible size, so it cannot be pointed at.');
  return point;
}

async function mouseClick(tabId, x, y, clickCount) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i });
  }
}

const NAMED_KEYS = {
  Enter: [13, 'Enter', '\r'],
  Tab: [9, 'Tab'],
  Escape: [27, 'Escape'],
  Backspace: [8, 'Backspace'],
  Delete: [46, 'Delete'],
  ArrowUp: [38, 'ArrowUp'],
  ArrowDown: [40, 'ArrowDown'],
  ArrowLeft: [37, 'ArrowLeft'],
  ArrowRight: [39, 'ArrowRight'],
  Home: [36, 'Home'],
  End: [35, 'End'],
  PageUp: [33, 'PageUp'],
  PageDown: [34, 'PageDown'],
  Space: [32, 'Space', ' '],
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };

function keyDefinition(combo) {
  const parts = combo.split('+');
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    if (!(m in MODIFIERS)) throw new Error(`Unknown modifier "${m}" in "${combo}". Use Alt, Control, Meta or Shift.`);
    modifiers |= MODIFIERS[m];
  }
  let def;
  if (NAMED_KEYS[name]) {
    const [keyCode, code, text] = NAMED_KEYS[name];
    def = { key: name === 'Space' ? ' ' : name, code, keyCode, text };
  } else if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : '';
    def = { key: name, code, keyCode: upper.charCodeAt(0), text: name };
  } else {
    throw new Error(`Unsupported key "${name}". Use a single character or one of: ${Object.keys(NAMED_KEYS).join(', ')}.`);
  }
  if (modifiers & (MODIFIERS.Alt | MODIFIERS.Control | MODIFIERS.Meta)) def.text = undefined;
  return { ...def, modifiers };
}

async function pressKey(tabId, combo) {
  const k = keyDefinition(combo);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
  await cdp(
    tabId,
    'Input.dispatchKeyEvent',
    k.text ? { type: 'keyDown', ...base, text: k.text, unmodifiedText: k.text } : { type: 'rawKeyDown', ...base },
  );
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// ---------------------------------------------------------------------------
// Accessibility snapshot with element refs
// ---------------------------------------------------------------------------

const SKIP_ROLES = new Set(['none', 'generic', 'presentation', 'InlineTextBox', 'LineBreak', 'ListMarker']);
const STATE_PROPS = new Set(['checked', 'disabled', 'expanded', 'focused', 'selected', 'pressed', 'required']);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function renderAxTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const refs = new Map();
  const lines = [];
  let length = 0;
  let truncated = false;

  const visit = (node, depth, parentName) => {
    if (truncated) return;
    const role = node.role?.value ?? '';
    const name = String(node.name?.value ?? '').replace(/\s+/g, ' ').trim();
    const redundantText = role === 'StaticText' && (!name || parentName.includes(name));
    const shown = !node.ignored && !SKIP_ROLES.has(role) && !redundantText;
    if (shown) {
      let line = `${'  '.repeat(depth)}- ${role}`;
      if (name) line += ` "${clip(name, 120)}"`;
      const value = node.value?.value;
      if (value !== undefined && value !== '' && String(value) !== name) line += ` value="${clip(String(value), 120)}"`;
      for (const p of node.properties ?? []) {
        const v = p.value?.value;
        if (STATE_PROPS.has(p.name) && v && v !== 'false') line += v === true || v === 'true' ? ` ${p.name}` : ` ${p.name}=${v}`;
      }
      if (node.backendDOMNodeId && role !== 'StaticText' && role !== 'RootWebArea') {
        const ref = `e${refs.size + 1}`;
        refs.set(ref, node.backendDOMNodeId);
        line += ` [ref=${ref}]`;
      }
      length += line.length + 1;
      if (length > SNAPSHOT_MAX_CHARS) {
        truncated = true;
        return;
      }
      lines.push(line);
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, shown ? depth + 1 : depth, shown ? name : parentName);
    }
  };

  if (root) visit(root, 0, '');
  if (truncated) lines.push(`… snapshot truncated at ${SNAPSHOT_MAX_CHARS} characters; use browser_read_page or browser_evaluate for the rest.`);
  return { text: lines.join('\n'), refs };
}

const SCROLL_FN = `function (el, direction, amount) {
  const scrollable = (n) => {
    const s = getComputedStyle(n);
    return /(auto|scroll|overlay)/.test(s.overflowY + ' ' + s.overflowX) &&
      (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth);
  };
  let box = el;
  while (box && box !== document.body && box !== document.documentElement && !scrollable(box)) box = box.parentElement;
  const scroller = box && box !== document.body && box !== document.documentElement ? box : document.scrollingElement;
  const page = scroller === document.scrollingElement;
  const step = amount ?? Math.round((page ? innerHeight : scroller.clientHeight) * 0.8);
  const dx = direction === 'left' ? -step : direction === 'right' ? step : 0;
  const dy = direction === 'up' ? -step : direction === 'down' ? step : 0;
  scroller.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return {
    scrolled: page ? 'page' : 'inner element',
    scrollTop: Math.round(scroller.scrollTop),
    scrollHeight: scroller.scrollHeight,
    atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
  };
}`;

const EDITABLE_FN = `function () {
  const sel = 'input, textarea, [contenteditable=""], [contenteditable="true"]';
  const field = this.matches(sel) ? this : this.querySelector(sel);
  if (!field) return false;
  field.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  field.focus();
  if (field.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(field);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
  } else if (typeof field.select === 'function') {
    field.select();
  }
  return true;
}`;

const SELECT_FN = `function (values) {
  if (!(this instanceof HTMLSelectElement)) return { error: 'Element is not a <select>. Click it and choose the option instead.' };
  const options = [...this.options];
  const picked = options.filter((o) => values.includes(o.value) || values.includes(o.label) || values.includes(o.text.trim()));
  if (!picked.length) {
    return { error: 'No option matches ' + JSON.stringify(values) + '. Options: ' + options.slice(0, 50).map((o) => o.label || o.value).join(' | ') };
  }
  for (const o of options) o.selected = this.multiple ? picked.includes(o) : o === picked[0];
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: picked.map((o) => o.label || o.value) };
}`;

// ---------------------------------------------------------------------------
// Tools (names match the bridge's browser_* tools without the prefix)
// ---------------------------------------------------------------------------

const TOOLS = {
  async list_tabs({ _session }) {
    const tabs = await chrome.tabs.query({});
    const mine = lastTab(_session);
    return tabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      active: t.active,
      lastUsedByAgent: t.id === mine,
      title: t.title,
      url: t.url,
    }));
  },

  async navigate({ url, newTab = false, tabId, _session }) {
    if (!url) throw new Error('url is required');
    const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    // Never repurpose the user's own tab implicitly: reuse this chat's tab or open one.
    const mine = lastTab(_session);
    const existing = newTab
      ? null
      : tabId != null
        ? await getTab(tabId, _session)
        : mine != null
          ? await chrome.tabs.get(mine).catch(() => null)
          : null;
    let tab;
    if (existing) {
      tab = await chrome.tabs.update(existing.id, { url: target });
    } else {
      tab = await chrome.tabs.create({ url: target, active: false });
      await addToGroup(tab.id);
    }
    rememberTab(_session, tab.id);
    const loaded = await waitForLoad(tab.id);
    return { ...(await pageInfo(tab.id)), loaded };
  },

  async snapshot({ _session, tabId }) {
    const tab = await getTab(tabId, _session);
    const { nodes } = await cdp(tab.id, 'Accessibility.getFullAXTree');
    const { text, refs } = renderAxTree(nodes);
    refsByTab.set(tab.id, refs);
    const info = await pageInfo(tab.id);
    return `Tab ${info.tabId}: ${info.title}\nURL: ${info.url}\n\n${text}`;
  },

  async click({ _session, tabId, ref, selector, doubleClick = false }) {
    const tab = await getTab(tabId, _session);
    const node = await resolveElement(tab.id, { ref, selector });
    const point = await elementPoint(tab.id, node);
    await mouseClick(tab.id, point.x, point.y, doubleClick ? 2 : 1);
    await settle(tab.id);
    const result = await pageInfo(tab.id);
    if (point.coveredBy) result.warning = `Another element (${point.coveredBy}) was on top of the target and may have received the click.`;
    return result;
  },

  async hover({ _session, tabId, ref, selector }) {
    const tab = await getTab(tabId, _session);
    const point = await elementPoint(tab.id, await resolveElement(tab.id, { ref, selector }));
    await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    return pageInfo(tab.id);
  },

  async fill({ _session, tabId, ref, selector, text = '', submit = false }) {
    const tab = await getTab(tabId, _session);
    const node = await resolveElement(tab.id, { ref, selector });
    const editable = await callOn(tab.id, node, EDITABLE_FN);
    if (!editable) throw new Error('That element is not a text field. Use browser_select_option for <select>, or browser_click for checkboxes.');
    if (text) await cdp(tab.id, 'Input.insertText', { text });
    else await pressKey(tab.id, 'Delete');
    if (submit) await pressKey(tab.id, 'Enter');
    await settle(tab.id);
    return pageInfo(tab.id);
  },

  async type({ _session, tabId, text, submit = false }) {
    const tab = await getTab(tabId, _session);
    if (text) await cdp(tab.id, 'Input.insertText', { text });
    if (submit) await pressKey(tab.id, 'Enter');
    await settle(tab.id);
    return pageInfo(tab.id);
  },

  async press_key({ _session, tabId, key }) {
    const tab = await getTab(tabId, _session);
    await pressKey(tab.id, key);
    await settle(tab.id);
    return pageInfo(tab.id);
  },

  async select_option({ _session, tabId, ref, selector, values }) {
    const tab = await getTab(tabId, _session);
    const node = await resolveElement(tab.id, { ref, selector });
    const result = await callOn(tab.id, node, SELECT_FN, [values]);
    if (result.error) throw new Error(result.error);
    return result;
  },

  async scroll({ _session, tabId, direction = 'down', amount, ref, selector }) {
    const tab = await getTab(tabId, _session);
    if (ref || selector) {
      const node = await resolveElement(tab.id, { ref, selector });
      return callOn(tab.id, node, `function (d, a) { return (${SCROLL_FN})(this, d, a); }`, [direction, amount ?? null]);
    }
    return evaluate(
      tab.id,
      `(${SCROLL_FN})(document.elementFromPoint(innerWidth / 2, innerHeight / 2), ${JSON.stringify(direction)}, ${amount ?? null})`,
    );
  },

  async screenshot({ _session, tabId, fullPage = false }) {
    const tab = await getTab(tabId, _session);
    // Background tabs do not paint, so capture would stall until they are shown.
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(200);
    }
    const params = { format: 'png' };
    if (fullPage) {
      const { cssContentSize } = await cdp(tab.id, 'Page.getLayoutMetrics');
      params.captureBeyondViewport = true;
      params.clip = {
        x: 0,
        y: 0,
        width: Math.ceil(cssContentSize.width),
        height: Math.ceil(Math.min(cssContentSize.height, 16_000)),
        scale: 1,
      };
    }
    const { data } = await cdp(tab.id, 'Page.captureScreenshot', params);
    return { image: { data, mimeType: 'image/png' }, ...(await pageInfo(tab.id)) };
  },

  async read_page({ _session, tabId, maxChars = 20_000 }) {
    const tab = await getTab(tabId, _session);
    const page = await evaluate(tab.id, `({ title: document.title, url: location.href, text: document.body ? document.body.innerText : '' })`);
    const text = page.text.length > maxChars ? `${page.text.slice(0, maxChars)}\n… truncated (${page.text.length} characters total)` : page.text;
    return `Tab ${tab.id}: ${page.title}\nURL: ${page.url}\n\n${text}`;
  },

  async evaluate({ _session, tabId, expression }) {
    const tab = await getTab(tabId, _session);
    // Always JSON so the agent can tell the string "42" from the number 42.
    return JSON.stringify(await evaluate(tab.id, expression), null, 2);
  },

  async wait_for({ _session, tabId, text, textGone, timeoutMs = 15_000 }) {
    const tab = await getTab(tabId, _session);
    if (!text && !textGone) {
      await sleep(timeoutMs);
      return pageInfo(tab.id);
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const body = await evaluate(tab.id, 'document.body ? document.body.innerText : ""').catch(() => '');
      if ((!text || body.includes(text)) && (!textGone || !body.includes(textGone))) return pageInfo(tab.id);
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${text ? `"${text}" to appear` : `"${textGone}" to disappear`}.`);
      }
      await sleep(400);
    }
  },

  async history({ _session, tabId, action }) {
    const tab = await getTab(tabId, _session);
    if (action === 'back') await chrome.tabs.goBack(tab.id);
    else if (action === 'forward') await chrome.tabs.goForward(tab.id);
    else if (action === 'reload') await chrome.tabs.reload(tab.id);
    else throw new Error('action must be back, forward or reload');
    const loaded = await waitForLoad(tab.id, 15_000);
    return { ...(await pageInfo(tab.id)), loaded };
  },

  async dialog({ _session, tabId, accept = true, promptText }) {
    const tab = await getTab(tabId, _session);
    const open = openDialogs.get(tab.id);
    if (!open) throw new Error('No JavaScript dialog is open on this tab.');
    await cdp(tab.id, 'Page.handleJavaScriptDialog', { accept, ...(promptText != null && { promptText }) });
    openDialogs.delete(tab.id);
    return { type: open.type, message: open.message, accepted: accept };
  },

  async activate_tab({ _session, tabId }) {
    const tab = await getTab(tabId, _session);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return pageInfo(tab.id);
  },

  async close_tab({ tabId }) {
    if (tabId == null) throw new Error('tabId is required');
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },
};
