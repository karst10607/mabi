#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "=========================================="
echo "🐾 準備推送 AuraPet 至 GitHub (倉庫名: mab)"
echo "=========================================="

# 1. 檢查並喚起 GitHub 登入驗證
if ! gh auth status >/dev/null 2>&1; then
  echo "檢測到 GitHub 登入已過期，正在為您喚起瀏覽器一鍵授權..."
  gh auth login -h github.com -p https -w
fi

# 2. 建立遠端 mab 倉庫並推送
echo "正在建立遠端 mab 倉庫並推送代碼..."
gh repo create mab --public --source=. --remote=origin --push 2>/dev/null || git push -u origin main

echo ""
echo "=========================================="
echo "🎉 恭喜！已成功推送到您的 GitHub！"
echo "🔗 倉庫網址：https://github.com/karst10607/mab"
echo "=========================================="
