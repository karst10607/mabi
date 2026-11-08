# AGENTS.md — AuraPet agent 工作規範

本檔是任何 agent（Qoder 排程、Copilot coding agent、手動 session）在此 repo 工作的**行為契約**。
目標架構見 Epic（`gh issue list --label v2`）；body↔daemon 協議見 `docs/ws-protocol.md`。

## 1. 專案現況與方向

- AuraPet 目前是 Electron 桌面寵物（v1.5.2）。渲染＝THREE 自訂 shader skinning（`renderer/rig2d.js`）。
- 實測（`tools/godot-probe/README.md`、`tools/diagnostics/README.md`）：Linux 透明視窗 idle
  Electron ~36%／679MB；Godot full-rig 11%／17%／216MB（idle／walk）。
- 遷移方向：**Chromium 殼 → Godot body；Node 留為 headless daemon**（大腦＋MCP faces）。
- body↔daemon 唯一通道＝`docs/ws-protocol.md`（DRAFT v0.1）。MCP 對外只講標準
  stdio／Streamable HTTP（見 issue #4 勘誤：不用舊 HTTP+SSE、MCP 不放上本專案 WS、
  pet 當 MCP server 需非同步 ticket）。

## 2. 自動 loop 契約

1. 一次只允許一個 agent session 動這個 repo。每輪開始先檢查：若有 label `agent-working`
   且 `updatedAt` 在 90 分鐘內的 issue，視為另一個 session 正在跑——本輪直接結束，
   不做任何 git 操作。
2. 選題與自主建單：
   - 既有題選取：open、label `agent-ready`、body 的 `Blocked by` 所列 issue 全數關閉、編號最小者。
   - 自主建單與 triage：遇使用者提出新需求或發現現有 bug 時，允許 agent 主動開立 issue，清楚填寫現況、預期行為、DoD 與驗證方式，打上適當標籤（如 `bug` / `enhancement` 與 `agent-ready`），依優先度進行 triage 後依序排入開發。
3. 開工：label 換 `agent-working`，在 issue 留言一行計畫。
4. 分支 `agent/issue-<N>`；完成後 push、開 PR（body 寫 `Closes #N`＋驗證證據）。
5. `checks` CI 綠 → squash merge 回 main；紅兩次 → label `agent-blocked`、留言原因、跳過該題。
6. 收尾：issue 貼證據後關閉、移除 `agent-working`。**接著回到第 2 步取下一個題，
   直到沒有可做的題或本輪累計 90 分鐘**；結束時彙報本輪完成的全部 issue。
7. 卡住（需硬體／需使用者決策／上游 repo）→ `agent-blocked`＋`needs-human`，跳過該題繼續。
8. 禁止：發 release／打 tag、force push、改 git config、動系統設定、提交 secrets。
9. 心跳：長題實作期間每 20–30 分鐘在 issue 留一行簡短進度，讓 `updatedAt` 保持新鮮——
   單寫者檢查（第 1 條）靠它判斷是否還有 session 在跑。

## 3. 驗證指令（issue 的 DoD 一律引用這些）

| 用途 | 指令 |
| --- | --- |
| 安裝 | `nvm use && npm ci` |
| 跑 app | `npm start` |
| JS 語法 | `node --check <file>`（對 main.js／preload.js／renderer/*.js／daemon/*.js／tools/bridge/*.mjs） |
| Shell 語法 | `find . -name '*.sh' -not -path './node_modules/*' -exec bash -n {} \;` |
| 協議 contract | `node tools/bridge/contract-test.mjs` |
| Godot parse | `cd godot && <godot-bin> --headless --path . --import`（bin 取得方式見 tools/godot-probe/README.md） |
| CPU/RSS probe | 見 `tools/godot-probe/README.md`；序列量測、量前停 Electron pet、量後恢復 |
| CI | GitHub Actions `checks` workflow（只做靜態檢查；**CI runner 無 X11/GPU，透明 probe 不可在 CI 跑**） |

## 4. 量測紀律（違反會得到假數據）

- 一次只跑一個 benchmark；不可並行（共享 CPU/GPU 會污染結果）。
- CPU 用 `/proc/<pid>/stat` 的 utime+stime 差值；**不要用 CDP 量 CPU**（實測膨脹 150–200%）。
- `pkill`／`pgrep` pattern 不得在 wrapper cmdline 中自我命中；用 `[e]lectron`、
  `^[.]/Godot` 這類寫法。
- 量完必須恢復使用者環境（重開 Electron pet），並在 issue 註明。

## 5. Commit／版本

- 身分：`git -c user.name="Howl" -c user.email="karst10607@gmail.com" commit ...`；
  **永不修改 git config**。
- 訊息風格照 `git log`：`perf(linux): ...`、`fix(eyes): ...`、`tools: ...`、`docs: ...`。
- 行為變更→CHANGELOG＋版本 bump；docs／tools／CI 不 bump。**tag／release 一律人工批准**。
- `gh` 不在 PATH：`/home/koto/公共/House_Loan/gh_2.67.0_linux_amd64/bin/gh`。

## 6. 環境

- Node 版本見 `.nvmrc`（24）。Godot binary 不進 repo，依 probe README 下載。
- 本機：Linux／X11／Cinnamon／Vega 8。Win／mac／Wayland 驗證屬 `needs-human`。
