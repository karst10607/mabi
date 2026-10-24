# AuraPet 真實貓咪建模筆記

最後更新：2026-10-24

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
| `mab/renderer/models/cat2d/cat_rig.json` | 手工 landmark／權重來源，座標是去背原圖像素 |
| `mab/renderer/models/cat2d/cat_meta.json` | 工具產生：貼圖尺寸、眼睛、脖子、`rig` |
| `mab/renderer/models/cat2d/cat_meta.js` | 同上，改成 ES module（`file://` 不能用 fetch） |
| `mab/renderer/rig2d.js` | `PetRig2D`：網格、權重、著色器、眨眼、30 fps 節流；不含物種常數 |
| `mab/tools/` | 去背、格線、landmark 疊圖、貼圖烘焙、閉眼貼圖（不進安裝檔） |
| `rigtest/` | 六格測試台（idle／左右轉頭／閉眼／耳朵後貼／甩尾） |

貼圖取樣：`NoColorSpace`（保持原色）、`LinearMipmapLinearFilter`（縮小顯示不閃爍）、
`anisotropy = 4`。不開 mipmap 時鬍鬚會斷成點。

### 網格與權重

- 網格 72×148，座標是貼圖像素空間，**y 軸翻轉**成世界座標（y 向上）。
- 權重全部在 `load()` 內用 CPU 算好並寫進 attribute：

| 權重 | 算法 | 用途 |
| --- | --- | --- |
| `aHead` | 以脖子為界的 smoothstep（上 95 px、下 55 px） | 頭部剛體旋轉／位移 |
| `aBreath` | 胸口高斯（center 520,836、σ 240×180）× 1176→1036 淡出 | 胸腔呼吸；前掌、影子不動 |
| `aTail` | `rig.tail` 的 x／y smoothstep（480→335、1096→1226） | 尾巴擺動 |
| `aEarL/R` | 以 `rig.ears` 的 center／sigma（70×95）取高斯 | 耳朵繞 pivot 旋轉 |
| `aLeg` (vec4) | `rig.legs` 四條腿各自的高斯（center／sigma）× 以 `pivot.y ± 26` 的 smoothstep 掐掉上半身 | 四腳步態：每條腿繞自己的肩／胯樞紐旋轉，只有擺動期抬掌 |

- 上表數值都在 `cat_rig.json`，`make_tex.py` 原封不動寫進 meta 的 `rig`。
  `rig2d.js` 只解釋欄位，**沒有任何貓的常數**；換物種不必改程式。
- `rig` 座標是去背原圖像素；載入時才減 `origin` 換成貼圖空間，pivot 再翻成 y 向上。
- `ears` 只接受 0 或 2 個；`tail` 可以是 `null`。鳥、龜目前可把兩者設空，
  共用頭／胸的變形。`bodyPlan` 目前只有 `quadruped` 一種權重模型，
  翅膀、縮殼這類 body-specific 變形還沒做；四足步態已經有，見下方「走路循環」。
- 外部化後重跑六格測試台，與改前截圖（1169×856）逐像素比對：
  只有 2 個像素差 1/255，肉眼與構圖完全相同。
- 耳朵是**繞耳根（pivot）旋轉**，不是整體平移。早期用平移會把整個額頭一起拉走。
- 頭部變換在耳朵之後執行，所以轉頭時耳朵會跟著頭走。

### 新增物種：art → landmarks → meta

1. 準備正面、平背景、輪廓清楚的原圖（四肢不要被背景同色吃掉）。
2. 去背：

   ```bash
   hy3d-venv/Scripts/python.exe mab/tools/matte_base.py art.png work/
   ```

3. 畫格線讀座標（可只輸出頭部／尾巴的裁切）：

   ```bash
   hy3d-venv/Scripts/python.exe mab/tools/grid.py work/base_rgba.png \
     --crop 150,100,820,760 --out work/grid_head.png
   ```

4. 複製 `cat_rig.json` 成新物種的 rig 檔，填 `head`、`breath`、`ears`、`tail`、
   `eyeRadiusScale`。非綠眼要把 `eyes: [{cx,cy,rx,ry}, …]` 寫進 rig 檔；
   脖子不是自動找最窄列時，加 `neck: {row: y}`。
