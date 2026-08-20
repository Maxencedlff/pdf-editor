"""Catalogue de polices locales + reconnaissance de police par comparaison d'images.

Sur un PDF scanne, la police d'origine n'existe nulle part dans le fichier : il n'y a
qu'une image. On la retrouve empiriquement -- on redessine le mot lu par l'OCR avec
chaque police candidate et on garde celle dont les pixels recouvrent le mieux ceux du
scan (IoU sur les masques d'encre).
"""
from __future__ import annotations

import math
import os
import threading
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

LIB = "/usr/share/fonts/truetype/liberation"
DEJA = "/usr/share/fonts/truetype/dejavu"


@dataclass(frozen=True)
class FontEntry:
    key: str          # identifiant stable cote client
    label: str        # nom affiche
    path: str         # fichier ttf
    family: str       # famille logique (sans, serif, mono, narrow)
    bold: bool
    italic: bool

    @property
    def available(self) -> bool:
        return os.path.exists(self.path)


def _fam(family: str, label: str, base: str, folder: str, suffixes) -> list[FontEntry]:
    out = []
    for bold, italic, suf in suffixes:
        style = (" Gras" if bold else "") + (" Italique" if italic else "")
        out.append(
            FontEntry(
                key=f"{base}{suf}",
                label=f"{label}{style}",
                path=f"{folder}/{base}{suf}.ttf",
                family=family,
                bold=bold,
                italic=italic,
            )
        )
    return out


_LIB_SUF = [
    (False, False, "-Regular"),
    (True, False, "-Bold"),
    (False, True, "-Italic"),
    (True, True, "-BoldItalic"),
]
_DEJA_SUF_SANS = [
    (False, False, ""),
    (True, False, "-Bold"),
    (False, True, "-Oblique"),
    (True, True, "-BoldOblique"),
]
_DEJA_SUF_SERIF = [
    (False, False, ""),
    (True, False, "-Bold"),
    (False, True, "-Italic"),
    (True, True, "-BoldItalic"),
]

CATALOG: list[FontEntry] = [
    *_fam("sans", "Sans (Arial)", "LiberationSans", LIB, _LIB_SUF),
    *_fam("serif", "Serif (Times)", "LiberationSerif", LIB, _LIB_SUF),
    *_fam("mono", "Mono (Courier)", "LiberationMono", LIB, _LIB_SUF),
    *_fam("narrow", "Sans etroit", "LiberationSansNarrow", LIB, _LIB_SUF),
    *_fam("sans2", "Sans (Verdana)", "DejaVuSans", DEJA, _DEJA_SUF_SANS),
    *_fam("serif2", "Serif (DejaVu)", "DejaVuSerif", DEJA, _DEJA_SUF_SERIF),
    *_fam("mono2", "Mono (DejaVu)", "DejaVuSansMono", DEJA, _DEJA_SUF_SANS),
]
CATALOG = [f for f in CATALOG if f.available]
BY_KEY = {f.key: f for f in CATALOG}
DEFAULT_KEY = "LiberationSans-Regular" if "LiberationSans-Regular" in BY_KEY else CATALOG[0].key


def resolve(key: str | None) -> FontEntry:
    if key and key in BY_KEY:
        return BY_KEY[key]
    return BY_KEY[DEFAULT_KEY]


def variant(key: str, bold: bool, italic: bool) -> FontEntry:
    """Meme famille, autre graisse/italique."""
    base = resolve(key)
    for f in CATALOG:
        if f.family == base.family and f.bold == bold and f.italic == italic:
            return f
    return base


# Cache par thread : les objets de police de PIL ne supportent pas d'etre partages entre
# threads, et l'analyse des lignes tourne en parallele.
_local = threading.local()


def load(path: str, size: int) -> ImageFont.FreeTypeFont:
    cache = getattr(_local, "fonts", None)
    if cache is None:
        cache = _local.fonts = {}
    key = (path, int(size))
    font = cache.get(key)
    if font is None:
        if len(cache) > 256:
            cache.clear()
        font = cache[key] = ImageFont.truetype(path, max(4, int(size)))
    return font


# --------------------------------------------------------------------------- #
# Mesures
# --------------------------------------------------------------------------- #
def text_width(entry: FontEntry, text: str, size: float) -> float:
    """Largeur en px du texte rendu a `size` px (mesure sub-pixel par mise a l'echelle)."""
    ref = 100
    f = load(entry.path, ref)
    w = f.getlength(text or " ")
    return w * size / ref


