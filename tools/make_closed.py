"""Paint a natural fur-textured closed-eye variant of a skin texture.

    python tools/make_closed.py renderer/models/cat2d --name cat

Replaces each open eye with:
1. Smooth base fur color inpainted from the surrounding eye socket + directional
   upper/lower lid tone continuity.
2. Real high-frequency hair/fur grain sampled strictly from pure brow/cheek fur
   outside the eye socket (with all eye/eyeliner pixels masked out of the grain
   source so zero open-eye ghosting can ever occur).
3. Subtle 3D convex upper-lid shading + soft upper fold shadow + a tapered,
   Gaussian-feathered dark warm-brown lash crease that narrows smoothly at both
   canthi (no hard drawn polyline).
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

    # True green/yellow-green iris marker (strict enough not to match golden tabby fur)
    b, g, r = bgr[..., 0].astype(int), bgr[..., 1].astype(int), bgr[..., 2].astype(int)
    green = (((g > 95) & (g > r + 10) & (g > b + 28)) & (alpha > 40)).astype(np.uint8)
    _, lab = cv2.connectedComponents(green)
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19))

    eye_masks = []
    all_eyes_union = np.zeros((h, w), np.uint8)
    for e in meta["eyes"]:
        cx, cy = e["cx"] - ox, e["cy"] - oy
        rx, ry = float(e["rx"]), float(e["ry"])
        m = np.zeros((h, w), np.uint8)
        cv2.ellipse(
            m,
            (int(round(cx)), int(round(cy))),
            (int(round(rx * 2.85)), int(round(ry * 2.80))),
            eye_angle_deg,
            0,
            360,
            1,
            -1,
        )
        y_lo, y_hi = max(0, int(cy) - 18), min(h, int(cy) + 19)
        x_lo, x_hi = max(0, int(cx) - 22), min(w, int(cx) + 23)
        win = lab[y_lo:y_hi, x_lo:x_hi]
        ids, counts = np.unique(win[win > 0], return_counts=True)
        if len(ids):
            lid = ids[np.argmax(counts)]
            comp = (lab == lid).astype(np.uint8)
            local_box = np.zeros((h, w), np.uint8)
            cv2.circle(local_box, (int(round(cx)), int(round(cy))), int(round(max(rx, ry) * 1.9)), 1, -1)
            m |= cv2.dilate(comp & local_box, kern)
        eye_masks.append((cx, cy, rx, ry, m))
        all_eyes_union |= m
        print("eye mask px:", int(m.sum()))

    # Extract high-frequency fur texture from the original image, strictly
    # zeroing out any pixel inside or near the eye masks so no eyeball/eyeliner
    # edge can ever be copied into the closed eyelid.
    orig_f = orig_bgr.astype(np.float32)
    orig_low = cv2.GaussianBlur(orig_f, (0, 0), 2.8)
    fur_grain = np.clip(orig_f - orig_low, -22.0, 22.0)
    no_grain_zone = cv2.dilate(all_eyes_union, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0
    fur_grain[no_grain_zone] = 0.0

    # Fill transparent background pixels with the local fur median before inpainting
    opaque_fur = orig_bgr[(alpha > 180) & (~no_grain_zone)]
    fallback_col = (
        np.median(opaque_fur, axis=0).astype(np.uint8)
        if len(opaque_fur)
        else np.array([105, 152, 192], dtype=np.uint8)
    )

    bgr_for_inpaint = bgr.copy()
    outside = alpha < 60
    if outside.any():
        bgr_for_inpaint[outside] = fallback_col

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

    for cx, cy, rx, ry, mask in eye_masks:
        # 1. Smooth base color inpaint (large radius + heavy Gaussian smoothing inside socket
        # so dark corner eyeliner doesn't leave dark puddles inside the lid)
        inpainted = cv2.inpaint(bgr_for_inpaint, mask * 255, 10, cv2.INPAINT_NS)
        inpainted_smooth = cv2.GaussianBlur(inpainted.astype(np.float32), (0, 0), 4.5)

        # Blend toward the warm median fur color right around the upper/lower socket
        dx = xx - cx
        dy = yy - cy
        u = (dx * cos_a + dy * sin_a) / max(rx, 1.0)
        v = (-dx * sin_a + dy * cos_a) / max(ry, 1.0)

        # Sample clean brow fur color above the eye and cheek fur color below the eye
        brow_ring = (np.abs(u) < 1.6) & (v > -3.6) & (v < -2.7) & (alpha > 160) & (~no_grain_zone)
        cheek_ring = (np.abs(u) < 1.6) & (v > 2.7) & (v < 3.6) & (alpha > 160) & (~no_grain_zone)
        if brow_ring.any() and cheek_ring.any():
            brow_col = np.median(orig_bgr[brow_ring], axis=0).astype(np.float32)
            cheek_col = np.median(orig_bgr[cheek_ring], axis=0).astype(np.float32)
            t_vert = np.clip((v + 2.2) / 4.4, 0.0, 1.0)[..., None]
            vert_grad = brow_col * (1.0 - t_vert) + cheek_col * t_vert
            core_w = np.exp(-0.5 * ((u / 1.9) ** 2 + (v / 1.8) ** 2))[..., None] * 0.45
            inpainted_smooth = inpainted_smooth * (1.0 - core_w) + vert_grad * core_w

        # Feather the socket mask edge so there is zero seam
        mask_f = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 2.6) * (alpha > 20).astype(np.float32)
        mask_f3 = mask_f[..., None]

        # Gently curved resting eyelid crease (slightly lower in the middle, uplifted at corners)
        v_crease = 0.22 - 0.14 * (u ** 2)

        # 2. Graft real high-frequency fur grain from outside the eye socket using
        # smooth bilinear remapping so hair strokes are crisp and never blocky.
        u_src = np.clip(u * 0.82, -1.65, 1.65)
        v_src = np.where(
            v <= v_crease,
            -3.15 + (v - v_crease) * 0.65,
            +3.05 + (v - v_crease) * 0.65,
        )
        map_x = np.clip(cx + (u_src * rx) * cos_a - (v_src * ry) * sin_a, 0, w - 1).astype(np.float32)
        map_y = np.clip(cy + (u_src * rx) * sin_a + (v_src * ry) * cos_a, 0, h - 1).astype(np.float32)
        sampled_grain = cv2.remap(fur_grain, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        sampled_alpha = cv2.remap(alpha.astype(np.float32), map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        valid_src = (sampled_alpha > 150).astype(np.float32)[..., None]
        coat_scale = np.clip(inpainted_smooth / 95.0, 0.35, 1.05)
        sampled_grain = sampled_grain * valid_src * coat_scale

        lid_tex = np.clip(inpainted_smooth + sampled_grain, 0, 255)

        # 3. 3D upper-eyelid dome shading: slightly fuller/warmer on the upper lid dome,
        # soft crease shadow along the top socket fold
        dome = np.exp(-((u / 1.25) ** 2 + ((v + 0.25) / 0.80) ** 2))
        upper_fold = np.exp(-(((v + 1.15 + 0.12 * (u ** 2)) / 0.35) ** 2)) * np.exp(-((u / 1.45) ** 2))
        lid_tex = lid_tex * (1.0 + 0.05 * dome[..., None] - 0.09 * upper_fold[..., None])

        cur_f = bgr.astype(np.float32) * (1.0 - mask_f3) + lid_tex * mask_f3

        # 4. Natural tapered eyelid slit (soft feathered lash line + subtle lower-lid rim highlight)
        span = np.clip(1.0 - (u / 1.62) ** 2, 0.0, 1.0)
        taper = span ** 1.35  # smooth point at both inner and outer corners

        dist_c = v - v_crease
        sigma = 0.12 + 0.05 * span
        crease_w = np.exp(-0.5 * (dist_c / sigma) ** 2) * taper * (alpha > 45).astype(np.float32)
        crease_w = np.clip(crease_w * 0.88, 0.0, 0.90)[..., None]

        # Upper lash/fur fringe softening right above the slit
        lash_fringe = (
            np.exp(-0.5 * ((dist_c + 0.14) / 0.17) ** 2)
            * (span ** 1.6)
            * 0.24
            * (alpha > 45).astype(np.float32)
        )[..., None]

        # Subtle lower-lid rim highlight just below the slit so the two lids look met, not drawn
        lower_rim = (
            np.exp(-0.5 * ((dist_c - 0.17) / 0.14) ** 2)
            * (span ** 1.5)
            * 0.13
            * (alpha > 45).astype(np.float32)
        )[..., None]

        ring_mask = (u ** 2 + v ** 2 > 7.5) & (u ** 2 + v ** 2 < 14.0) & (alpha > 150) & (~no_grain_zone)
        if ring_mask.any():
            lid_col = np.median(orig_bgr[ring_mask], axis=0).astype(np.float32)
        else:
            lid_col = np.array([90.0, 120.0, 150.0], np.float32)
        crease_col = np.clip(lid_col * 0.22 + np.array([6.0, 9.0, 14.0], np.float32), 8.0, 44.0)

        cur_f = cur_f * (1.0 - lash_fringe) + (crease_col * 1.25) * lash_fringe
        cur_f = np.clip(cur_f + lower_rim * np.array([12.0, 15.0, 19.0], np.float32), 0, 255)
        cur_f = cur_f * (1.0 - crease_w) + crease_col * crease_w

        bgr = np.clip(cur_f, 0, 255).astype(np.uint8)
        bgr_for_inpaint = bgr.copy()
        if outside.any():
            bgr_for_inpaint[outside] = fallback_col

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
