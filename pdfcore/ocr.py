"""Lecture du texte d'une page scannee (Tesseract), regroupe en lignes."""
from __future__ import annotations

import numpy as np
import pytesseract
from PIL import Image

DEFAULT_LANG = "fra+eng"
MIN_CONF = 35.0


def available_langs() -> list[str]:
    try:
        return sorted(pytesseract.get_languages(config=""))
    except Exception:
        return ["eng"]


def ocr_lines(img_rgb: np.ndarray, lang: str = DEFAULT_LANG, psm: int = 3) -> list[dict]:
    """Retourne les lignes lues : {text, bbox (px), conf, words}.

    Les mots sont regroupes par (bloc, paragraphe, ligne) : une ligne complete donne un
    bien meilleur indice de police et de couleur qu'un mot isole.
    """
    cfg = f"--psm {psm} -c preserve_interword_spaces=1"
    try:
        data = pytesseract.image_to_data(
            Image.fromarray(img_rgb), lang=lang, config=cfg, output_type=pytesseract.Output.DICT
        )
    except pytesseract.TesseractError:
        return []

    groups: dict[tuple, dict] = {}
    for i, raw in enumerate(data["text"]):
        word = (raw or "").strip()
        if not word:
            continue
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError):
            conf = -1.0
        if conf < MIN_CONF:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
        g = groups.setdefault(key, {"words": [], "x0": 1e9, "y0": 1e9, "x1": -1e9, "y1": -1e9, "confs": []})
        g["words"].append({"text": word, "bbox": [x, y, x + w, y + h]})
        g["x0"] = min(g["x0"], x); g["y0"] = min(g["y0"], y)
        g["x1"] = max(g["x1"], x + w); g["y1"] = max(g["y1"], y + h)
        g["confs"].append(conf)

    lines = []
    for key in sorted(groups):
        g = groups[key]
        if not g["words"]:
            continue
        for seg in _split_columns(sorted(g["words"], key=lambda w: w["bbox"][0])):
            xs = [w["bbox"] for w in seg]
            lines.append(
                {
                    "slope_deg": _line_slope(seg),
                    "text": " ".join(w["text"] for w in seg),
                    "bbox": [
                        float(min(b[0] for b in xs)), float(min(b[1] for b in xs)),
                        float(max(b[2] for b in xs)), float(max(b[3] for b in xs)),
                    ],
                    "conf": round(sum(g["confs"]) / len(g["confs"]), 1),
                    "words": seg,
                }
            )
    return lines


def _line_slope(words: list[dict]) -> float:
    """Pente de la ligne en degres, d'apres les centres des mots.

    Sur un document photographie de travers, elle vaut quelques degres ; la retirer evite
    de confondre cette rotation avec un texte italique.
    """
    if len(words) < 2:
        return 0.0
    cx = np.array([(w["bbox"][0] + w["bbox"][2]) / 2 for w in words], dtype=float)
    cy = np.array([(w["bbox"][1] + w["bbox"][3]) / 2 for w in words], dtype=float)
    if cx.max() - cx.min() < 1e-6:
        return 0.0
    slope = np.polyfit(cx, cy, 1)[0]
    return float(np.degrees(np.arctan(slope)))


def _split_columns(words: list[dict]) -> list[list[dict]]:
    """Coupe une ligne la ou un large blanc separe deux colonnes.

    Tesseract rend "Total a payer          1 350,00 EUR" comme une seule ligne. La
    traiter d'un bloc rendrait le libelle et le montant inseparables a l'edition, et
    fausserait la detection de police (on comparerait un texte troue d'un grand vide).
    """
    if len(words) < 2:
        return [words] if words else []
    heights = sorted(w["bbox"][3] - w["bbox"][1] for w in words)
    ref = heights[len(heights) // 2] or 10
    out, cur = [], [words[0]]
    for prev, w in zip(words, words[1:]):
        if w["bbox"][0] - prev["bbox"][2] > ref * 1.8:
            out.append(cur); cur = [w]
        else:
            cur.append(w)
    out.append(cur)
    return [c for c in out if c]