def ink_width(entry: FontEntry, text: str, size: float) -> float:
    """Largeur du premier au dernier pixel d'encre (pas l'avance typographique)."""
    ref = 100
    f = load(entry.path, ref)
    bb = f.getbbox(text or " ")
    w = (bb[2] - bb[0]) if bb else f.getlength(text or " ")
    return w * size / ref


def fit_size(entry: FontEntry, text: str, target_w: float, hint: float) -> float:
    """Taille en px pour que `text` occupe exactement `target_w` px de large."""
    if not text.strip() or target_w <= 1:
        return hint
    w_at_hint = text_width(entry, text, hint)
    if w_at_hint <= 0.01:
        return hint
    return hint * target_w / w_at_hint


def ink_height_ratio(entry: FontEntry, text: str) -> float:
    """Hauteur d'encre du texte rapportee au corps, pour ces glyphes precis."""
    ref = 100
    f = load(entry.path, ref)
    bb = f.getbbox(text or "X")
    if not bb:
        return 0.7
    h = (bb[3] - bb[1]) / ref
    return h if h > 0.05 else 0.7


def fit_size_by_height(entry: FontEntry, text: str, target_h: float, hint: float) -> float:
    """Corps deduit de la hauteur d'encre observee.

    Plus fiable que la largeur : la hauteur ne depend pas de la chasse de la police,
    donc une police approximative donne quand meme le bon corps.
    """
    t = (text or "").strip()
    if not t or target_h <= 1:
        return hint
    r = ink_height_ratio(entry, t)
    return target_h / r if r > 0.05 else hint


def tracking_slots(text: str) -> int:
    """Nombre d'intervalles ou l'interlettrage s'applique.

    Les espaces en sont exclus : les resserrer collerait les mots entre eux, ce qui se
    remarque bien plus qu'une largeur totale approximative.
    """
    t = text or ""
    return sum(1 for a, b in zip(t, t[1:]) if not a.isspace() and not b.isspace())


def tracking_for(entry: FontEntry, text: str, size: float, target_w: float) -> float:
    """Espacement additionnel par caractere pour retomber sur la largeur d'origine."""
    t = text or ""
    n = tracking_slots(t)
    if n < 1 or target_w <= 1:
        return 0.0
    natural = ink_width(entry, t, size)
    # Correction volontairement discrete : au-dela, le texte parait comprime ou etire,
    # defaut plus visible qu'un leger ecart de longueur de ligne.
    limit = size * 0.06
    return float(np.clip((target_w - natural) / n, -limit, limit))


def ink_bbox(mask: np.ndarray):
    """Bbox des pixels non nuls, ou None."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def render_mask(entry: FontEntry, text: str, size: int, pad: int = 6, blur: float = 0.0) -> np.ndarray:
    """Masque binaire (True = encre) du texte rendu seul.

    `blur` reproduit le flou mesure sur le scan. Sans lui, on comparerait un rendu net a
    un texte numerise empate : l'empatement gonfle la hauteur d'encre d'environ 10 % mais
    la largeur de 1 %, ce qui fait passer n'importe quel texte pour une police condensee
    et grasse.
    """
    f = load(entry.path, size)
    w = int(f.getlength(text or " ")) + 2 * pad
    h = int(size * 2.2) + 2 * pad
    img = Image.new("L", (max(w, 8), max(h, 8)), 0)
    ImageDraw.Draw(img).text((pad, pad), text, font=f, fill=255)
    a = np.asarray(img)
    if blur > 0.05:
        a = cv2.GaussianBlur(a.astype(np.float32), (0, 0), float(blur))
    return a > 96


# --------------------------------------------------------------------------- #
# Reconnaissance
# --------------------------------------------------------------------------- #
def _normalize(mask: np.ndarray, out_h: int = 32) -> np.ndarray | None:
    """Recadre sur l'encre puis met a hauteur fixe -- rend les masques comparables."""
    bb = ink_bbox(mask)
    if bb is None:
        return None
    x0, y0, x1, y1 = bb
    crop = mask[y0:y1, x0:x1]
    h, w = crop.shape
    if h < 2 or w < 2:
        return None
    out_w = max(2, min(1400, int(round(w * out_h / h))))
    im = Image.fromarray((crop * 255).astype(np.uint8)).resize((out_w, out_h), Image.BILINEAR)
    return np.asarray(im) > 110


