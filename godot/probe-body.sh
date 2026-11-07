#!/bin/bash
# Sequential CPU/RSS probe for the Godot body (issue #11).
#
#   GODOT_BIN=/path/to/Godot_v4.7.2-stable_linux.x86_64 ./godot/probe-body.sh
#
# A brain must already be listening on the port (start tools/bridge/dev-brain.mjs
# or the Electron app). Stop the Electron pet before measuring; this script only
# measures the Godot process, but a running Electron pet shares the GPU/compositor
# and would pollute the numbers (AGENTS.md §4).
#
# pgrep is anchored to the full binary+project path so the wrapper command line
# cannot match itself.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="${GODOT_BIN:?set GODOT_BIN to the Godot 4.7.2 binary}"
PORT="${PORT:-47821}"
CONFIG="${CONFIG:-$HOME/.config/aurapet-desktop/app-settings.json}"
PATTERN="^${BIN} --path ${ROOT}"

measure() {
  local label="$1"; shift
  pkill -f "$PATTERN" 2>/dev/null
  sleep 2
  nohup "$BIN" --path "$ROOT" -- "$@" > "/tmp/body-probe-$label.log" 2>&1 &
  sleep 10
  local pid
  pid=$(pgrep -f "$PATTERN" | head -1)
  if [ -z "$pid" ]; then
    echo "$label FAILED"; tail -5 "/tmp/body-probe-$label.log"; return
  fi
  local c1 t1 c2 t2 dt rss draws
  c1=$(awk '{print $14+$15}' "/proc/$pid/stat"); t1=$(date +%s%N)
  sleep 10
  t2=$(date +%s%N)
  c2=$(awk '{print $14+$15}' "/proc/$pid/stat"); dt=$(( (t2-t1)/1000000 ))
  rss=$(awk '/VmRSS/{print $2}' "/proc/$pid/status")
  draws=$(grep -a 'draws/s' "/tmp/body-probe-$label.log" | tail -1)
  echo "body $label cpu=$(( (c2-c1)*1000/dt ))% rss=$(( rss/1024 ))MB pid=$pid ${draws:+($draws)}"
  pkill -f "$PATTERN"
  sleep 2
}

measure idle --port="$PORT" --config="$CONFIG" --lowproc
measure walk --port="$PORT" --config="$CONFIG" --lowproc --walk
echo "BODY PROBE DONE"
