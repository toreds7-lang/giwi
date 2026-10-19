# Kimi WebBridge: reverse-engineering notes

This document records how Kimi's browser-control extension works internally and which of its ideas GiwiBridge reuses. GiwiBridge contains **no Kimi code**. The analysis was done to understand the design, and the implementation was written independently using standard Chrome extension and CDP APIs.

## Sources

| Source | What it gave |
|---|---|
| [Kimi WebBridge introduction](https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-introduction) | Product scope: open pages, click, fill forms, extract data. Two modes: a side-panel chat, and remote control by a local agent such as Claude Code. Install routes. |
| [How Kimi Browser Extension Works](https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-how-it-works) | High-level flow: a *local bridge service* receives agent instructions, and the extension executes them "based on the Chrome DevTools Protocol". No ports or protocol given. |
| [YouTube: "Meet the new Kimi Browser Extension (formerly Kimi WebBridge)"](https://www.youtube.com/watch?v=L1y09RA3fts), Kimi AI channel, 40 s | The official launch video. It has no narration (auto-captions are only "[music]"), so it was reviewed frame by frame. GiwiBridge drove Edge to the video and screenshotted it every 4 s; see [What the launch video shows](#what-the-launch-video-shows). |
| Extension package `fldmhceldgbpfpkbgopacenieobmligc`, v2.0.23 (Chrome Web Store CRX) | Everything below. Analysed with **REA** (rea-agents 6.7.0) through its **MCP tools inside Claude Code**: `analyze_javascript_application`, `inspect_analysis_view` and `trace_application_feature` (see [REA MCP session](#rea-mcp-session)). Earlier passes used the REA CLI. Targeted reading of the minified sources filled the gaps REA reported. |

## Package overview (REA)

REA's JavaScript application graph of the whole unpacked extension contains 217 JS modules, 41 assets, 3 workers, 1 storage node and 375 network-endpoint candidates. Most of those candidates are noise from bundled pdf.js.

The literal routes worth noting come from two bundled LLM SDKs. REA places both **inside the background service worker**:
- the OpenAI SDK at `background.js:1113`: `/chat/completions`, `/responses`, `/images/generations`, `/moderations`, `/realtime/sessions`, …
- the Anthropic SDK at `background.js:1128–1158`: `/v1/messages`, `/v1/messages/count_tokens`, `/v1/files?beta=true`, `/v1/agents?beta=true`, plus the `anthropic-beta` header.

So the agent loop for the side-panel chat runs in the service worker and talks to Kimi's gateway (`agent-gw.kimi.com`). That gateway is separate from the local-agent control path described next.

## REA MCP session

These calls were made with REA's MCP tools from within Claude Code.

1. **`analyze_javascript_application`** was run on `background.js`, `content-scripts/record.js` and `content-scripts/selection.js` (retained evidence `ev_48c3dd72…`). It parsed 1.82 MB of text into 366,914 syntax nodes and produced 121 findings, with 0 parse failures. It also counted **5 sender-validation checks**, where code verifies who sent a message.
2. **`inspect_analysis_view`** (JavaScript facts) found:
   - **workers:** two `new Worker(...)` calls in `record.js:129`, one from an inline `data:text/javascript` URL. This is rrweb's worker, high confidence.
   - **storage:** `indexedDB.open` at `background.js:1188` (exact).
   - **endpoints:** 106 nodes in `background.js`, mostly the two SDKs above. It also pinpointed the local-bridge code at `background.js:1622`:
     - the control socket `new WebSocket(uB(e,t))`, where `uB` appends `?client=<id>`;
     - the `testConnection` socket;
     - `fetch(`${e.serverBase}/api/connections`, {method:"POST"})`, a daemon endpoint missed in the earlier manual pass.
3. **`trace_application_feature`** was seeded with the WebSocket node and the `/api/connections` node. Both reached the same 202-node / 210-edge component through one hub: 104 endpoints, 2 workers, 1 storage node via a `persists_to` edge, and 41 assets. REA's graph is per-module, so it proves that all of this lives in **one service-worker bundle**, but it cannot separate the flows inside that minified file.
4. **Limits REA reported:**
   - Seeds on literal strings returned **no match**: the `127.0.0.1` route, `/chat/completions` as a route seed, and the message types `RECORD_STEP` / `RECORD_ARM`.
   - The bridge URL is built from a template (`ws://127.0.0.1:${port}/ws`).
   - Chrome `runtime` messages are not modelled as channels. REA states that a missing match "is not evidence that the feature is absent".

The code at the `/api/connections` location turns out to be the extension's internal control API, handled through `chrome.runtime.onMessage`:

| Group | Messages | Notes |
|---|---|---|
| Daemon link | `GET_STATUS`, `CONNECT {url}`, `RECONCILE_NOW`, `DISCONNECT`, `TEST_CONNECTION {url}`, `UPGRADE_DAEMON` | `GET_STATUS` also reports version drift between extension and daemon |
| Pairing | `GENERATE_CONNECTION {serverBase}` | Sends `POST /api/connections` to the daemon and returns its JSON |
| Recording | `START_RECORDING`, `STOP_RECORDING`, `CANCEL_RECORDING`, `PAUSE_RECORDING`, `RESUME_RECORDING`, `RETRY_DISTILL`, `REDISTILL_REVIEW` | |
| Chat history | `HISTORY_LIST/OPEN/DELETE/RENAME/TITLE` | Answer `{error: "forbidden"}` unless the sender URL starts with the extension's own origin, so content scripts can't read chat history. This is one of the sender checks REA counted |

## Manifest

- MV3, name "Kimi", version 2.0.23.
- Permissions: `tabs`, `activeTab`, `debugger`, `storage`, `alarms`, `tabGroups`, `windows`, `sidePanel`, `contextMenus`, `favicon`, `webNavigation`, `webRequest`, `scripting`, `unlimitedStorage`. Host permissions: `<all_urls>`.
- CSP `connect-src` allows `ws://*:*`, `wss://*:*`, `http://*:*`, `https://*:*`, `www.kimi.com`, `www.kimi.ai`, `agent-gw.kimi.com` and `gator.volces.com`.
- Content scripts `record.js` and `selection.js` run on every page. `record.js` is the Skill recorder (see [Skills](#skills-recording-and-distillation)). `selection.js` powers the text-selection card and bundles math rendering.

## Local bridge ("daemon") endpoints

The constants come straight from `background.js`:

| Purpose | Endpoint |
|---|---|
| Control channel | `ws://127.0.0.1:10086/ws?client=<persistent uuid>` |
| Health | `GET http://127.0.0.1:10086/status` |
| Pairing | `POST http://127.0.0.1:10086/api/connections` (found by REA MCP) |
| Internal | `/internal/trajectory`, `/internal/sidepanel-control`, `/internal/upgrade` (`POST` → `202 {"started": true}`) |

The URL can be overridden. Storage keys are `local_url`, `ws_should_connect` and `ws_client_id`, plus a per-session `wb-browser-session` UUID.

## Wire protocol

The extension is the WebSocket **client** and the local daemon is the server.

```
ext → daemon  {type:"hello", payload:{extensionVersion}}
daemon → ext  {type:"hello_ack"}
either way    {type:"ping"} / {type:"pong"}
daemon → ext  {type:"tool_call", requestId, payload:{name, args}}
ext → daemon  {type:"tool_result", responseToRequestId, payload:{data} | {error}}
daemon close  4409 = "this daemon is already driven by another browser"
```

The daemon adds `_tabId` and `_session` to `args`.

Connection upkeep:

- A `chrome.alarms` "reconcile" alarm fires every 30 s.
- After a close, the extension retries quickly, after 1 s and then 3 s.
- A connect attempt times out after 10 s.
- After 45 s with no traffic, the link is treated as dead.

## Browser execution

- The extension calls `chrome.debugger.attach({tabId}, "1.3")`, first detaching any stale session. It then sends `Page.enable` and toggles `Emulation.setFocusEmulationEnabled` around actions so that background tabs accept input.
- CDP domains used:
  - `Accessibility.getFullAXTree` for snapshots with `@eN` refs.
  - `DOM.getBoxModel` / `resolveNode` / `querySelectorAll` and `Runtime.callFunctionOn` to target elements.
  - `Input.dispatchMouseEvent`, `Input.insertText` and `Input.dispatchKeyEvent` for input.
  - `Page.captureScreenshot` with `Page.getLayoutMetrics`, `Page.printToPDF`, `DOM.setFileInputFiles` (uploads), and `Page.getNavigationHistory` / `navigateToHistoryEntry`.
- Every command has a 300 s timeout and is raced against `Page.javascriptDialogOpening`. If a dialog blocks the page, the agent is told to call the `dialog` tool.
- New agent tabs open **in the background** (`active:false`) and are grouped into a Chrome tab group per agent session. Controlled tabs get a cursor overlay and a swapped favicon, both restored 60 s after the agent goes idle.

## Tool surface (31 tools)

`navigate, find_tab, find, evaluate, snapshot, read_page, click, fill, mouse_click, cdp, key_type, send_keys, screenshot, scroll, save_as_pdf, upload, close_tab, list_tabs, list_browser_tabs, attach_tab, activate_tab, close_session, wait, dialog, select_option, hover, set_checked, drag, inspect_region, highlight_region, clear_highlight`

`cdp` is a raw DevTools Protocol passthrough.

## Skills: recording and distillation

**What REA MCP reported.** In one MCP session, `analyze_javascript_application` was scoped to `content-scripts/record.js` and `content-scripts/selection.js` (retained evidence `ev_9bce175e…`), and `inspect_analysis_view` was run on its JavaScript facts. Two findings came back:

- `record.js` starts a Web Worker from an inline `data:text/javascript` URL (high confidence).
- `selection.js`'s "endpoint" candidates are TeX macro names (`\df@tag`, `\current@color`), which means bundled math rendering, not network calls.

`trace_application_feature` was then seeded with the message literals `RECORD_STEP` and `RECORD_ARM` across `record.js` + `background.js`. It returned **no match**, and REA states that this "is not evidence that the feature is absent". REA's application graph models Electron IPC channels, not `chrome.runtime` message literals. The flow below was therefore read from the source.

**Recorder (`record.js`, runs on every page and stays dormant until armed).** It bundles **rrweb**, the open-source session-recording library. The data-URL worker is consistent with rrweb's inlined canvas worker.

Messages:

| Direction | Message | Meaning |
|---|---|---|
| page → background | `RECORD_QUERY` | Sent on load: "am I armed?" |
| background → page | `RECORD_ARM` / `RECORD_DISARM` | Start or stop recording on this page |
| page → background | `RECORD_STEP {payload}` | One semantic step |
| page → background | `RECORD_RRWEB {ts, events}` | rrweb event batch, sent at 50 events or after 2 s |
| page → background | `SIGNIFICANT_CHANGE {reason, url}` | URL change, or a dialog/modal appeared (350 ms debounce, 1.2 s throttle) |

Semantic steps are `click`, `input` and `key` (Enter/Tab only). Each carries:
- a CSS selector, label, element text, role and accessible name;
- whitelisted attributes (`id`, `name`, `type`, `role`, `href`, `aria-*`, `title`, `placeholder`, `alt`, `value`, `data-testid`);
- the URL, plus click coordinates and scroll offsets for clicks.

Privacy details:
- **Password fields are recorded as empty strings.**
- rrweb runs with `maskAllInputs: false` (rrweb still masks password inputs by default), `recordCanvas: false` and `collectFonts: false`.
- While recording, the page's favicon is swapped for a red-dot "recording" icon.

**Background side.** While a session's status is `recording`:
- each step is appended to the session with a screenshot of the tab;
- rrweb chunks are stored per tab;
- a "reaction" screenshot (`<stepId>:react`) is captured after each significant change.

When recording stops, a draft Skill is built:
- `name`: the first step label, up to 40 characters;
- `sourceUrl`: the first navigation;
- `prompt`: the numbered step descriptions;
- `inputs` / `inputValues`: parameterised fields.

The draft enters status `distilling`, an LLM fills in step descriptions, inputs and notes, and the Skill becomes `ready`. A failure leaves it at `distill_failed`.

## What the launch video shows

| Time | Scene |
|---|---|
| 0:02–0:06 | Title cards: "Any Web Task", "Fetch Enterprise Data — Let Kimi Take Over" |
| 0:10 | "Add to Chrome" on the Web Store; a side panel showing *Recording: Daily paper research → 1. Open arXiv.org e-Print archive* |
| 0:14 | The agent browsing the Moonshot AI careers page |
| 0:18 | Side panel: "Hi, what can I do for you?", quick actions (Summarize this page, arXiv paper survey, Build a Google Forms survey), input hint "press @ for tabs, or / for skills", a **Requires approval** mode switch |
| 0:22 | "Generate Reusable Skills": `/web-skill-creator Make a skill for this page so you can fill it out using my resume and cover letter next time.` |
| 0:26 | Skill **Moonshot Application** created (details below) |
| 0:30 | Agent trace (List tabs → Page structure interactive=true → Run script …) halted by a **per-site permission prompt**: "Kimi wants to interact with https://careers.kimi.ai/ — This site isn't in your authorized list — run scripts on the page — Deny / Just once / Allow and remember" |
| 0:34 | Running the skill (details below) |
| 0:38 | Kimi end card |

At 0:26, the "Moonshot Application" Skill is described this way: "the recipe fills everything from your resume/request and returns a per-field ok/FAILED report". Resume and cover-letter files go through a separate upload tool because "scripts can't set file inputs". The quick actions on screen are *Turn a site into a skill*, *Record actions as a skill*, *Save this session as a skill* and *Compact context*.

At 0:34, the skill fills the application form, with Chrome's "'Kimi' started debugging this browser" banner visible. Before ticking the consent checkbox it asks the user explicitly. It fills fields visibly one at a time with a progress badge, and it does not press Submit.

## Telemetry

Side-panel events named `webbridge_sidepanel_*` are emitted: login attempts, upgrade clicks, quick actions, chat-id reports and user feedback text. The CSP allows `gator.volces.com`, which looks like an analytics endpoint. This analysis did not confirm which events go there.

## How GiwiBridge maps to this

| Kimi WebBridge | GiwiBridge |
|---|---|
| Separate daemon (Kimi Work / agent installer) on port 10086, shared by all agents | The first chat's MCP server hosts the connection on port 10087, and other chats relay through it (`/agent`). If the host chat exits, another takes over. The different port means both can be installed at once |
| Per-session tab groups (`_session`) | Per-chat "current tab" via `_session`, all in one "Giwi" group |
| hello / ping / tool_call / tool_result envelope, close code 4409 | Same envelope and close code |
| Alarm-based reconnect, keepalive pings | Same approach (3 s retry while awake, 30 s alarm, 20 s keepalive) |
| `chrome.debugger` + CDP 1.3, focus emulation, dialog racing | Same techniques |
| AX-tree snapshot with `eN` refs | Same idea, using refs mapped to `backendDOMNodeId` |
| Background tabs in per-session groups | Background tabs in a single "Giwi" group |
| Side-panel chat, cloud gateway, telemetry | None: local only |
| 31 tools | 18 tools covering navigation, reading, input, dialogs and tabs |
| No origin check found in the extension (the daemon is closed source) | Bridge rejects non-extension `Origin` and non-localhost `Host` |

## Not implemented yet (ideas, most valuable first)

1. **Per-site approval** before the agent acts on a new site (Deny / Just once / Allow and remember), as shown at 0:30 of the video. GiwiBridge currently trusts the agent on every site.
2. **Pairing**: Kimi pairs the extension with its daemon through `POST /api/connections`. GiwiBridge only checks that the WebSocket `Origin` is an extension origin. A one-time pairing token, shown by the bridge and entered in the extension, would also shut out other installed extensions.
3. **File upload** through `DOM.setFileInputFiles`. Page scripts cannot set file inputs, so the video's job-application skill depends on this.
4. **Skills**: record with rrweb plus semantic steps, distil into a parameterised recipe, and replay with a per-field ok/FAILED report. Also "turn a site into a skill".
5. Save as PDF (`Page.printToPDF`), a raw `cdp` passthrough, drag-and-drop, highlight/inspect region.
6. Per-session tab groups and a visible agent cursor.
7. iframe support for snapshots and selectors.
