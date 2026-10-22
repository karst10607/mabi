# 🐾 AuraPet - 跨平台 AI 靈動桌面寵物 (ChatGPT 桌面夥伴)

> 一款集「可愛動態桌面精靈」與「強大 ChatGPT 風格 AI 助手」於一體的現代跨平台桌面應用程式，原生支援 **macOS**、**Windows** 與 **Linux**。

---

## ✨ 核心特色

### 1. 🎭 雙形態無縫切換 (Dual Modes)
- **靈動寵物形態 (Pet Mode)**：
  - **透明無邊框懸浮窗**：背景全透明，無違和融入任何桌面壁紙。
  - **隨意拖曳與始終置頂**：可自由拖曳至螢幕任意角落（或停駐在 Dock / 工作列旁），支援一鍵置頂。
  - **動態生動反饋**：自帶呼吸浮動、眨眼微表情、高親密回饋、動態光影。
  - **互動養成系統**：
    - 👋 **摸摸頭**：點擊或撫摸寵物，冒出愛心粒子與幸福反饋，提升「親密度 ❤️」。
    - 🍣 **餵壽司**：及時投餵可口小點心，補充寵物「能量值 ⚡」。
    - 🎾 **拋球玩耍**：增進情感交流，活力滿分。
  - **智慧關懷氣泡**：自帶時間感知（早晨、午餐、下午茶、深夜關心、久坐喝水提醒）。

- **ChatGPT 桌面對話形態 (Chat Mode)**：
  - **Option + Space** 或點擊對話按鈕無縫展開現代毛玻璃對話面板。
  - **靈動寵物狀態連動**：對話頂部即時呈現寵物頭像與狀態燈（思考中 🟡、線上即時 🟢）。
  - **流暢串流輸出 (Streaming Response)**：即問即答，打字機動態光標。
  - **完整 Markdown 與語法高亮**：支援代碼區塊一鍵複製、條列項、引用與重點強調。
  - **快速指令膠囊**：提供文字潤色、代碼除錯、核心提煉、商務郵件、番茄鐘等常用 Prompt。

---

### 2. 🧠 多樣化 AI 模型支援
- **✦ 內建智慧模式**：免設定、零 API Key 門檻，開箱即享溫暖陪伴與基礎問答。
- **OpenAI**：支援 `gpt-4o`、`gpt-4o-mini`、`o1` 等全系列模型。
- **Google Gemini**：支援 `gemini-2.0-flash`、`gemini-1.5-flash`、`gemini-1.5-pro`。
- **Anthropic Claude**：支援 `claude-3-5-sonnet`、`claude-3-5-haiku`。
- **Ollama (本機完全離線)**：串接 `http://localhost:11434`，保護隱私，免聯網費用。
- **自定義相容端點**：相容 DeepSeek、Moonshot、SiliconFlow 等 OpenAI-compatible API。

---

### 3. 📸 真實寵物照片建模 (Real Pet Photo Companion)
- **支援上傳自家毛小孩照片**（貓貓、狗狗、鳥鳥、兔兔等任何寵物照片）。
- **智慧邊緣柔化與動態光暈**：三種懸浮輪廓風格（✨ 靈動光環懸浮、🔮 現代毛玻璃圓環、🌿 柔和無邊框原形），擺脫死板的方框截圖。
- **生動動態物理模擬**：真實寵物照片自帶呼吸起伏 (`@keyframes realPetBreathe`)、靈動浮動、撫摸產生愛心與音效反饋。
- **個性與靈魂注入**：在設定中填寫自家毛小孩的品種與真實性格（如「貪吃肉泥、喜歡被摸下巴、傲嬌」），**AI 對話時會自動繼承真實寵物的人格與第一人稱說話**！

---

### 4. 🎨 四款風格化預設形象 (隨時無縫切換)
1. **Lumi 賽博靈狐 🦊**：飄逸的霓虹狐耳、發光額印與柔和狐尾，科技靈動感十足。
2. **Koma 柴犬寶貝 🐕**：圓嘟嘟的小肉頰、搖尾巴與吐舌頭，溫暖治癒滿分。
3. **Luna 霓虹貓咪 🐱**：深色賽博萌貓、大大的發光青藍瞳孔與靈動貓耳。
4. **Mochi 星雲水滴 ✨**：Q彈果凍水滴身體、頭頂幸運星，夢幻可愛。

---

## ⌨️ 快捷鍵指南

| 快捷鍵 | 作用 |
| :--- | :--- |
| **`Option + Space`** (Mac) / **`Alt + Space`** (Win/Linux) | 瞬間在「桌面寵物」與「ChatGPT 對話面板」間雙向切換 |
| **`Cmd/Ctrl + Shift + P`** | 快速喚起並聚焦寵物視窗 / 隱藏 |
| **`Esc`** | 快速將對話面板收攏回桌面寵物形態 |
| **`Enter`** | 發送對話訊息 |
| **`Shift + Enter`** | 換行輸入 |

---

## 🚀 快速啟動與開發指南

### 1. 安裝依賴
```bash
cd desktop-pet
npm install
```

### 2. 本機啟動
```bash
npm start
```

### 3. 打包發布 (Win / Mac / Linux)
專案預先配置好 `electron-builder`：

- **打包為 macOS 應用程式 (.dmg / .zip)**：
  ```bash
  npm run dist -- --mac
  ```
- **打包為 Windows 執行檔 (.exe / 免安裝版)**：
  ```bash
  npm run dist -- --win
  ```
- **打包為 Linux 應用程式 (.AppImage / .deb)**：
  ```bash
  npm run dist -- --linux
  ```

---

## 📂 專案檔案結構

```text
desktop-pet/
├── package.json          # 專案配置、依賴與跨平台打包參數
├── main.js               # Electron 主進程 (透明無邊框視窗、托盤選單、全域快捷鍵、IPC 通信)
├── preload.js            # 安全的 ContextBridge API 注入
└── renderer/             # 前端視圖與邏輯
    ├── index.html        # 雙形態 HTML 架構 (寵物介面 + ChatGPT 對話窗 + 設定對話框)
    ├── styles.css        # 現代深色毛玻璃設計系統、流暢粒子動畫與 Sprite 樣式
    ├── pet.js            # 寵物動畫引擎、SVG 皮膚渲染、Web Audio 音效合成、親密度系統
    ├── ai-service.js     # 多模型 AI 調用與串流處理器 (OpenAI/Gemini/Claude/Ollama/內建)
    └── app.js            # 主介面狀態協調、即時 Markdown 渲染、快捷鍵與設定同步
```

---

## 💡 跨平台相容性細節
- **macOS**：利用 `mainWindow.setAlwaysOnTop(true, 'floating', 1)` 與 `setVisibleOnAllWorkspaces` 確保在多桌面與全螢幕 App 切換時寵物依舊能優雅常駐。
- **Windows**：無邊框透明視窗支援微軟 DWM 硬體合成，滑鼠拖曳與縮放無鋸齒邊緣。
- **Linux**：加入 `--enable-transparent-visuals` 參數適配 X11 與 Wayland 桌面環境。
