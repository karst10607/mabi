"""Cut a flat-background reference image into a soft-edged RGBA matte.

    python tools/matte_base.py ART.png WORK_DIR

Writes WORK_DIR/base_rgba.png and a magenta composite for visual checking.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", help="reference image with a flat background")
    ap.add_argument("out_dir", nargs="?", default=".", help="directory for base_rgba.png (default: .)")
    ap.add_argument("--threshold", type=int, default=18, help="colour distance that counts as foreground")
    ap.add_argument("--solid-interior", type=int, default=0,
                    help="erode silhouette by N px and force interior alpha=255 (prevents grey fur/muzzle bleed)")
    args = ap.parse_args()

    src = Path(args.src)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.int32)
    h, w = a.shape[:2]
    print("size", w, "x", h)

    margin = min(20, h // 4, w // 4)
    corners = np.concatenate([a[:margin, :margin].reshape(-1, 3), a[:margin, -margin:].reshape(-1, 3),
                              a[-margin:, :margin].reshape(-1, 3), a[-margin:, -margin:].reshape(-1, 3)])
    bg = np.median(corners, 0)
    print("bg median", bg, "std", corners.std(0).round(2))

    d = np.abs(a - bg).max(axis=2)
    print("distance histogram (unique-ish):")
    for t in [4, 8, 12, 20, 30, 45]:
        print(f"  d>{t}: {(d > t).sum()}")

    fg_raw = d > args.threshold
    fg_raw = ndimage.binary_closing(fg_raw, np.ones((5, 5), bool))
    fg_raw = ndimage.binary_fill_holes(fg_raw)
    lab, n = ndimage.label(fg_raw)
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    keep = np.argmax(counts)
    m = lab == keep
    print("components", n, "biggest", int(counts[keep]), "of image", w * h)
    ys, xs = np.nonzero(m)
    print("bbox x%d-%d y%d-%d  (%dx%d)" % (xs.min(), xs.max(), ys.min(), ys.max(),
                                           xs.max() - xs.min() + 1, ys.max() - ys.min() + 1))

    # soft alpha from the distance, so the silhouette edge is not stair-stepped
    soft_lo = args.threshold / 3
    alpha = np.clip((d - soft_lo) / (args.threshold - soft_lo), 0, 1) * m
    if args.solid_interior > 0:
        interior = ndimage.binary_erosion(m, iterations=args.solid_interior)
        alpha = np.where(interior, 1.0, alpha)
    out = np.dstack([a, (alpha * 255).round()]).astype(np.uint8)
    out[alpha < 0.02] = 0
    Image.fromarray(out, "RGBA").save(out_dir / "base_rgba.png")

    al = out[..., 3:4] / 255.0
    comp = (out[..., :3] * al + np.array([255, 0, 255]) * (1 - al)).astype(np.uint8)
    Image.fromarray(comp).save(out_dir / "base_check.png")
    print("saved", out_dir / "base_rgba.png")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
