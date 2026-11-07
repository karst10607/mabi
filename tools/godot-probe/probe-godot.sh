#!/bin/bash
# Godot transparent-window probe：CPU/RSS at given damage rates.
# 用法：./probe-godot.sh [14 30]
#   EXTRA=--lowproc            事件驅動 idle
#   SCENE=res://fullrig.tscn   改量 full-rig（skinning shader＋步態）
#   EXTRA="--walk --lowproc"   full-rig 走路模式
# pgrep 用 ^ anchor 只命中 Godot 本體（wrapper cmdline 以 /bin/bash 開頭）。
set -u
cd "$(dirname "$0")"
BIN=./Godot_v4.7.2-stable_linux.x86_64
RATES=("$@")
[ ${#RATES[@]} -eq 0 ] && RATES=(14 30)
for RATE in "${RATES[@]}"; do
  pkill -f "^[.]/Godot_v4.7.2" 2>/dev/null
  sleep 2
  RATE_ARG=(--rate="$RATE")
  [ "$RATE" = "adaptive" ] && RATE_ARG=()
  nohup "$BIN" --path . ${SCENE:-} -- "${RATE_ARG[@]}" ${EXTRA:-} > "/tmp/godot-probe-$RATE.log" 2>&1 &
  sleep 10
  P=$(pgrep -f "^[.]/Godot_v4.7.2" | head -1)
  if [ -z "$P" ]; then
    echo "rate=$RATE FAILED"; tail -5 "/tmp/godot-probe-$RATE.log"; continue
  fi
  c1=$(awk '{print $14+$15}' /proc/$P/stat); t1=$(date +%s%N)
  sleep 10; t2=$(date +%s%N)
  c2=$(awk '{print $14+$15}' /proc/$P/stat); dt=$(( (t2-t1)/1000000 ))
  rss=$(awk '/VmRSS/{print $2}' /proc/$P/status)
  echo "godot rate=$RATE cpu=$(( (c2-c1)*1000/dt ))% rss=$(( rss/1024 ))MB pid=$P"
  pkill -f "^[.]/Godot_v4.7.2"
  sleep 2
done
echo "GODOT PROBE DONE"