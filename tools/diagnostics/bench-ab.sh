#!/bin/bash
# Linux A/B CPU bench：idle 與 walk 兩種狀態，序列量測（平行會污染採樣）。
# 用法：./tools/diagnostics/bench-ab.sh [V0 V1 V2 V3 V4]
#
# 方法論同 README：量 CPU 不帶 --remote-debugging-port（CDP 會讓 GPU helper
# 飆到 150–200%）。walking 狀態靠 main.js 的暫存 env-gated hook 連續漫遊觸發
# （hook 直接設 roamEnabled、不寫設定檔；腳本結束時還原 main.js 與 rig2d.js）。
# 採樣：/proc/<pid>/stat utime+stime 差分，GPU 與 renderer 分開報。
set -u
cd "$(dirname "$0")/../.."
RIG=renderer/rig2d.js
MAIN=main.js
CSS=renderer/styles.css
ORIG=/tmp/bench-ab-orig
mkdir -p "$ORIG"
cp "$RIG" "$ORIG/rig2d.js"
cp "$MAIN" "$ORIG/main.js"
cp "$CSS" "$ORIG/styles.css"
trap 'cp "$ORIG/rig2d.js" "$RIG"; cp "$ORIG/main.js" "$MAIN"; cp "$ORIG/styles.css" "$CSS"' EXIT

# 暫存 bench hook：所有變體（含 V0） identical，不影響 A/B 有效性。
python3 - <<'PY'
p = 'main.js'
s = open(p).read()
anchor = "    scheduleRoam(9000);"
hook = """    scheduleRoam(9000);
    // BENCH HOOK (temporary, env-gated, removed after bench): continuous roam
    // so the walking render path can be sampled without CDP or input automation.
    if (process.env.AURAPET_BENCH === 'walk') {
      roamEnabled = true; // direct assignment: do NOT persist via writeAppSettings
      setInterval(() => { if (!roaming) roamWalk(); }, 400);
    }"""
assert s.count(anchor) == 1, 'anchor not unique'
open(p, 'w').write(s.replace(anchor, hook, 1))
PY

apply_variant() {
  cp "$ORIG/rig2d.js" "$RIG"
  cp "$ORIG/styles.css" "$CSS"
  case "$1" in
    V1) sed -i 's/antialias: true/antialias: false/' "$RIG" ;;
    V2) sed -i 's/this.renderer.setPixelRatio(window.devicePixelRatio || 1);/this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));/' "$RIG" ;;
    V3) sed -i 's/preserveDrawingBuffer: true/preserveDrawingBuffer: false/' "$RIG" ;;
    V4) sed -i 's/const IDLE_FRAME_MS = 110;/const IDLE_FRAME_MS = 200;/' "$RIG" ;;
    V5) sed -i 's/animation: floatPet 3.5s ease-in-out infinite;/animation: floatPet 3.5s steps(28) infinite;/; s/animation: shadowScale 3.5s ease-in-out infinite;/animation: shadowScale 3.5s steps(28) infinite;/' "$CSS" ;;
    V6) sed -i 's/animation: floatPet 3.5s ease-in-out infinite;/animation: none;/; s/animation: shadowScale 3.5s ease-in-out infinite;/animation: none;/' "$CSS" ;;
    V9) patch -s -p1 < tools/diagnostics/v9-idle-skip.patch ;;
    V0) : ;;
    *) echo "unknown variant $1" >&2; exit 1 ;;
  esac
}

killpet() {
  pkill -f "mabi/node_modules/electron/dist/electron" 2>/dev/null
  pkill -f "mabi/node_modules/.bin/electron" 2>/dev/null
  for _ in $(seq 1 20); do
    pgrep -f "mabi/node_modules/electron/dist/electron" >/dev/null || return 0
    sleep 0.5
  done
  echo "WARN: pet processes survived kill" >&2
}

sample() { # $1 = seconds; echoes "gpu_pct renderer_pct"
  local secs=$1 gp rd a b t1 t2 dt
  gp=$(pgrep -f "dist/electron --type=gpu-process" | head -1)
  rd=$(pgrep -f "dist/electron --type=renderer" | head -1)
  [ -n "$gp" ] && [ -n "$rd" ] || { echo "NA NA"; return; }
  local g1 r1 g2 r2
  g1=$(awk '{print $14+$15}' /proc/$gp/stat); r1=$(awk '{print $14+$15}' /proc/$rd/stat)
  t1=$(date +%s%N); sleep "$secs"; t2=$(date +%s%N)
  g2=$(awk '{print $14+$15}' /proc/$gp/stat); r2=$(awk '{print $14+$15}' /proc/$rd/stat)
  dt=$(( (t2 - t1) / 1000000 ))
  echo "$(( (g2 - g1) * 1000 / dt )) $(( (r2 - r1) * 1000 / dt ))"
}

run_mode() { # $1=variant $2=mode $3=sample_secs
  local V=$1 mode=$2 secs=$3
  killpet
  AURAPET_BENCH=$mode nohup npm start > "/tmp/bench-$V-$mode.log" 2>&1 &
  for _ in $(seq 1 30); do
    pgrep -f "dist/electron --type=gpu-process" >/dev/null && break
    sleep 0.5
  done
  sleep 8  # startup settle; walk hook starts roaming right after did-finish-load
  local res
  res=$(sample "$secs")
  echo "$V $mode gpu=${res% *}% renderer=${res#* }%"
  killpet
  sleep 2
}

VARIANTS=("$@")
[ ${#VARIANTS[@]} -eq 0 ] && VARIANTS=(V0 V1 V2 V3 V4)
for V in "${VARIANTS[@]}"; do
  apply_variant "$V"
  echo "[$V] rig2d diff:"; diff "$ORIG/rig2d.js" "$RIG" | head -6
  echo "[$V] styles diff:"; diff "$ORIG/styles.css" "$CSS" | head -8
  run_mode "$V" idle 10
  run_mode "$V" walk 20
done
killpet
echo "BENCH DONE"