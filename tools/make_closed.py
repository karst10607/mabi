"""Paint a clean, bold closed-eye variant of a skin texture.

    python tools/make_closed.py renderer/models/cat2d --name cat

Replaces each open eye with:
1. Smooth surrounding fur color via Telea inpainting + Gaussian feathering,
   swallowing dark outer eyeliner pixels so no black smudges bleed into the socket.
2. A full-width, bold dark curved closed-eye line (`[-1.75*rx, +1.75*rx]`,
   `thickness=3` across the main span with soft tip tapering at the outer 15%)
   that reads clearly even at small desktop-pet window scales.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("skin_dir", help="directory holding <name>_tex.png and <name>_meta.json")
    ap.add_argument("--name", required=True, help="texture/meta prefix, e.g. cat")
    ap.add_argument("--preview", help="optional path for a 4x eye preview")
    args = ap.parse_args()

    skin = Path(args.skin_dir)
    src = skin / (args.name + "_tex.png")
    meta = json.loads((skin / (args.name + "_meta.json")).read_text(encoding="utf-8"))
    out_path = skin / (args.name + "_tex_closed.png")

    ox, oy = meta["origin"]
    tex = cv2.imread(str(src), cv2.IMREAD_UNCHANGED)  # BGRA
    h, w = tex.shape[:2]
    orig_bgr = tex[..., :3].copy()
    bgr = orig_bgr.copy()
    alpha = tex[..., 3].copy()

    eyes_sorted = sorted(meta["eyes"], key=lambda e: e["cx"])
    if len(eyes_sorted) >= 2:
        dx_eye = eyes_sorted[1]["cx"] - eyes_sorted[0]["cx"]
        dy_eye = eyes_sorted[1]["cy"] - eyes_sorted[0]["cy"]
        eye_angle_rad = math.atan2(dy_eye, dx_eye) if abs(dx_eye) > 1e-3 else 0.0
    else:
        eye_angle_rad = 0.0
    eye_angle_deg = math.degrees(eye_angle_rad)
    cos_a, sin_a = math.cos(eye_angle_rad), math.sin(eye_angle_rad)

    b, g, r = bgr[..., 0].astype(int), bgr[..., 1].astype(int), bgr[..., 2].astype(int)
    green = (((g > 90) & (g > r + 15) & (g > b + 18)) & (alpha > 40)).astype(np.uint8)
    _, lab = cv2.connectedComponents(green)
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 25))

    eye_masks = []
    for e in meta["eyes"]:
        cx, cy = e["cx"] - ox, e["cy"] - oy
        rx, ry = float(e["rx"]), float(e["ry"])
        m = np.zeros((h, w), np.uint8)
        cv2.ellipse(
            m,
            (int(round(cx)), int(round(cy))),
            (int(round(rx * 2.55)), int(round(ry * 2.55))),
            eye_angle_deg,
            0,
            360,
            1,
            -1,
        )
        y_lo, y_hi = max(0, int(cy) - 20), min(h, int(cy) + 21)
        x_lo, x_hi = max(0, int(cx) - 25), min(w, int(cx) + 26)
        win = lab[y_lo:y_hi, x_lo:x_hi]
        ids, counts = np.unique(win[win > 0], return_counts=True)
        if len(ids):
            lid = ids[np.argmax(counts)]
            comp = (lab == lid).astype(np.uint8)
            local_box = np.zeros((h, w), np.uint8)
            cv2.circle(local_box, (int(round(cx)), int(round(cy))), int(round(max(rx, ry) * 1.85)), 1, -1)
            m |= cv2.dilate(comp & local_box, kern)

        # Swallow dark eyeliner pixels right on the border of m so inpaint doesn't smear dark wedges
        border_ring = cv2.dilate(m, np.ones((7, 7), np.uint8)) - m
        luma = 0.114 * b + 0.587 * g + 0.299 * r
        ring_vals = luma[(border_ring > 0) & (alpha > 150)]
        if len(ring_vals):
            dark_thresh = np.percentile(ring_vals, 25)
            dark_border = (border_ring > 0) & (luma < min(85, dark_thresh + 10))
            m[dark_border] = 1
            m = cv2.dilate(m, np.ones((3, 3), np.uint8))

        eye_masks.append((cx, cy, rx, ry, m))
        print("eye mask px:", int(m.sum()))

    def rot_pt(dx, dy, cx0, cy0):
        return (cx0 + dx * cos_a - dy * sin_a, cy0 + dx * sin_a + dy * cos_a)

    opaque_fur = orig_bgr[alpha > 180]
    fallback_col = (
        np.median(opaque_fur, axis=0).astype(np.uint8)
        if len(opaque_fur)
        else np.array([105, 152, 192], dtype=np.uint8)
    )
    bgr_for_inpaint = bgr.copy()
    outside = alpha < 60
    if outside.any():
        bgr_for_inpaint[outside] = fallback_col

    for cx, cy, rx, ry, mask in eye_masks:
        inpainted = cv2.inpaint(bgr_for_inpaint, mask * 255, 6, cv2.INPAINT_TELEA)
        inpainted_smooth = cv2.GaussianBlur(inpainted.astype(np.float32), (0, 0), 2.0)
        mask_f = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 2.5) * (alpha > 15).astype(np.float32)
        bgr = np.clip(
            bgr.astype(np.float32) * (1.0 - mask_f[..., None]) + inpainted_smooth * mask_f[..., None],
            0,
            255,
        ).astype(np.uint8)
        bgr_for_inpaint = bgr.copy()
        if outside.any():
            bgr_for_inpaint[outside] = fallback_col

        # Full-width bold curved lid line spanning [-1.75*rx, +1.75*rx],
        # keeping full 3px thickness across 80% of the eye and tapering only at the outer tips
        p0 = rot_pt(-rx * 1.75, 0.5, cx, cy)
        p2 = rot_pt(+rx * 1.75, 0.5, cx, cy)
        p1 = rot_pt(0.0, ry * 0.52, cx, cy)
        pts = []
        for i in range(49):
            t = i / 48.0
            x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
            y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
            pts.append((x, y))

        line = np.zeros((h, w), np.float32)
        for i in range(len(pts) - 1):
            t_mid = (i + 0.5) / (len(pts) - 1)
            d_end = abs(t_mid - 0.5) * 2.0
            seg_thick = 3 if d_end < 0.78 else (2 if d_end < 0.90 else 1)
            seg_val = 255.0 if d_end < 0.82 else 255.0 * (1.0 - (d_end - 0.82) / 0.20)
            seg_canvas = np.zeros((h, w), np.uint8)
            pt_a = (int(round(pts[i][0])), int(round(pts[i][1])))
            pt_b = (int(round(pts[i + 1][0])), int(round(pts[i + 1][1])))
            cv2.line(seg_canvas, pt_a, pt_b, int(round(max(0, seg_val))), seg_thick, cv2.LINE_AA)
            line = np.maximum(line, seg_canvas.astype(np.float32))

        line = cv2.GaussianBlur(line, (0, 0), 0.8) / 255.0
        line = np.clip(line * 1.38, 0, 1) * (alpha > 40).astype(np.float32)
        line = line[..., None]
        lid_color = np.array([14, 20, 30], np.float32)
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
            pad = 65
            x0, x1 = max(0, cx - pad), min(w, cx + pad)
            y0, y1 = max(0, cy - pad), min(h, cy + pad)
            crops.append(cv2.resize(flat[y0:y1, x0:x1], None, fx=4, fy=4, interpolation=cv2.INTER_NEAREST))
        cv2.imwrite(args.preview, np.hstack(crops).astype(np.uint8))
        print("wrote", args.preview)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
