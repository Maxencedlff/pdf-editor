"""Scenarios de bout en bout de la version web (Playwright, Chromium), un par defaut
releve a l'audit du 19/10/2026. Lancer depuis la racine du depot :

    python3 tests/web/e2e.py

Le script sert web/ sur un port libre, fabrique ses PDF de test avec PyMuPDF et rend
un code d'erreur si un scenario echoue."""
import asyncio, http.server, os, socketserver, sys, tempfile, threading
import fitz
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TMP = tempfile.mkdtemp(prefix="e2e-pdf-")
failures = []

def check(ok, label):
    print(("ok    " if ok else "ECHEC ") + label, flush=True)
    if not ok: failures.append(label)

def make_pdfs():
    """Trois pages de texte ; une page pivotee de 90 degres ; une page a MediaBox decalee."""
    d = fitz.open()
    for n in range(3):
        p = d.new_page(width=595, height=842)
        p.insert_text((60, 80), f"Facture numero {n + 1}", fontsize=18)
        p.insert_text((60, 120), "Date : 12 mars 2026", fontsize=12)
        p.insert_text((60, 150), "Client : Monsieur Dupont", fontsize=12)
        p.insert_image(fitz.Rect(60, 300, 535, 700), pixmap=fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 400, 300), 0))
    d.save(f"{TMP}/texte.pdf")
    d = fitz.open()
    p = d.new_page(width=600, height=800); p.insert_text((60, 80), "Page pivotee", fontsize=14); p.set_rotation(90)
    p = d.new_page(width=600, height=800); p.insert_text((160, 180), "Cadre decale", fontsize=14)
    p.set_mediabox(fitz.Rect(100, 100, 700, 900))
    d.save(f"{TMP}/reperes.pdf")

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve():
    handler = lambda *a, **k: Quiet(*a, directory=os.path.join(ROOT, "web"), **k)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

async def open_doc(pg, url, path):
    await pg.goto(url); await pg.wait_for_function("window.__ready === true")
    await pg.evaluate("import('./js/ui.js').then(m => { window.__ui = m; window.__S = m.S; })")
    await pg.set_input_files("#picker", path)
    await pg.wait_for_function("document.getElementById('veil').hidden", timeout=120000)
    await pg.wait_for_timeout(300)

async def export(pg, name):
    async with pg.expect_download() as dl:
        await pg.evaluate("__ui.exportPdf()")
    path = f"{TMP}/{name}"
    await (await dl.value).save_as(path)
    return path

async def edit_line(pg, title, text):
    await pg.locator(f'.hit[title="{title}"]').first.click()
    await pg.fill("#txt", text); await pg.click("#applyBtn"); await pg.wait_for_timeout(400)

