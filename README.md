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
需要 **Node.js 22.12+**（建議 24，版本見 `.nvmrc`）：
```bash
cd mabi
nvm use            # 或自行切換到 Node 24
npm ci
```

### 2. 本機啟動
```bash
npm start
```

### 3. 打包發布（Linux／Windows）
v2 的產物不再走 electron-builder：Godot body（embedded pck）＋ Node SEA daemon
單檔＋launcher。Linux 產出 AppImage／deb，Windows 產出 zip（exe＋cmd 啟動器）。

```bash
nvm use
npm ci
npm run dist:linux      # → dist/linux/AuraPet-<version>-x86_64.AppImage、aurapet_<version>_amd64.deb
npm run dist:win        # → dist/windows/AuraPet-<version>-win64.zip
```

需要 Godot 4.7.2 editor binary（`GODOT_BIN=/path/to/Godot_v4.7.2-stable_linux.x86_64`，
預設找 `~/桌面/godot-pet-probe/`）與 `mksquashfs`（squashfs-tools；本機若無會用
electron-builder 快取）。AppImage runtime 缺少時自動下載。也可免安裝檢查 deb 佈局：

```bash
dpkg-deb -x dist/linux/aurapet_<version>_amd64.deb /tmp/aurapet-deb
/tmp/aurapet-deb/usr/bin/aurapet
```

`dist:win` 可在 Windows 直接執行，也可在 Linux／macOS 交叉建置（會下載同版本
win-x64 `node.exe`；Godot Windows export templates 需已安裝）。解壓後執行
`AuraPet-win64\aurapet.cmd`：先起 `aurapet-daemon.exe`，再開 Godot body；
設定檔在 `%APPDATA%\aurapet-desktop\app-settings.json`。macOS 打包尚未遷移（見 #16）。

### 4. GitHub Actions 遠端建置
`.github/workflows/release.yml` 建置 Linux 與 Windows：

- Actions 頁面 `Run workflow`（`dry_run=true` 預設）：建置並上傳 Actions Artifacts，**不發 Release**。
- 人工推送 `v*` tag：建置後上傳 AppImage／deb／Windows zip 到 GitHub Release。

Godot binary 與 2 GB export templates 以 `actions/cache` 快取，重跑不必重新下載；
Windows job 另做打包後 daemon 的 loopback smoke（UI 403／MCP 401）。

### 5. Godot body 與效能實測（v2 退役 Electron）
Epic #7 已正式完成架構重構並退役 Electron。body 實作在 `godot/`：透明視窗、rig、tray、roam 改由 Godot 4.7 執行，只透過 `docs/ws-protocol.md` 連 Node daemon。Godot 4.7.2 binary 不進 repo；啟動方式、Linux tray helper（Ayatana AppIndicator）與 CPU/RSS 量測見 `godot/README.md`。

跨平台實測數據對照表（240×290 透明置頂視窗，詳細見 `tools/godot-probe/README.md`）：

| 執行環境 / 堆疊 | idle CPU | walk CPU | RSS 記憶體 | 效能差異 |
| :--- | :---: | :---: | :---: | :--- |
| **Electron v1.5.2** (Linux baseline) | ~36% | ~62% | 679 MB | 舊架構 baseline |
| **Godot body v0** (Linux Vega 8) | 11% | 17% | 242 MB | idle 省 3.3x，RAM 省 2.8x |
| **Godot body v0** (**Windows 11 DWM**) | **0.8%** | **0.8%** | **417 MB** | **CPU 降低 45~77 倍** |
| **Node SEA Daemon** (**Windows 11**) | **0.0%** | **0.0%** | **46 MB** | 無介面 headless 大腦 |

### 6. 按需 chat／設定頁（localhost）
daemon 在 `http://127.0.0.1:47830/` 提供現有 chat／設定 DOM（需 bridge token；tray
「開啟對話／設定」會帶 token 開啟）。頁面關閉即零成本，設定與聊天都走 WS；舊 Electron
`localStorage` 會在升級後一次性遷進 daemon config。細節見 `ui/README.md`。

### 7. MCP server face（本機 AI 助理呼叫寵物）
daemon 在 `http://127.0.0.1:47822/mcp` 提供標準 MCP Streamable HTTP（`mcpPort` 可覆寫），
只綁 loopback、需 `Authorization: Bearer <mcpToken>`（0600 config），並檢查 Origin／Host
allowlist。tools：`pet.say`、`pet.mood.get`、`pet.ask`＋`pet.ask.result`（非同步 ticket）、
`notes.search`（聚合 `mcpUpstreams` 設定的上游筆記 MCP）。body 完全不知道 MCP 存在；
設定頁「系統設定」可看 server／上游狀態。細節見 `daemon/README.md`。

