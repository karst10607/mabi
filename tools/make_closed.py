"""Paint a closed-eye variant of a skin texture.

    python tools/make_closed.py renderer/models/cat2d --name cat

Keeps every pixel except the two eye ovals: each oval is inpainted from the
surrounding fur, then a soft lid line is drawn across it.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("skin_dir", help="directory holding <name>_tex.png and <name>_meta.json")
    ap.add_argument("--name", required=True, help="texture/meta prefix, e.g. cat")
    ap.add_argument("--preview", help="optional path for a 6x eye preview")
    args = ap.parse_args()

    skin = Path(args.skin_dir)
    src = skin / (args.name + "_tex.png")
    meta = json.loads((skin / (args.name + "_meta.json")).read_text(encoding="utf-8"))
    out_path = skin / (args.name + "_tex_closed.png")

    ox, oy = meta["origin"]
    tex = cv2.imread(str(src), cv2.IMREAD_UNCHANGED)  # BGRA
    h, w = tex.shape[:2]
    bgr = tex[..., :3].copy()
    alpha = tex[..., 3].copy()

    # the green iris is the only reliable eye marker; dilate it to swallow the lid rim
    b, g, r = bgr[..., 0].astype(int), bgr[..., 1].astype(int), bgr[..., 2].astype(int)
    green = ((g > 90) & (g > r + 18) & (g > b + 18) & (alpha > 40)).astype(np.uint8)
    n, lab = cv2.connectedComponents(green)
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 25))
    eye_masks = []
    for e in meta["eyes"]:
        cx, cy = e["cx"] - ox, e["cy"] - oy
        # the pupil sits at the eye centre, so look in a window for the iris label
        win = lab[int(cy) - 20:int(cy) + 21, int(cx) - 25:int(cx) + 26]
        ids, counts = np.unique(win[win > 0], return_counts=True)
        m = np.zeros((h, w), np.uint8)
        cv2.ellipse(m, (int(round(cx)), int(round(cy))),
                    (int(round(e["rx"] * 2.6)), int(round(e["ry"] * 2.6))),
                    0, 0, 360, 1, -1)
        if len(ids):
            lid = ids[np.argmax(counts)]
            m |= cv2.dilate((lab == lid).astype(np.uint8), kern)
        else:
            print("no iris component at eye centre; using the ellipse mask only")
        eye_masks.append((cx, cy, e["rx"], e["ry"], m))
        print("eye mask px:", int(m.sum()))

    for cx, cy, rx, ry, mask in eye_masks:
        bgr = cv2.inpaint(bgr, mask * 255, 6, cv2.INPAINT_TELEA)

        # lid line: shallow down-curve spanning the eye
        p0 = (cx - rx * 1.7, cy + 0.5)
        p2 = (cx + rx * 1.7, cy + 0.5)
        p1 = (cx, cy + ry * 0.5)
        pts = []
        for i in range(41):
            t = i / 40
            x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
            y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
            pts.append((x, y))
        line = np.zeros((h, w), np.uint8)
        cv2.polylines(line, [np.round(np.array(pts)).astype(np.int32)], False, 255, 3, cv2.LINE_AA)
        line = cv2.GaussianBlur(line, (0, 0), 0.8).astype(np.float32) / 255.0
        line = np.clip(line * 1.35, 0, 1)[..., None]
        lid_color = np.array([14, 20, 30], np.float32)  # BGR, dark warm brown
        bgr = (bgr.astype(np.float32) * (1 - line) + lid_color * line).astype(np.uint8)

    out = np.dstack([bgr, alpha])
    cv2.imwrite(str(out_path), out)
    print("wrote", out_path, out.shape)

    if args.preview:
        prev = out.astype(np.float32)
        bg = np.array([150, 150, 155], np.float32)
        al = prev[..., 3:4] / 255.0
        flat = prev[..., :3] * al + bg * (1 - al)
        crops = []
        for e in meta["eyes"]:
            cx, cy = int(e["cx"] - ox), int(e["cy"] - oy)
            pad = 60
            x0, x1 = max(0, cx - pad), min(w, cx + pad)
            y0, y1 = max(0, cy - pad), min(h, cy + pad)
            crops.append(cv2.resize(flat[y0:y1, x0:x1], None, fx=6, fy=6, interpolation=cv2.INTER_NEAREST))
        cv2.imwrite(args.preview, np.hstack(crops).astype(np.uint8))
        print("wrote", args.preview)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
