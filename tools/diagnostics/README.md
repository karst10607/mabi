# 效能／閃爍量測工具

這輪改動（閒置影格預算、`preserveDrawingBuffer`、隱藏時停畫）就是靠這幾個腳本量出來的。
全部走 Chrome DevTools Protocol，需要以 `--remote-debugging-port` 啟動：

```sh
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \
  --remote-debugging-port=9223 --log-level=3
WS=$(curl -s http://127.0.0.1:9223/json | grep -o 'ws://[^"]*' | head -1)
```

`--log-level=3` 只是為了讓 `Intel/Haswell` 那條 `eglQueryDeviceAttribEXT: Bad attribute`
（約每秒 28 行）不要淹沒 stdout；它不影響被量的東西。

| 檔 | 做什麼 |
| --- | --- |
| `eval.mjs` | 對 pet 的 renderer 求值一個運算式並印 JSON。用 Node 24（全域 `WebSocket`） |
| `shot.mjs` | `Page.captureScreenshot` 存檔。截的是渲染端畫面，不是螢幕 |
| `cpu.sh` | 每個 pet 程序與 WindowServer 的中位數 CPU% |

## 畫了幾幀

`renderer.info.render.calls` 每次 render 都會歸零，永遠讀到 1，不能當計數器；要自己包：

```js
const rr = window.rig2d.renderer, oo = rr.render.bind(rr);
window.__draws = 0; rr.render = (...a) => { window.__draws++; return oo(...a); };
```

間隔 3 秒讀兩次即可得到「次/秒」。閒置實測：改動前 27–30，改動後 10–14。

## 快檔／慢檔怎麼分配

`rig2d.needsFastFrame()` 包一層計數，再讀每個還在動的量，可以看出是誰在拖著 30fps：

```js
const g = window.rig2d, nf = g.needsFastFrame.bind(g);
window.__p = { fast: 0, slow: 0 };
g.needsFastFrame = () => { const v = nf(); v ? window.__p.fast++ : window.__p.slow++; return v; };
```

完全不動的閒置約有 1/3 的幀仍是快檔，那來自閉眼／睏眼／耳朵抖動這些本來就要細看的動作。

## 停畫與喚醒

`mainWindow.on('hide')` 在 macOS 的 frameless 透明視窗上不會觸發，所以顯示狀態由
`showPetWindow()`／`hidePetWindow()`／`minimizePetWindow()` 明確送 `window-visibility`。
驗證方式：

```js
window.__vis = []; window.electronAPI.onWindowVisibility(v => window.__vis.push(v));
window.electronAPI.closeApp();     // 之後 __vis 應有 false、rig2d.running 變 false
```

要再叫回來又不動滑鼠，就再開第二個實例觸發 `second-instance`：

```sh
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .   # 拿到單實例鎖失敗即自動離開
```

## 已量過的結論（Intel Iris 5100／macOS 12.7.6／4 邏輯核心）

- 閒置：繪製 27–30 次/秒 → 10–14 次/秒；renderer CPU 7.4/7.7% → 3.9–5.4%。
- `preserveDrawingBuffer: true` 成本為零：GPU helper 11.7–15.2% → 11.8–15.2%。
- `ignore-gpu-blocklist` **不能拿掉**：拿掉後 GPU helper 從約 13% 升到約 20%，
  而 WebGL 仍是同一張 `ANGLE (Intel Inc., Intel Iris OpenGL Engine, OpenGL 4.1)`。
- `--log-level=3` 對 CPU 沒有可辨識的差異（只是消掉 log 噪音）。
- 閃爍不是 renderer 造成的：兩段各 90 秒、4Hz 的 `shot.mjs` 迴圈（714 幀）沒有壞幀。
- 帶 `--remote-debugging-port` 時 GPU helper 會飆到 150–200%，那是 CDP 的代價，
  量 CPU 請改用 `npm start`，量畫面才用 CDP。

## Linux 實測（2026-11-07，Vega 8／Linux Mint／X11／ANGLE OpenGL 4.6 radeonsi）

方法：`bench-ab.sh`（idle 10s、walk 20s，/proc utime+stime 差分，**序列**跑避免互相污染）。
walk 靠 main.js 暫存 env hook（`AURAPET_BENCH=walk` 連續漫遊、直接設 `roamEnabled` 不寫設定檔）
觸發，腳本結束還原。量 CPU 不帶 CDP（代價見上）。變體：V1 `antialias:false`、V2 pixelRatio
cap 1、V3 `preserveDrawingBuffer:false`、V4 `IDLE_FRAME_MS 200`、V5 CSS 動畫 `steps(28)`、
V6 CSS 動畫 none、V9 量化 idle skip＋idle burst 20fps（patch 存 `v9-idle-skip.patch`）。

| 變體 | idle GPU／renderer | walk GPU／renderer |
| --- | --- | --- |
| V0 baseline | 27%／9% | 43%／19% |
| V1 | 28%／10% | 41%／18% |
| V2 | 30%／12% | 40%／17% |
| V3 | 30%／11% | 40%／18% |
| V4 | 28%／9% | 40%／18% |
| V5 | 30%／10% | 40%／18% |
| V6 | 28%／9% | 42%／20% |
| V9 | 24%／8% | 40%／17% |

**全在 ±3pp 噪聲內，無贏家**（dpr=1，V2 在此為 no-op；HiDPI 才有意義）。

隔离鏈（找出成本在哪）：

- `probe.py`：idle 實際繪製率 14/s（fast 7.7＋slow 6.3），與 Mac 優化後同級；
  `needsFastFrame` 沒有卡死。
- park（停繪、視窗可見、DOM 計時器活著）＝0%；hide＝0% → 成本完全隨內容走。
- V7 強制 1fps＝0%；**V8 canvas `display:none` 但照 14fps 繪製＝0%** → GL draw 本身免費，
  成本在「每次 canvas damage 觸發的透明視窗 composite」，約 19ms CPU／次（27% ÷ 14/s）。
- WebGL renderer 字串確認硬體：`ANGLE (AMD, Vega 8, radeonsi raven ACO, OpenGL 4.6)`，
  非 SwiftShader／llvmpipe。
- `flicker.py` 30s 120 幀 blanks=0、median 非透明率 0.285（工具驗證＋V0 空白幀 baseline）。

結論：此 X11＋ANGLE stack 上 alpha WebGL canvas 的 per-damage composite 是 idle 地板；
renderer flags 與 idle 幀預算都動不了它。再降要嘛犧牲 ambient 生動感換 damage rate（產品決策），
要嘛繞開 Chromium composite（native／Godot）；Tauri 不解（同一套 Chromium composite）。
v1.5.2 的硬體加速修正仍是最大贏（342% → 這個地板）。

新工具：`bench-ab.sh`（Linux A/B）、`flicker.py`／`probe.py`（純標準庫 WebSocket client，
Node 18 無全域 WebSocket、環境無 ws 模組時的替代）、`flicker-ab.sh`（V0／V3／WIN 閃爍 A/B）。
