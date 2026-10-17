"""Serveur local de l'editeur PDF.

Rien ne sort de la machine : les documents restent en memoire et sur le disque local.
"""
from __future__ import annotations

import io

import uuid
from pathlib import Path

import fitz
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from pdfcore import fonts, ocr
from pdfcore.document import Doc

BASE = Path(__file__).parent
STORE: dict[str, Doc] = {}
MAX_DOCS = 8
MAX_MB = 120

app = FastAPI(title="Editeur PDF local", docs_url=None, redoc_url=None)


def get(doc_id: str) -> Doc:
    d = STORE.get(doc_id)
    if not d:
        raise HTTPException(404, "Document inconnu ou expire, rouvrez le fichier.")
    return d


LOCAL_ROOT = Path("/mnt/c/Users/maxde").resolve()


@app.get("/api/local")
def local_file(path: str):
    """Sert un PDF du disque, pour ouvrir l'editeur directement sur un fichier (?file=...).

    Accepte un chemin Windows (C:\\...) ou WSL ; limite au dossier utilisateur.
    """
    if len(path) > 2 and path[1] == ":":
        path = "/mnt/" + path[0].lower() + path[2:].replace("\\", "/")
    p = Path(path).resolve()
    if not p.is_relative_to(LOCAL_ROOT) or p.suffix.lower() != ".pdf" or not p.is_file():
        raise HTTPException(404, "Fichier introuvable.")
    return FileResponse(p, media_type="application/pdf", filename=p.name)


@app.get("/api/config")
def config():
    return {
        "fonts": [
            {"key": f.key, "label": f.label, "family": f.family, "bold": f.bold, "italic": f.italic}
            for f in fonts.CATALOG
        ],
        "langs": ocr.available_langs(),
        "default_lang": ocr.DEFAULT_LANG,
    }


@app.post("/api/open")
async def open_pdf(file: UploadFile = File(...), lang: str = Form(ocr.DEFAULT_LANG)):
    raw = await file.read()
    if len(raw) > MAX_MB * 1024 * 1024:
        raise HTTPException(413, f"Fichier trop volumineux (max {MAX_MB} Mo).")
    try:
        src = fitz.open(stream=raw, filetype="pdf")
    except Exception:
        raise HTTPException(400, "Fichier illisible : ce n'est pas un PDF valide.")
    if src.needs_pass:
        raise HTTPException(400, "PDF protege par mot de passe.")

    while len(STORE) >= MAX_DOCS:
        STORE.pop(next(iter(STORE)), None)

    doc_id = uuid.uuid4().hex[:12]
    d = Doc(doc_id=doc_id, name=file.filename or "document.pdf", src=src, lang=lang)
    STORE[doc_id] = d
    return {
        "doc_id": doc_id,
        "name": d.name,
        "page_count": src.page_count,
        "pages": [d.page_meta(i) for i in range(src.page_count)],
    }


@app.get("/api/page/{doc_id}/{idx}")
def page_png(doc_id: str, idx: int, dpi: float = 140, v: str = ""):
    d = get(doc_id)
    if not 0 <= idx < d.src.page_count:
        raise HTTPException(404, "Page inexistante.")
    png = d.render_page_png(idx, dpi=max(40, min(400, dpi)))
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/analyze/{doc_id}/{idx}")
def analyze(doc_id: str, idx: int, force: str | None = None):
    d = get(doc_id)
    if not 0 <= idx < d.src.page_count:
        raise HTTPException(404, "Page inexistante.")
    return d.analyze(idx, force=force)


@app.post("/api/op/{doc_id}")
def add_op(doc_id: str, op: dict = Body(...)):
    d = get(doc_id)
    if op.get("type") not in {"text", "erase", "add_text", "image", "draw"}:
        raise HTTPException(400, "Operation inconnue.")
    op.setdefault("page", 0)
    op["uid"] = uuid.uuid4().hex[:8]
    d.ops.append(op)
    return {"ok": True, "count": len(d.ops), "uid": op["uid"], "version": d.ops_hash(op["page"])}


@app.post("/api/undo/{doc_id}")
def undo(doc_id: str):
    d = get(doc_id)
    removed = d.ops.pop() if d.ops else None
    return {"ok": True, "removed": removed, "count": len(d.ops)}


@app.post("/api/op/{doc_id}/delete/{uid}")
def delete_op(doc_id: str, uid: str):
    d = get(doc_id)
    d.ops = [o for o in d.ops if o.get("uid") != uid]
    return {"ok": True, "count": len(d.ops)}


@app.post("/api/pages/{doc_id}")
def pages_action(doc_id: str, body: dict = Body(...)):
    d = get(doc_id)
    action = body.get("action")
    idx = int(body.get("index", 0))
    if action == "rotate":
        d.rotations[idx] = (d.rotations.get(idx, 0) + int(body.get("angle", 90))) % 360
        d._cache.clear()
    elif action == "delete":
        order = d.order()
        if len(order) <= 1:
            raise HTTPException(400, "Impossible de supprimer la derniere page.")
        d.page_order = [p for p in order if p != idx]
    elif action == "move":
        order = d.order()
        to = int(body.get("to", 0))
        if idx in order and 0 <= to < len(order):
            order.remove(idx)
            order.insert(to, idx)
            d.page_order = order
    elif action == "restore":
        d.page_order = list(range(d.src.page_count))
    else:
        raise HTTPException(400, "Action inconnue.")
    return {"ok": True, "order": d.order(), "rotations": d.rotations}


@app.get("/api/export/{doc_id}")
def export(doc_id: str):
    d = get(doc_id)
    try:
        data = d.build()
    except Exception as exc:
        raise HTTPException(500, f"Export impossible : {exc}")
    name = (d.name or "document.pdf").rsplit(".", 1)[0] + "-modifie.pdf"
    return Response(
        data,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{name}"', "Content-Length": str(len(data))},
    )


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")


# La version locale reprend la feuille de style et les icones de la version web (une
# seule source de design) : le dossier web est servi en lecture seule sous /web.
app.mount("/web", StaticFiles(directory=BASE / "web"), name="web")
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
