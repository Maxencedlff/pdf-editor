/* Acces au serveur local (server.py). Chaque methode correspond a une route /api ; l'UI ne
   connait que cette classe, comme la version web ne connait que PdfDoc (web/js/doc.js).

   Le serveur garde le document, les retouches, l'ordre et la rotation des pages. On en
   tient ici un miroir minimal (retouches par uid, pages retirees, rotations, analyses)
   pour que l'interface reponde sans aller-retour et pour savoir rejouer une operation. */

/** Requete JSON ; une erreur HTTP devient une Error portant le message du serveur. */
async function request(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let detail = r.statusText || `Erreur ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch (_) { /* corps non JSON */ }
    throw new Error(detail);
  }
  return r;
}
const json = async (url, opts) => (await request(url, opts)).json();
const post = (url, body) => json(url, {
  method: "POST",
  headers: body ? { "Content-Type": "application/json" } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

/** Catalogue des polices et langues OCR disponibles sur le serveur. */
export const loadConfig = () => json("/api/config");

/** Recupere un PDF du disque (ouverture directe par ?file=<chemin>). */
export async function fetchLocalFile(path) {
  const r = await request(`/api/local?path=${encodeURIComponent(path)}`);
  const name = path.split(/[\\/]/).pop() || "document.pdf";
  return new File([await r.blob()], name, { type: "application/pdf" });
}

export class LocalDoc {
  constructor(info) {
    this.id = info.doc_id;
    this.name = info.name;
    this.pageCount = info.page_count;
    this.sizes = info.pages.map((p) => ({ width: p.width, height: p.height }));
    this.ops = new Map();        // uid -> operation, miroir de la liste du serveur
    this.removed = new Set();    // pages retirees de l'export
    this.rotations = new Map();  // page -> angle (0, 90, 180, 270)
    this.analyses = new Map();   // page -> analyse ; les textes y sont mis a jour apres retouche
    this.version = 0;            // compteur anti-cache pour les rendus
  }

  static async open(file) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return new LocalDoc(await json("/api/open", { method: "POST", body: fd }));
  }

  pageSize(i) { return this.sizes[i]; }

  /** Rendu de la page, retouches et rotation comprises (la rotation est appliquee par le
      serveur ; l'UI la defait pour animer elle-meme). */
  async renderPage(i, dpi) {
    const d = Math.max(40, Math.min(400, dpi)).toFixed(1);
    const r = await request(`/api/page/${this.id}/${i}?dpi=${d}&v=${++this.version}`);
    return createImageBitmap(await r.blob());
  }

  /** Analyse d'une page. `force` = "ocr" | "native" impose le regime et remplace le cache. */
  async analyze(i, force) {
    if (!force && this.analyses.has(i)) return this.analyses.get(i);
    const a = await json(`/api/analyze/${this.id}/${i}` + (force ? `?force=${force}` : ""));
    this.analyses.set(i, a);
    return a;
  }

  findItem(page, id) {
    return this.analyses.get(page)?.items.find((it) => it.id === id) || null;
  }

  opsFor(page) { return [...this.ops.values()].filter((o) => o.page === page); }

  /** Ajoute une operation ; renvoie l'uid attribue par le serveur. Le meme contenu peut
      etre renvoye plus tard pour la retablir (le serveur n'a pas de « retablir »). */
  async addOp(op) {
    const res = await post(`/api/op/${this.id}`, op);
    this.ops.set(res.uid, op);
    return res.uid;
  }

  async deleteOp(uid) {
    await post(`/api/op/${this.id}/delete/${uid}`);
    this.ops.delete(uid);
  }

  /** Pivote de `delta` degres (multiple de 90, negatif vers la gauche). */
  async rotate(i, delta) {
    await post(`/api/pages/${this.id}`, { action: "rotate", index: i, angle: delta });
    const angle = (((this.rotations.get(i) || 0) + delta) % 360 + 360) % 360;
    if (angle) this.rotations.set(i, angle); else this.rotations.delete(i);
  }

  async remove(i) {
    await post(`/api/pages/${this.id}`, { action: "delete", index: i });
    this.removed.add(i);
  }

  /** Remet une page retiree. Le serveur ne sait que tout restaurer : on restaure, puis on
      retire de nouveau les pages qui doivent le rester. */
  async restore(i) {
    this.removed.delete(i);
    await post(`/api/pages/${this.id}`, { action: "restore" });
    for (const j of this.removed) await post(`/api/pages/${this.id}`, { action: "delete", index: j });
  }

  /** PDF final, construit par le serveur. */
  async export() {
    const r = await request(`/api/export/${this.id}`);
    return r.blob();
  }
}