5. 疊圖檢查，迭代到耳朵、胸口、尾巴區域正確：

   ```bash
   hy3d-venv/Scripts/python.exe mab/tools/landmarks.py work/base_rgba.png \
     --rig work/dog_rig.json --out work/dog_landmarks.png
   ```

6. 烘焙貼圖與 meta：

   ```bash
   hy3d-venv/Scripts/python.exe mab/tools/make_tex.py work/base_rgba.png \
     --rig work/dog_rig.json --out mab/renderer/models/dog2d --name dog
   ```

7. 產生閉眼貼圖（非綠眼會只用橢圓遮罩，需人工檢查）：

   ```bash
   hy3d-venv/Scripts/python.exe mab/tools/make_closed.py \
     mab/renderer/models/dog2d --name dog --preview work/dog_closed.png
   ```

目前 App 只掛 `cat2d`（`pet.js` 的 `mountRig()`）；新目錄產好後還要加一個
skin 掛載與設定選項，才會出現在 UI。這是下一步，不是工具鏈的事。

### 眼睛

- 眨眼不用幾何變形：`uEyeOpen` 在兩張貼圖之間做 `mix()`，閉眼時整塊換成
  `cat_tex_closed.png`。
- 凝視（`uGaze`）只在眼睛周圍的橢圓遮罩內偏移取樣座標。
- 早期用「把取樣座標往外擴」模擬閉眼，失敗：瞳孔在正中心，往外擴時中心不動，
  結果眼睛反而變大、虹膜被拉花。已移除。

### 待機動作

參數在 `rig2d.js` 的 `animate()`：

| 參數 | 振幅 | 備註 |
| --- | --- | --- |
| `uBreath` | 胸腔上提 9 px、左右各擴 ~0.055 × 半寬 | 3.2 秒一輪，吸氣 35%、吐氣 65%；前掌固定 |
| `uHeadShift` | 14 / 9 px + 呼吸 ±1.5 px | 水平跟隨慢速 `sway`，垂直加 `headBob` 與吸氣抬升 |
| `uTailSway` | 34 px | 尾巴左右甩，`aTail` 權重 |
| 耳朵抖動 | 0.16 rad | 機率觸發，約每 3 秒 |
| CSS `floatPet` | 停用（cat2d） | 整個 wrapper 連影子一起上下 8 px，會蓋掉胸腔呼吸 |

- 呼吸只看胸腔，不動整隻貓：舊版用 `aBody` 把 14 px 的垂直位移套用到脖子以下
  所有頂點，連前掌都跟著上下，再加 CSS 的 8 px 漂浮，就是「史萊姆」感。
- 驗證不能只看程式：隱藏 UI 與影子，每 200 ms 截 20 張 alpha 圖，量輪廓。
  這輪前掌底緣 20 張都固定在 device y=287，胸寬 74→78 px（DIP ≈ 1.18），
  證明是胸腔在動而不是整隻平移。
- 呼吸速度：3.2 秒一輪 ≈ 19 次/分；吸氣比吐氣快。

### 閉眼貼圖怎麼來的

`make_closed.py`：把兩眼的虹膜連同眼眶遮掉（`cv2.inpaint`），再畫一條微微下彎的眼線。

- 遮罩必須大於整個眼睛，不能只框綠色虹膜。實測眼睛約 66×60 px，
  虹膜只有 30×30，若照虹膜大小去遮，inpaint 會把綠色從邊界補回眼睛裡。
- 目前用固定橢圓（`rx*2.6`, `ry*2.6`）蓋掉整顆眼。

```bash
hy3d-venv/Scripts/python.exe mab/tools/make_closed.py \
  mab/renderer/models/cat2d --name cat
```

### App 整合與多角色切換／移除

- 2D Live2D 風格角色（`RIG_SKINS`）：
  - `cat2d`：條碼（棕黑虎斑貓，`renderer/models/cat2d/`）
  - `ami2d`：阿咪（橘色虎斑貓 + 粉紅鈴鐺項圈，`renderer/models/ami2d/`）
  - `kk2d`：KK（台灣黑犬／歐告 + 白霜嘴吻 + 淺藍項圈，`renderer/models/kk2d/`）
