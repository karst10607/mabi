"""Overlay a rig JSON on the matte to check landmark placement before baking.

    python tools/landmarks.py work/base_rgba.png --rig skins/cat.json --out work/landmarks.png

Ear centres are green, ear pivots orange, breath blue, tail cyan. Coordinates
are the same as the rig file: original matte image pixels.
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def ellipse(d, center, sigma, color, width=2):
    cx, cy = center
    sx, sy = sigma
    d.ellipse([cx - sx, cy - sy, cx + sx, cy + sy], outline=color, width=width)


def cross(d, x, y, r, color):
    d.line([(x - r, y), (x + r, y)], fill=color, width=2)
    d.line([(x, y - r), (x, y + r)], fill=color, width=2)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("image")
    ap.add_argument("--rig", required=True)
    ap.add_argument("--out", help="output PNG (default: <image>_landmarks.png)")
    args = ap.parse_args()

    rig = json.loads(Path(args.rig).read_text(encoding="utf-8"))
    src = Path(args.image)
    im = Image.open(src).convert("RGBA")
    comp = Image.new("RGB", im.size, (255, 0, 255))
    comp.paste(im, (0, 0), im)
    d = ImageDraw.Draw(comp)

    neck_cfg = rig.get("neck", {})
    neck_row = neck_cfg.get("row")
    if neck_row is not None:
        d.line([(0, neck_row), (im.width, neck_row)], fill=(255, 60, 60), width=2)
        neck_cx = neck_cfg.get("cx", im.width / 2)
        x_span = rig.get("head", {}).get("xSpan")
        if x_span and len(x_span) == 2:
            for dx, col in [(x_span[0], (255, 100, 100)), (x_span[1], (180, 40, 40))]:
                d.line([(neck_cx - dx, 0), (neck_cx - dx, neck_row + 60)], fill=col, width=2)
                d.line([(neck_cx + dx, 0), (neck_cx + dx, neck_row + 60)], fill=col, width=2)

    for e in rig.get("ears", []):
        ellipse(d, e["center"], e["sigma"], (0, 255, 80))
        cross(d, *e["center"], 8, (0, 255, 80))
        px, py = e["pivot"]
        d.ellipse([px - 6, py - 6, px + 6, py + 6], outline=(255, 150, 0), width=2)
        cross(d, px, py, 10, (255, 150, 0))

    b = rig.get("breath")
    if b:
        ellipse(d, b["center"], b["sigma"], (0, 160, 255))
        cross(d, *b["center"], 10, (0, 160, 255))
        for y in b.get("fade", []):
            d.line([(0, y), (im.width, y)], fill=(0, 160, 255), width=2)

    t = rig.get("tail")
    if t:
        x0, x1 = sorted(t["x"])
        y0, y1 = sorted(t["y"])
        d.rectangle([x0, y0, x1, y1], outline=(0, 255, 255), width=2)

    for e in rig.get("eyes", []):
        ellipse(d, (e["cx"], e["cy"]), (e["rx"], e["ry"]), (255, 255, 0))

    out = Path(args.out) if args.out else src.with_name(src.stem + "_landmarks.png")
    comp.save(out)
    print("wrote", out, comp.size)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
