# daemon/ — brain modules

Headless-side modules being carved out of the Electron app (Epic #7, issue #9).
In this phase they still run **inside the Electron main process / renderer**;
the WS bridge (#10) and the Godot body (#11) land later.

## Modules

| Module | Runtime | Responsibility |
| --- | --- | --- |
| `config-store.js` | Node only | Single writer for `app-settings.json`: atomic write (tmp + rename + fsync), `0600` mode, one-time `.bak` of the pre-migration file. Same flat schema as v1.5.2 plus `schemaVersion`. |
| `pet-state.js` | UMD (Node + browser) | Pure pet-state rules: affection/energy clamps, 10-point energy floor, posture order, pat/feed/play wake-up, idle → doze/sleep drift. No DOM, no storage, no timers. |
| `ai-service.js` | UMD (Node + browser) | AI provider clients (builtin/openai/gemini/claude/ollama/custom). Config is read through an injected adapter (`get(key)` / `set(key, value)`), never through a global directly. |

## Dependency graph

```
main.js ──────────────► config-store.js  (file I/O only)
   │
renderer/index.html
   ├─► daemon/pet-state.js ◄── renderer/pet.js      (rendering + persistence stay here)
   ├─► daemon/ai-service.js ◄── renderer/app.js
   └─► renderer/app.js
```

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

## Config file

`<userData>/app-settings.json`, e.g.

```json
{
  "petPosition": { "x": 3105, "y": 652 },
  "roamEnabled": true,
  "schemaVersion": 1
}
```

On the first write after upgrade the previous file is copied to
`app-settings.json.bak` before the atomic replace. Unknown keys are preserved.
