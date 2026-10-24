"""Bake a cropped texture and skin meta from the matte plus rig landmarks.

    python tools/make_tex.py work/base_rgba.png --rig skins/cat.json \
        --out renderer/models/cat2d --name cat

Rig JSON keys (coordinates in the original matte image):
  eyes            optional [{cx,cy,rx,ry}] override; default detects green irises
  neck            optional {"row": y} or {"search": [y0,y1]} for the narrowest row
  bodyPlan        default "quadruped"
  head            {fullAboveNeck, zeroBelowNeck}
  breath          {center:[x,y], sigma:[sx,sy], fade:[y0,y1]}
  ears            [{center:[x,y], pivot:[x,y], sigma:[sx,sy]}] (0 or 2)
  legs            [{center:[x,y], pivot:[x,y], sigma:[sx,sy]}] exactly 4, in
                  front-left, front-right, back-left, back-right order. `pivot`
                  is the shoulder/hip joint the leg rotates about.
  tail            {x:[x0,x1], y:[y0,y1]} or null
  eyeRadiusScale  gaze warp radius as a multiple of the iris
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

REQUIRED = ("head", "breath", "eyeRadiusScale")


def detect_eyes(a, sil):
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    green = (g > 90) & (g > r + 18) & (g > b + 18) & sil
    lab, n = ndimage.label(green)
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    eyes = []
    for i in np.argsort(-sizes):
        if sizes[i] < 200 or len(eyes) == 2:
            break
        ys, xs = np.nonzero(lab == i)
        eyes.append({"cx": float(xs.mean()), "cy": float(ys.mean()),
                     "rx": float((xs.max() - xs.min()) / 2), "ry": float((ys.max() - ys.min()) / 2),
                     "px": int(sizes[i])})
    eyes.sort(key=lambda e: e["cx"])
    if len(eyes) < 2:
        raise SystemExit("found fewer than two green-irised eyes; add an \"eyes\" override to the rig JSON")
    return eyes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", help="matte from matte_base.py (RGBA)")
    ap.add_argument("--rig", required=True, help="skin rig JSON")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--name", required=True, help="texture/meta prefix, e.g. cat")
    ap.add_argument("--pad", type=int, default=12, help="transparent margin around the crop")
    args = ap.parse_args()

    rig = json.loads(Path(args.rig).read_text(encoding="utf-8"))
    missing = [k for k in REQUIRED if k not in rig]
    if missing:
        raise SystemExit("rig JSON is missing: " + ", ".join(missing))

    legs = rig.get("legs", [])
    if legs and len(legs) != 4:
        raise SystemExit('"legs" must list exactly 4 legs (FL, FR, BL, BR) or be omitted')

    base = Image.open(args.base).convert("RGBA")
    a = np.asarray(base)
    h, w = a.shape[:2]
    sil = a[..., 3] > 40

    if "eyes" in rig:
        eyes = sorted(rig["eyes"], key=lambda e: e["cx"])
        if len(eyes) != 2:
            raise SystemExit("\"eyes\" must list exactly two eyes")
    else:
        eyes = detect_eyes(a, sil)
    print("eyes:", json.dumps(eyes, indent=None))

    neck_cfg = rig.get("neck", {})
    if neck_cfg.get("row") is not None:
        neck_y = int(neck_cfg["row"])
    else:
        y0, y1 = neck_cfg.get("search", [380, 640])
        widths = {}
        for y in range(y0, y1):
            xs = np.nonzero(sil[y])[0]
            if len(xs):
                widths[y] = xs[-1] - xs[0]
        if not widths:
            raise SystemExit("no silhouette rows in the neck search range")
        neck_y = min(widths, key=widths.get)
    neck_xs = np.nonzero(sil[neck_y])[0]
    if not len(neck_xs):
        raise SystemExit("empty silhouette at neck row %d" % neck_y)
    if neck_cfg.get("cx") is not None:
        neck_cx = float(neck_cfg["cx"])
    else:
        neck_cx = float((neck_xs[0] + neck_xs[-1]) / 2)
    print("neck y=", neck_y, "width", int(neck_xs[-1] - neck_xs[0]), "cx", neck_cx)

    ys, xs = np.nonzero(sil)
    x0, x1 = max(0, xs.min() - args.pad), min(w, xs.max() + args.pad + 1)
    y0, y1 = max(0, ys.min() - args.pad), min(h, ys.max() + args.pad + 1)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    crop = Image.fromarray(a[y0:y1, x0:x1], "RGBA")
    tex_path = out_dir / (args.name + "_tex.png")
    crop.save(tex_path)
    print("texture", crop.size, "origin", (int(x0), int(y0)))

    meta = {
        "texW": crop.width,
        "texH": crop.height,
        "origin": [int(x0), int(y0)],
        "eyes": eyes,
        "neck": {"y": int(neck_y), "cx": neck_cx},
        "rig": {
            "bodyPlan": rig.get("bodyPlan", "quadruped"),
            "head": rig["head"],
            "breath": rig["breath"],
            "ears": rig.get("ears", []),
            "paws": rig.get("paws", []),
            "legs": legs,
            "gait": rig.get("gait", {}),
            "tail": rig.get("tail"),
            "eyeRadiusScale": rig["eyeRadiusScale"],
        },
    }
    meta_json = out_dir / (args.name + "_meta.json")
    meta_json.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    meta_js = out_dir / (args.name + "_meta.js")
    meta_js.write_text("// generated by tools/make_tex.py\nexport default "
                       + json.dumps(meta, indent=2) + ";\n", encoding="utf-8")
    print("wrote", tex_path, meta_json, meta_js)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
