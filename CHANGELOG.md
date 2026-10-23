# Changelog

所有重要變更都記在這裡。版本遵循 [Semantic Versioning](https://semver.org/)，格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)。

## [1.4.1] - 2026-10-23

### Fixed

- macOS 選單列圖示改為 PNG template image（`assets/trayTemplate.png`／`@2x`）：原本把 SVG 交給 `nativeImage.createFromBuffer` 會得到 0×0 空圖，托盤在 macOS 上是不可見的。Windows/Linux 改用 `assets/tray.png`。
- 補上 `engines.node >= 22.12.0`、`.nvmrc`（24）與 README 建置說明。electron-builder 26 在 Node 20.18 會因 `@noble/hashes` 的 ESM `require` 失敗。
- macOS 產物檔名固定加入架構（`artifactName` 含 `${arch}`），避免 x64 與 arm64 的 `.dmg`／`.zip` 在 Release 目錄互相覆蓋。

### Changed

- GitHub Actions 改為 Node 24；macOS 以原生 runner 建置 x64（`macos-15-intel`）與 arm64（`macos-15`），並在 `v*` tag 時由單一 release job 上傳 `.dmg`／`.zip`／`.exe`。
- CI 明確設定 `CSC_IDENTITY_AUTO_DISCOVERY=false`，沒有 Developer ID 也能完成未簽名 macOS 打包。

### Added

- `assets/` 托盤圖示，以及 GitHub Actions 的 macOS x64/arm64 Artifacts。

## [1.4.0] - 2026-10-23

### Added

- 透視跑動引擎：底部快捷列新增 `🏃` 按鈕（`#btn-pet-perspective`），以 Z 軸深度做進出場動畫——遠方微小尺寸奔跑進場、視窗外散步、深處折返、湊近螢幕。
- 條碼新增專屬奔跑姿態 `renderer/models/cat2d/cat_run_*`：有跑動姿態時走 **Mode B**（專屬跑姿），其餘角色走 **Mode A**（骨骼步態＋深度縮放）。

### Fixed

- 眼神跟隨不再破圖：`renderer/rig2d.js` 把 UV 位移限制在虹膜半徑內，避免黑色眼線被拖進眼球或向下看時 UV 空間折疊；閉眼貼圖也重製為帶毛紋版本。
- 跑動與睡眠混合不再把眨眼權重直接壓死；`main.js` 加上 `disable-domain-blocking-for-3d-apis` 與 `ignore-gpu-blocklist`，改善部分 GPU 環境的 WebGL 渲染。

## [1.3.0] - 2026-10-23

### Added

- 為「條碼（`cat2d`）」新增兩款 3/4 立體側臉輪廓的動態骨骼新姿態（底部姿態按鈕新增 `🥊` 與 `🙌` 階段）：
  - **側躺玩拳頭（`side` / `cat_side_*`）**：身體舒適側臥，雙前掌捲成小拳頭靠在臉頰與眼角旁輕柔揉動（`aPawL` / `aPawR` 前肢旋轉權重）。
  - **仰天躺手手高舉（`belly` / `cat_belly_*`）**：翻肚露出暖棕斑點肚皮，雙手高舉過頭呈「萬歲／投降睡姿」並隨呼吸輕微伸展晃動，頭呈 3/4 立體側臉輪廓。
- `renderer/rig2d.js` 新增自主眼神三態循環與滑鼠凝視追蹤：
  - 待機時眼神自動在「直視鏡頭」、「看向遠方他處」與「閉眼小憩」間平滑切換；滑鼠靠近時自動睜眼並跟隨游標。
- `renderer/rig2d.js` 新增 `head.xRange` 水平隔離遮罩，確保仰天躺與側躺轉頭時不牽動高舉的雙手或橫臥的背部。
- `tools/make_closed.py` 支援依雙眼連線角度自動旋轉閉眼弧線，並防止 3/4 側臉邊緣眼角去背補色黑邊。

## [1.2.1] - 2026-10-23

### Fixed

- 修正切換寵物或切換姿態時出現全身「果凍式劇烈抖動／拉伸」的四大根因：
  1. **呼吸與搖尾相位倒轉（主要根因）**：`renderer/rig2d.js` 原本以累積總時間 `t` 直接除以動態呼吸週期 `breathPeriod = 3.2 + sb * 2.0` 及乘以動態搖尾頻率 `t * (1.15 - sb * 0.5)`，當 `sleepBlend (sb)` 在 0.5 秒內於 `0 ↔ 1` 過渡且 `t` 已累積數十至數百秒時，相位瞬間倒退數十個週期（20~30Hz 高頻震動）。改為以每幀 `dt` 增量積分 `this.breathPhase` 與 `this.tailPhase`，頻率改變時相位完全連續。
  2. **換貼圖前容器長寬比提前變形**：`renderer/pet.js` 的 `setPosture()` 原本在非同步載入新貼圖前就切換 `body.posture-rest`（將 `.pet-graphic.rig-mode` 從 `150×198` 改為 `178×184`），導致舊貼圖在 WebGL 畫布上先被橫向拉寬 19% 再換圖。改為待 `rig.load()` 完成後才在同一個同步 tick 內切換 `posture-rest`、`setSleepy(..., true)`、`setViewport()` 與 `stepAndRender(0)`。
  3. **胸腔水平呼吸膨脹中心偏移**：`renderer/rig2d.js` Vertex Shader 原本以脖子 `uNeck.x` 作為胸腔水平膨脹中心，導致側臥／母雞蹲（如 `ami_rest` 頭偏右側）在呼吸時整個背部隨之左右晃動。新增 `uBreathCx` uniform，改以胸腔中心 `breathCx` 對稱膨脹。
  4. **滑鼠懸停／點擊時的 CSS 彈簧縮放**：`renderer/styles.css` 為 `.pet-graphic.rig-mode` 關閉 `cubic-bezier(0.34, 1.56, 0.64, 1)` 的 `scale(1.06)` / `scale(0.95)` 過渡，避免點擊互動或切換時整張 WebGL 畫布產生果凍彈跳。

## [1.2.0] - 2026-10-23

### Added

- 實作寵物「打瞌睡（方案 A）」與「趴下休息（方案 B）」四階段姿態循環（`sit` 坐姿清醒 → `doze` 坐姿打瞌睡 → `rest` 趴下休息 → `sleep` 趴下熟睡）：
  - **方案 A（原地低頭閉眼打瞌睡）**：`renderer/rig2d.js` 新增 `setSleepy()` 與 `sleepBlend` 平滑過渡（閉眼、低頭縮脖、微傾頭、耳朵放鬆下垂、慢速深呼吸與 `💤` 粒子特效）。
  - **方案 B（專屬趴姿休息模型）**：為三隻角色新增趴姿（貓咪母雞蹲／狗狗趴地）貼圖、閉眼貼圖與骨架設定：
    - 條碼：`renderer/models/cat2d/cat_rest_*`
    - 阿咪：`renderer/models/ami2d/ami_rest_*`
    - KK：`renderer/models/kk2d/kk_rest_*`
  - 底部快捷列新增休息切換按鈕（`#btn-pet-rest`：`💤` / `😪` / `🐾` / `🌙`），支援一鍵切換四種姿態，以及待機滿 3 分鐘自動進入打瞌睡／熟睡、互動時自動喚醒。
- `tools/make_tex.py` 支援 `neck.cx` 手動指定脖子水平中心；`renderer/rig2d.js` 支援 `head.xSpan` 眼線以下水平權重遮罩，避免趴姿轉頭或低頭時拉扯到拱起的背部與後腿。

### Fixed

- 修正連續切換角色或姿態時重複建立 `THREE.WebGLRenderer` 導致 Chromium 觸發 WebGL context loss 封鎖（畫面變空白）的問題，改為單一 `PetRig2D` WebGL context 動態替換網格與貼圖。

## [1.1.0] - 2026-10-23

### Added

- 新增兩款 Live2D 風格真實寵物模型：
  - `ami2d`（**阿咪**，橘虎斑貓、粉紅鈴鐺項圈）：`renderer/models/ami2d/`（`ami_rig.json`、`ami_tex.png`、`ami_tex_closed.png`、`ami_meta.json/js`）。
  - `kk2d`（**KK**，台灣黑犬、銀白霜毛嘴吻與淺藍項圈）：`renderer/models/kk2d/`（`kk_rig.json`、`kk_tex.png`、`kk_tex_closed.png`、`kk_meta.json/js`）。
- 支援多款寵物角色快速切換與移除管理：
  - 點擊桌寵視窗底部的名字標籤（`#pet-name-badge`）可一鍵在未隱藏的角色間循環切換，並同步更新預設名字與圖示。
  - 設定面板「寵物外觀」每張角色卡右上角新增 `✕` 移除按鈕（寫入 `localStorage.aurapet_hidden_skins`），並提供「恢復全部角色」按鈕。
- `tools/matte_base.py` 新增 `--solid-interior N` 參數，將輪廓遮罩向內侵蝕 `N` px 並強制內部像素 `alpha = 255`，避免灰白毛色（如黑犬白霜嘴吻）在去背時被誤判為半透明背景。
- 新增 GitHub Actions 遠端自動打包工作流程（`.github/workflows/release.yml`），支援推送 `v*` 標籤或手動觸發（`workflow_dispatch`）自動建置 Windows Portable / NSIS 安裝包並上傳至 GitHub Releases / Artifacts。

### Fixed

- 修正設定面板 `.skin-selector` 在 240×290 視窗下的 CSS Grid 水平溢位問題（`minmax(0, 1fr)` + `min-width: 0`）。

### Verified

- `ami2d` 與 `kk2d` 通過六格動作測試台（idle／左右轉頭／閉眼／飛機耳／搖尾）與主程式切換／移除實測，無 console error。

## [1.0.1] - 2026-10-23

### Changed

- 2D rig 的物種權重移出 `renderer/rig2d.js`，改由 skin meta 的 `rig` 提供：頭部帶狀區、胸腔高斯、耳朵中心／樞軸、尾巴區、眼睛凝視半徑。貓的數值原封不動搬到 `cat_rig.json` 與 `cat_meta.*`，畫面不變。
- 建置設定排除 `tools/**`，Python 產圖工具不進安裝檔。

### Added

- `renderer/models/cat2d/cat_rig.json`：手工 landmark／權重來源，座標為去背原圖像素。
- `tools/`：`matte_base.py`、`grid.py`、`landmarks.py`、`make_tex.py`、`make_closed.py` 與 `requirements.txt`，可用 CLI 為新物種烘焙貼圖與 meta。
- 文件新增「新增物種：art → landmarks → meta」流程與 `meta.rig` 欄位說明。
- 研究 issue [#3](https://github.com/karst10607/mabi/issues/3)：Live2D Cubism 與自製 rig 的取捨、FREE 版限制與授權評估。

### Verified

- `tools/` 重跑產生的貓貼圖、`cat_meta.json/js`、閉眼貼圖與原檔 SHA-256 相同。
- 六格 rig 測試台與改前截圖逐像素比對：僅 2 個像素差 1/255。
- App 切換 `cat2d` 載入正常，無 console error。

## [1.0.0]

- 既有基線版本（套件版號沿用；先前功能未逐項記錄）。
