# Godot transparent-window probe（2026-11-07 驗證）

目的：驗證繞開 Chromium 的 per-damage transparent-window composite 能否消滅
Linux idle CPU 地板（見 `../diagnostics/README.md` 的隔离鏈）。

重跑：下載 Godot 4.7.2 linux binary 到此目錄、`cp ../../renderer/models/cat2d/cat_tex.png .`、
`./Godot_v4.7.2-stable_linux.x86_64 --headless --path . --import`（game mode 不 import 貼圖，
漏這步會量到空場景）、然後 `./probe-godot.sh 14 30`（`EXTRA=--lowproc` 切事件驅動）。
量測前停掉 Electron pet（序列量測紀律）。

## 結果（Vega 8／X11／Cinnamon，240×290 透明置頂視窗，sprite 14/30Hz 更新）

| stack | idle CPU | walk 等效 CPU | RSS |
| --- | --- | --- | --- |
| Electron v1.5.2 | ~36%（GPU 27＋renderer 9） | ~62%（43＋19） | 679 MB |
| Godot Vulkan＋lowproc | **9%** | **10%** | **257 MB** |
| Godot Vulkan 一般模式 | 16% | 17% | 257–309 MB |
| Godot GL Compatibility | **透明壞掉（黑盒）**，不可用 | — | 197 MB |

- 透明只在 **Vulkan（Forward+）** 路徑成功（截圖驗證貓直接坐在桌面上）；
  GL Compatibility 在此 stack 給黑盒，runtime `WINDOW_FLAG_TRANSPARENT_BACKGROUND` 也救不了。
- `OS.low_processor_usage_mode`（內容不變就 sleep）是 Godot 版事件驅動 idle，有效。
- probe 是單 sprite bob，**不含** full skinning rig／步態／DOM 狀態列／chat／tray；
  真實 port 成本會更高，但 composite 結構性差異不變。
- 結論：CPU 地板確認來自 Chromium 透明視窗合成路徑；Godot 繞開後 idle 4x、walk 6x、RAM 2.6x 省。
  Tauri 不解 CPU 地板（同一套 webview composite），只贏 RAM／安裝包。
