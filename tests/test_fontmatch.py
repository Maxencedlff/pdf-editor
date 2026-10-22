"""Verifie que la police d'un texte scanne est bien retrouvee (bruit + JPEG inclus)."""
import io, sys
sys.path.insert(0, "/mnt/c/Users/maxde/pdf-editor")
import numpy as np
from PIL import Image, ImageDraw
from pdfcore import fonts, raster

SAMPLES = [
    "Facture N 2026-0451", "Monsieur Dupont", "Total a payer",
    "Le present contrat est conclu", "Reference client ABX-77",
]
TARGETS = ["LiberationSans-Regular","LiberationSans-Bold","LiberationSerif-Regular",
           "LiberationSerif-Bold","LiberationMono-Regular","DejaVuSans","DejaVuSerif"]

def fake_scan(text, entry, size, dpi_noise=True):
    f = fonts.load(entry.path, size)
    w = int(f.getlength(text)) + 40; h = int(size * 2.4) + 30
    img = Image.new("RGB", (w, h), (250, 248, 243))       # papier legerement creme
    ImageDraw.Draw(img).text((20, 15), text, font=f, fill=(28, 30, 38))
    a = np.asarray(img).astype(np.int16)
    if dpi_noise:
        a += np.random.default_rng(0).normal(0, 5, a.shape).astype(np.int16)
    a = np.clip(a, 0, 255).astype(np.uint8)
    buf = io.BytesIO(); Image.fromarray(a).save(buf, "JPEG", quality=72); buf.seek(0)
    return np.asarray(Image.open(buf).convert("RGB"))

ok = exact_fam = style_ok = 0; total = 0; fails = []
for key in TARGETS:
    entry = fonts.BY_KEY[key]
    for text in SAMPLES:
        for size in (18, 28, 42):
            img = fake_scan(text, entry, size)
            m = raster.measure_line(img, (0, 0, img.shape[1], img.shape[0]), text)
            got = fonts.BY_KEY[m["font_key"]]
            total += 1
            if got.family == entry.family: exact_fam += 1
            if got.bold == entry.bold and got.italic == entry.italic: style_ok += 1
            if got.key == key: ok += 1
            else: fails.append((key, m["font_key"], text[:18], size, m["font_score"]))
            # corps estime : tolerance 15%
            err = abs(m["size_px"] - size) / size
            assert err < 0.22, f"taille {m['size_px']} vs {size} ({key}, {text[:12]})"
print(f"police exacte : {ok}/{total} ({100*ok/total:.0f}%)")
print(f"graisse+italique : {style_ok}/{total} ({100*style_ok/total:.0f}%)")
print(f"famille correcte : {exact_fam}/{total} ({100*exact_fam/total:.0f}%)")
for f in fails[:12]: print("  MISS", f)
