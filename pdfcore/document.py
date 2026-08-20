"""Modele de document : analyse des pages, edition, export.

Deux regimes d'edition selon la nature de la page :

* page native  -> on retire le texte d'origine et on le reecrit en vectoriel, avec la
  police reellement embarquee dans le PDF quand elle contient les glyphes voulus.
* page scannee -> il n'y a qu'une image. On repere les lignes par OCR, on efface par
  inpainting et on redessine avec la police, la couleur et le corps mesures sur l'image.
  Seule la zone modifiee est reincrustee, a la resolution native du scan : le reste du
  document n'est jamais reencode.

Toutes les coordonnees stockees sont en points PDF (1/72 pouce).
"""
from __future__ import annotations

import hashlib
import io
import json
import math
from dataclasses import dataclass, field

import fitz
import numpy as np
from PIL import Image

from . import fonts, ocr, raster

PREVIEW_DPI = 140
ANALYZE_DPI = 200
MAX_PATCH_DPI = 400
MIN_PATCH_DPI = 150
PATCH_MARGIN_PT = 2.5

PDF_FALLBACK = [
    ("courier", "mono"), ("mono", "mono"), ("consol", "mono"),
    ("times", "serif"), ("georgia", "serif"), ("garamond", "serif"),
    ("book", "serif"), ("roman", "serif"), ("serif", "serif"),
    ("narrow", "narrow"), ("verdana", "sans2"), ("dejavu", "sans2"),
]


