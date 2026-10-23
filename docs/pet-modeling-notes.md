# AuraPet 真實貓咪建模筆記

最後更新：2026-10-23

這份文件記錄把「條碼貓」做成桌面寵物的兩輪嘗試：先做 3D（已封存為分支目標），
目前走 Live2D 風格的 2D。內容分成：路線決定、已修正、已發現、尚未決定、可重現指令。

---

## 1. 路線決定

| 項目 | 決定 |
| --- | --- |
| 主要路線 | **2D，Live2D 風格**：單張貼圖 + 可變形網格 |
| 3D | **保留為分支目標**，不刪除、不進主線 |
| 底圖來源 | AI 生成正面坐姿圖（使用者於 2026-10-23 選擇此方案） |
| 3D 是否續做 | 暫停。形狀可用但無貼圖，質感遠低於預期 |

轉向原因：3D 這一輪的模型形狀「坑坑巴巴像泥土」、沒有貼圖，且
`hy3dpaint` 需要 CUDA Toolkit 才能編譯 `custom_rasterizer`，本機沒有。

---

## 2. 3D 回合（已封存）

### 產出

- `mab/renderer/models/pet.glb`
  - 60,000 面（由原始高模簡化）
  - 1,441,068 bytes
  - 單一 PBR 材質，`baseColorFactor` = `#946136`
- 換算成 sRGB 後量測平均色 `#6a5039`，目標 `#69523c`。

### 流程

1. 參考照片／影片抽格 → 挑出唯一一張乾淨全身照 `v1_t16.7`。
2. `rembg` 去背，得到 `layers/base_rgba.png`。
3. `fixmask.py` / `fixmask2.py` 修掉誤判的木櫃與項圈吊牌，得到
   `candidates/p6_in.png`（3D 建模的正式輸入）。
4. `gen2.py` 跑 `Hunyuan3DDiTFlowMatchingPipeline`（50 steps、octree 384）→ `out/p6.glb`。
5. `proc.py` 簡化 + 上色 + 輸出 GLB。

```bash
hy3d-venv/Scripts/python.exe gen2.py candidates/p6_in.png out/p6.glb
hy3d-venv/Scripts/python.exe proc.py out/p6.glb out/p6_stats.json 60000 mab/renderer/models/pet.glb 946136
```

### 為什麼停在這裡

- **沒有貼圖**：`hy3dpaint` 的 `custom_rasterizer` 需要以 CUDA Toolkit 編譯，本機沒有，
  所以只能用單色材質。
- **形狀品質不足**：照片直接丟 image-to-3D，背面與側面是模型自己「發明」的，
  加上去背殘留，成品有凹陷與黏土感。
- **授權**：Hunyuan3D-2.1 為騰訊非商業授權。把 `pet.glb` 推上**公開** repo
  等同再散布模型輸出，有授權風險。

### 若之後要續做 3D（分支）

1. 先對照片做乾淨去背，再建模（這一輪是去背後仍帶雜物，靠人工補救）。
2. 補 CUDA Toolkit → 編譯 `custom_rasterizer` → 才有貼圖。
3. 多角度照片或影片，不要只靠單張正面照。
4. 分支建議名稱：`feat/3d-model`；GLB 是否進版控需先確認授權。

---

## 3. 2D 回合（現行）

### 架構：一張貼圖、一個網格

Live2D 的做法不是把貓切成很多圖層，而是**一張圖 + 可變形網格**：
頂點在 CPU 端先算好權重，頂點著色器依參數推移頂點，片段著色器只處理眼睛。
這樣沒有圖層接縫，也不需要補畫被遮住的區域。

| 檔案 | 作用 |
| --- | --- |
| `mab/renderer/models/cat2d/cat_tex.png` | 主貼圖 618×1270 RGBA |
| `mab/renderer/models/cat2d/cat_tex_closed.png` | 閉眼版貼圖（只改眼睛區域） |
| `mab/renderer/models/cat2d/cat_meta.json` | 五官／脖子／耳尖／尾巴座標 |
| `mab/renderer/models/cat2d/cat_meta.js` | 同上，改成 ES module（`file://` 不能用 fetch） |
| `mab/renderer/rig2d.js` | `PetRig2D`：網格、權重、著色器、眨眼、30 fps 節流 |
| `rigtest/` | 六格測試台（idle／左右轉頭／閉眼／耳朵後貼／甩尾） |

貼圖取樣：`NoColorSpace`（保持原色）、`LinearMipmapLinearFilter`（縮小顯示不閃爍）、
`anisotropy = 4`。不開 mipmap 時鬍鬚會斷成點。