- **快速切換角色與休息姿態（方案 A + 方案 B）**：
  - 直接點擊寵物視窗底部的**名字標籤**（`#pet-name-badge`）即可在未移除的寵物角色間循環切換，並自動同步預設名字與圖示。
  - 點擊底部快捷列的 **`💤` 休息按鈕**（`#btn-pet-rest`），可循環切換四種姿態：
    1. `sit`（坐姿清醒）
    2. `doze`（**方案 A**：坐姿低頭閉眼打瞌睡，`PetRig2D.setSleepy(true)` 驅動低頭、耳朵放鬆、閉眼與慢呼吸）
    3. `rest`（**方案 B**：切換為 `*_rest_*` 母雞蹲／趴地貼圖與骨架，張眼趴著休息）
    4. `sleep`（**方案 A + B**：趴姿閉眼熟睡 + `💤` 粒子特效）
  - 趴姿模型在 `*_rest_rig.json` 中使用 `neck: { row, cx }` 指定脖子中心，並透過 `head.xSpan: [fullHalfW, zeroHalfW]` 限制眼線以下的水平頭部權重，避免轉頭時拉動拱起的貓背或後腿。
  - 在「設定 → 寵物外觀」中，每個角色卡片右上角都有 `✕` 移除按鈕，可將不想要的角色從切換清單與外觀選單隱藏（儲存於 `localStorage.aurapet_hidden_skins`），底部亦提供「恢復全部角色」按鈕。
- `index.html` 加了 import map，讓 `rig2d.js` 在 `file://` 下能解析 `import 'three'`。
- `pet.js` 動態 `import('./rig2d.js')`，`mountRig(skinId)` / `disposeRig()` 成對呼叫，
  切換 skin 時會銷毀 WebGL context 與 canvas。
- 互動：摸摸 → 脈動 + 眨眼（狗狗角色 `kk2d` / `shiba` 會顯示專屬汪汪台詞）；餵食 → 點頭；玩 → 甩尾。
- 「牠對你的稱呼」存在 `aurapet_user_title`（預設「主人」）。問候、摸摸台詞、
  待機台詞、內建回覆與 API 的 system prompt 都會套用；API 路徑是在送出前把
  prompt 裡的「主人」換成稱呼，再補一句 `請以「<稱呼>」稱呼使用者`。
- 所有 2D rig 角色都會把 `body` 加上 `skin-rig` class，講話泡泡改用小視窗專屬的位置（見 #17）。

### 走路循環（四腳慢步）

站姿貼圖才有腿可動，所以走路是**獨立的一組貼圖**（`<prefix>_walk_tex.png` +
`<prefix>_walk_rig.json`），不是把坐姿變形。

- `rig.legs` 固定 4 條，順序 **FL、FR、BL、BR**；`center`／`sigma` 是腿的重量中心與
  高斯半徑，`pivot` 是肩／胯樞紐（腿繞它轉）。`tools/landmarks.py` 會把它們疊在
  去背圖上，烘焙前先用它核坐标。
- `rig.gait` 覆寫步態，缺省時用 `rig2d.js` 的 `DEFAULT_GAIT`：四拍側步態
  （lateral sequence），相位 `[0.25, 0.75, 0, 0.5]`，佔空比 68%，也就是任何時刻
  至少三隻掌踩地，因此身體從不需要離地。
- 佔空期掌腳相對於身體往後走（等效於地面往後移），擺動期用 smoothstep 把腳
  送回前方並用半個正弦抬掌 `gait.lift` px。兩段在接合點角度連續，所以不會抖。
- **`rig2d.js` 裡沒有任何物種常數**；腿的位置、擺幅、抬掌高度全在 rig JSON。
- 身體保持水平：`pet.js` 的 `applyPerspectiveTransform()` 不再隨步伐升降或擠壓，
  只有深度 `z` 会影响垂直位置與縮放。

### 沿螢幕邊緣散步（漫遊）

主程序搬的是**整個視窗**；貓在視窗內只負責踏歩與面向。

