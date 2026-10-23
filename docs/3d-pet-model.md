# 3D 寵物模型 — 開發紀錄

**狀態：2026-10-23 暫停。** 主線改走 2D，3D 保留為後續分支目標。

一句話結論：整條 pipeline 跑得通，但**成品品質不足**，而且不是調參數就能救的那種不足。

---

## 1. 為什麼品質上不去

目前 [renderer/models/pet.glb](../renderer/models/pet.glb) 的外觀問題，逐項對應到根因：

| 症狀 | 根因 |
|---|---|
| 表面坑坑巴巴、像泥土 | 單張照片的 shape-only diffusion，皺褶是模型「猜」出來的，不是掃描到的 |
| 顏色死板、沒有毛感 | 完全沒有貼圖，只有一個純色 `baseColorFactor` |
| 五官糊成一團 | Hunyuan3D-2.1 的 shape 分支解析度到不了眼睛/鼻頭這種尺度 |
| 側背面造型合理但僵硬 | 只有一個視角的資訊，背面是模型補的 |
| 邊緣有細碎雜點 | 60k 面簡化後沒有重新平滑法線 |

**關鍵限制：** `hy3dshape` 只產出幾何。官方的外觀貼圖在 `hy3dpaint`，它依賴 `custom_rasterizer`，而那是**必須用 CUDA Toolkit 現場編譯**的 extension。本機沒裝 CUDA Toolkit，所以只能停在「單色幾何」。

這是路線本身的品質天花板，不是 bug。

---

## 2. 現行流程

```
選照片 → 裁切 → 去背 → 驗遮罩 → Hunyuan3D-2.1 → 簡化 → 上色 → GLB
         (先)     (先)    (不可省)      (約 3 分鐘)   (60k)   (單色)   (1.4 MB)
```

實際指令：

```bash
# 生成（讀一張已經去背好的 RGBA PNG）
./hy3d-venv/Scripts/python.exe gen2.py candidates/p6_in.png out/p6.glb

# 簡化 + 上色 + 輸出
./hy3d-venv/Scripts/python.exe proc.py out/p6.glb out/p6_stats.json 60000 \
    mab/renderer/models/pet.glb 946136
```

- `gen2.py`：吃「已經去背好」的 PNG，不做任何遮罩處理。
- `proc.py`：`fast_simplification` 簡化 → `trimesh.export_glb(include_normals=True)` → 寫入 baseColorFactor。
- 第五個參數是**實際寫進 `baseColorFactor` 的 hex**，不是目標外觀色。glTF 的 `baseColorFactor` 是線性空間，three.js 不會幫你從 sRGB 轉，所以要靠量測回推（見 §4.6）。

---

## 3. 已修的問題

### 3.1 寵物完全透明（首次執行）

renderer 的 JS 有語法錯誤，初始化中斷、畫布沒建立。修掉語法錯誤後正常。
**教訓：** 先看 DevTools console，不要先懷疑透明視窗設定。

### 3.2 `Error launching app — Cannot find module ...\orient-viewer`
自建的除錯工具 `orient-viewer/` 沒有 `package.json`。補上 `{"name":"orient-viewer","main":"main.js"}` 即解。這與 `mab` 本體無關。

### 3.3 模型底部被切掉
`model3d.js` 原本寫死縮放值，換模型就會裁到腳。改成依 `Box3` 自動取景：
以 bbox 中心置中、`maxDim → 2.0` 單位，再依 `fov` 與 `aspect` 算相機距離。
因為 pivot 會左右擺頭，寬度要取 `max(size.x, size.z)` 才不會在轉到側面時出界。

### 3.4 「貓的後半身是一張牆壁」— 真正原因
不是渲染 bug。**`rembg` 把貓身後的木櫃一起吃進遮罩了**，Hunyuan3D 照著那個輪廓長出一塊垂直平板。
驗證方式：用 app 自己的渲染器把模型丟進 300×300 覆蓋層，8 個角度截圖 → 平板確實是網格幾何，不是 DOM 也不是 WebGL 問題。

修法：換成唯一一張乾淨的全身坐姿照，**先裁切再摳圖**（避免貓鬚碰到椅子導致連通），再手動去掉右下角的牛皮紙板與吊著的項圈牌。

### 3.5 中途誤判：以為「灰板 = 缺法線」
第一次看到灰板時，發現 GLB 沒有 `NORMAL` attribute，於是改用 `include_normals=True` 重出。**補法線是對的，但當時並不是灰板的成因**——成因是 3.4 的幾何問題。這段白繞了一圈，記錄下來避免重犯。

### 3.6 把棕貓改成黑貓（已回滾）
曾對照片做白平衡「校正」，把紅褐虎斑壓成炭黑 `#39332d`。那是錯的，暖色調是貓真實的毛色。已回滾。

### 3.7 簡化參數方向搞反
`fast_simplification.simplify(..., target_reduction=X)` 的 X 是**要刪掉的比例**，不是保留的比例。
寫成 0.05 會幾乎原樣不動（845k→803k）；要留 5% 得寫 `target_reduction=0.95`。

### 3.8 渲染出來的顏色比實際暗、偏藍
`baseColorFactor` 是**線性空間**。把 sRGB 的 `#69523c` 直接塞進去，實際顯示會偏；再加上天光的 ground color 是冷灰藍，整個畫面更灰。
修法：把 `HemisphereLight` 的 ground 改成暖色 `0x6b5c4b`，然後**用像素量測回推** baseColorFactor。
最終實測：渲染中位數 `#70553a`、平均 `#6a5039`，對照照片色板加權平均 `#69523c`，落在可接受範圍。

