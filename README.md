# GiwiBridge

Let a coding agent (Claude Code, Cursor, Codex, …) drive **your real browser**: your tabs and your logged-in sessions. It can open pages, read them, click, fill in forms, take screenshots and run JavaScript.

It follows the same design as [Kimi WebBridge](https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-introduction) (now called the Kimi Browser Extension), and was written from scratch. [docs/kimi-webbridge-findings.md](docs/kimi-webbridge-findings.md) explains what was learned by reverse-engineering Kimi's extension and how this project maps to it.

## How it works

```
 Agent (Claude Code)            bridge/server.js                     extension/ (Chrome or Edge)
┌──────────────────┐  MCP   ┌────────────────────────┐  WebSocket  ┌──────────────────────────┐
│ browser_click …  │ stdio  │ MCP server             │◄────────────│ MV3 service worker       │
│                  ├───────►│ + ws://127.0.0.1:10087 │ tool_call ► │ chrome.debugger (CDP 1.3)│──► your tabs
└──────────────────┘        │   /ws  and  /status    │ ◄ tool_result└──────────────────────────┘
                            └────────────────────────┘
```

- The agent launches `bridge/server.js` as an MCP server. The server also listens on `127.0.0.1:10087`.
- The extension connects *out* to that port as a WebSocket client, so no native-messaging host is needed. It retries every 3 s while awake and every 30 s by alarm.
- Each tool call is sent to the extension as `{type:"tool_call"}`. The extension carries it out on the tab with Chrome DevTools Protocol commands (`Input.dispatchMouseEvent`, `Input.insertText`, `Accessibility.getFullAXTree`, `Page.captureScreenshot`, …) and replies with `{type:"tool_result"}`.
- Everything runs on your machine. Nothing is sent to any cloud service.

### Several agent chats, one browser

Each agent chat starts its own copy of `server.js`, but they share the browser:

- The first copy to bind port 10087 **hosts** the browser connection.
- Later copies see a GiwiBridge on the port and connect to it at `ws://127.0.0.1:10087/agent`. They **relay** their tool calls through it.
- If the hosting chat closes, a remaining copy takes over the port within about a second. The extension reconnects to it on its own: within 3 s while awake, or within 30 s if Chrome had put it to sleep.
- Every call carries its chat's session id. The extension keeps a separate "current tab" for each chat, so two chats don't steer each other's tabs. Explicit `tabId`s still work across chats.

`GET /status` shows `sharingChats`, the number of other chats relaying through the host.

## Setup

1. **Install the bridge's dependencies** (Node 20+):
   ```sh
   cd bridge
   npm install
   ```
2. **Load the extension.** Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked**, and select the `extension/` folder. Pin it to the toolbar if you like. The badge shows **ON** while the bridge is connected.
3. **Register the MCP server with your agent.** For Claude Code, scoped to this project (already done on this machine):
   ```sh
   claude mcp add --scope local giwi-bridge -- "C:\Program Files\nodejs\node.exe" "D:\2026_Agent\giwi_broswer\bridge\server.js"
   ```
   Other MCP clients use the same command: `node <path>/bridge/server.js`. Restart the agent session so it picks up the server.

Then ask the agent something like *"open news.ycombinator.com and summarise the top 5 stories"*.

## Tools

| Tool | Purpose |
|---|---|
| `browser_list_tabs` | List tabs (id, title, URL, active, last used by this chat) |
| `browser_navigate` | Open a URL in this chat's tab, or in a new background tab in the purple **Giwi** tab group |
| `browser_snapshot` | Accessibility-tree outline with `[ref=eN]` handles for the actions below |
| `browser_click` / `browser_hover` | Real mouse events on a ref or CSS selector; warns if something covers the target |
| `browser_fill` | Replace a text field's contents, optionally pressing Enter |
| `browser_type` / `browser_press_key` | Type at the current focus; press keys such as `Enter`, `Escape`, `Control+a` |
| `browser_select_option` | Pick `<select>` options by value or label |
| `browser_scroll` | Scroll the page or the scrollable container holding an element |
| `browser_screenshot` | PNG of the viewport or the full page |
| `browser_read_page` | Visible text, title and URL |
| `browser_evaluate` | Run JavaScript in the page; returns JSON |
| `browser_wait_for` | Wait for text to appear or disappear |
| `browser_history` | Back, forward, reload |
| `browser_dialog` | Accept or dismiss alert, confirm, prompt or beforeunload dialogs |
| `browser_activate_tab` / `browser_close_tab` | Bring a tab to the front, or close it |

The agent never takes over a tab you are using unless it passes that tab's `tabId`. Without one, `browser_navigate` reuses that chat's own tab or opens a new one.

## Configuration

| Setting | Where | Default |
|---|---|---|
| Bridge port | `GIWI_BRIDGE_PORT` env var for `server.js` | `10087` (Kimi uses `10086`, so both can be installed) |
| Port the extension connects to | In the extension's service-worker console: `chrome.storage.local.set({ bridgeUrl: 'ws://127.0.0.1:PORT/ws' })` | `ws://127.0.0.1:10087/ws` |
| Accept only one extension ID | `GIWI_EXTENSION_ID` env var | any `chrome-extension://` origin |

## Security notes

- The agent acts **as you**, with your cookies and logged-in sessions. Treat it like letting someone use your unlocked browser. `browser_evaluate` can read anything a page can.
- The bridge listens on `127.0.0.1` only. It rejects WebSocket connections whose `Origin` isn't a browser extension, so websites can't impersonate the extension. It also rejects requests whose `Host` isn't localhost, which blocks DNS rebinding.
- The `/agent` relay socket only accepts handshakes that carry **no** `Origin` header and **do** carry an `x-giwi-bridge-agent` header. Browsers always send `Origin` and can't add custom headers to WebSockets, so web pages and extensions can't use it. Any program running as you on this machine can, which is the same trust the bridge already gives local processes.
- Only one browser can be connected at a time. Another one is refused with close code `4409`.
- There is no per-site approval prompt yet: the agent can act on any site. Kimi asks *Deny / Just once / Allow and remember* first, and this is the top item in the findings doc's roadmap.
- While the agent is working, Chrome shows its "started debugging this browser" banner. That banner is how `chrome.debugger` works and can't be hidden.

## Limitations

- Only the main frame is covered: snapshots and selectors don't reach into iframes yet.
- Browser-internal pages (`chrome://`, `edge://`, extension stores) can't be automated. That is a Chromium rule.
- `browser_screenshot` brings the tab to the front, because Chromium doesn't paint background tabs.
- A bridge from before version 0.2.0 can't share. If one owns the port, newer chats report that clearly and take over once it exits. To clear it sooner, reconnect `giwi-bridge` in the chat that started it.
- Chats sharing the browser can still act on the same tab if one passes another's `tabId`. Nothing locks a tab to a chat.

## Testing

Tested with Microsoft Edge 155 (Chromium 155):
- **Single chat:** navigation, snapshot refs, fill, select, checkbox, submit, typing and keys, scrolling, alert handling, screenshots, link navigation and history, stale-ref rejection, and tab listing and closing.
- **Two chats sharing one Edge:** each chat gets its own tab, `navigate` and `read_page` without a `tabId` stay on the calling chat's tab, and `list_tabs` marks each chat's own tab. When the hosting chat exits, the other takes over and the real extension reconnects to it.

Chrome 155 ignores the `--load-extension` flag, so the automated runs used Edge. In Chrome, use the manual **Load unpacked** route.
