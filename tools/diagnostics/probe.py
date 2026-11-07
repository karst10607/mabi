#!/usr/bin/env python3
"""閒置繪製率 probe：包 renderer.render 與 needsFastFrame 計數，3 秒讀一次。
用法：python3 probe.py <ws-url>
同時 dump needsFastFrame 每個條件的當前值，找出是誰拖著快檔。
"""
import json
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from flicker import WS

WRAP = """
(() => {
  const rr = window.rig2d.renderer, oo = rr.render.bind(rr);
  window.__draws = 0; rr.render = (...a) => { window.__draws++; return oo(...a); };
  const g = window.rig2d, nf = g.needsFastFrame.bind(g);
  window.__p = { fast: 0, slow: 0 };
  g.needsFastFrame = () => { const v = nf(); v ? window.__p.fast++ : window.__p.slow++; return v; };
  return 'wrapped';
})()
"""

READ = """
(() => {
  const g = window.rig2d;
  return {
    draws: window.__draws, fast: window.__p.fast, slow: window.__p.slow,
    running: g.running,
    mouseAge: Math.round(performance.now() - g.lastMouseAt),
    stepAmp: +g.stepAmp.toFixed(4), stepAmpTarget: g.stepAmpTarget,
    pulse: +g.pulse.toFixed(4), nod: +g.nod.toFixed(4),
    sleepDelta: +Math.abs(g.sleepBlend - (g.sleepy ? 1 : 0)).toFixed(4),
    blink: +g.blink.toFixed(4), blinkTimer: +g.blinkTimer.toFixed(2),
    flickL: +g.flickTimerL.toFixed(2), flickR: +g.flickTimerR.toFixed(2),
    drowsyDelta: +Math.abs(g.autoDrowsy - g.drowsyTarget).toFixed(4),
    gazeDX: +Math.abs(g.autoGazeX - g.gazeTargetX).toFixed(4),
    gazeDY: +Math.abs(g.autoGazeY - g.gazeTargetY).toFixed(4),
  };
})()
"""


def evaluate(ws, expr, i):
    ws.send(json.dumps({"id": i, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == i:
            return m.get("result", {}).get("result", {}).get("value", m)


def main():
    ws = WS(sys.argv[1])
    print(evaluate(ws, WRAP, 1))
    time.sleep(3)
    a = evaluate(ws, READ, 2)
    time.sleep(3)
    b = evaluate(ws, READ, 3)
    print("t0:", json.dumps(a))
    print("t1:", json.dumps(b))
    print(f"draws_per_sec={(b['draws'] - a['draws']) / 3:.1f} "
          f"fast_per_sec={(b['fast'] - a['fast']) / 3:.1f} "
          f"slow_per_sec={(b['slow'] - a['slow']) / 3:.1f}")


if __name__ == "__main__":
    main()