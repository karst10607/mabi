# godot/ — AuraPet body v0

Production port of the transparent pet window from Electron/Chromium to Godot
4.7.2 (Epic #7, issue #11). The Node daemon remains the brain; this scene owns
the window, rig, tray and movement, and talks to the brain only through
[`docs/ws-protocol.md`](../docs/ws-protocol.md).

Measured on the reference machine (Vega 8 / X11 / Cinnamon, 240×290 window):

| stack | idle CPU | walk CPU | RSS |
| --- | --- | --- | --- |
| Electron v1.5.2 | ~36% | ~62% | 679 MB |
| **Godot body v0** | **11%** | **17%** | **241–242 MB** |

## Layout

| file | role |
| --- | --- |
| `body.gd` | window, tray, click-through, roam, say bubble, WS client |
| `rig_2d.gd` | 73×149 skinning mesh + shader driver (port of `renderer/rig2d.js`) |
| `body.gdshader` | VERT/FRAG port of `renderer/rig2d.js` (copied from the probe) |
| `tray_helper.py` | Linux Ayatana AppIndicator helper (see below) |
| `probe-body.sh` | sequential idle/walk CPU+RSS probe |
| `assets/` | cat2d skin set copied from `renderer/models/cat2d` (packaging #15 should dedupe) |

## Run

```bash
# brain without the Electron window (stop the app first if you want port 47821)
node tools/bridge/dev-brain.mjs --port=47821

# body reads the bridge token from ~/.config/aurapet-desktop/app-settings.json
GODOT_BIN=/path/to/Godot_v4.7.2-stable_linux.x86_64
"$GODOT_BIN" --path godot -- --port=47821 --lowproc
```

Arguments (after `--`): `--config=PATH`, `--token=...`, `--port=N`,
`--lowproc`, `--rate=N`, `--walk`, `--shot=PATH`, `--shot-after=SECONDS`,
`--no-tray`, `--selftest=tray`.

`--shot` writes the viewport PNG (alpha preserved) and exits; it is what the
committed `docs/body-v0-*.png` evidence was captured with.

## Protocol coverage

| message | behaviour |
| --- | --- |
| `hello` / `hello-ack` | token from config, 5s timeout, 1s→30s reconnect |
| `state.sync` | mode/posture/skin/nickname/roam/visibility/clickThrough/alwaysOnTop |
| `mode.set` / `mode.changed` | 240×290 ↔ 460×680, acked |
| `window.apply` / `window.state` | always-on-top, click-through, visibility, x/y |
| `window.minimize` / `window.close` | minimize / graceful quit |
| `roam.command` / `roam.state` | trapezoid walk along the work area row, 78 px/s |
| `pose.set` | sit/doze/rest/sleep/walk (+ side/belly/run artwork) |
| `react` / `say` / `sound.play` | ear flick, speech bubble, clip playback if bundled |
| `interaction` / `activity` | click/drag/tray pat & feed |
| `ping` / `pong` | 15s ping, 45s no-pong reconnect |
| `roam.enabled`, `roam.set-enabled`, `ui.busy` | via brain |

## Tray

Godot 4.7 only implements `DisplayServer` status indicators on Windows and
macOS (`platform/{windows,macos}`: `create_status_indicator`; `linuxbsd/X11`
has none). On Linux the body therefore spawns `tray_helper.py`, an Ayatana
AppIndicator process that connects to the same bridge as a `ui` client. Tray
actions are normal protocol messages (`mode.toggle`, `window.set`,
`roam.set-enabled`, `interaction`, `window.close`); the brain relays them to
the body. Dependencies are already present on Cinnamon:
`python3-gi`, `gir1.2-ayatanaappindicator3-0.1`.

The helper exits when the body process dies (`--parent-pid`).

## Known v0 limitations

- **No global hotkeys**: Godot has no cross-platform global shortcut API.
  Tray items and clicking the pet are the substitute; revisit when the tray /
  input layer moves to the daemon.
- **No TTS or sound assets**: `say` renders a bubble; `speech` is logged only.
  `sound.play` loads `res://assets/<clip>` if a clip is bundled.
- **No chat/settings UI in the body** — issue #12 serves that as a browser page.
  `mode.set chat` only resizes the window for now.
- **HiDPI**: Godot's X11 window is 240×290 device pixels while Electron used
  240×290 DIP (480×580 on Xft.dpi=192). Probe thresholds and comparison use the
  same 240×290 device window as `tools/godot-probe`.
- **`side`/`belly` postures** are accepted by the body for artwork parity but
  are outside the protocol's current `posture` enum (additive change later).
- **`roam.set-enabled` from the tray** is sent by the body/helper although the
  contract lists it as `ui>brain`; the server already accepts it (same
  pragmatic exception as the #10 preload shim). Tighten when tray ownership is
  decided.

## Probe

```bash
GODOT_BIN=/path/to/Godot_v4.7.2-stable_linux.x86_64 ./godot/probe-body.sh
```

Stop the Electron pet first; the script measures the Godot PID only but a
running Electron pet shares the compositor/GPU. Results on the reference
machine: `idle cpu=11% rss=241MB (14.3 draws/s)`,
`walk cpu=17% rss=242MB (32.9 draws/s)`.
