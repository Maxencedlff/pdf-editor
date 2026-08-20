"""Edition au niveau pixel : lecture des couleurs d'un scan, effacement propre, redessin.

Tout est en RGB uint8, coordonnees en pixels de l'image de page rendue.
"""
from __future__ import annotations

import numpy as np
import cv2
from PIL import Image, ImageDraw

from . import fonts
from .fonts import FontEntry

Box = tuple[float, float, float, float]


def clamp_box(box: Box, w: int, h: int, pad: int = 0) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = box
    x0 = int(max(0, min(w - 1, round(x0) - pad)))
    y0 = int(max(0, min(h - 1, round(y0) - pad)))
    x1 = int(max(x0 + 1, min(w, round(x1) + pad)))
    y1 = int(max(y0 + 1, min(h, round(y1) + pad)))
    return x0, y0, x1, y1


def ink_mask(gray: np.ndarray) -> tuple[np.ndarray, bool]:
    """Separe encre / papier dans un crop en niveaux de gris.

    Retourne (masque encre, texte_sombre). Le seuil d'Otsu ne dit pas de quel cote est
    le texte : on tranche en supposant que l'encre est minoritaire et touche peu les
    bords du crop.
    """
    if gray.size == 0:
        return np.zeros_like(gray, dtype=bool), True
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    dark = th > 0                      # hypothese : texte sombre
    frac = dark.mean()
    if frac > 0.55:                    # trop de "texte" -> c'est du blanc sur noir
        return ~dark, False
    return dark, True


def blur_sigma(gray: np.ndarray, mask: np.ndarray) -> float:
    """Flou du scan, en pixels, mesure sur la largeur des transitions encre/papier.

    Un contour net ne compte qu'un ou deux pixels intermediaires ; un scan empate en
    compte beaucoup plus. Le rapport a la longueur du contour donne l'ordre de grandeur
    du flou, qu'on reapplique ensuite aux polices candidates.
    """
    if gray.size < 64 or not mask.any():
        return 0.0
    ink = float(np.percentile(gray[mask], 20))
    bg = gray[~mask]
    if bg.size < 16:
        return 0.0
    paper = float(np.percentile(bg, 80))
    span = paper - ink
    if abs(span) < 25:
        return 0.0
    lo, hi = min(ink, paper) + 0.3 * abs(span), min(ink, paper) + 0.7 * abs(span)
    mid = int(((gray > lo) & (gray < hi)).sum())
    m8 = mask.astype(np.uint8)
    edge = int((m8 - cv2.erode(m8, np.ones((3, 3), np.uint8), iterations=1)).sum())
    if edge < 8:
        return 0.0
    return float(np.clip(0.5 * mid / edge, 0.0, 2.2))


def sample_colors(img: np.ndarray, box: Box) -> dict:
    """Couleur de l'encre et du papier dans une zone de texte du scan."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = clamp_box(box, w, h)
    crop = img[y0:y1, x0:x1]
    if crop.size == 0:
        return {"ink": (0, 0, 0), "paper": (255, 255, 255), "dark_text": True, "mask": None}

    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    mask, dark_text = ink_mask(gray)

    # Coeur du trait : on erode pour ne garder que les pixels pleinement encres,
    # sinon l'antialiasing delave la couleur mesuree.
    m8 = mask.astype(np.uint8)
    core = cv2.erode(m8, np.ones((2, 2), np.uint8), iterations=1).astype(bool)
    if core.sum() < 12:
        core = mask
    ink = np.median(crop[core], axis=0) if core.sum() else np.array([0, 0, 0])

    # Papier : autour du texte, dans une bande elargie, hors encre dilatee.
    px0, py0, px1, py1 = clamp_box(box, w, h, pad=max(3, int((y1 - y0) * 0.35)))
    outer = img[py0:py1, px0:px1]
    og = cv2.cvtColor(outer, cv2.COLOR_RGB2GRAY)
    omask, _ = ink_mask(og)
    if not dark_text:
        omask = ~omask if omask.mean() < 0.5 else omask
    far = ~cv2.dilate(omask.astype(np.uint8), np.ones((5, 5), np.uint8), iterations=1).astype(bool)
    paper = np.median(outer[far], axis=0) if far.sum() > 20 else np.array([255, 255, 255])

    return {
        "ink": tuple(int(v) for v in ink),
        "paper": tuple(int(v) for v in paper),
        "dark_text": bool(dark_text),
        "mask": mask,
        "crop_origin": (x0, y0),
    }


def measure_line(
    img: np.ndarray, box: Box, text: str, detect_font: bool = True, line_slope_deg: float = 0.0
) -> dict:
    """Analyse complete d'une ligne scannee : couleurs, police, corps, baseline."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = clamp_box(box, w, h)
    info = sample_colors(img, box)
    mask = info.get("mask")
    box_h = y1 - y0

    entry, score = fonts.resolve(None), 0.0
    sigma = 0.0
    if detect_font and mask is not None and mask.any():
        gray_crop = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_RGB2GRAY)
        if not info["dark_text"]:
            gray_crop = 255 - gray_crop
        sigma = blur_sigma(gray_crop, mask)
        far = ~cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2).astype(bool)
        noise = float(gray_crop[far].std()) if far.sum() > 30 else 99.0
        entry, score = fonts.identify(
            mask, text, line_slope_deg=line_slope_deg, blur=sigma, noise=noise
        )

    # Corps : on cherche la taille qui reproduit la largeur d'encre mesuree.
    ib = fonts.ink_bbox(mask) if mask is not None else None
    tracking = 0.0
    if ib and text.strip():
        iw, ih = ib[2] - ib[0], ib[3] - ib[1]
        hint = max(6.0, box_h * 0.78)
        size = float(np.clip(fonts.fit_size_by_height(entry, text.strip(), ih, hint), 4, box_h * 2.4))
        # La hauteur donne le corps ; le tracking rattrape la chasse pour que le texte
        # reoccupe exactement la meme largeur qu'avant.
        tracking = fonts.tracking_for(entry, text.strip(), size, iw)
        ink_left = x0 + ib[0]
        ink_top = y0 + ib[1]
        ink_bottom = y0 + ib[3]
    else:
        size = max(6.0, box_h * 0.78)
        ink_left, ink_top, ink_bottom = x0, y0, y1

    return {
        "ink": info["ink"],
        "paper": info["paper"],
        "dark_text": info["dark_text"],
        "font_key": entry.key,
        "font_score": round(score, 3),
        "blur": round(sigma, 2),
        "bold": entry.bold,
        "italic": entry.italic,
        "size_px": round(size, 2),
        "tracking": round(tracking, 3),
        "ink_left": float(ink_left),
        "ink_top": float(ink_top),
        "ink_bottom": float(ink_bottom),
    }


