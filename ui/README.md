# ui/ — on-demand chat/settings page (issue #12)

The browser page the daemon serves at `http://127.0.0.1:47830/` (override with
the `uiPort` config key). It reuses `renderer/index.html`, `app.js`, `pet.js`,
`rig2d.js`, `styles.css` and `models/` verbatim; `ui-bridge.js` is the only new
piece.

## How it works

- `daemon/ui-server.js` requires the bridge token. Open `/` with
  `?token=…` (set as an HttpOnly cookie) once; static assets then require that
  cookie. Loopback only, no directory listing, `/models/` path traversal is
  rejected.
- The server injects `window.__AURAPET__ = { token, wsPort, uiPort, settings }`
  and loads `ui-bridge.js` where `../daemon/ai-service.js` used to be.
- `ui-bridge.js`:
  - patches `Storage.prototype` so `localStorage` for this origin is an
    in-memory map backed by the daemon config; writes become `settings.set`
    patches (removals use `null`),
  - implements `window.electronAPI` and `AIService` over the bridge WS
    (`chat.send`/`delta`/`done`/`error`/`abort`, `settings.*`, `mode.*`,
    `window.*`, `roam.*`, `ui.busy`, `activity`),
  - reconnects with 1s→30s backoff.
- Tray → 「開啟對話／設定」 opens this URL with the token (`tray_helper.py`,
  or `OS.shell_open` in the Godot native tray on Windows/macOS).

## Settings migration

Electron keeps reading its own `localStorage` unchanged. On the first bridge
handshake after upgrading, `preload.js` copies every `aurapet_*` key (plus
defaults for absent ones) into the daemon config via `settings.set` and sets an
`aurapet_ui_migrated` marker, so the browser page starts with the same values.

## Chat

`chat.send` carries only the newest user text; the daemon keeps per-connection
history and streams the reply back (`chat.delta` carries the accumulated text).
`chat.abort` stops the provider stream and replies `chat.done` with the partial
text. Provider/model changes go through `settings.set`, and the daemon reloads
`daemon/ai-service.js` immediately.

Closing the page closes its WS; there is no resident renderer for the UI
(the Electron pet renderer is unaffected).
