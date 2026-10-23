"""Draw a labelled pixel grid over the matte so landmarks can be read off.

    python tools/grid.py work/base_rgba.png --out work/grid.png
"""
import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("image")
    ap.add_argument("--out", help="output PNG (default: <image>_grid.png)")
    ap.add_argument("--crop", help="x0,y0,x1,y1 (default: whole image)")
    ap.add_argument("--step", type=int, default=50, help="minor grid spacing")
    args = ap.parse_args()

    src = Path(args.image)
    im = Image.open(src).convert("RGBA")
    comp = Image.new("RGB", im.size, (255, 0, 255))
    comp.paste(im, (0, 0), im)
    d = ImageDraw.Draw(comp)
    for x in range(0, im.width, args.step):
        c = (0, 220, 255) if x % (args.step * 4) else (255, 230, 0)
        d.line([(x, 0), (x, im.height)], fill=c, width=1)
        if x % (args.step * 2) == 0:
            d.text((x + 2, 2), str(x), fill=(255, 255, 255))
    for y in range(0, im.height, args.step):
        c = (0, 220, 255) if y % (args.step * 4) else (255, 230, 0)
        d.line([(0, y), (im.width, y)], fill=c, width=1)
        if y % (args.step * 2) == 0:
            d.text((2, y + 1), str(y), fill=(255, 255, 255))

    out = Path(args.out) if args.out else src.with_name(src.stem + "_grid.png")
    if args.crop:
        box = tuple(int(v) for v in args.crop.split(","))
        if len(box) != 4:
            raise SystemExit("--crop needs x0,y0,x1,y1")
        comp = comp.crop(box)
    comp.save(out)
    print("wrote", out, comp.size)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
