# Changelog

所有重要變更都記在這裡。版本遵循 [Semantic Versioning](https://semver.org/)，格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)。

## [1.5.0] - 2026-10-24

### Changed

- **「跑過來」改成四腳慢步**：`renderer/rig2d.js` 的步態從「彈跳＋前後腳兩段」換成真正的四足步態——每隻腳有自己的肩／髖關節（`uLegPivot[4]`、`uLegAngle`、`uLegLift`），依 4-beat lateral sequence 以相位 `[0.25, 0.75, 0, 0.5]`、著地率 68% 輪流舉步，任何時刻至少三隻腳踩地。身體不再隨步伐上下擺（移除 `runHeadBob` 與 `angleZ` 的彈跳項），`pet.js` 的 `applyPerspectiveTransform()` 也拿掉 `hopLift`／`squash`／`lean`。
- **條碼、阿咪、kk狗都補了站姿Walking素材**：新增 `renderer/models/ami2d/ami_walk_*` 與 `renderer/models/kk2d/kk_walk_*`（原只有條碼有 `cat_walk_*`）。三張的 `rig.legs` 各 4 條、`rig.gait` 決定擺幅與舉腳高度，`rig2d.js` 內不含任何物種專屬常數。
- **螢幕邊緣漫遊從跳躍改成散步**：`main.js` 的 `roamWalk()` 只改變視窗 x（全程保持水平），速度 78 px/s、採梯形速度曲線（前 15% 加速、中段等速、後 15% 減速）；`renderer/styles.css` 刪除 `roam-takeoff`／`roam-air`／`roam-land` 與對應 keyframes，改為 `body.roam-walk` 只暫停 idle 漂浮。托盤選單項目改名為「到處走 (螢幕邊緣)」。
- 透視進場四段場景改名：`far-run-in` → `far-walk-in`，走位速度降到 38–54 px/s，台詞改為「從遠方慢慢走過來…」。
- **閒置不再空轉**：`rig2d.js` 的動畫迴圈改成自我排程（`schedule()`／`wake()`／`stop()`），rAF 沒辦法跑得比 vsync 還慢，所以兩幀之間的空檔改用 `setTimeout` 等。還有東西在緩動時走 30fps（`ACTIVE_FRAME_MS`），全部到位後降到約 9fps（`IDLE_FRAME_MS`）；耳朵抖動原本是 `sin(t*34)` 取樣，在低幀率會出錯，改成自帶 0.42 秒包絡的獨立計時器。實測繪製次數 27–30 次/秒 → 10–14 次/秒，renderer CPU 7.4/7.7% → 3.9/5.4%（同一行程內交錯 A/B）。
- `pet.js` 的位移迴圈（原本 60fps 永不停止）改成只在真的在走路時執行：`runPerspectiveSequence()` 呼叫 `startLocomotionLoop()`，`isLocomotionSettled()` 判定沒剩路點、沒在移動時自行停下（歸零時把 `L.x`／`L.z` 吸附到 0，否則殘留 0.1–0.4 的偏移會讓它永遠停不下來）。
- 漫遊時的視窗位移從 16ms 放寬到 33ms（`ROAM.tickMs`）：步態是時間基的，30Hz 的視窗移動剛好對應 30fps，也讓透明置頂視窗的每幀 resize 成本減半。

### Added

- `tools/eye_grid.py`：把貼圖的眼睛區域依 `*_meta.json` 的中心點裁出、放大並疊上來源座標網格，用來量 `eyes.rx/ry`。
- `docs/pet-modeling-notes.md` 新增「走路循環（四腳慢步）」章節，並把漫遊章節改寫為散步版。
- `docs/pet-modeling-notes.md` 新增坑 #20：`pip install` 找不到相容 wheel 時會**無訊息退回源碼編譯**——這台 macOS 12 裝 `opencv-python-headless` 拖出 6 個 clang job、load average 180、跑了近一小時。規則改成 `--only-binary=:all:`＋鎖版本＋不加 `--quiet`。

### Fixed

- `*_walk_rig.json` 的 `eyes.rx/ry` 之前填成整顆眼球的半徑，而倉庫慣例是**虹膜**半徑（`tools/make_closed.py` 會再乘 2.85／2.80 當眼瞼遮罩），導致閉眼烘焙把半個額頭糊掉。三張 walk 貼圖已改用真實虹膜半徑重烤。
- 向右漫遊時貓不會鏡像：`setRoamState()` 原本只在 `!walking` 時套用透視變換，`flipX = -1` 永遠進不了 DOM；現在一律套用，`mountRig()` 完成時也補一次。
- 隱藏／最小化後還在繪製：`mainWindow.on('hide')` 在 macOS 的 frameless 透明置頂視窗上不會觸發（實測 `hide()` 生效、`isVisible()` 變 false，但事件不來），所以改由 `showPetWindow()`／`hidePetWindow()`／`minimizePetWindow()` 這三個實際移動視窗的入口送 `window-visibility`，渲染端對應 `rig2d.wake()`／`stop()`；`did-finish-load` 與 `pet-activity` 各留一條自癒路徑，避免漏掉一條顯示路徑讓貓卡在一張靜止的臉。
- 不定時閃爍：`rig2d.js` 的 `WebGLRenderer` 加上 `preserveDrawingBuffer: true`。預設值 `false` 表示畫布交給合成器之後緩衝區就失效，任何兩次繪製之間的合成（`floatPet` 的 CSS 動畫、視窗移動、失去焦點）都可能取到一張空表面，貓就閃一下消失；保留緩衝區後合成器永遠拿得到最後畫好的那一幀。實測成本為零（GPU helper 11.7–15.2% → 11.8–15.2%，同一台機器同一量法）。
- 不定時閃爍（第二項）：視窗一失去焦點就被 Chromium 當成背景而凍結所有 rAF，透明視窗因此停在最後一張（常常是黑的）畫面，改用 `backgroundThrottling: false`。
- 閃爍調查的負結果：`ignore-gpu-blocklist` 曾在 macOS 被關掉測試，結果 GPU helper 從約 13% 升到約 20%（WebGL 仍是同一張 `ANGLE (Intel Inc., Intel Iris OpenGL Engine, OpenGL 4.1)`），所以這個 switch 在 Mac 上是有用的，維持不變。渲染端本身也不是元兇：兩段各 90 秒、4Hz 的 `Page.captureScreenshot`（714 幀）沒有任何空白或壞幀。
- stderr 洪水：`ignore-gpu-blocklist` 會讓 ANGLE 在 Intel/Haswell 上以 **ERROR 等級**每秒約 28 次重記同一條 `eglQueryDeviceAttribEXT: Bad attribute`（舊 log 實測 57 800 行幾乎都是這一句），其實只是探測不支援的 EGL device 屬性，不影響繪製。`main.js` 新增 `app.commandLine.appendSwitch('log-level', '3')` 封住輸出、switch 保留。實測：改前同機 3.6 KB/s（約 13 MB/h），改後 60 秒 stderr **0 bytes**。

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
