# Changelog

所有重要變更都記在這裡。版本遵循 [Semantic Versioning](https://semver.org/)，格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)。

## [Unreleased]

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