| 參數 | 值 | 說明 |
| --- | --- | --- |
| 間隔 | 6–14 秒 | 每次走到位後重新抽 |
| 目標 | 當下螢幕的 `workArea` | 只換 x，維持在目前那一列（走路不離地） |
| 位移 | ≥110 px | 太近就 1.5 秒後重抽，避免原地抖 |
| 速度 | 78 px/s | `ROAM.speed` 是巡航速度；時長 = 距離／速度，夾在 0.9–24 秒 |
| 速度曲線 | 梯形 | 前後各 15% 時間加速／減速，中段定速——這才是走的樣子 |
| 視窗 | 240×290 全部進工作區 | 含底部 dock，因此貼工作列時貓會比邊緣高約 60 px |

- 暫停條件：對話模式、視窗隱藏／最小化、設定面板開啟（`set-ui-busy`）、
  摸摸／餵食／玩之後 5–9 秒、使用者拖曳後 5–9 秒。
- 行走中的 `move` 事件會繞過位置存檔（`roaming` + 最後一幀 150 ms 內），
  只在走到位與關閉時寫 `app-settings.json`，避免每幀寫檔。
- 主程序用 `roam-state` 送 `walk-left`／`walk-right`／`idle`；`pet.js` 據此翻轉面向
  並讓 rig 進入走路姿態。CSS 只剩 `body.roam-walk` 關掉待機浮動，避免一晃一晃
  跟腳步打架。
- 開關：**預設關閉**；托盤「到處走 (螢幕邊緣)」與設定 → 系統設定可開啟，存成
  `app-settings.json` 的 `roamEnabled`；托盤與設定面板會同步。舊版設定檔若已寫入
  `true` 會保留，只有缺欄位的新安裝才是關閉。
- 限制：只沿**螢幕**工作區水平走，不爬其他應用程式的視窗邊緣（見第 6 節）；
  多螢幕時只會在目前所在的螢幕內走，不會跨螢幕。

### 影格預算：沒東西在動就少畫、不畫

透明置頂視窗只要 `renderer.render()` 一次，就得請 macOS 重新合成那一塊螢幕，
所以省 CPU 的重點是**少畫**，不是少算。

| 機制 | 位置 | 說明 |
| --- | --- | --- |
| 自我排程的 rAF | `rig2d.js` `schedule()` | rAF 無法跑得比 vsync 慢，因此兩幀之間的空檔用 `setTimeout` 等，等完才交給下一張 animation frame |
| 快／慢兩檔 | `ACTIVE_FRAME_MS = 30`、`IDLE_FRAME_MS = 110` | 約 30fps 與約 9fps |
| 忙碌判定 | `rig2d.needsFastFrame()` | 任何還在朝目標緩動的量（`stepAmp`、`pulse`、`nod`、`sleepBlend`、`blink`、耳朵抖動、`autoDrowsy`、`autoGaze`）或 2.4 秒內有滑鼠移動，就要求快檔 |
| 停擺 | `rig2d.stop()` | 由主程序的 `window-visibility` 觸發，視窗不在螢幕上時一張都不畫 |
| 位移迴圈 | `pet.js` `locoTick`／`isLocomotionSettled()` | 只有真的在走路時才有 60fps 迴圈；停下來時把 `L.x`／`L.z` 吸附為 0，否則 0.1–0.4 的殘值會讓它永遠自轉 |

兩個踩過的坑：

- **漸近緩動永遠「還沒到位」**：`Math.abs(sleepBlend - target) > 0.004` 這種帶死區的
  比較是必要的，寫成 `!==` 會讓快檔要求永遠不放手。同理，睏眼原本用「目標 > 0.5」
  判定，會把整個 1.6–3.4 秒閉眼停留都算成忙碌，改成存下 `drowsyTarget` 再比距離。
- **高頻抖動不能低頻取樣**：耳朵的 `sin(t*34)` 在 9fps 下會取樣成亂抖，所以它改成
  自帶 0.42 秒包絡的獨立計時器，并且在抖動期間要求快檔。瞇眼同理：`blinkTimer`
  還剩不到 0.25 秒時就要先回到快檔，否則第一格會一口氣把眼睛關死。

喚醒路徑（`wake()`）挂在滑鼠移動、`setLocomotion`、`setSleepy`、`react`、`load`、
`window-visibility`，以及主程序那條 `pet-activity`（只有摸到看得見的貓才會送）。
`did-finish-load` 則把「隱藏時重新載入」的視窗重新按下去，避免重載後在螢幕外畫圖。

