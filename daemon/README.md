# daemon/ — brain modules

Headless-side modules being carved out of the Electron app (Epic #7, issue #9).
In this phase they still run **inside the Electron main process / renderer**;
the WS bridge (#10) and the Godot body (#11) land later.

## Modules

| Module | Runtime | Responsibility |
| --- | --- | --- |
| `config-store.js` | Node only | Single writer for `app-settings.json`: atomic write (tmp + rename + fsync), `0600` mode, one-time `.bak` of the pre-migration file. Same flat schema as v1.5.2 plus `schemaVersion`. Also stores the bridge `bridgeToken` (0600). |
| `bridge-server.js` | Node only (`ws`) | Body↔daemon WS server, protocol v1 subset: hello/token, state.sync, mode, window, roam, interaction/react, ui.busy, ping. Owns brain state (mode, roam schedule) and validates the loopback token. |
| `ui-server.js` | Node only | Serves the existing renderer DOM as an on-demand localhost page (bridge token required, cookie/query), reusing `renderer/` and injecting the config snapshot for the browser shim. |
| `mcp-server.js` | Node only | MCP server face: standard Streamable HTTP JSON-RPC on `127.0.0.1` (default `47822/mcp`) with bearer token, Origin/Host allowlist and session tracking. Tools translate to brain state / WS (`pet.say`, `pet.mood.get`, `pet.ask`＋`pet.ask.result`, `notes.search`). |
| `mcp-client.js` | Node only (`@modelcontextprotocol/sdk`) | MCP client face (issue #13): connects upstream note MCP servers over Streamable HTTP or stdio, namespaces tools as `<server>.<tool>`, reconnects with 1s→30s backoff, feeds `notes.search`, and redacts tokens from status/logs. |
| `standalone.js` | Node only | Headless entry for the packaged app (issue #15): config store + bridge + UI + MCP, no Electron. Bundled by esbuild and injected into the Node binary as a SEA single file. |
| `pet-state.js` | UMD (Node + browser) | Pure pet-state rules: affection/energy clamps, 10-point energy floor, posture order, pat/feed/play wake-up, idle → doze/sleep drift. No DOM, no storage, no timers. |
| `ai-service.js` | UMD (Node + browser) | AI provider clients (builtin/openai/gemini/claude/ollama/custom). Config is read through an injected adapter (`get(key)` / `set(key, value)`), never through a global directly. |

## Dependency graph

```
main.js ──────────────► daemon/config-store.js   (file I/O only)
   │                  └► daemon/bridge-server.js  ── ws ──┐
   │  (window executor: window.apply / roam.command)       │
   ▼                                                       │
preload.js ◄──── IPC ────┘          WebSocket (127.0.0.1:47821)
   │                                                       │
renderer/index.html                                        │
   ├─► daemon/pet-state.js ◄── renderer/pet.js            │
   ├─► daemon/ai-service.js ◄── renderer/app.js            │
   └─► renderer/app.js ── window.electronAPI ──► preload ──┘
```

The body is split across two Electron processes in this phase: the **preload
shim** owns the WebSocket and protocol translation, while the **main process**
owns the actual window (resize/minimize/close/click-through/roam motion) and
reports `window.state` / `roam.state` back through the shim. The renderer page
keeps using `window.electronAPI` and never sees the protocol.

`daemon/` modules must not `require` Electron — that is what lets them move
into a headless daemon unchanged. Only `config-store.js` touches Node built-ins;
`pet-state.js` and `ai-service.js` are environment-neutral.

## Storage adapters

`ai-service.js` takes an optional store in its constructor:

```js
const { createConfigStore } = require('./config-store');

const store = createConfigStore({ dir: userDataDir });
const ai = new AIService({
  store: {
    get: (key) => store.get(`ai.${key}`),
    set: (key, value) => store.patch({ [`ai.${key}`]: value })
  }
});
```

The renderer currently passes a localStorage adapter (default when
`localStorage` exists), which keeps v1.5.2 behaviour byte-for-byte. Issue #12
moves chat/settings to a daemon-served page and swaps in the file-backed
adapter with a one-time localStorage migration.

## UI face (issue #12)

`ui-server.js` binds `127.0.0.1:47830` (config `uiPort`), requires the bridge
token on `/` (`?token=…` → HttpOnly cookie) and serves the existing renderer
DOM plus `ui/ui-bridge.js`. The page is a `ui` WS client: chat streaming and
settings go through `chat.send` / `chat.delta` / `chat.done` / `chat.error` /
`chat.abort` and `settings.get` / `settings.set` / `settings.changed`.
`AIService` runs in the daemon with the file-backed config store; the browser
only renders. Closing the page removes its WS and renderer.

## MCP server face (issue #14)

`mcp-server.js` exposes the pet to local MCP clients (Qoder, MCP Inspector, ...)
over the standard **Streamable HTTP** transport — JSON-RPC 2.0 POSTs, no
private WS and no MCP details visible to the body.

- Endpoint: `http://127.0.0.1:47822/mcp` (config `mcpPort`).
- Auth: `Authorization: Bearer <mcpToken>`; the token is generated once into
  the 0600 config file. Missing/wrong token → HTTP 401, non-loopback
  `Origin`/`Host` → HTTP 403. Loopback web origins get CORS headers.
- Sessions: `Mcp-Session-Id` is issued on `initialize`; unknown ids → 404,
  `DELETE` terminates one, `GET` (no server-initiated SSE) → 405.
- Capabilities declare only `tools` (`listChanged: false`).

| tool | behaviour |
| --- | --- |
| `pet.say` | translates to the `say` WS event; returns `delivered=false` (tool error) when the body is offline |
| `pet.mood.get` | brain snapshot: mode/posture/skin/nickname/roam/visibility/bodyConnected |
| `pet.ask` | starts the AI answer in the background and returns `{ticket, state:"pending"}` immediately (no 60s tool timeout) |
| `pet.ask.result` | polls a ticket: `pending` / `done` (with `answer`) / `error` |
| `notes.search` | aggregates upstream note MCP servers configured in `mcpUpstreams` through `mcp-client.js` (Streamable HTTP or stdio), bounded to ≤4.5s total |

`notes.search` has no upstreams by default and says so explicitly. Its
aggregation runs through the MCP client face, so it works with any compliant
notes server; the UI only reads `mcp.servers.get` / `mcp.status` /
`mcp.server.status`.

`tools/mcp/smoke-test.mjs` drives the whole face against a stub body, stub UI,
stub Streamable HTTP upstream and stub stdio upstream (no external services):

```bash
node tools/mcp/smoke-test.mjs
```

## MCP client face (issue #13)

`mcp-client.js` is the daemon's MCP **client**. `mcpUpstreams` (0600 config)
lists servers:

```jsonc
{
  "mcpUpstreams": [
    // Joplin built-in endpoint: token must go in the query string
    { "name": "joplin", "transport": "streamable-http",
      "url": "http://127.0.0.1:41184/mcp", "token": "<api.token>", "tokenIn": "query" },
    // any stdio MCP server
    { "name": "obsidian", "transport": "stdio",
      "command": "npx", "args": ["-y", "mcp-obsidian"], "env": { "OBSIDIAN_API_KEY": "<key>" } },
    // Jira stdio MCP server (issue #32)
    { "name": "jira", "transport": "stdio",
      "command": "npx", "args": ["-y", "@modelcontextprotocol/server-jira"],
      "env": {
        "JIRA_URL": "https://your-domain.atlassian.net",
        "JIRA_EMAIL": "your-email@example.com",
        "JIRA_API_TOKEN": "<api-token>"
      }
    }
  ]
}
```

- Namespacing: upstream `search_notes` on `joplin` becomes `joplin.search_notes`.
- Capabilities: client declares only `tools`; sampling/roots are not forwarded.
- Lifecycle: exponential backoff 1s→30s, `reload()` diffs config, stdio child
  processes are closed on `stop()`; states are `configured`/`connecting`/
  `ready`/`error`/`stopped`.
- Secrets: tokens live only in the 0600 config; `mcp.status`,
  `mcp.servers.get`, `settings.get`, `settings.changed` and logs carry
  `auth: "configured"` (or `envKeys`) instead. `upstream-smoke.mjs` asserts this:

```bash
node tools/mcp/upstream-smoke.mjs --from-joplin
```

## Config file

`<userData>/app-settings.json` — the platform default matches Electron v1.5.2
(`Linux ~/.config`, `macOS ~/Library/Application Support`, `Windows %APPDATA%`,
each under `aurapet-desktop/`; `AURAPET_CONFIG_DIR` overrides). For example:

```json
{
  "petPosition": { "x": 3105, "y": 652 },
  "roamEnabled": true,
  "schemaVersion": 1,
  "bridgeToken": "<64 hex chars>"
}
```

On the first write after upgrade the previous file is copied to
`app-settings.json.bak` before the atomic replace. Unknown keys are preserved.
