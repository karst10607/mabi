# Honoka × AuraPet 整合指南（含 ADR 0002 單一 Daemon 收斂架構）

> **架構更新（[ADR 0002](adr/0002-unified-daemon-and-media-mcp.md)）**：
> 1. **常駐 Daemon 收斂**：移除 Playwright 截圖強依賴後，純 JS 網頁文章擷取（HTML→Markdown）與 Joplin／本地 Inbox 歸檔已直接內建於 `mabi` 的跨平台常駐 Daemon（`daemon/url-ingest.js` / MCP `notes.save_url`），不再強制要求額外常駐 `honoka-bridge.service`。
> 2. **隨選影音下載（YT / FB / IG / X）**：`yt-dlp` 影片下載獨立為 `tools/mcp/yt-dlp-mcp.mjs`（stdio MCP），平時 0 MB 記憶體不常駐，需要載片時才由 MCP Client 按需喚醒。
> 3. **向下相容**：以下說明保留既有 `karst10607/honoka-publish` 外部掛載（`mcpUpstreams` + `honokaEvents` SSE）之完整相容配置。

## 架構（ADR 0002 推薦模式 vs. 傳統外部模式）

```
[ADR 0002 單一常駐 Daemon 模式]
MCP clients / 使用者 ──► AuraPet daemon (127.0.0.1:47822/mcp)
                            ├─ 內建 notes.save_url (純 JS HTML→MD + Joplin / Inbox) ──► bridge.say 氣泡
                            └─ mcpUpstreams (stdio, 按需喚醒) ──► tools/mcp/yt-dlp-mcp.mjs (YT/FB/IG/X 影片下載)

[傳統外部 honoka-publish 相容模式]
Telegram / Discord ──► honoka-publish daemon ──┬─ yt-dlp 影片下載
MCP clients（Antigravity…）──stdio MCP───────►│─ Chromium 整頁截圖 (選用)
                                              ├─ Joplin 筆記（Clipper REST）
                                              ├─ 事件 GET /events（SSE, token）
                                              └─ MCP stdio tools
AuraPet daemon ──mcpUpstreams(stdio)──► honoka.<tool>（pull）
AuraPet daemon ──honokaEvents(SSE)────► bridge.say ──► Godot body 氣泡（push）
```

- **常駐輕量邊界（ADR 0002）**：`mabi/daemon/` 僅內建純 JS 資訊收集與筆記歸檔，嚴禁引入 Playwright/Chromium；`yt-dlp` 獨立於 `tools/mcp/yt-dlp-mcp.mjs` 隨選呼叫。
- **MCP 是 pull**：AI/agent 主動呼叫工具；server 不能喚醒 AI。
- **事件是 push**：內建擷取或外部 SSE 事件 → mabi daemon → 既有 WS `say` → 氣泡；不經 LLM、不加新 WS type。
- **程序分離**：`yt-dlp-mcp.mjs` 為隨選 stdio 子行程，載完即退；傳統 `honoka-launch` 亦可拉起桌寵（detached child）。


## 設定步驟

### 1. honoka-publish

```bash
cd honoka-publish
npm ci
node bin/honoka-publish.js bridge     # 或 honoka-launch（順便拉起桌寵）
```

設定檔 `HONOKA_DIR/.honoka/bridge-settings.json`（0600，`bridgeToken` 首次啟動自動生成）：

| 鍵 | 說明 |
| --- | --- |
| `joplinApiUrl` / `joplinToken` / `joplinNotebookId` | Joplin Web Clipper（Settings → Web Clipper 開啟，token 在該頁） |
| `telegramBotToken` / `telegramAllowedUser` | @BotFather token＋自己的 Telegram user id（建議限制單一使用者） |
| `videoDir` / `videoMaxSizeMB` | 影片存放位置與大小上限（預設 500 MB） |
| `bridgeToken` | bridge／SSE 認證（Bearer 或 `?token=`） |

用 API 寫入（不落地手動編輯亦可）：

```bash
curl -X POST http://127.0.0.1:44124/api/settings \
  -H "Authorization: Bearer <bridgeToken>" -H "Content-Type: application/json" \
  -d '{"telegramBotToken":"…","telegramAllowedUser":"…","joplinApiUrl":"http://127.0.0.1:41184","joplinToken":"…","joplinNotebookId":"…"}'
```

Telegram 收到連結後的行為：影片平台（YouTube/Bilibili/X/Vimeo/TikTok…）→ yt-dlp 下載＋進度回報；其餘 → Readability 擷取＋整頁截圖 → Joplin 筆記；失敗重試一次後落 `Inbox/`。