閃爍調查記錄：

- **最可能的元兇**：`THREE.WebGLRenderer` 預設 `preserveDrawingBuffer: false`，畫布交給
  合成器後其內容即失效。透明置頂視窗每 3.5 秒被 `floatPet` 的 CSS 動畫合成一次，
  兩次繪製之間的合成就會取到空表面 → 貓閃一下消失。改成 `true` 之後 CPU 沒有變化
  （GPU helper 11.7–15.2% → 11.8–15.2%），但合成器隨時都拿得到最後一幀。
- 第二層：`backgroundThrottling: false`。視窗一失去焦點就被當成背景，rAF 全數凍結
  （實測 4 秒 0 幀、`document.hidden === true`），透明視窗於是留在舊畫面。
- 負結果：把 `ignore-gpu-blocklist` 在 macOS 關掉測試，WebGL 仍是同一張
  `ANGLE (Intel Inc., Intel Iris OpenGL Engine, OpenGL 4.1)`，但 GPU helper 從約 13%
  升到約 20%，所以這個 switch 留著。
- 渲染端不是元兇：兩段各 90 秒、4Hz 的 `Page.captureScreenshot`（714 幀）沒有任何
  空白或壞幀。
- 另外：`mainWindow.on('hide')` 在 macOS 的 frameless 透明視窗上不會觸發，
  所以顯示狀態一律由 `showPetWindow()`／`hidePetWindow()`／`minimizePetWindow()` 明確送出。
  本機 `screencapture` 沒有螢幕錄取權限，截到的是純桌布，因此「螢幕上看起來如何」
  這類證據只能靠使用者目視，無法在此環境取證。

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

16. **呼吸時寵物後面浮出一個比較大的半透明貓影**
    有兩個來源，兩個都修了：
    (a) `.pet-graphic` 的 `filter: drop-shadow(0 8px 14px rgba(0,0,0,0.3))`。
        SVG skin 看起來像光暈，但照片貓的剪影被模糊、偏移後變成
        一隻「比較大的貓」墊在後面，`floatPet` 上下浮動時更明顯。
        → rig mode 改成 `filter: none`。alpha 驗證：有陰影約 309k、
        移除後約 147k。
    (b) 桌面上同時存在**第二個 AuraPet 實例**（先前測試殘留，視窗只差 2px，
        兩個都 always-on-top）。前貓呼吸上浮時就露出後貓的輪廓，這才是
        使用者看到「而且更多了」的主因。CDP 的 `Page.captureScreenshot`
        只會截單一視窗，所以先前驗證看不到它；要用 OS 層截圖
        （PowerShell `CopyFromScreen`）或列舉視窗才會現形。
        → 關掉殘留實例，並在 `main.js` 加 `requestSingleInstanceLock()`：
        第二次啟動直接退出，只把既有視窗叫回來。
    教訓：透明視窗的視覺驗證要同時看「視窗內部」與「桌面實際合成結果」，
    兩者不一致時先懷疑有其他視窗疊著。

17. **講話泡泡蓋住貓臉**
    泡泡原本 `top: 36px` 置中，在 240×290 的視窗正好壓在眼睛上。
    貓是照片、臉佔畫面中央，往上移沒有空間。
    → 只在 cat2d（`body.skin-rig`）把泡泡改成貼著底部狀態列上方
    （`bottom: 62px`），尾巴翻成朝上；臉與胸口完全露出來。
    泡泡同時加 `pointer-events: none`，不會擋住摸貓。

**捲動問題的驗證方式**：不能只用 CDP `Input.dispatchMouseEvent`，合成事件不會打到
原生捲軸。改用 PowerShell `SetCursorPos` + `mouse_event` 送出 OS 層級輸入，
分別測「滾輪停在 tabs／footer／遮罩」、「點捲軸軌道」、「拖曳捲軸拇指」三種操作，
`scrollTop` 都能正常變化；只靠 JS 設 `scrollTop` 成功並不算修好。