### 網格與權重

- 網格 72×148，座標是貼圖像素空間，**y 軸翻轉**成世界座標（y 向上）。
- 權重全部在 `load()` 內用 CPU 算好並寫進 attribute：

| 權重 | 算法 | 用途 |
| --- | --- | --- |
| `aHead` | 以脖子為界的 smoothstep | 頭部剛體旋轉／位移 |
| `aBody` | 下半身 smoothstep | 呼吸起伏 |
| `aTail` | 左下角 smoothstep | 尾巴擺動 |
| `aEarL/R` | 以耳尖與耳根中點為中心的高斯（σx 70、σy 95） | 耳朵繞耳根旋轉 |

- 耳朵是**繞耳根旋轉**，不是整體平移。早期用平移會把整個額頭一起拉走。
- 頭部變換在耳朵之後執行，所以轉頭時耳朵會跟著頭走。

### 眼睛

- 眨眼不用幾何變形：`uEyeOpen` 在兩張貼圖之間做 `mix()`，閉眼時整塊換成
  `cat_tex_closed.png`。
- 凝視（`uGaze`）只在眼睛周圍的橢圓遮罩內偏移取樣座標。
- 早期用「把取樣座標往外擴」模擬閉眼，失敗：瞳孔在正中心，往外擴時中心不動，
  結果眼睛反而變大、虹膜被拉花。已移除。

### 待機動作

三個正弦（呼吸／擺頭／甩尾）疊加，參數在 `rig2d.js` 的 `tick()`：

| 參數 | 振幅 | 備註 |
| --- | --- | --- |
| `uBreath` | 14 px | 身體縱向起伏，`aBody` 權重 |
| `uHeadShift` | 14 / 9 px | 水平跟隨 `sway`，垂直加 `headBob` |
| `uTailSway` | 34 px | 尾巴左右甩，`aTail` 權重 |
| 耳朵抖動 | 0.16 rad | 機率觸發，約每 3 秒 |

- 驗證方式不能只看程式：關掉 `.pet-avatar-wrapper` 的 CSS `floatPet` 動畫後，
  間隔 1.2 秒截 4 張圖比對。振幅過大時整隻貓會看起來在「平移」而不是呼吸，
  判準是腳與身體底緣不跟著頭一起位移。

### 閉眼貼圖怎麼來的

`make_closed.py`：把兩眼的虹膜連同眼眶遮掉（`cv2.inpaint`），再畫一條微微下彎的眼線。

- 遮罩必須大於整個眼睛，不能只框綠色虹膜。實測眼睛約 66×60 px，
  虹膜只有 30×30，若照虹膜大小去遮，inpaint 會把綠色從邊界補回眼睛裡。
- 目前用固定橢圓（`rx*2.6`, `ry*2.6`）蓋掉整顆眼。

```bash
hy3d-venv/Scripts/python.exe make_closed.py
```

### App 整合

- 新 skin：`cat2d`（設定 → 寵物外觀 → 「真實虎斑貓」）。
- `index.html` 加了 import map，讓 `rig2d.js` 在 `file://` 下能解析 `import 'three'`。
- `pet.js` 動態 `import('./rig2d.js')`，`mountRig()` / `disposeRig()` 成對呼叫，
  切換 skin 時會銷毀 WebGL context 與 canvas。
- 互動：摸摸 → 脈動 + 眨眼；餵食 → 點頭；玩 → 甩尾。

---

## 4. 已修正的問題

1. **整個 renderer 掛掉（真正造成「透明寵物」的原因）**
   `pet.js` 的 `renderSkin()` 裡，slime skin 被寫成裸 `else { ... }`，
   後面的 `custom_photo` 與新分支變成 `} else if` → 語法錯誤，
   `PetEngine is not defined`，整隻寵物不會出現。
   改成 `else if (this.skin === 'slime')`。
   注意：這與 3D 無關，是原本就存在的 bug。

2. **2D 測試台一片空白**
   網格在 y-down 的貼圖座標（0…1270），相機卻設成 `top=0, bottom=-vh`，
   可視範圍是負 y；再加上 `zoom = 1/s` 反而把視野縮到 71×71 px，
   而且相機沒有對準貼圖中心。
   修法：頂點 y 取負號、相機置中於 `(W/2, -H/2)`、`zoom = s`（不是 1/s）。

3. **三角形背面剔除**
   y 翻轉後繞序要維持正面；目前 `a, c, b` 的索引順序在翻轉後剛好是正面。

