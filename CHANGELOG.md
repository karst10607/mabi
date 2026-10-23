# Changelog

所有重要變更都記在這裡。版本遵循 [Semantic Versioning](https://semver.org/)，格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)。

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