18. **呼吸像史萊姆一樣上下伸縮**
    舊版把呼吸做成**整隻身體的垂直位移**：`aBody` 對脖子以下所有頂點加 14 px 的
    `sin` 位移，前掌與影子都跟著上下；CSS 的 `floatPet` 又讓整個 wrapper 連影子
    每幾秒浮 8 px。兩者疊加，看起來就像一整坨東西被拉長、壓短。
    → 改成 `aBreath`：高斯權重只留在胸口（x=350, y=700, σx=240, σy=180），
    在 y=900→1040 之間淡出，前掌權重為 0。著色器只讓胸口上提 9 px、
    左右各擴 0.055 × 半寬，頭部多抬 ±1.5 px；cat2d 同時停用 CSS float。
    驗證：隱藏 UI 與影子，每 200 ms 截 20 張 alpha 圖，前掌底緣全部固定在
    device y=287，胸寬 74→78 px —— 動的是胸腔，不是整隻貓。

19. **漫遊時視窗每移動一次就變大**
    Windows 上 `BrowserWindow.setPosition()` 在非整數縮放（本機 DPR 1.18）每呼叫
    一次就讓視窗長大一些。最小重現：240×290 的 frameless 視窗連呼 60 次
    `setPosition`，會從 244×293 變成 334×353。實際漫遊時每步 +1～2 px，
    最後貓會越走越大、視窗底部超出工作區。
    → 每一步都改用 `setBounds({ x, y, width: 240, height: 290 })` 固定尺寸；建立視窗後
    也先 `setBounds` 正規化一次。用「當下 bounds」當固定值仍會每步 +1，必須釘住
    設計尺寸。驗證：cat2d 走完整段路程都維持 241×291。
    另一個坑：早期跳躍版會飛出畫面上緣（量到 y=-43）；改成散步後 y 全程釘死，
    `pickRoamTarget()` 只換 x，x 仍夾在 `workArea` 內。

20. **`pip install` 找不到 wheel 會無訊息改成源碼編譯**
    `make_closed.py` 需要 `cv2`。在這台 macOS 12.7.6 上裝 `opencv-python-headless`
    （沒鎖版本）時，pip 抓不到 `macosx_14_0` 標籤的 wheel，**不報錯也不提醒**，
    直接退回 sdist 用 cmake＋6 個 clang job 源碼建置。i5-4278U 只有 4 核，
    load average 衝到 180、`/tmp` 被填到剩 126 MB，跑了近一小時還沒結果，
    而且畫面看起來跟「安裝卡住」一模一樣——完全看不出是在編譯。
    代價不只時間：建到一半程序被殺會留殘骸（這次清出 840 MB 的 Homebrew
    `openssl@3` staging、1.4 GB 的臨時 clone 都是這樣累積的）。
    → 工具鏈依賴一律加 `--only-binary=:all:`，缺 wheel 時讓它立刻失敗而不是默默編譯；
    版本要鎖死（NumPy 2 需要 opencv ≥ 4.10，實測用 `opencv-python-headless==4.10.0.84`）；
    不要加 `--quiet`，它會把「正在源碼建置」這個關鍵訊號一起吃掉。
    疑似卡住時先 `top -l 2` 看第二輪取樣（第一輪是瞬時值，會全報 0.0%），
    再 `pgrep -fl clang` 確認是不是在編 C++。

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
- **是否把 cat2d 設為預設 skin**（現在預設仍是 kitsune）。
- **寵物視窗的設定面板本體是否要重排**：捲動問題已修（見 #12），
  但在 240×290 下仍只能看到約 156 px 的內容，AI 模型設定得滾很久。
  要不要把寵物視窗開設定時改成「暫時放大視窗」或「另開一般尺寸視窗」尚未決定。
- **尾巴權重是概略值**：目前用左下角方形區域近似，尾巴壓在身體下方時表現尚可，
  但沒有精準的尾部遮罩。
- **發佈身分還是佔位值**：`appId` 是 `com.antigravity.aurapet`、author 是
  `Antigravity`，都是 scaffold 留下來的。要對外發佈前得改成自己的。
- **Windows 沒有簽章**：portable exe 首次執行會被 SmartScreen 攔。
  要不要買 code signing 憑證（或先只給熟人用）尚未決定。
- **macOS / Linux 沒有實機測過**：程式路徑都寫了（`setLoginItemSettings`、
  `~/.config/autostart`、AppImage），但托盤、透明視窗、自動啟動都沒在真機跑過。