4. **閉眼遮罩太小**
   只遮虹膜 → inpaint 從邊界把綠色補回去，眼睛看起來沒閉。
   改成覆蓋整顆眼睛（含眼眶）的橢圓。

5. **耳朵平移把額頭拉歪**
   改成繞耳根旋轉，並把高斯從 σ 165 縮到 σy 95、σx 70。

6. **顏色偏暗／偏藍**
   自訂 `ShaderMaterial` 不會自動做輸出色彩空間轉換，貼圖若標成 sRGB 會被解碼成
   線性值卻直接寫進 framebuffer。
   2D 精靈要的是「像素原色」：兩張貼圖都設 `THREE.NoColorSpace`，所見即原圖。

7. **`fetch()` 在 `file://` 失效**
   `cat_meta` 改成 `cat_meta.js`（ES module export default），`load(texUrl, meta, closedUrl)`。

8. **Electron 啟動環境**
   Qoder 的 shell 繼承 `ELECTRON_RUN_AS_NODE=1`，Electron 會用 Node 模式啟動
   （表現為 `bad option: --remote-debugging-port`）。
   一定要 `env -u ELECTRON_RUN_AS_NODE` 再啟動。

9. **截圖卡住**
   `Page.captureScreenshot` 在 `document.visibilityState === 'hidden'` 時永遠不返回。
   啟動時加 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
   --disable-background-timer-throttling`。

10. **一直跳「Unable to find Electron app at ... orient-viewer」**
    `orient-viewer` 原本沒有 `package.json`；補上之後就不會再被當成壞掉的 app。

11. **鬍鬚變成一顆顆灰點**
    貼圖 618×1270 縮到約 96×198 顯示，1 px 寬的鬍鬚在縮小取樣時被跳過，
    只剩零星像素。原本 `minFilter = LinearFilter`、不建 mipmap。
    改成 `LinearMipmapLinearFilter` + `generateMipmaps = true` + `anisotropy = 4`
    之後，鬍鬚變成連續淡線，臉頰的雜點也消失，眼睛細節仍保留。

12. **設定面板在寵物小視窗裡「滾不動」**
    寵物視窗只有 240×290，開設定後可捲動區實際只剩約 156 px 高。
    成因有三個，疊加起來像「卡住」：
    - 分頁列（`.settings-tabs`）放在 `.modal-body` 裡面，往下滾時分頁會跟著跑掉，
      使用者失去「這裡可以換頁」的線索。→ 移到 `.modal-body` 之前，並加
      `flex-shrink: 0` 把 header／tabs／footer 都釘住。
    - 可捲動區被壓成一條窄縫，滑鼠滾輪停在 header、tabs、footer 或遮罩上時
      完全沒有反應。→ `settingsModal` 上監聽 `wheel`，事件不在 body 裡就轉發
      `body.scrollTop += e.deltaY`。
    - 捲軸只有系統預設細線、幾乎看不到。→ 自訂 `::-webkit-scrollbar`
      （10 px、半透明白），並加 `overscroll-behavior: contain`。
    另外把 modal 從 `90% / max-height 88%` 放寬到 `calc(100% - 12px)`、
    卡片壓縮（emoji 18 px、說明 `nowrap + ellipsis` 避免高度不齊），
    且在高 `max-height: 420px` 時再縮一級 padding。
    開面板與切分頁時 `scrollTop = 0`，切到寵物頁會 `scrollIntoView` 目前選中的卡。

13. **上傳預覽與佔位圖重疊**
    CSS 沒有全域 `.hidden` 規則（講話泡泡是淡出而非 `display:none`），
    所以 `.photo-preview-container.hidden`、`.upload-placeholder.hidden` 從未真的隱藏，
    空的預覽圓圈壓在上傳提示上。→ 針對這兩個元素補
    `display: none !important`。

14. **舊存的 skin 值讓寵物變空白**
    3D 分支的 `model3d` 曾寫進 `localStorage.aurapet_skin`；2D 版本沒有這個
    `renderSkin()` 分支，`svgHtml` 會是空字串 → 整個寵物區空白，而且設定面板
    也沒有對應的 radio 可以改回來。→ `PetEngine` 加白名單，
    不認得的值退回 `kitsune`。

15. **`package.json` 少了 `three`**
    2D 版的 import map 指向 `node_modules/three/build/three.module.js`，
    但 commit 時沒有把依賴寫進 `package.json`／lock。本機因為已經裝了所以能跑，
    乾淨 clone 後 `npm install` 不會有 three，cat2d 會直接載入失敗。
    → 補 `"dependencies": { "three": "^0.186.1" }`。

**捲動問題的驗證方式**：不能只用 CDP `Input.dispatchMouseEvent`，合成事件不會打到
原生捲軸。改用 PowerShell `SetCursorPos` + `mouse_event` 送出 OS 層級輸入，
分別測「滾輪停在 tabs／footer／遮罩」、「點捲軸軌道」、「拖曳捲軸拇指」三種操作，
`scrollTop` 都能正常變化；只靠 JS 設 `scrollTop` 成功並不算修好。

---

## 5. 已發現（量測與素材）

- **素材庫沒有正面全身照**。照片與影片抽格都沒有「正面坐好、四腳完整」的一張，
  這是當初 3D 形狀不可控的根因之一。
- 權威色：`#69523c`（由參考影片抽格平均）。
- `rembg` 去背後，`alpha=0` 的像素仍保留原本 RGB。用 RGBA→RGB 預覽會誤判
  「東西沒去掉」。驗證要合成到洋紅底，或數 `alpha>40` 的像素。
