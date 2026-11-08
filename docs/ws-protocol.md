# AuraPet Bridge Protocol（WS）v0.1

Status：**CANDIDATE**。機器可讀契約與 contract test 已落地（見第 6 節）；Godot body v0
（`godot/`，issue #11）已實作 body 端，chat／settings 由 daemon 的 localhost UI 頁
（`ui/`，issue #12）以 `ui` 角色承載，Node daemon 仍嵌在 Electron main（#15 抽出）。
兩端正式拆分後升 v1.0／FROZEN。凍結後同 v 只允许 additive 變更
（新增訊息／新增欄位），breaking 變更一律 v+1。

## 0. 定位與邊界

本協議是**私有內部契約**：Node daemon（brain）與 Godot renderer（body）、按需 UI（ui）
之間的 localhost 訊息約定。傳輸層用 WebSocket（RFC 6455），僅聽 127.0.0.1。

**MCP 邊界規則**：daemon 對外（筆記軟體 MCP servers、外部 MCP clients）一律講標準 MCP
（JSON-RPC 2.0、stdio／Streamable HTTP transport），由 MCP SDK 處理；本協議的 WS 與 JSON
shape **绝不對外暴露、也不承載 MCP 訊息**。daemon 內部負責翻譯（MCP tool result → pet 反應
→ `say`；外部 MCP tool call → daemon → `say`／`pose.set`）。因此 body／ui 換殼不影響 MCP 合規。

MCP server face 由 `daemon/mcp-server.js` 以標準 Streamable HTTP（127.0.0.1＋bearer token）
實作，完全不經過本 WS；UI 只透過上面 `mcp.status`／`mcp.server.status` 看狀態。

## 1. 角色與連線

- `brain`：Node daemon。WS server，預設 127.0.0.1:47821（設定可改）。擁有：設定、pet 狀態機、
  AI service、MCP client/server faces、roam 決策。
- `body`：Godot renderer。WS client。擁有：透明視窗、rig 渲染、輸入、tray（若實作於 body）、
  視窗移動執行。 reconnect backoff 1s→30s cap。
- `ui`：按需 chat／設定頁（瀏覽器或未來原生）。WS client，開著才連。

安全：hello 帶 config 檔（0600）內的 shared token；brain 拒絶不符者。loopback only、無 TLS 需求。

## 2. Envelope

```json
{ "v": 1, "id": 7, "t": "roam.get" }                  // 有 id = request
{ "v": 1, "id": 7, "ok": true, "enabled": true }      // reply 帶同 id
{ "v": 1, "id": 7, "ok": false, "error": { "code": "bad-state", "message": "..." } }
{ "v": 1, "t": "say", "text": "喵～", "emotion": "happy" }   // 無 id = event
```

- 收到未知 `t`：有 id 回 error `unknown-type`；無 id 記 log 忽略（forward compat）。
- 未知欄位一律忽略（additive 規則）。
- reply 以 `id` 對應請求、不重複帶 `t`；payload 型別由 pending id 決定。

## 3. 生命週期

| t | 方向 | 欄位 | 語意 |
| --- | --- | --- | --- |
| hello | body/ui→brain | role, name, version, protocol, token | 連線 handshake |
| hello-ack | brain→client | ok, session, protocol, brainVersion | 接受；protocol 不符回 error 並斷線 |
| state.sync | brain→body | mode, posture, skin, nickname, roamEnabled, visibility, clickThrough, alwaysOnTop | 連線／重連後全量快照，body 據此恢復畫面 |
| ping / pong | 雙向 | ts | heartbeat；連 miss 3 次視同斷線 |
| bye | 雙向 | reason | 正常關閉 |

## 4. 訊息清單

### mode（形態 pet|chat）
| t | 方向 | 欄位 | 語意 |
| --- | --- | --- | --- |
| mode.request | ui→brain | mode | 要求切換形態 |
| mode.toggle | body/ui→brain | — | tray／hotkey 觸發；brain 算下一個 mode |
| mode.set | brain→body | mode | 命令 body 切換視窗形態 |
| mode.changed | body→brain→ui | mode | body 確認完成（brain 轉發 ui） |

### window（body 擁有視窗能力）
| t | 方向 | 欄位 | 語意 |
| --- | --- | --- | --- |
| window.set | ui→brain | alwaysOnTop?, clickThrough?, forward?, visible? | 要求視窗屬性 |
| window.apply | brain→body | 同上 | 命令 body 套用（click-through＝mouse passthrough） |
| window.state | body→brain→ui | alwaysOnTop, clickThrough, visible, x, y | 屬性／位置回報 |
| window.minimize / window.close | ui→brain→body | — | 最小化／退出（close 由 brain 決定 shutdown 順序） |

### roam（brain 決策、body 執行移動）
| t | 方向 | 欄位 | 語意 |
| --- | --- | --- | --- |
| roam.get | ui→brain | (id) | reply {enabled} |
| roam.set-enabled | ui→brain | enabled | 寫設定 |
| roam.enabled | brain→body+ui | enabled | 廣播 |
| roam.command | brain→body | action: start\|stop\|park, dir?, target? | 命令移動／停／park |
| roam.state | body→brain→ui | state: idle\|walk-left\|walk-right, x, y | 移動狀態回報（body 選 walk pose 用） |