def _shape_iou(a: np.ndarray, b: np.ndarray) -> float:
    """IoU des formes, apres recalage du candidat sur la largeur de la reference.

    Le recalage absorbe la derive d'espacement qui, sur une ligne entiere, decale la fin
    du texte et ecraserait tous les scores. La chasse perdue ici est reintroduite
    separement par _aspect_score.
    """
    if a.shape[1] != b.shape[1]:
        b = np.asarray(
            Image.fromarray((b * 255).astype(np.uint8)).resize((a.shape[1], a.shape[0]), Image.BILINEAR)
        ) > 110
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter) / float(union) if union else 0.0


def _aspect_score(w_ref: int, w_cand: int) -> float:
    """Proximite de chasse : 1.0 si le candidat a la meme largeur a hauteur egale."""
    if w_ref < 1 or w_cand < 1:
        return 0.0
    return float(np.exp(-3.0 * abs(np.log(w_ref / w_cand))))


# Ponderation calibree par balayage sur des scans simulees (bruit + JPEG).
W_SHAPE, W_ASPECT = 0.75, 0.25


def _despeckle(mask: np.ndarray) -> np.ndarray:
    """Retire le poivre-et-sel du seuillage, qui gonflerait l'epaisseur mesuree."""
    m = mask.astype(np.uint8)
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8)).astype(bool)


def stroke_ratio(mask: np.ndarray) -> float:
    """Demi-epaisseur du trait rapportee a la hauteur d'encre.

    Obtenue par transformee de distance : contrairement a un rapport aire/perimetre, elle
    resiste au grignotage des bords par le bruit de numerisation.
    """
    if mask.shape[0] < 4 or not mask.any():
        return 0.0
    dt = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 3)
    vals = dt[dt > 0]
    if vals.size < 8:
        return 0.0
    return float(np.percentile(vals, 85)) / mask.shape[0]


def estimate_slant(mask: np.ndarray) -> float:
    """Inclinaison des fûts, en degres (0 = droit, ~8-12 = italique).

    On cisaille le masque a differents angles et on garde celui qui aligne le mieux les
    traits verticaux (energie maximale de la projection sur les colonnes). Mesure directe
    et insensible au flou, la ou la comparaison de formes prend un scan bave pour de
    l'italique gras.
    """
    h, w = mask.shape
    if h < 8 or w < 8 or not mask.any():
        return 0.0
    best_a, best_e = 0.0, -1.0
    for ang in range(-20, 21, 2):
        t = math.tan(math.radians(ang))
        pad = int(abs(t) * h) + 2
        out = np.zeros((h, w + pad), dtype=bool)
        base = pad // 2
        for y in range(h):
            dx = int(round((y - h / 2) * t)) + base
            if 0 <= dx <= pad:
                out[y, dx : dx + w] = mask[y]
        col = out.sum(axis=0).astype(np.float64)
        e = float((col ** 2).sum())
        if e > best_e:
            best_a, best_e = float(ang), e
    return best_a


def _crop_ink(mask: np.ndarray) -> np.ndarray | None:
    bb = ink_bbox(mask)
    if bb is None:
        return None
    x0, y0, x1, y1 = bb
    c = mask[y0:y1, x0:x1]
    return c if c.shape[0] >= 2 and c.shape[1] >= 2 else None


def _upscale(mask: np.ndarray, factor: float) -> np.ndarray:
    if abs(factor - 1.0) < 0.02:
        return mask
    h = max(2, int(round(mask.shape[0] * factor)))
    w = max(2, int(round(mask.shape[1] * factor)))
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)) > 110


def _looks_bold(ref: np.ndarray, text: str, blur: float) -> bool | None:
    """Compare l'epaisseur de trait observee a celle d'un maigre et d'un gras temoins.

    Les temoins sont rendus a la meme hauteur et avec le meme flou que la reference, donc
    les trois epaisseurs sont directement comparables. Retourne None si l'ecart entre les
    deux temoins est trop faible pour trancher.
    """
    probe = {}
    for bold in (False, True):
        entry = variant(DEFAULT_KEY, bold, False)
        size = ref.shape[0] / max(0.05, ink_height_ratio(entry, text))
        try:
            m = _crop_ink(render_mask(entry, text, int(np.clip(size, 6, 300)), blur=blur))
        except OSError:
            return None
        if m is None:
            return None
        if m.shape[0] != ref.shape[0]:
            m = _upscale(m, ref.shape[0] / m.shape[0])
        probe[bold] = stroke_ratio(_despeckle(m))
    thin, thick = probe[False], probe[True]
    gap = thick - thin
    if gap < 0.004:
        return None
    observed = stroke_ratio(_despeckle(ref))
    d_thin, d_thick = abs(observed - thin), abs(observed - thick)
    # On ne tranche que si l'ecart est franc. Sur un scan bruite, l'epaisseur mesuree
    # oscille assez pour qu'un depart serre se trompe une fois sur deux ; mieux vaut
    # alors laisser la comparaison de formes decider.
    if min(d_thin, d_thick) > 0.45 * gap:
        return None
    return d_thick < d_thin


