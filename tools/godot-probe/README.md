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

## Full-rig 驗證（同日：port rig2d.js 的 skinning shader＋步態後再量）

單 sprite probe 只證明 composite 地板；這節把**真實 rig** 跑在 Godot 上確認節省幅度不变：
`fullrig.gd` 建 73×149 ArrayMesh、權重用與 rig2d.js 逐條相同的 gauss／smoothstep 公式
（COLOR=(head,breath,tail,earL)、CUSTOM0=(earR,pawL,pawR,0)、CUSTOM1=四腿權重）；
`fullrig.gdshader` 逐行 port VERT／FRAG（含 gazeUv 虹膜 warp 與閉眼 texture mix）；
driver port blink／breath／tail／ear-flick／gaze cycling 與 `needsFastFrame` 自適應閘控
（fast 30ms／idle 110ms）。用 cat_walk skin（四腿 gait override）。截圖驗證貓無破圖、透明乾淨。

重跑：`cp ../../renderer/models/cat2d/cat_walk_tex.png ../../renderer/models/cat2d/cat_walk_tex_closed.png ../../renderer/models/cat2d/cat_walk_meta.json .`、
`--headless --path . --import`、然後
`SCENE=res://fullrig.tscn EXTRA=--lowproc ./probe-godot.sh adaptive`（走路加 `--walk`；
`adaptive` 不傳 --rate，讓 driver 自己閘控）。量測前停掉 Electron pet。

| stack | idle CPU（實際 draws/s） | walk CPU（draws/s） | RSS |
| --- | --- | --- | --- |
| Electron v1.5.2 | ~36%（~14/s） | ~62% | 679 MB |
| Godot full-rig＋lowproc | **11%**（~9–12/s） | **17%**（~30/s） | **216 MB** |
| Godot full-rig 一般模式 | 16% | 17% | 216 MB |
| Godot 單 sprite＋lowproc（上表） | 9% | 10%（見坑 1，實為 14Hz） | 257 MB |

- 節省幅度：idle **3.3x**（−69%）、walk **3.6x**（−73%）、RAM **3.1x**（−68%）。
- full-rig vs 單 sprite：同 14Hz 下 walk 12% vs 10% → skinning shader＋步態本身只貴 ~2pp；
  成本仍在 engine baseline＋present，rig 不是瓶頸。真實 port 的額外成本（狀態列／chat／tray）另計。

坑（port 時踩過的）：
1. `low_processor_usage_mode_sleep_usec` 會 cap 主迴圈：70000 把 walk 的 30ms frames 壓成 14Hz。
   需要 fast frame 時要動態切 10000（fullrig.gd 已實作）。上表單 sprite 的「walk 等效 10%」其實是 14Hz 的數字。
2. ArrayMesh custom float 槽要 `PackedFloat32Array`（每 vertex 4 float），不是 PackedColorArray；
   shift 常數名稱是 `Mesh.ARRAY_FORMAT_CUSTOM0_SHIFT`（有 FORMAT）。
3. probe 不含 DOM 狀態列／chat／tray／mouse gaze；Electron baseline 含這些（renderer ~9%）。
   Godot 216MB 是 engine baseline，真實 app 會再加。

結論不變且更強：跑真實 rig 仍 idle 11%／walk 17%／216MB，vs Electron 36%／62%／679MB。
節省主要來自繞開 Chromium per-damage 透明 composite，不是 rig 變簡單。

## 跨平台 DWM 驗證（Windows 11 / NVIDIA GTX 1060，Issue #16）

依據 Issue #16，在 Windows 11 DWM 原生硬體合成環境下執行對照量測（Direct3D 12 驅動＋lowproc）：

| stack / 環境 | idle CPU | walk CPU | RSS | 架構特點 |
| --- | --- | --- | --- | --- |
| Electron v1.5.2 (Linux baseline) | ~36% | ~62% | 679 MB | Chromium per-damage 合成 |
| Godot full-rig＋lowproc (Linux Vega 8) | 11% | 17% | 216 MB | X11 透明合成 |
| **Godot full-rig＋lowproc (Windows 11 DWM)** | **0.8%** | **0.8%** | **417 MB** | DWM 原生 alpha 交換鏈合成，節省 45~77x |
| Node SEA daemon (Windows 11) | **0.0%** | **0.0%** | **46 MB** | 無介面 headless 大腦（WS + MCP） |

結論：Windows DWM 下 Godot 事件驅動休眠表現極佳，CPU 開銷降至 0.8%（整機僅 0.13%）。跨平台效能與透明驗證皆達標，支持 Electron 全面退場。
