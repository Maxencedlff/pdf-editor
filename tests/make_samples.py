"""Fabrique deux PDF de test : un natif, et sa version 'scannee' (image bruitee)."""
import io, sys
sys.path.insert(0, "/mnt/c/Users/maxde/pdf-editor")
import fitz, numpy as np
from PIL import Image

OUT = "/tmp/claude-1000/-home-maxdevops/4dafb280-78bb-42c5-a283-67abe006e176/scratchpad"

def build_native(path):
    doc = fitz.open(); page = doc.new_page(width=595, height=842)
    S = "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"
    B = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
    R = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
    page.draw_rect(fitz.Rect(0,0,595,90), color=None, fill=(0.13,0.29,0.53))
    page.insert_text((45,55),"CABINET MARCHAND",fontsize=24,fontfile=B,fontname="sb",color=(1,1,1))
    page.insert_text((45,120),"Facture N 2026-0451",fontsize=18,fontfile=B,fontname="sb2",color=(0.13,0.29,0.53))
    page.insert_text((45,150),"Date : 12 mars 2026",fontsize=11,fontfile=R,fontname="sr",color=(0.2,0.2,0.2))
    page.insert_text((45,170),"Client : Monsieur Dupont",fontsize=11,fontfile=R,fontname="sr",color=(0.2,0.2,0.2))
    y=230
    for label, amount in [("Prestation de conseil","1 200,00 EUR"),("Deplacement","150,00 EUR"),("Total a payer","1 350,00 EUR")]:
        page.insert_text((45,y),label,fontsize=12,fontfile=S,fontname="se",color=(0.1,0.1,0.1))
        page.insert_text((420,y),amount,fontsize=12,fontfile=S,fontname="se",color=(0.1,0.1,0.1))
        y+=30
    page.insert_text((45,420),"Le present contrat est conclu pour une duree de douze mois.",fontsize=10,fontfile=S,fontname="se",color=(0.25,0.25,0.25))
    doc.save(path); doc.close(); print("natif  ->", path)

def build_scan(src, path, dpi=300):
    doc = fitz.open(src); page = doc[0]
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB, alpha=False)
    a = np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,3).astype(np.int16)
    rng = np.random.default_rng(7)
    a = a * np.array([1.0,0.995,0.96])                       # papier legerement jauni
    a += rng.normal(0,4,a.shape)                              # grain du capteur
    ys = np.linspace(0,1,a.shape[0])[:,None,None]
    a -= 6*np.sin(ys*3.1)                                     # leger vignetage
    img = Image.fromarray(np.clip(a,0,255).astype(np.uint8))
    img = img.rotate(0.25, resample=Image.BICUBIC, fillcolor=(250,248,240))  # scan de travers
    buf = io.BytesIO(); img.save(buf,"JPEG",quality=80); buf.seek(0)
    out = fitz.open(); p = out.new_page(width=595,height=842)
    p.insert_image(p.rect, stream=buf.getvalue())
    out.save(path); out.close(); doc.close(); print("scan   ->", path, f"({dpi} dpi)")

build_native(f"{OUT}/sample_native.pdf")
build_scan(f"{OUT}/sample_native.pdf", f"{OUT}/sample_scan.pdf")
