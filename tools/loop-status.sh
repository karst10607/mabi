#!/bin/bash
# AuraPet agent loop 儀表板（GitHub 側）
# 用法：./tools/loop-status.sh
# 這只反映 GitHub 狀態；排程 run 本身（pending/running/success/failed）在
# Qoder 的 Automations 頁，或直接叫 agent 查 qoder_cron list。
set -u
GH=${GH:-/home/koto/公共/House_Loan/gh_2.67.0_linux_amd64/bin/gh}
R=${R:-karst10607/mabi}

echo "== Epic 進度 =="
all=$($GH issue list --repo "$R" --label v2 --state all --json number,labels \
  -q '[.[] | select([.labels[].name] | index("epic") | not)] | length')
closed=$($GH issue list --repo "$R" --label v2 --state closed --json number -q 'length')
echo "子任務 closed ${closed:-0} / ${all:-0}"

echo
echo "== 開放中 issues（label / 最後更新 / 標題）=="
$GH issue list --repo "$R" --label v2 --state open --json number,title,labels,updatedAt \
  -q '.[] | "\(.number)\t\([.labels[].name]|join(","))\t\(.updatedAt)\t\(.title)"' | sort -n

echo
echo "== 開啟中的 PR（CI 狀態）=="
$GH pr list --repo "$R" --state open --json number,title,headRefName,statusCheckRollup \
  -q '.[] | "\(.number)\t\(.headRefName)\t\([.statusCheckRollup[]?.conclusion // "pending"]|unique|join(","))\t\(.title)"'

echo
echo "== 最近 CI runs =="
$GH run list --repo "$R" --limit 5 --json status,conclusion,headBranch,displayTitle \
  -q '.[] | "\(.status)/\(.conclusion // "-")\t\(.headBranch)\t\(.displayTitle)"'