def identify(
    samples: list[tuple[np.ndarray, str]],
    candidates: list[FontEntry] | None = None,
    line_slope_deg: float = 0.0,
    blur: float = 0.0,
    noise: float = 0.0,
):
    """Devine la police d'un texte scanne.

    `samples` est une liste de (masque d'encre, texte lu) portant chacun sur quelques mots.
    On ne compare jamais une ligne entiere : sur soixante caracteres, un ecart d'espacement
    minime decale la fin du trace et fait s'effondrer le recouvrement de toutes les
    polices a la fois, si bien que le classement ne veut plus rien dire. Sur des mots
    isoles, dont l'OCR donne la position exacte, il n'y a pas de derive a rattraper.

    Retourne (FontEntry, score 0..1) ; un score bas signale un resultat peu fiable.
    """
    prepared = []
    for mask, text in samples:
        text = (text or "").strip()
        ref = _crop_ink(mask) if mask is not None else None
        if ref is None or len(text) < 2 or ref.shape[0] < 5:
            continue
        prepared.append((ref, text[:40], max(1.0, 24.0 / ref.shape[0])))
    if not prepared:
        return resolve(None), 0.0

    pool = candidates if candidates is not None else CATALOG
    ref0, text0, boost0 = prepared[0]
    if candidates is None and len(text0) >= 5 and ref0.shape[0] >= 12:
        # Un scan bave et epaissi passe volontiers pour de l'italique gras aux yeux d'une
        # comparaison de formes. On mesure donc l'inclinaison, en retirant la pente de la
        # ligne elle-meme : sur une photo de document prise de travers, la page entiere
        # penche sans que le texte soit italique pour autant.
        residual = abs(estimate_slant(ref0) - line_slope_deg)
        # Filtre asymetrique : "droit" est une conclusion sure, "penche" ne l'est pas
        # (il reste une rotation residuelle possible), donc on n'impose rien dans ce cas.
        if residual < 4.0:
            subset = [f for f in pool if not f.italic]
            if subset:
                pool = subset

        # Sur un texte petit ou une image bruitee, l'ecart d'epaisseur entre un maigre et
        # un gras se compte en fractions de pixel : la mesure n'y veut plus rien dire.
        want_bold = _looks_bold(ref0, text0, blur) if (ref0.shape[0] >= 20 and noise < 2.0) else None
        if want_bold is not None:
            subset = [f for f in pool if f.bold == want_bold]
            if subset:
                pool = subset

    best, best_score = resolve(None), -1.0
    for entry in pool:
        total, weight = 0.0, 0.0
        for ref, text, boost in prepared:
            try:
                # Rendu a la taille reellement observee : le candidat subit alors les memes
                # pertes de rasterisation que le scan, sinon un trait net passe pour maigre
                # face a un trait bruite qui parait gras.
                size = ref.shape[0] / max(0.05, ink_height_ratio(entry, text))
                cand = _crop_ink(render_mask(entry, text, int(round(np.clip(size, 6, 300))), blur=blur))
            except OSError:
                continue
            if cand is None:
                continue
            ref_up = _upscale(ref, boost)
            cand_up = _upscale(cand, boost)
            if cand_up.shape[0] != ref_up.shape[0]:
                cand_up = _upscale(cand_up, ref_up.shape[0] / cand_up.shape[0])
            score = W_SHAPE * _shape_iou(ref_up, cand_up) + W_ASPECT * _aspect_score(
                ref_up.shape[1], cand_up.shape[1]
            )
            total += score * len(text)
            weight += len(text)
        if weight and total / weight > best_score:
            best, best_score = entry, total / weight
    return best, max(0.0, best_score)