- 顯示縮放不是 1.25，實測 DIP:pixel ≈ 1.18（176/150）。
- 截圖驗證前先看 `document.visibilityState`，不要憑 code 推論。
- 2D 貼圖 618×1270，在 240×290 的寵物視窗裡實際顯示約 96×198。

---

## 6. 尚未決定

- **底圖要不要改用真貓照片做 image-to-image**，讓斑紋更貼近本尊。
  目前是純文字生成的虎斑貓（顏色對了，花紋是 AI 自己長的）。
- **3D 分支放哪**：`feat/3d-model`？GLB 要不要進版控（授權問題）。
- **閉眼貼圖要不要改用 AI 生成**：現在的閉眼是 inpaint 補丁，近看偏糊。
- **表情要擴充到哪些**：目前只有眨眼、凝視、耳朵、尾巴；sleepy／eating 還沒有專屬表情。
- **凝視是否要跟滑鼠**：`uGaze` 已可用，尚未接到滑鼠座標。
- **講話泡泡會蓋住貓臉**：這是原本所有 skin 都有的版面行為，對 198 px 高的貓更明顯，
  要不要為 cat2d 調整版面。
- **是否把 cat2d 設為預設 skin**（現在預設仍是 kitsune）。
- **寵物視窗的設定面板本體是否要重排**：捲動問題已修（見 #12），
  但在 240×290 下仍只能看到約 156 px 的內容，AI 模型設定得滾很久。
  要不要把寵物視窗開設定時改成「暫時放大視窗」或「另開一般尺寸視窗」尚未決定。
- **尾巴權重是概略值**：目前用左下角方形區域近似，尾巴壓在身體下方時表現尚可，
  但沒有精準的尾部遮罩。

---

## 7. 重現指令

```bash
# 產生 2D 素材（需要 hy3d-venv 裡的 opencv / numpy / rembg）
hy3d-venv/Scripts/python.exe matte_base.py
hy3d-venv/Scripts/python.exe make_tex.py
hy3d-venv/Scripts/python.exe make_closed.py

# 六格測試台（啟動後用 CDP 截圖）
env -u ELECTRON_RUN_AS_NODE ./mab/node_modules/electron/dist/electron.exe \
  --remote-debugging-port=9224 \
  --user-data-dir="C:/Users/LilithS/AppData/Local/Temp/aura-rig-profile" \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding ./rigtest
node reload-shot.mjs 9224 rig-check.png

# 主程式
env -u ELECTRON_RUN_AS_NODE ./mab/node_modules/electron/dist/electron.exe \
  --remote-debugging-port=9223 \
  --user-data-dir="C:/Users/LilithS/AppData/Local/Temp/aura-app-profile" \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding ./mab
```

切換 skin（在 DevTools 或 CDP 執行）：

```js
localStorage.setItem('aurapet_skin', 'cat2d');
location.reload();
```

---

## 8. 驗證規則（這輪踩過的坑）

1. 先看畫面，再說「好了」。截圖存在不代表有東西。
2. 量測，不要憑感覺：顏色取平均、遮罩數 `alpha>40 的像素`。
3. 判斷「畫面空白」時，先分開「幾何錯」與「相機錯」：
   把相機固定在已知位置渲染一次，再看物件 bounding box。
4. 一個 CDP page target 只能有一個 debugger client，腳本要排隊跑。
5. 舊頁面的例外會殘留，重新載入後要清空錯誤陣列再判斷。