- **托盤「開機自動啟動」沒有實點測過**：原生選單無法用 CDP 點，實作照 Electron
  標準 API 寫，但沒有端到端驗證。
- **要不要沿其他應用程式的視窗邊緣散步**：這輪只做螢幕工作區（跨平台、不需特殊權限）。
  走視窗上緣要列舉其他 process 的視窗：Windows 用 Win32 `EnumWindows` +
  `GetWindowRect`，macOS 要 Accessibility 權限（`AXUIElement`），Linux 各 WM 不同；
  先在 Windows 做一個實驗分支比較合理。托盤「到處走」之後也要能分辨這兩種模式。

---

## 7. 獨立常駐與 honoka 整合順序

方向：**先讓寵物自己站得住，再談同步**。不要把 honoka-publish 的私有能力
import 進寵物，也不要解析它的 stdout。

### Phase A：單機常駐（已做，Windows 已驗證）

| 項目 | 實作 | 狀態 |
| --- | --- | --- |
| 單一實例 | `requestSingleInstanceLock()`；第二次啟動直接退出，只把既有視窗叫回來 | 已驗證 |
| 視窗位置記憶 | `app-settings.json`（`%APPDATA%\aurapet-desktop`），`move` / `moved` 500 ms debounce；還原前檢查是否落在任一螢幕工作區 | 已驗證（Win32 `MoveWindow` 與重啟） |
| 開機自動啟動 | 托盤「開機自動啟動」：Windows/macOS 用 `setLoginItemSettings`、Linux 寫 `~/.config/autostart/*.desktop` | 程式完成，**托盤實點未測** |
| 崩潰重啟 | renderer `render-process-gone` / `unresponsive` 自動 reload（每分鐘最多 5 次）；main process 例外 `app.relaunch()`，20 秒內只重啟一次並寫 `crash.log` | renderer 用 CDP `Page.crash` 驗證過 |
| 打包 | electron-builder：Windows portable + NSIS；asar 排除 `renderer/models/pet.glb` | 已產出 portable exe；macOS/Linux 未實機測 |

Portable 版注意：`process.execPath` 指向解壓後的暫存目錄，註冊自動啟動要用
`PORTABLE_EXECUTABLE_FILE`；Linux AppImage 同理要用 `APPIMAGE`。

### Phase B：外部程序 + 單一 owner（下一步）

- honoka-publish 自己跑（`--watch` 或排程），由它**唯一**寫入狀態檔。
- 寵物只讀：不寫檔、不呼叫 honoka、不解析 stdout。
- 狀態檔路徑存在 `app-settings.json`（例如 `honokaStatePath`），沒設定就不啟用。
- honoka 端用 atomic write（temp + rename）；寵物讀到壞 JSON 就沿用上一個狀態。
- 超過 N 秒沒更新視為 stale，泡泡顯示「同步中斷」，而不是一直顯示上次的成功訊息。

建議 JSON（草案，尚未實作）：

```json
{
  "updatedAt": "2026-10-23T12:34:56+08:00",
  "status": "syncing|ok|error|paused",
  "message": "3 篇已同步",
  "lastError": null,
  "seq": 42
}
```

`updatedAt` 用含時區的 ISO 8601；`seq` 用來分辨同一秒內的重複寫入。

### Phase C：真的需要深度整合時

改 **honoka-publish** 匯出穩定介面（或就是上面的 JSON），而不是在寵物裡塞
adapter。寵物端不該知道 honoka 的內部資料結構，這樣 honoka 重構時寵物不會跟著壞。

為什麼不是現在做：寵物連「自己常駐」都是這次才補齊的。先把 Phase A 穩定下來，
Phase B 才有東西可以測；反過來先接 honoka，會把兩個都還不穩的東西綁在一起。

---

## 8. 重現指令

