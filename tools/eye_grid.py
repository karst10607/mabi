"""Crop each eye of a skin texture at 4x with a labelled source-pixel grid.

    python tools/eye_grid.py renderer/models/cat2d/cat_walk_tex.png out.png

The grid lines are drawn every 20 source pixels and labelled with the texture
coordinate, so an eye's radius can be read straight off the image.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ZOOM = 4
STEP = 20


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tex")
    ap.add_argument("out")
    ap.add_argument("--pad", type=int, default=110)
    args = ap.parse_args()

    tex_path = Path(args.tex)
    with open(str(tex_path).replace("_tex.png", "_meta.json"), encoding="utf-8") as fh:
        meta = json.load(fh)
    ox, oy = meta["origin"]
    tex = cv2.imread(str(tex_path), cv2.IMREAD_UNCHANGED)
    h, w = tex.shape[:2]
    al = tex[..., 3:4].astype(np.float32) / 255.0
    flat = (tex[..., :3].astype(np.float32) * al + np.array([150, 150, 155], np.float32) * (1 - al))
    flat = flat.astype(np.uint8)

    crops = []
    for i, e in enumerate(sorted(meta["eyes"], key=lambda e: e["cx"])):
        cx, cy = int(round(e["cx"] - ox)), int(round(e["cy"] - oy))
        x0, x1 = max(0, cx - args.pad), min(w, cx + args.pad)
        y0, y1 = max(0, cy - args.pad), min(h, cy + args.pad)
        crop = cv2.resize(flat[y0:y1, x0:x1], None, fx=ZOOM, fy=ZOOM,
                          interpolation=cv2.INTER_NEAREST)
        ch, cw = crop.shape[:2]
        canvas = np.zeros((ch + 26, cw + 34, 3), np.uint8)
        canvas[:] = (30, 30, 30)
        canvas[26:, 34:] = crop

        def draw(img, x, y, label):
            cv2.line(img, (x, y), (x, img.shape[0]), (255, 255, 0), 1)
            cv2.putText(img, label, (x + 2, y + 11), cv2.FONT_HERSHEY_SIMPLEX, 0.3,
                        (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(img, label, (x + 2, y + 11), cv2.FONT_HERSHEY_SIMPLEX, 0.3,
                        (255, 255, 0), 1, cv2.LINE_AA)

        for v in range(x0 - (x0 % STEP), x1, STEP):
            draw(canvas, 34 + (v - x0) * ZOOM, 26, str(v))
        for v in range(y0 - (y0 % STEP), y1, STEP):
            cv2.line(canvas, (34, 26 + (v - y0) * ZOOM), (canvas.shape[1], 26 + (v - y0) * ZOOM),
                     (0, 230, 230), 1)
            cv2.putText(canvas, str(v), (1, 26 + (v - y0) * ZOOM + 11),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.3, (0, 230, 230), 1, cv2.LINE_AA)
        cv2.circle(canvas, (34 + (cx - x0) * ZOOM, 26 + (cy - y0) * ZOOM), 3, (0, 0, 255), -1)
        crops.append(canvas)

    sep = np.full((crops[0].shape[0], 12, 3), 40, np.uint8)
    out = crops[0]
    for c in crops[1:]:
        out = np.hstack([out, sep, c])
    cv2.imwrite(args.out, out)
    print("wrote", args.out, out.shape)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