async def main():
    make_pdfs()
    httpd = serve()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    errors = []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--mute-audio"])
        ctx = await b.new_context(viewport={"width": 1440, "height": 1400}, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # 1. Changer l'ordre des pages ne fait pas grossir le fichier.
        await open_doc(pg, url, f"{TMP}/texte.pdf")
        ref = os.path.getsize(await export(pg, "ref.pdf"))
        await pg.evaluate("__S.doc.movePage(2, 0)")
        moved = await export(pg, "moved.pdf")
        check(os.path.getsize(moved) <= ref * 1.05, f"ordre change sans doubler le poids ({ref} -> {os.path.getsize(moved)} octets)")
        check("numero 3" in fitz.open(moved)[0].get_text(), "la page deplacee est bien en tete")

        # 2. Dupliquer puis corriger une ligne de la copie : une seule retouche, pas de fantome.
        await open_doc(pg, url, f"{TMP}/texte.pdf")
        await edit_line(pg, "Date : 12 mars 2026", "Date : 12 mars 2026, version longue et definitive")
        await pg.evaluate("__S.doc.duplicate(0)")
        copy = await pg.evaluate("__S.doc.order[1]")
        await pg.evaluate(f"__ui.loadPage({copy})"); await pg.wait_for_timeout(500)
        await edit_line(pg, "Date : 12 mars 2026, version longue et definitive", "Court")
        n = await pg.evaluate(f"__S.doc.ops.filter(o => o.page === {copy} && o.type === 'text').length")
        check(n == 1, f"copie de page : la nouvelle retouche remplace l'ancienne ({n} retouche(s))")

        # 3. Annuler une nouvelle correction rend l'ordre d'avant (la gomme reste au-dessus).
        await open_doc(pg, url, f"{TMP}/texte.pdf")
        await edit_line(pg, "Client : Monsieur Dupont", "Client : Madame Martin")
        await pg.evaluate("__S.doc.addOp({ type: 'erase', page: 0, bbox: [150, 135, 300, 160] })")
        before = await pg.evaluate("__S.doc.ops.map(o => o.type)")
        await edit_line(pg, "Client : Madame Martin", "Client : Monsieur Durand")
        await pg.evaluate("__ui.undo()"); await pg.wait_for_timeout(400)
        after = await pg.evaluate("__S.doc.ops.map(o => o.type)")
        check(before == after, f"annuler rend l'ordre d'avant ({before} / {after})")

        # 4. Un rectangle autour d'une ligne laisse la ligne touchable ; son trait le selectionne.
        await open_doc(pg, url, f"{TMP}/texte.pdf")
        await pg.evaluate("__S.doc.addOp({ type: 'mark', kind: 'rect', page: 0, color: '#e0262a', width: 2, box: [40, 100, 400, 160] })")
        await pg.evaluate("__ui.loadPage(0)"); await pg.wait_for_timeout(500)
        hit = pg.locator('.hit[title="Date : 12 mars 2026"]')
        await hit.click(); await pg.wait_for_timeout(200)
        check(await pg.evaluate("!!__S.sel"), "le texte entoure d'un rectangle reste modifiable")
        await pg.keyboard.press("Escape")
        cv = await pg.locator("#canvas").bounding_box()
        k = await pg.evaluate("__S.baseScale * __S.zoom")
        await pg.mouse.click(cv["x"] + 40 * k, cv["y"] + 130 * k); await pg.wait_for_timeout(200)
        check(await pg.evaluate("!document.getElementById('objBar').hidden"), "toucher le trait du rectangle le selectionne")

        # 5. Echap puis glisser l'ancien objet selectionne : aucune erreur.
        await pg.keyboard.press("Escape")
        await pg.mouse.move(cv["x"] + 40 * k, cv["y"] + 130 * k); await pg.mouse.down()
        await pg.mouse.move(cv["x"] + 80 * k, cv["y"] + 170 * k, steps=5); await pg.mouse.up()
        check(not errors, f"glisser apres Echap sans erreur {errors[:1]}")

        # 6. Annotation sur une page pivotee et sur un cadre decale : a la bonne place.
        await open_doc(pg, url, f"{TMP}/reperes.pdf")
        for page in (0, 1):
            await pg.evaluate(f"__S.doc.addOp({{ type: 'mark', kind: 'rect', page: {page}, color: '#ff0000', width: 3, box: [30, 30, 130, 90] }})")
        out = fitz.open(await export(pg, "reperes-out.pdf"))
        for i, label in ((0, "page pivotee de 90 degres"), (1, "page a cadre decale")):
            pix = out[i].get_pixmap(dpi=72)
            red = [(x, y) for y in range(pix.height) for x in range(pix.width)
                   if (lambda c: c[0] > 200 and c[1] < 80 and c[2] < 80)(pix.pixel(x, y))]
            box = [min(x for x, _ in red), min(y for _, y in red), max(x for x, _ in red), max(y for _, y in red)] if red else None
            check(box is not None and all(abs(a - b) <= 3 for a, b in zip(box, [29, 29, 131, 91])), f"{label} : rectangle a sa place ({box})")
        await b.close()
    httpd.shutdown()
    check(not errors, f"aucune erreur JavaScript {errors[:2]}")
    print("\n" + ("Tout passe." if not failures else f"{len(failures)} echec(s)."))
    sys.exit(1 if failures else 0)

asyncio.run(main())