### 8. MCP client face（上游筆記 MCP 聚合）
daemon 也是 MCP **client**：`mcpUpstreams`（設定檔 `app-settings.json`，0600；Linux
`~/.config/aurapet-desktop`、macOS `~/Library/Application Support/aurapet-desktop`、
Windows `%APPDATA%\aurapet-desktop`）列出既有筆記 server，工具以 `<server>.<tool>` 命名。
支援 Streamable HTTP 與 stdio：

```jsonc
{
  "mcpUpstreams": [
    { "name": "joplin", "transport": "streamable-http",
      "url": "http://127.0.0.1:41184/mcp", "token": "<Joplin api.token>", "tokenIn": "query" },
    { "name": "honoka", "transport": "stdio",
      "command": "node", "args": ["/path/to/honoka-publish/bin/honoka-publish.js"],
      "env": { "HONOKA_DIR": "/home/<user>/honoka-docs" } },
    { "name": "obsidian", "transport": "stdio",
      "command": "npx", "args": ["-y", "mcp-obsidian"], "env": { "OBSIDIAN_API_KEY": "<key>" } },
    { "name": "jira", "transport": "stdio",
      "command": "npx", "args": ["-y", "@modelcontextprotocol/server-jira"],
      "env": {
        "JIRA_URL": "https://your-domain.atlassian.net",
        "JIRA_EMAIL": "user@example.com",
        "JIRA_API_TOKEN": "<Jira API token>"
      }
    }
  ]
}
```

Joplin 需在設定開啟 Web Clipper（API token 在「Web Clipper → API token」）；其內建 endpoint
只吃 `?token=`，所以 `tokenIn: "query"`。Honoka（honoka-publish）以 stdio 接入，暴露
`save_url`／`download_video`（背景 ticket＋`get_job_status`）、`search_notes`、`list_inbox`；
其 Joplin 憑證讀自身的 `HONOKA_DIR/.honoka/bridge-settings.json`，不必放進 mabi 設定。
`notes.search` 會聚合 honoka 的 `search_notes`；`pet.ask` 對「筆記」相關問題會先搜上游筆記、
把命中結果注入 prompt（ticket 結果附 `context: {hits, sources}`）。token／env 只寫 config，
不進 log、WS 或 `mcp.status`；`settings.get` 會回傳 `auth: "configured"`／`envKeys` 而不是憑證。重連 backoff 1s→30s，stdio 子進程
會隨 daemon 停止。驗證：`node tools/mcp/upstream-smoke.mjs --from-joplin`（真實上游
tools/list＋tools/call，並斷言 token 不外洩）。

---

## 📂 專案檔案結構

```text
mabi/
├── package.json          # 專案配置、依賴與跨平台打包參數
├── .nvmrc                # 建置用 Node 版本
├── main.js               # Electron 主進程 (透明無邊框視窗、托盤選單、全域快捷鍵、IPC 通信)
├── preload.js            # 安全的 ContextBridge API 注入
├── daemon/               # brain 模組：config store、pet state、AI service、WS bridge
├── godot/                # Godot body v0：透明視窗、rig、tray helper、probe
├── ui/                   # 按需 chat／設定頁的瀏覽器 shim
├── packaging/            # Linux launcher／.desktop 與 Windows .cmd 啟動器
├── tools/dist/           # 打包：Godot export＋Node SEA（Linux AppImage／deb、Windows zip）
├── tools/bridge/         # 協議 schema、contract test、headless dev brain
├── tools/mcp/            # MCP server／client face smoke tests
├── assets/               # 托盤圖示 (macOS template PNG + Win/Linux 彩色 PNG)
├── build/icon.png        # 應用程式圖示 (electron-builder 會轉成 .icns/.ico)
├── .github/workflows/    # GitHub Actions 遠端建置與 Release
└── renderer/             # 前端視圖與邏輯
    ├── index.html        # 雙形態 HTML 架構 (寵物介面 + ChatGPT 對話窗 + 設定對話框)
    ├── styles.css        # 現代深色毛玻璃設計系統、流暢粒子動畫與 Sprite 樣式
    ├── pet.js            # 寵物動畫引擎、SVG 皮膚渲染、Web Audio 音效合成、親密度系統
    ├── rig2d.js          # three.js 2D 網格變形 rig
    ├── ai-service.js     # 多模型 AI 調用與串流處理器 (OpenAI/Gemini/Claude/Ollama/內建)
    ├── app.js            # 主介面狀態協調、即時 Markdown 渲染、快捷鍵與設定同步
    └── models/           # cat2d / ami2d / kk2d 貼圖、meta 與 rig 權重
```

---

## 💡 跨平台相容性細節
- **macOS**：利用 `mainWindow.setAlwaysOnTop(true, 'floating', 1)` 與 `setVisibleOnAllWorkspaces` 確保在多桌面與全螢幕 App 切換時寵物依舊能優雅常駐。
- **Windows**：無邊框透明視窗支援微軟 DWM 硬體合成，滑鼠拖曳與縮放無鋸齒邊緣。
- **Linux**：加入 `--enable-transparent-visuals` 參數適配 X11 與 Wayland 桌面環境。
