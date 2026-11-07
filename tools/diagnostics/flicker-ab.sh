#!/bin/bash
# 閃爍 A/B：V0（preserveDrawingBuffer:true 對照）、V3（false）、WIN（贏家組合）。
# 用法：./tools/diagnostics/flicker-ab.sh V0 V3 WIN
# 帶 --remote-debugging-port 只量畫面不量 CPU（CDP 代價見 README）。
set -u
cd "$(dirname "$0")/../.."
RIG=renderer/rig2d.js
CSS=renderer/styles.css
ORIG=/tmp/flicker-ab-orig
mkdir -p "$ORIG"
cp "$RIG" "$ORIG/rig2d.js"
cp "$CSS" "$ORIG/styles.css"
trap 'cp "$ORIG/rig2d.js" "$RIG"; cp "$ORIG/styles.css" "$CSS"' EXIT

killpet() {
  pkill -f "mabi/node_modules/electron/dist/electron" 2>/dev/null
  pkill -f "mabi/node_modules/.bin/electron" 2>/dev/null
  for _ in $(seq 1 20); do
    pgrep -f "mabi/node_modules/electron/dist/electron" >/dev/null || return 0
    sleep 0.5
  done
}

apply_variant() {
  cp "$ORIG/rig2d.js" "$RIG"
  cp "$ORIG/styles.css" "$CSS"
  case "$1" in
    V3) sed -i 's/preserveDrawingBuffer: true/preserveDrawingBuffer: false/' "$RIG" ;;
    WIN|V5)
      # 贏家組合：idle CSS 動畫改 steps(28)，composite 從 60Hz 降到 ~8Hz。
      sed -i 's/animation: floatPet 3.5s ease-in-out infinite;/animation: floatPet 3.5s steps(28) infinite;/; s/animation: shadowScale 3.5s ease-in-out infinite;/animation: shadowScale 3.5s steps(28) infinite;/' "$CSS"
      ;;
    V0) : ;;
    *) echo "unknown variant $1" >&2; exit 1 ;;
  esac
}

for V in "$@"; do
  apply_variant "$V"
  killpet
  nohup npm start -- --remote-debugging-port=9223 > "/tmp/flicker-$V.log" 2>&1 &
  for _ in $(seq 1 30); do
    curl -s http://127.0.0.1:9223/json >/dev/null 2>&1 && break
    sleep 0.5
  done
  sleep 8
  WS=$(curl -s http://127.0.0.1:9223/json | python3 -c "import json,sys; ts=json.load(sys.stdin); print(next(t['webSocketDebuggerUrl'] for t in ts if t.get('type')=='page'))")
  echo "=== $V ==="
  python3 tools/diagnostics/flicker.py "$WS" 90 "/tmp/flicker-$V"
  killpet
  sleep 2
done
echo "FLICKER DONE"