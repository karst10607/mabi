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