### pet（狀態機在 brain；演出在 body）
| t | 方向 | 欄位 | 語意 |
| --- | --- | --- | --- |
| interaction | body/ui→brain | kind: pat\|feed\|click\|…, source: tray\|window\|ui | 互動事件；brain 更新 affection/energy 並決定反應 |
| activity | body→brain | — | 重置 idle 計時（舊 pet-activity） |
| react | brain→body | kind, emotion | 反應演出（happy／eating…） |
| say | brain→body | text, emotion?, ttlMs?, speech? | 對話气泡＋可選 TTS |
| pose.set | brain→body | posture: sit\|doze\|rest\|sleep\|walk, skin? | 姿勢／skin 切換 |
| sound.play | brain→body | clip | 音效 |
| ui.busy | ui→brain | busy | chat 開／streaming 中；brain 據此 pause roam |

### ui／chat／settings（只走 ui↔brain，body 不參與）
| t | 方向 | 欄位 | 語意 |
| --- | --- | --- | --- |
| chat.send | ui→brain | text | 送 LLM（ai-service 住 brain） |
| chat.delta / chat.done / chat.error | brain→ui | text / full / error | streaming 回覆 |
| chat.abort | ui→brain | — | 中止目前串流；brain 回 chat.done（已產生的 full） |
| settings.get / settings.set | ui↔brain | (id) / patch | 設定讀寫；brain 廣播 settings.changed |
| settings.changed | brain→ui | patch | 廣播 |

### mcp（只走 ui↔brain；body 永远看不到 MCP 細節）
| t | 方向 | 欄位 | 語意 |
| --- | --- | --- | --- |
| mcp.servers.get | ui→brain | (id) | reply {servers:[{name, transport, state, toolCount, error?}]} |
| mcp.status | brain→ui | servers | 上游連線／工具數變化廣播（同上；憑證與 URL 一律不進 payload） |
| mcp.server.status | brain→ui | enabled, port, clients, tools | MCP server face（`daemon/mcp-server.js`）狀態：監聽埠、session 數、已實作 tool 名 |

上游欄位：`transport` 為 `stdio`／`streamable-http`；`state` 為 `configured`／`connecting`／
`ready`／`error`／`stopped`；`error` 只在失敗時出現，且已遮罩 token。連線由
`daemon/mcp-client.js`（issue #13 / #32）管理：`mcpUpstreams` 設定（0600）每項
`{name, transport, url|command, args?, env?, token?, tokenIn?: "header"|"query"}`，
工具內部命名為 `<server>.<tool>`，重連 backoff 1s→30s。Joplin 內建 endpoint 需
`tokenIn: "query"`；Jira 支援 stdio（`JIRA_URL`、`JIRA_EMAIL`、`JIRA_API_TOKEN`）與 Issue 結構（`issues`）自動萃取，其 token 與憑證只存 0600 config，
不進 log／WS／status。

### sysinfo（系統資源／htop 資訊，Linux 優先＋跨平台 fallback）
| t | 方向 | 欄位 | 語意 |
| --- | --- | --- | --- |
| sysinfo.get | body/ui→brain | (id) | 取得即時系統資源快照（reply 帶 cpu, memory, swap, processes, uptime） |
| sysinfo.subscribe | body/ui→brain | — | 訂閱即時推播（brain 定時採集並廣播 sysinfo.data） |
| sysinfo.unsubscribe | body/ui→brain | — | 取消訂閱（無訂閱者時 brain 停止背景採集） |
| sysinfo.data | brain→body/ui | cpu, memory, swap, processes, uptime | 即時推播系統監控數據 |

## 5. 舊 preload channel 對照（遷移血統）

| 舊（Electron IPC） | 新 |
| --- | --- |
| switch-mode | mode.request → mode.set |
| mode-changed | mode.changed |
| toggle-mode-request | mode.toggle → mode.set |
| set-always-on-top | window.set → window.apply |
| minimize-app | window.minimize |
| close-app | window.close |
| set-ignore-mouse-events | window.set(clickThrough, forward) → window.apply |
| pet-interaction | interaction(source:tray, kind:pat/feed) → react |
| pet-activity | activity |
| roam-state | roam.state（改由 body 回報）＋ roam.command |
| window-visibility | window.state(visible)（改由 body 回報） |
| set-ui-busy | ui.busy |
| get-roam-enabled | roam.get (request/reply) |
| set-roam-enabled | roam.set-enabled → roam.enabled |

方向翻轉備註：Electron 時代 main process 擁有視窗，故 roam-state／window-visibility 是
main→renderer；新架構 body 擁有視窗，改為 body→brain 回報、brain 轉發 ui。

## 6. 機器可讀契約

- 契約本體：`tools/bridge/protocol.schema.json`（envelope、全部 type、必填欄位、方向、
  第 5 節 14 條舊 channel 對照）。
- 驗證測試：`node tools/bridge/contract-test.mjs`（零依賴；exit 0 才算守約，`checks` CI 會跑）。
- 驗證規則：request＝有 `id` 無 `ok`（`t` 必填且須允許 request）；reply＝有 `id` 有 `ok`
  （以 pending id 對應請求型別驗 payload；`ok:false` 必帶 `error.code`／`error.message`）；
  event＝無 `id`、`ok`；未知 `t` 無 id 忽略、有 id 回 `unknown-type`；未知欄位忽略。
- 新增 type 時同步 schema／fixtures／本文件；測試會抓漏。同 v 只加不改，breaking 才 v+1。

## 7. 演化和凍結規則

- 同 v：只加訊息／欄位，不改語意、不刪欄位；接收端忽略未知。
- breaking：v+1，hello 協商；brain 同時支援舊 v 一個過渡期。
- 凍結動作：兩端實作 merge 後本文件升 v1.0 並標 FROZEN；之後變更走 PR review。