```bash
# 產生 2D 素材（依 mab/tools/requirements.txt：Pillow / numpy / scipy / opencv-python）
# 條碼 (cat2d)
hy3d-venv/Scripts/python.exe mab/tools/matte_base.py \
  vibe_images/cat-base-front_1792727676420_f9faebe7.png layers/
hy3d-venv/Scripts/python.exe mab/tools/make_tex.py layers/base_rgba.png \
  --rig mab/renderer/models/cat2d/cat_rig.json \
  --out mab/renderer/models/cat2d --name cat
hy3d-venv/Scripts/python.exe mab/tools/make_closed.py \
  mab/renderer/models/cat2d --name cat

# 阿咪 (ami2d) — 加上 --solid-interior 3 確保內部灰白毛色 alpha=255
hy3d-venv/Scripts/python.exe mab/tools/matte_base.py \
  vibe_images/ami_base_front.jpg work/ami --solid-interior 3
hy3d-venv/Scripts/python.exe mab/tools/make_tex.py work/ami/base_rgba.png \
  --rig mab/renderer/models/ami2d/ami_rig.json \
  --out mab/renderer/models/ami2d --name ami
hy3d-venv/Scripts/python.exe mab/tools/make_closed.py \
  mab/renderer/models/ami2d --name ami

# KK (kk2d) — 加上 --solid-interior 3 保護白霜嘴吻與眉毛不被灰底距離公式誤傷為半透明
hy3d-venv/Scripts/python.exe mab/tools/matte_base.py \
  vibe_images/kk_base_front.jpg work/kk --threshold 26 --solid-interior 3
hy3d-venv/Scripts/python.exe mab/tools/make_tex.py work/kk/base_rgba.png \
  --rig mab/renderer/models/kk2d/kk_rig.json \
  --out mab/renderer/models/kk2d --name kk
hy3d-venv/Scripts/python.exe mab/tools/make_closed.py \
  mab/renderer/models/kk2d --name kk

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

打包（Windows，在 `mab/` 目錄）：

```bash
npm install
npx electron-builder --win portable   # dist/AuraPet 1.0.1.exe（單檔，73 MB）
npx electron-builder --win nsis

# 確認授權有問題的 GLB 沒進 asar（應該沒有輸出）
npx @electron/asar list "dist/win-unpacked/resources/app.asar" | grep pet.glb
```

兩個實際踩到的打包坑：

- **不要把輸出目錄改到 `dist` 以外卻忘了排除 `dist`**。electron-builder 只會自動
  排除「目前的輸出目錄」；`files` 必須自己加 `!dist/**`，否則上一個 73 MB 的 exe
  和整包 Electron 會被再包進 asar（實測從 14 MB 膨脹到 369 MB）。
- **`EBUSY: resource busy or locked`**：`app.asar` 被檔案索引或防毒暫時持有。
  把輸出指到工作區外的暫存目錄重建，或關掉持有檔案的程式；不要直接刪 `dist`。

驗證打包版要用**乾淨的 profile**，不要沿用開發時的 `%APPDATA%\aurapet-desktop`，
否則看到的 skin／視窗位置是舊設定：

```bash
"dist/win-unpacked/AuraPet.exe" \
  --user-data-dir="C:/Users/LilithS/AppData/Local/Temp/aura-pack-profile"
```

打包後的 UI 驗證仍用 CDP（`--remote-debugging-port=9225`）；截桌面則用
PowerShell `CopyFromScreen`。不要同時開第二個 profile 的實例做對照 ——
單一實例鎖是綁 user-data-dir 的，換 profile 就繞過了，只會讓畫面多一隻貓。

---

## 9. 驗證規則（這輪踩過的坑）

1. 先看畫面，再說「好了」。截圖存在不代表有東西。
2. 量測，不要憑感覺：顏色取平均、遮罩數 `alpha>40 的像素`。
3. 判斷「畫面空白」時，先分開「幾何錯」與「相機錯」：
   把相機固定在已知位置渲染一次，再看物件 bounding box。
4. 一個 CDP page target 只能有一個 debugger client，腳本要排隊跑。
5. 舊頁面的例外會殘留，重新載入後要清空錯誤陣列再判斷。
6. 透明視窗要同時看「CDP 視窗內截圖」與「OS 桌面截圖」。兩者不一致時，
   先找是不是有第二個視窗／第二個實例疊著。
7. 單一實例鎖綁的是 user-data-dir；用不同 `--user-data-dir` 開「對照組」等於
   繞過鎖，會製造出使用者看到的疊影。驗證前先數 process 與視窗。