def baseline_from_ink(entry: FontEntry, text: str, size_px: float, ink_top: float) -> float:
    """Retrouve la baseline a partir du haut d'encre observe, via les metriques de la police."""
    f = fonts.load(entry.path, max(4, int(round(size_px))))
    ascent, _ = f.getmetrics()
    bb = f.getbbox(text or "X")
    top_rel = bb[1] if bb else 0
    return ink_top + (ascent - top_rel)


def erase(img: np.ndarray, box: Box, paper=None, pad: int = 2) -> np.ndarray:
    """Efface une zone en preservant le grain du papier (inpainting), sur place."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = clamp_box(box, w, h, pad=pad)
    crop = img[y0:y1, x0:x1]
    if crop.size == 0:
        return img
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    mask, _ = ink_mask(gray)
    cover = mask.mean()

    if cover > 0.62:
        # Zone quasi pleine (aplat de couleur, image) : l'inpainting n'a rien a recopier.
        fill = paper if paper is not None else np.median(crop.reshape(-1, 3), axis=0)
        crop[:, :] = np.array(fill, dtype=np.uint8)
        return img

    m = cv2.dilate(mask.astype(np.uint8) * 255, np.ones((3, 3), np.uint8), iterations=2)
    background = crop[m == 0]
    if background.shape[0] > 30 and float(background.std(axis=0).max()) < 6.0:
        # Fond parfaitement uni (bandeau de couleur, aplat) : le recopier tel quel est
        # plus net que de le reconstruire, l'inpainting y laisse des trainees.
        crop[:, :] = np.median(background, axis=0).astype(np.uint8)
        return img
    # Marge de securite : sans elle, le halo d'antialiasing subsiste en gris.
    inpainted = cv2.inpaint(crop, m, 4, cv2.INPAINT_TELEA)
    img[y0:y1, x0:x1] = inpainted
    return img


def draw_text(
    img: np.ndarray,
    text: str,
    entry: FontEntry,
    size_px: float,
    color,
    x: float,
    baseline: float,
    align: str = "left",
    box_right: float | None = None,
    tracking: float = 0.0,
) -> np.ndarray:
    """Dessine du texte a la baseline donnee, avec anti-aliasing, sur place."""
    if not text:
        return img
    pil = Image.fromarray(img)
    d = ImageDraw.Draw(pil)
    f = fonts.load(entry.path, max(4, int(round(size_px))))

    fill = tuple(int(c) for c in color)
    lsb = f.getbbox(text)[0] if text else 0
    width = f.getlength(text) + tracking * max(0, len(text) - 1)
    ox = x - lsb
    if align in ("center", "right") and box_right is not None:
        span = box_right - x
        ox = x - lsb + (span - width) * (0.5 if align == "center" else 1.0)

    if abs(tracking) < 0.05:
        d.text((ox, baseline), text, font=f, fill=fill, anchor="ls")
    else:
        # Pas d'espacement natif dans PIL : on avance glyphe par glyphe.
        cx = ox
        for ch in text:
            d.text((cx, baseline), ch, font=f, fill=fill, anchor="ls")
            cx += f.getlength(ch) + tracking
    np.copyto(img, np.asarray(pil))
    return img


def paste_image(img: np.ndarray, overlay_rgba: Image.Image, box: Box) -> np.ndarray:
    h, w = img.shape[:2]
    x0, y0, x1, y1 = clamp_box(box, w, h)
    ov = overlay_rgba.convert("RGBA").resize((x1 - x0, y1 - y0), Image.LANCZOS)
    base = Image.fromarray(img)
    base.paste(ov, (x0, y0), ov)
    np.copyto(img, np.asarray(base.convert("RGB")))
    return img