def hex_color(rgb) -> str:
    r, g, b = (int(max(0, min(255, v))) for v in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def parse_hex(s: str, default=(0, 0, 0)):
    try:
        s = s.lstrip("#")
        return tuple(int(s[i : i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return default


def int_to_rgb(c: int):
    return ((c >> 16) & 255, (c >> 8) & 255, c & 255)


def guess_font_key(pdf_font: str, bold: bool, italic: bool) -> str:
    name = (pdf_font or "").lower()
    family = "sans"
    for needle, fam in PDF_FALLBACK:
        if needle in name:
            family = fam
            break
    bold = bold or "bold" in name or "black" in name or "heavy" in name
    italic = italic or "italic" in name or "oblique" in name
    for f in fonts.CATALOG:
        if f.family == family and f.bold == bold and f.italic == italic:
            return f.key
    return fonts.DEFAULT_KEY


# --------------------------------------------------------------------------- #
def render_np(page: fitz.Page, dpi: float, clip: fitz.Rect | None = None) -> np.ndarray:
    pix = page.get_pixmap(dpi=int(round(dpi)), clip=clip, colorspace=fitz.csRGB, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3).copy()


def page_native_dpi(page: fitz.Page) -> float:
    """Resolution reelle de la plus grande image de la page.

    Sert a re-encoder les retouches a la finesse du scan : rendre a 150 dpi une page
    numerisee a 300 rendrait le rectangle retouche visiblement plus flou que le reste.
    """
    best = 0.0
    pw = max(1.0, page.rect.width)
    for info in page.get_images(full=True):
        try:
            w = info[2]
        except (IndexError, TypeError):
            continue
        if w:
            best = max(best, float(w) * 72.0 / pw)
    if best <= 0:
        return ANALYZE_DPI
    return float(np.clip(best, MIN_PATCH_DPI, MAX_PATCH_DPI))


def image_coverage(page: fitz.Page) -> float:
    """Fraction de la page couverte par des images."""
    area = page.rect.get_area()
    if area <= 0:
        return 0.0
    covered = 0.0
    try:
        for info in page.get_image_info():
            r = fitz.Rect(info["bbox"]) & page.rect
            if not r.is_empty:
                covered += r.get_area()
    except Exception:
        return 0.0
    return min(1.0, covered / area)


# --------------------------------------------------------------------------- #
@dataclass
class Doc:
    doc_id: str
    name: str
    src: fitz.Document
    ops: list[dict] = field(default_factory=list)
    page_order: list[int] = field(default_factory=list)
    rotations: dict[int, int] = field(default_factory=dict)
    analysis: dict[int, dict] = field(default_factory=dict)
    lang: str = ocr.DEFAULT_LANG
    _cache: dict = field(default_factory=dict)

    # ---------------- analyse ---------------- #
    def page_meta(self, idx: int) -> dict:
        p = self.src[idx]
        return {"index": idx, "width": p.rect.width, "height": p.rect.height}

    def native_items(self, page: fitz.Page, idx: int) -> list[dict]:
        """Spans de texte vectoriel, fusionnes quand ils partagent le meme style."""
        items: list[dict] = []
        data = page.get_text("dict")
        for block in data.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                merged: list[dict] = []
                for span in line.get("spans", []):
                    text = span.get("text", "")
                    if not text.strip():
                        continue
                    flags = span.get("flags", 0)
                    style = (span.get("font"), round(span.get("size", 10), 2), span.get("color", 0), flags)
                    if merged and merged[-1]["_style"] == style and abs(
                        merged[-1]["bbox"][2] - span["bbox"][0]
                    ) < span.get("size", 10) * 0.6:
                        prev = merged[-1]
                        gap = span["bbox"][0] - prev["bbox"][2]
                        joiner = " " if gap > span.get("size", 10) * 0.18 and not prev["text"].endswith(" ") else ""
                        prev["text"] += joiner + text
                        prev["bbox"] = [
                            min(prev["bbox"][0], span["bbox"][0]), min(prev["bbox"][1], span["bbox"][1]),
                            max(prev["bbox"][2], span["bbox"][2]), max(prev["bbox"][3], span["bbox"][3]),
                        ]
                    else:
                        merged.append(
                            {
                                "_style": style, "text": text, "bbox": list(span["bbox"]),
                                "origin": list(span.get("origin", (span["bbox"][0], span["bbox"][3]))),
                                "font": span.get("font", ""), "size": span.get("size", 10),
                                "color": span.get("color", 0), "flags": flags,
                            }
                        )
                for m in merged:
                    bold = bool(m["flags"] & 2 ** 4)
                    italic = bool(m["flags"] & 2 ** 1)
                    rgb = int_to_rgb(m["color"])
                    items.append(
                        {
                            "id": f"p{idx}-n{len(items)}",
                            "source": "native",
                            "text": m["text"],
                            "bbox": [round(v, 2) for v in m["bbox"]],
                            "baseline": round(m["origin"][1], 2),
                            "left": round(m["origin"][0], 2),
                            "pdf_font": m["font"],
                            "font_key": guess_font_key(m["font"], bold, italic),
                            "font_score": 1.0,
                            "size": round(m["size"], 2),
                            "color": hex_color(rgb),
                            "paper": "#ffffff",
                            "bold": bold,
                            "italic": italic,
                            "tracking": 0.0,
                            "align": "left",
                        }
                    )
        return items

    def scan_items(self, page: fitz.Page, idx: int) -> list[dict]:
        """Lignes reperees par OCR, mesurees sur l'image (couleur, police, corps)."""
        # Analyser a la finesse du scan plutot qu'a une valeur fixe : sur un document
        # numerise a 300 dpi, un corps de 8 pt ne fait que 22 px de haut a 200 dpi, trop
        # peu pour mesurer une epaisseur de trait ou distinguer deux polices.
        dpi = float(np.clip(page_native_dpi(page), ANALYZE_DPI, 300.0))
        img = render_np(page, dpi)
        k = 72.0 / dpi  # px -> pt
        lines = ocr.ocr_lines(img, lang=self.lang)
        items = []
        for i, ln in enumerate(lines):
            m = raster.measure_line(
                img, ln["bbox"], ln["text"], line_slope_deg=ln.get("slope_deg", 0.0)
            )
            x0, y0, x1, y1 = ln["bbox"]
            items.append(
                {
                    "id": f"p{idx}-o{i}",
                    "source": "ocr",
                    "text": ln["text"],
                    "conf": ln["conf"],
                    "bbox": [round(x0 * k, 2), round(y0 * k, 2), round(x1 * k, 2), round(y1 * k, 2)],
                    "ink_left": round(m["ink_left"] * k, 2),
                    "ink_top": round(m["ink_top"] * k, 2),
                    "ink_bottom": round(m["ink_bottom"] * k, 2),
                    "pdf_font": "",
                    "font_key": m["font_key"],
                    "font_score": m["font_score"],
                    "size": round(m["size_px"] * k, 2),
                    "tracking": round(m["tracking"] * k, 3),
                    "color": hex_color(m["ink"]),
                    "paper": hex_color(m["paper"]),
                    "bold": m["bold"],
                    "italic": m["italic"],
                    "align": "left",
                }
            )
        return items

    def analyze(self, idx: int, force: str | None = None) -> dict:
        """Analyse une page. force = 'ocr' | 'native' pour imposer le regime."""
        if force is None and idx in self.analysis:
            return self.analysis[idx]
        page = self.src[idx]
        text_len = len(page.get_text("text").strip())
        cover = image_coverage(page)

        if force == "ocr":
            mode = "scan"
        elif force == "native":
            mode = "native"
        elif cover >= 0.6:
            # Grande image de fond : page numerisee, avec ou sans couche OCR invisible.
            mode = "scan"
        elif text_len >= 12:
            mode = "native"
        else:
            mode = "scan"

        if mode == "scan":
            items = self.scan_items(page, idx)
            if not items and text_len >= 12:
                mode, items = "native", self.native_items(page, idx)
        else:
            items = self.native_items(page, idx)
            if not items:
                mode, items = "scan", self.scan_items(page, idx)

        res = {
            "index": idx, "mode": mode, "items": items,
            "width": page.rect.width, "height": page.rect.height,
            "native_dpi": round(page_native_dpi(page), 1),
            "image_coverage": round(cover, 2),
        }
        self.analysis[idx] = res
        return res

    def find_item(self, idx: int, item_id: str) -> dict | None:
        for it in self.analysis.get(idx, {}).get("items", []):
            if it["id"] == item_id:
                return it
        return None

    # ---------------- edition ---------------- #
    def ops_for(self, idx: int) -> list[dict]:
        return [o for o in self.ops if o.get("page") == idx]

    def ops_hash(self, idx: int) -> str:
        payload = json.dumps(self.ops_for(idx), sort_keys=True, default=str)
        return hashlib.sha1(payload.encode()).hexdigest()[:16]

    def _embedded_font(self, page: fitz.Page, pdf_font: str, text: str):
        """Buffer de la police embarquee si elle couvre tous les caracteres voulus.

        Un PDF n'embarque souvent qu'un sous-ensemble des glyphes reellement utilises :
        reutiliser la police telle quelle sur un texte contenant une lettre absente
        produirait des trous. Dans ce cas on refuse et on retombe sur une police systeme.
        """
        if not pdf_font:
            return None
        target = pdf_font.split("+")[-1].lower()
        for info in page.get_fonts(full=True):
            xref, basefont = info[0], (info[3] or "")
            if basefont.split("+")[-1].lower() != target:
                continue
            try:
                extracted = self.src.extract_font(xref)
                buf = extracted[3] if len(extracted) > 3 else None
                if not buf:
                    continue
                probe = fitz.Font(fontbuffer=buf)
                if all(probe.has_glyph(ord(c)) for c in text if not c.isspace()):
                    return buf
            except Exception:
                continue
        return None

    def _apply_native_text(self, page: fitz.Page, op: dict, item: dict) -> bool:
        """Reecrit un fragment de texte vectoriel."""
        bbox = fitz.Rect(op.get("bbox") or item["bbox"])
        pad = max(0.6, item.get("size", 10) * 0.08)
        rect = fitz.Rect(bbox.x0 - pad, bbox.y0 - pad, bbox.x1 + pad, bbox.y1 + pad)
        # fill=None : on retire le texte sans peindre de rectangle blanc par-dessus,
        # sinon on effacerait le fond colore ou l'image sous-jacente.
        page.add_redact_annot(rect, fill=None)
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )

        text = op.get("text", "")
        if not text.strip():
            return True
        size = float(op.get("size") or item.get("size") or 10)
        color = [c / 255 for c in parse_hex(op.get("color") or item.get("color", "#000000"))]
        baseline = float(op.get("baseline") or item.get("baseline") or bbox.y1)
        left = float(op.get("left") or item.get("left") or bbox.x0)

        buf = self._embedded_font(page, item.get("pdf_font", ""), text) if not op.get("font_key_changed") else None
        try:
            if buf:
                page.insert_text(
                    (left, baseline), text, fontsize=size, fontname="EMB" + str(abs(hash(item.get("pdf_font", ""))) % 9999),
                    fontbuffer=buf, color=color, render_mode=0,
                )
            else:
                entry = fonts.resolve(op.get("font_key") or item.get("font_key"))
                page.insert_text(
                    (left, baseline), text, fontsize=size, fontfile=entry.path,
                    fontname=entry.key[:12], color=color, render_mode=0,
                )
            return True
        except Exception:
            try:
                page.insert_text((left, baseline), text, fontsize=size, fontname="helv", color=color)
                return True
            except Exception:
                return False

    def _patch_region(self, page: fitz.Page, rect: fitz.Rect, painter) -> None:
        """Rend une region, laisse `painter` la retoucher, puis la reincruste.

        On ne touche qu'a ce rectangle : le reste de la page (et donc l'image du scan
        d'origine) n'est ni decode ni reencode.
        """
        dpi = page_native_dpi(page)
        margin = PATCH_MARGIN_PT + 2.0
        clip = fitz.Rect(rect.x0 - margin, rect.y0 - margin, rect.x1 + margin, rect.y1 + margin) & page.rect
        if clip.is_empty or clip.width < 1 or clip.height < 1:
            return
        # Alignement sur la grille de pixels du scan : un clip tombant entre deux pixels
        # forcerait un reechantillonnage, et le rectangle reincruste se verrait comme une
        # plaque legerement plus claire ou plus floue que le reste de la page.
        step = 72.0 / dpi
        snapped = fitz.Rect(
            math.floor(clip.x0 / step) * step, math.floor(clip.y0 / step) * step,
            math.ceil(clip.x1 / step) * step, math.ceil(clip.y1 / step) * step,
        ) & page.rect
        if not snapped.is_empty and snapped.width >= 1 and snapped.height >= 1:
            clip = snapped
        img = render_np(page, dpi, clip=clip)
        scale = dpi / 72.0

        def to_px(r: fitz.Rect):
            return (
                (r.x0 - clip.x0) * scale, (r.y0 - clip.y0) * scale,
                (r.x1 - clip.x0) * scale, (r.y1 - clip.y0) * scale,
            )

        painter(img, scale, clip, to_px)

        buf = io.BytesIO()
        Image.fromarray(img).save(buf, format="PNG", optimize=True)
        page.insert_image(clip, stream=buf.getvalue(), keep_proportion=False, overlay=True)

    def _apply_raster_text(self, page: fitz.Page, op: dict, item: dict | None) -> None:
        """Remplace du texte dans une zone image : effacement par inpainting + redessin."""
        base = item or {}
        bbox = fitz.Rect(op.get("bbox") or base.get("bbox") or [0, 0, 10, 10])
        text = op.get("text", "")
        entry = fonts.resolve(op.get("font_key") or base.get("font_key"))
        entry = fonts.variant(
            entry.key,
            bool(op.get("bold", base.get("bold", entry.bold))),
            bool(op.get("italic", base.get("italic", entry.italic))),
        )
        color = parse_hex(op.get("color") or base.get("color", "#000000"))
        size_pt = float(op.get("size") or base.get("size") or 10)
        tracking_pt = float(op.get("tracking", base.get("tracking", 0.0)) or 0.0)
        align = op.get("align") or base.get("align") or "left"
        paper = parse_hex(op.get("paper") or base.get("paper", "#ffffff"), (255, 255, 255))

        ink_left = float(base.get("ink_left", bbox.x0))
        ink_top = float(base.get("ink_top", bbox.y0))
        if op.get("left") is not None:
            ink_left = float(op["left"])
        if op.get("top") is not None:
            ink_top = float(op["top"])

        def paint(img, scale, clip, to_px):
            erase_rect = fitz.Rect(
                bbox.x0 - PATCH_MARGIN_PT, bbox.y0 - PATCH_MARGIN_PT,
                bbox.x1 + PATCH_MARGIN_PT, bbox.y1 + PATCH_MARGIN_PT,
            )
            raster.erase(img, to_px(erase_rect), paper=paper, pad=1)
            if not text.strip():
                return
            size_px = size_pt * scale
            baseline = raster.baseline_from_ink(entry, text, size_px, (ink_top - clip.y0) * scale)
            raster.draw_text(
                img, text, entry, size_px, color,
                x=(ink_left - clip.x0) * scale, baseline=baseline,
                align=align, box_right=(bbox.x1 - clip.x0) * scale,
                tracking=tracking_pt * scale,
            )

        # Le texte saisi est souvent plus long que celui qu'il remplace : la zone
        # reincrustee doit couvrir le resultat, sinon la fin des mots est rognee.
        need = fonts.ink_width(entry, text, size_pt) + tracking_pt * max(0, len(text) - 1)
        target = fitz.Rect(
            min(bbox.x0, ink_left), min(bbox.y0, ink_top - size_pt * 0.25),
            max(bbox.x1, ink_left + need + size_pt * 0.3), max(bbox.y1, ink_top + size_pt * 1.35),
        ) & page.rect
        self._patch_region(page, target if not target.is_empty else bbox, paint)
        # Couche de texte invisible : la retouche reste selectionnable et cherchable.
        if text.strip():
            try:
                page.insert_text(
                    (ink_left, ink_top + size_pt * 0.8), text, fontsize=size_pt,
                    fontname="helv", render_mode=3,
                )
            except Exception:
                pass

    def _apply_erase(self, page: fitz.Page, op: dict) -> None:
        rect = fitz.Rect(op["bbox"])
        mode = op.get("mode", "smart")
        color = parse_hex(op.get("color", "#ffffff"), (255, 255, 255))

        def paint(img, scale, clip, to_px):
            if mode == "fill":
                x0, y0, x1, y1 = raster.clamp_box(to_px(rect), img.shape[1], img.shape[0])
                img[y0:y1, x0:x1] = np.array(color, dtype=np.uint8)
            else:
                raster.erase(img, to_px(rect), paper=None, pad=1)

        # Le texte vectoriel survivrait a une retouche pixel : on le retire d'abord.
        page.add_redact_annot(rect, fill=None)
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )
        self._patch_region(page, rect, paint)

    def _apply_add_text(self, page: fitz.Page, op: dict) -> None:
        rect = fitz.Rect(op["bbox"])
        text = op.get("text", "")
        if not text.strip():
            return
        entry = fonts.variant(
            fonts.resolve(op.get("font_key")).key, bool(op.get("bold")), bool(op.get("italic"))
        )
        size = float(op.get("size") or 12)
        color = [c / 255 for c in parse_hex(op.get("color", "#111111"))]
        lines = text.split("\n")
        y = rect.y0 + size
        for line in lines:
            if line.strip():
                try:
                    page.insert_text(
                        (rect.x0, y), line, fontsize=size, fontfile=entry.path,
                        fontname=entry.key[:12], color=color,
                    )
                except Exception:
                    page.insert_text((rect.x0, y), line, fontsize=size, fontname="helv", color=color)
            y += size * 1.25

    def _apply_image(self, page: fitz.Page, op: dict) -> None:
        import base64

        raw = base64.b64decode(op["data"].split(",")[-1])
        page.insert_image(fitz.Rect(op["bbox"]), stream=raw, keep_proportion=bool(op.get("keep_ratio", True)), overlay=True)

    def _apply_draw(self, page: fitz.Page, op: dict) -> None:
        pts = op.get("points", [])
        if len(pts) < 2:
            return
        color = [c / 255 for c in parse_hex(op.get("color", "#d92626"))]
        width = float(op.get("width", 2))
        shape = page.new_shape()
        for a, b in zip(pts, pts[1:]):
            shape.draw_line(fitz.Point(a[0], a[1]), fitz.Point(b[0], b[1]))
        shape.finish(color=color, width=width, lineCap=1, lineJoin=1)
        shape.commit(overlay=True)

    def apply_page_ops(self, page: fitz.Page, idx: int) -> None:
        for op in self.ops_for(idx):
            kind = op.get("type")
            try:
                if kind == "text":
                    item = self.find_item(idx, op.get("item_id", ""))
                    if item and item["source"] == "native" and not op.get("as_raster"):
                        self._apply_native_text(page, op, item)
                    else:
                        self._apply_raster_text(page, op, item)
                elif kind == "erase":
                    self._apply_erase(page, op)
                elif kind == "add_text":
                    self._apply_add_text(page, op)
                elif kind == "image":
                    self._apply_image(page, op)
                elif kind == "draw":
                    self._apply_draw(page, op)
            except Exception as exc:  # une op ratee ne doit pas casser le rendu entier
                op["error"] = str(exc)

    # ---------------- sorties ---------------- #
    def render_page_png(self, idx: int, dpi: float = PREVIEW_DPI) -> bytes:
        key = ("png", idx, self.ops_hash(idx), round(dpi, 1), self.rotations.get(idx, 0))
        if key in self._cache:
            return self._cache[key]
        tmp = fitz.open()
        tmp.insert_pdf(self.src, from_page=idx, to_page=idx, annots=False)
        page = tmp[0]
        if self.ops_for(idx):
            self.apply_page_ops(page, idx)
        rot = self.rotations.get(idx, 0)
        if rot:
            page.set_rotation((page.rotation + rot) % 360)
        png = page.get_pixmap(dpi=int(dpi), colorspace=fitz.csRGB, alpha=False).tobytes("png")
        tmp.close()
        if len(self._cache) > 60:
            self._cache.clear()
        self._cache[key] = png
        return png

    def order(self) -> list[int]:
        return self.page_order or list(range(self.src.page_count))

    def build(self) -> bytes:
        out = fitz.open()
        for idx in self.order():
            out.insert_pdf(self.src, from_page=idx, to_page=idx, annots=True)
            page = out[-1]
            if self.ops_for(idx):
                self.apply_page_ops(page, idx)
            rot = self.rotations.get(idx, 0)
            if rot:
                page.set_rotation((page.rotation + rot) % 360)
        buf = out.tobytes(garbage=4, deflate=True, clean=True)
        out.close()
        return buf