### 2. mabi（AuraPet）

`app-settings.json`（0600；Linux `~/.config/aurapet-desktop/`）：

```jsonc
{
  "mcpUpstreams": [
    {
      "name": "honoka",
      "transport": "stdio",
      "command": "node",
      "args": ["/path/to/honoka-publish/bin/honoka-publish.js"],
      "env": { "HONOKA_DIR": "/home/<user>/honoka-docs" }
    }
  ],
  "honokaEvents": {
    "url": "http://127.0.0.1:44124/events",
    "token": "<honoka bridgeToken>"
  }
}
```

- `mcpUpstreams` → `notes.search` 聚合 honoka `search_notes`；`pet.ask` 對「筆記」問題先搜上游並把命中注入 prompt（ticket 附 `context:{hits,sources}`）。
- `honokaEvents` → 氣泡：`url_received` 🔗、`note_saved` 📝、`error` ⚠️、`download_progress` 收斂 25% 桶。
- 憑證：只有 `bridgeToken` 進 mabi 設定；Joplin/Telegram token 留在 honoka。`settings.get` 會回傳 `auth:"configured"`／`envKeys`。

### 3. 可選：honoka 啟動時順便拉起桌寵

```bash
AURAPET_DIR=~/mabi honoka-launch        # 偵測 47821，未執行才 detached 拉起
HONOKA_NO_PET=1 honoka-launch           # 只開 bridge
```

## 驗證指令

```bash
# honoka
curl -N "http://127.0.0.1:44124/events?token=<bridgeToken>"   # 應先收到 retry，再收到事件
npm test                                                       # 70/70

# mabi
node tools/mcp/upstream-smoke.mjs --config ~/.config/aurapet-desktop/app-settings.json --search 筆記
npm test                                                       # 16 contract + 63 smoke

# MCP face（mabi daemon 運行中）
curl -s http://127.0.0.1:47821/... 經 MCP 工具 notes.search / pet.ask
```

端到端：手機 Telegram 丟一條 YouTube 連結 → 桌寵冒出 🔗 → ⬇️ 25/50/75/100% → 📝；Joplin 出現筆記（含截圖附件）。

## 故障排除

| 症狀 | 檢查 |
| --- | --- |
| Telegram bot 無反應 | `telegramBotToken`／`telegramAllowedUser` 是否設定；網路是否需 VPN（polling）；`/status` 的 `integrations.telegram` |
| 筆記沒進 Joplin | Joplin 是否開啟 Web Clipper；`joplinToken`／`joplinNotebookId`；失敗會出現在 `<HONOKA_DIR>/Inbox/`（`list_inbox` 可查） |
| 筆記沒有截圖 | `npx playwright install chromium`；headless 主機可設 `HONOKA_DISABLE_CAPTURE=1` 走純文字 |
| 下載失敗 | `yt-dlp` 是否在 PATH；影片超過 `videoMaxSizeMB` 會被刪除並落 Inbox；非播放清單限制（`--no-playlist`） |
| 氣泡不出現 | `honokaEvents.url`（44124）／token 是否正確；honoka bridge 是否在跑；改設定後 daemon 需 reload／重啟 |
| MCP 工具沒列出 | `mcpUpstreams` 的 `command`／`args` 路徑；`HONOKA_DIR` env；`mcp.servers.get` 狀態 |
| 401／403 | bridge 需 `Authorization: Bearer <bridgeToken>`；SSE/EventSource 用 `?token=`；CORS 只允許 `bridgeAllowedOrigins` |

## 邊界規則（摘要，詳見 ADR 0002）

1. **禁止引入巨型二進位依賴進常駐 Daemon**：`mabi/daemon/` 僅允許純 JS 模組（如內建 `url-ingest.js`），嚴禁引入 Playwright / Chromium / JSDOM。
2. **外部二進位工具隨選化**：`yt-dlp` 影音下載獨立於 `tools/mcp/yt-dlp-mcp.mjs`（stdio MCP，平時不常駐）。
3. **WS 協議 additive-only**：事件复用 `say`，要新增 type 先改 `docs/ws-protocol.md`。
4. **Payload 不含 token／筆記內文**（只有 URL／標題／狀態）；桌寵離線時事件可丟棄（UI 通知非關鍵路徑）。
5. **版本／release 一律人工批准**（agent 只做 patch 版號＋CHANGELOG）。