### 3.9 除錯工具自己踩的坑
- `ELECTRON_RUN_AS_NODE=1` 被 Qoder 的 shell 繼承，Electron 會變成純 Node 直譯器 → 用 `env -u ELECTRON_RUN_AS_NODE` 啟動。
- 兩個 Electron app 共用預設 `user-data-dir` 時，**第二個會靜默退出**（把 URL 轉給第一個）→ 除錯工具要給自己的 `--user-data-dir`。
- Chromium 的 switch 要放在 app path **之前**，app 自訂參數放**之後**。
- **視窗不可見時 `Page.captureScreenshot` 會永久卡住**（不報錯、不給部分畫面）。先確認 `document.visibilityState`，用 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding` 啟動。
- 一個 CDP page target 只接受**一個** debugger client，兩支腳本同時跑會互相卡死。

---

## 4. 已發現 / 沉澱下來的事實

### 4.1 參考素材
`C:\Users\LilithS\圖片\條碼貓參考照片` 是**同一隻貓**：紅褐虎斑（ruddy ticked tabby），大耳、綠眼、有花紋項圈。不是黑貓，也不是兩隻。影片裡的深色只是光線暗。

可用性：
- `P_20250109_005025.jpg` — **唯一一張乾淨的全身坐姿**，頭轉側面。貓鬚碰到椅腳，`rembg` 會把貓和椅子上的人糊在一起，**必須先裁切再摳圖**。
- `P_20220909_074133.jpg` — 全身趴姿、正面、日光，但遮罩會吃到下巴下的書。
- `P_20250109_003849.jpg` — 乾淨的頭肩側面，適合當色彩參考。
- 其餘兩張不適合取形。

### 4.2 毛色色板（權威值）
從全身照去背區域取樣、k-means 量化：

```
#5b432f 20.1%   #70573e 19.7%   #473122 18.2%
#886e52 15.5%   #311f14 12.9%   #a88e6d  9.7%
#d3bd9a  3.8%
加權平均 ≈ #69523c
```

**不要做白平衡往灰/黑修**，暖色是這隻貓的毛色。

### 4.3 遮罩一定要用 alpha 通道驗證
`rembg` 輸出在 `alpha=0` 的區域**仍保留原始 RGB**。所以把 RGBA 轉成 RGB 預覽時，已經被「去掉」的物件還會顯示出來，非常容易誤判。
正確做法：合成到一個刺眼的純色底（洋紅）上，或直接數 `alpha>40` 的像素。

### 4.4 顯示縮放
本機 `devicePixelRatio ≈ 1.18`，不是系統設定的 1.25。每次截圖都要用 `截圖寬 / innerWidth` 實測，不要套 1.25。
`Page.captureScreenshot` 的輸出也是約 1.18×。

### 4.5 CDP 自動化限制
renderer 裡的 `const pet = ...` 在 `DOMContentLoaded` 內，**從 `Runtime.evaluate` 的全域看不到**。要驅動狀態得用 `localStorage.setItem(...)` + `Page.reload`，不能直接抓物件。

### 4.6 渲染顏色要量測，不要憑感覺
流程：截圖 → 只取貓身像素 → 算中位數 → 和目標色算比值 → 回推 `baseColorFactor`。
「看起來差不多」在這個專案裡已經出錯過一次。

---

## 5. 未決定事項

| # | 項目 | 選項 | 備註 |
|---|---|---|---|
| 1 | **2D 技術路線** | Live2D / 影片抽格 sprite sheet / 照片分層 Parallax / 直接 CSS sprite | 未開始 |
| 2 | 3D 貼圖要不要做 | 裝 CUDA Toolkit（4–5 GB）跑官方 `hy3dpaint` / 自寫 xatlas 展圖 + 照片投影烘焙 | 已暫緩 |
| 3 | 3D 程式碼放哪 | `main` 上保留 / 切到 `feat/3d-model` 分支 | 未定 |
| 4 | GLB 要不要進版控 | 目前 1.4 MB，在 `renderer/models/` | **見 §6 授權** |
| 5 | 基準色是否沿用 `#69523c` | — | 2D 也用得到 |

---

## 6. 授權

Hunyuan3D-2.1 是 **Tencent 非商業授權**。自己在本機跑沒問題，但**把生成的 GLB 推進公開 repo 屬於再散布**，要先確認授權條款允許，否則建議放私有分支或不要進版控。

---

## 7. 若之後回頭做 3D — 順序不能顛倒

> **一定要先去背、確認遮罩乾淨，才丟去建模。**

目前的 `gen2.py` 已經是「吃去背好的 PNG」，所以順序本身沒問題；缺的是**中間那一關「驗遮罩」**沒有強制執行。這次有兩輪時間是浪費在「模型長出奇怪的東西」上，追下去都是遮罩不乾淨（木櫃、紙板、項圈牌）。去背後的檢查成本是幾秒，重新生成的成本是 3–4 分鐘加上人工判讀。

要固化的規則：

1. 去背 → **合成到洋紅色底、人眼看過** → 才允許進生成。
2. 遮罩只能有**一個**連通區塊，且必須是貓。
3. 任何貼在貓身上的異物（紙板、標籤、吊牌、背後的傢俱）都算遮罩錯誤，不是「小瑕疵」——它會直接長成幾何。

建議的下一步（如果重啟 3D）：

1. 一次準備 3–4 個不同角度的乾淨遮罩（正面、側面、3/4），而不是單張。
2. 先確認 `hy3dpaint` 能跑起來，沒有貼圖的 shape 模型永遠會「像泥土」。
3. 簡化後重新計算平滑法線，並保留 UV。
4. 上色一律用 §4.6 的量測流程校正。
