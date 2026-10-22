/* Modele de document dans le navigateur : rendu (pdf.js), analyse, edition, export
   (pdf-lib). Toutes les coordonnees stockees sont en points PDF (1/72 pouce).

   Pages : chaque page a un identifiant stable, qui sert de cle aux retouches, rotations
   et analyses. Une page vient d'un PDF source (le document ouvert ou un PDF ajoute) ou
   est blanche ; `order` donne l'ordre affiche et exporte. Les pages du document ouvert
   gardent leur indice d'origine comme identifiant. */

import * as fonts from "./fonts.js";
import * as img from "./imaging.js";
import { ocrLines } from "./ocr.js";
import * as marks from "./marks.js";

const PATCH_MARGIN_PT = 2.5;
const MAX_PATCH_DPI = 320;
const MIN_PATCH_DPI = 150;

let uidCounter = 0;
const nextUid = () => `op${++uidCounter}`;

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export class PdfDoc {
  constructor(name, bytes, pdf) {
    this.name = name;
    this.bytes = bytes;
    this.pdf = pdf;
    this.sources = [{ bytes, pdf }];
    this.slots = new Map();
    for (let i = 0; i < pdf.numPages; i++) this.slots.set(i, { src: 0, index: i });
    this.order = [...this.slots.keys()];
    this.nextId = pdf.numPages;
    this.ops = [];
    this.analysis = new Map();
    this.rotations = new Map();
    this.removed = new Set();
    this.nativeDpi = new Map();
  }

  static async open(file) {
    const { bytes, pdf } = await load(file);
    return new PdfDoc(file.name || "document.pdf", bytes, pdf);
  }

  /** Page pdf.js d'un identifiant ; `null` pour une page blanche. */
  async pdfPage(id) {
    const slot = this.slots.get(id);
    if (!slot || slot.blank) return null;
    return this.sources[slot.src].pdf.getPage(slot.index + 1);
  }

  async pageSize(idx) {
    const slot = this.slots.get(idx);
    if (slot?.blank) return { ...slot.blank };
    const page = await this.pdfPage(idx);
    const v = page.getViewport({ scale: 1 });
    return { width: v.width, height: v.height };
  }

  /* ------------------------------------------------------------- pages */
  /** Page blanche placee apres `afterId`, de la taille donnee. */
  insertBlank(afterId, size) {
    const id = this.nextId++;
    this.slots.set(id, { blank: { width: size.width, height: size.height } });
    this.order.splice(this.order.indexOf(afterId) + 1, 0, id);
    return id;
  }

  /** Copie d'une page avec ses retouches et sa rotation, placee juste apres elle. */
  duplicate(id) {
    const copy = this.nextId++;
    this.slots.set(copy, { ...this.slots.get(id) });
    if (this.rotations.has(id)) this.rotations.set(copy, this.rotations.get(id));
    if (this.nativeDpi.has(id)) this.nativeDpi.set(copy, this.nativeDpi.get(id));
    // L'analyse est recopiee avec des zones renommees : une zone appartient a une page.
    const rename = (itemId) => itemId && itemId.replace(/^p\d+-/, `p${copy}-`);
    const a = this.analysis.get(id);
    if (a) {
      const clone = JSON.parse(JSON.stringify(a));
      clone.index = copy;
      clone.items.forEach((it) => (it.id = rename(it.id)));
      this.analysis.set(copy, clone);
    }
    for (const op of this.opsFor(id)) {
      this.addOp({ ...op, uid: undefined, page: copy, itemId: rename(op.itemId) });
    }
    this.order.splice(this.order.indexOf(id) + 1, 0, copy);
    return copy;
  }

  /** Ajoute les pages d'un autre PDF apres `afterId`. Retourne leurs identifiants. */
  async insertPdf(file, afterId) {
    const { bytes, pdf } = await load(file);
    const src = this.sources.push({ bytes, pdf }) - 1;
    const ids = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const id = this.nextId++;
      this.slots.set(id, { src, index: i });
      ids.push(id);
    }
    this.order.splice(this.order.indexOf(afterId) + 1, 0, ...ids);
    return ids;
  }

  /** Deplace une page a la position `pos` de l'ordre. */
  movePage(id, pos) {
    this.order.splice(this.order.indexOf(id), 1);
    this.order.splice(Math.max(0, Math.min(this.order.length, pos)), 0, id);
  }

  /** Resolution reelle de la plus grande image de la page.
      Elle sert a re-encoder les retouches a la finesse du scan : rendre a 150 dpi une page
      numerisee a 300 rendrait le rectangle retouche visiblement plus flou que le reste. */
  async detectNativeDpi(idx) {
    if (this.nativeDpi.has(idx)) return this.nativeDpi.get(idx);
    let dpi = 200;
    try {
      const page = await this.pdfPage(idx);
      if (!page) throw new Error("page blanche");
      const v = page.getViewport({ scale: 1 });
      const ops = await page.getOperatorList();
      let widest = 0;
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== pdfjsLib.OPS.paintImageXObject) continue;
        const name = ops.argsArray[i][0];
        const obj = page.objs.has(name) ? page.objs.get(name) : null;
        if (obj && obj.width) widest = Math.max(widest, obj.width);
      }
      if (widest > 0) dpi = Math.min(MAX_PATCH_DPI, Math.max(MIN_PATCH_DPI, (widest * 72) / v.width));
    } catch (_) { /* page sans image exploitable */ }
    this.nativeDpi.set(idx, dpi);
    return dpi;
  }

  /** Rend une region de page (en points) dans un canvas, a la resolution demandee. */
  async renderRegion(idx, rect, dpi, withOps = false) {
    const page = await this.pdfPage(idx);
    const scale = dpi / 72;
    const c = canvasOf((rect[2] - rect[0]) * scale, (rect[3] - rect[1]) * scale);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    if (page) {
      await page.render({
        canvasContext: ctx,
        viewport: page.getViewport({ scale }),
        transform: [1, 0, 0, 1, -rect[0] * scale, -rect[1] * scale],
      }).promise;
    }
    if (withOps) this.applyOps(idx, ctx, c, rect, scale);
    return c;
  }

  async renderPage(idx, dpi, withOps = true) {
    const { width, height } = await this.pageSize(idx);
    return this.renderRegion(idx, [0, 0, width, height], dpi, withOps);
  }

  /* ------------------------------------------------------------- analyse */
  async analyze(idx, { force = null, onProgress = null } = {}) {
    if (!force && this.analysis.has(idx)) return this.analysis.get(idx);
    const page = await this.pdfPage(idx);
    const size = await this.pageSize(idx);
    if (!page) {
      const res = { index: idx, mode: "native", items: [], width: size.width, height: size.height, dpi: 150 };
      this.analysis.set(idx, res);
      return res;
    }
    const dpi = Math.min(MAX_PATCH_DPI, Math.max(200, await this.detectNativeDpi(idx)));

    let boxes = [];
    let mode = "scan";
    if (force !== "ocr") {
      boxes = await this.nativeBoxes(page, dpi);
      if (boxes.length) mode = "native";
    }
    if (!boxes.length && force !== "native") {
      if (onProgress) onProgress({ status: "ocr", progress: 0 });
      const canvas = await this.renderPage(idx, dpi, false);
      const lines = await ocrLines(canvas, onProgress);
      boxes = lines.map((l) => ({ ...l, source: "ocr" }));
      mode = "scan";
    }

    const canvas = await this.renderPage(idx, dpi, false);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const k = 72 / dpi;

    const items = [];
    boxes.forEach((b, i) => {
      const m = this.measure(pixels, b);
      if (!m) return;
      items.push({
        id: `p${idx}-${i}`,
        source: b.source,
        text: b.text,
        conf: b.conf ?? null,
        bbox: b.bbox.map((v) => v * k),
        inkLeft: m.inkLeft * k,
        inkTop: m.inkTop * k,
        fontKey: m.fontKey,
        fontScore: m.fontScore,
        size: m.sizePx * k,
        tracking: m.tracking * k,
        blur: m.blur * k,
        grain: m.grain,
        color: img.hexOf(m.ink),
        paper: img.hexOf(m.paper),
        bold: m.bold,
        italic: m.italic,
        align: "left",
      });
    });

    const res = { index: idx, mode, items, width: size.width, height: size.height, dpi };
    this.analysis.set(idx, res);
    return res;
  }

  /** Boites de texte issues de la couche vectorielle, quand elle existe : plus precises
      que l'OCR et immediates. Les couleurs et la police restent mesurees sur l'image, ce
      qui traite de la meme facon un PDF natif et un scan. */
  async nativeBoxes(page, dpi) {
    const content = await page.getTextContent();
    const v = page.getViewport({ scale: dpi / 72 });
    const out = [];
    for (const item of content.items) {
      const text = (item.str || "").trim();
      if (!text) continue;
      const t = pdfjsLib.Util.transform(v.transform, item.transform);
      const h = Math.hypot(t[2], t[3]);
      const w = item.width * (dpi / 72);
      const x0 = t[4], y1 = t[5];
      if (w < 1 || h < 1) continue;
      const words = [];
      let cursor = x0;
      for (const part of text.split(/(\s+)/)) {
        const pw = (part.length / text.length) * w;
        if (part.trim()) words.push({ text: part, bbox: [cursor, y1 - h, cursor + pw, y1], conf: 100 });
        cursor += pw;
      }
      out.push({
        text, bbox: [x0, y1 - h * 1.05, x0 + w, y1 + h * 0.22],
        words, slope: 0, conf: 100, source: "native",
      });
    }
    return out;
  }

  measure(pixels, box) {
    const info = img.sampleColors(pixels, box.bbox);
    const mask = info.mask;
    const bb = fonts.inkBBox(mask);
    if (!bb) return null;
    const blur = img.blurSigma(info.gray, mask);
    const grain = Math.min(24, info.noise);

    const samples = this.fontSamples(pixels, box.words).slice(0, 3);
    if (!samples.length) samples.push({ mask, text: box.text });
    const { entry, score } = fonts.identify(samples, {
      lineSlope: box.slope || 0, blur, noise: info.noise,
    });

    const inkH = bb.y1 - bb.y0, inkW = bb.x1 - bb.x0;
    const hint = Math.max(6, (box.bbox[3] - box.bbox[1]) * 0.78);
    const sizePx = Math.max(4, Math.min((box.bbox[3] - box.bbox[1]) * 2.4,
      fonts.fitSizeByHeight(entry, box.text.trim(), inkH, hint)));
    const tracking = fonts.trackingFor(entry, box.text.trim(), sizePx, inkW);

    return {
      ink: info.ink, paper: info.paper, blur, grain,
      fontKey: entry.key, fontScore: Math.round(score * 1000) / 1000,
      bold: entry.bold, italic: entry.italic,
      sizePx, tracking,
      inkLeft: info.box[0] + bb.x0, inkTop: info.box[1] + bb.y0,
    };
  }

  /** Quelques mots isoles pour reconnaitre la police : longs, purement alphabetiques,
      sans les espaces dont la largeur varie d'une police a l'autre. */
  fontSamples(pixels, words) {
    if (!words || !words.length) return [];
    const scored = [];
    for (const w of words) {
      const t = (w.text || "").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (t.length < 4) continue;
      const letters = [...t].filter((c) => /\p{L}/u.test(c)).length;
      if (letters < t.length * 0.7) continue;
      scored.push({ letters, text: t, bbox: w.bbox });
    }
    scored.sort((a, b) => b.letters - a.letters);
    const out = [];
    for (const s of scored.slice(0, 3)) {
      const b = img.clampBox(s.bbox, pixels.width, pixels.height, 1);
      if (b[3] - b[1] < 5) continue;
      const { gray, w, h } = img.grayOf(pixels, b);
      const { mask } = img.inkMask(gray, w, h);
      if (mask.data.some((v) => v)) out.push({ mask, text: s.text });
    }
    return out;
  }

  /* ------------------------------------------------------------- edition */
  addOp(op) {
    op.uid = nextUid();
    this.ops.push(op);
    return op.uid;
  }
  undo() { return this.ops.pop() || null; }
  /** Remplace une operation a sa place : l'ordre compte, une retouche posee apres une
      autre la recouvre. */
  replaceOp(old, op) {
    if (!op.uid) op.uid = nextUid();
    const i = this.ops.indexOf(old);
    if (i < 0) this.ops.push(op); else this.ops[i] = op;
    return op;
  }
  removeOp(uid) { this.ops = this.ops.filter((o) => o.uid !== uid); }
  opsFor(idx) { return this.ops.filter((o) => o.page === idx); }
  findItem(idx, id) { return (this.analysis.get(idx)?.items || []).find((i) => i.id === id) || null; }

  /** Applique les operations d'une page sur un canvas deja rendu.
      `rect` est la region couverte par le canvas, en points ; `scale` le facteur px/pt.
      Les annotations forment une couche au-dessus des retouches, comme dans un lecteur
      PDF : corriger une ligne surlignee ne doit pas effacer le surlignage dans le fond. */
  applyOps(idx, ctx, canvas, rect, scale, list = this.opsFor(idx)) {
    if (!list.length) return;
    const ops = [...list.filter((o) => o.type !== "mark"), ...list.filter((o) => o.type === "mark")];
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const toPx = (r) => [
      (r[0] - rect[0]) * scale, (r[1] - rect[1]) * scale,
      (r[2] - rect[0]) * scale, (r[3] - rect[1]) * scale,
    ];

    for (const op of ops) {
      const seed = hashSeed(op.uid + (op.text || ""));
      if (op.type === "erase") {
        img.erase(pixels, toPx(op.bbox), seed);
        continue;
      }
      // Images et annotations se dessinent avec le canvas, pas pixel par pixel : on
      // repasse par lui le temps de les poser.
      if ((op.type === "image" && op.bitmap) || op.type === "mark") {
        ctx.putImageData(pixels, 0, 0);
        if (op.type === "image") {
          const b = toPx(op.bbox);
          ctx.drawImage(op.bitmap, b[0], b[1], b[2] - b[0], b[3] - b[1]);
        } else {
          marks.draw(ctx, op, (x) => (x - rect[0]) * scale, (y) => (y - rect[1]) * scale, scale);
        }
        pixels.data.set(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
        continue;
      }

      const item = op.itemId ? this.findItem(idx, op.itemId) : null;
      const base = item || {};
      const bbox = op.bbox || base.bbox;
      const entry = fonts.variant(op.fontKey || base.fontKey, !!op.bold, !!op.italic);
      const sizePt = op.size || base.size || 12;
      const color = img.rgbOf(op.color || base.color || "#111111");
      const inkLeft = op.left ?? base.inkLeft ?? bbox[0];
      const inkTop = op.top ?? base.inkTop ?? bbox[1];
      const blurPt = op.blur ?? base.blur ?? 0;
      const grain = op.grain ?? base.grain ?? 0;
      const trackPt = op.tracking ?? base.tracking ?? 0;

      if (op.type === "text") {
        img.erase(pixels, toPx([
          bbox[0] - PATCH_MARGIN_PT, bbox[1] - PATCH_MARGIN_PT,
          bbox[2] + PATCH_MARGIN_PT, bbox[3] + PATCH_MARGIN_PT,
        ]), seed);
      }
      if (!(op.text || "").trim()) continue;

      const sizePx = sizePt * scale;
      const top = op.type === "add" ? (bbox[1] - rect[1]) * scale + sizePx * 0.18 : (inkTop - rect[1]) * scale;
      const left = op.type === "add" ? (bbox[0] - rect[0]) * scale : (inkLeft - rect[0]) * scale;
      img.drawText(pixels, {
        text: op.text, entry, sizePx, color,
        x: left,
        baseline: img.baselineFromInk(entry, op.text, sizePx, top),
        align: op.align || "left",
        boxRight: (bbox[2] - rect[0]) * scale,
        tracking: op.type === "add" ? 0 : trackPt * scale,
        blur: op.type === "add" ? 0 : blurPt * scale,
        grain: op.type === "add" ? 0 : grain,
        seed,
      });
    }
    ctx.putImageData(pixels, 0, 0);
  }

  /* ------------------------------------------------------------- export */
  /** Reconstruit le PDF : seules les zones modifiees sont reincrustees, a la resolution
      du scan. Le reste de la page n'est ni decode ni reencode.

      L'arbre des pages est refait dans l'ordre voulu en reutilisant les pages du fichier
      ouvert : les recopier ecrirait chaque page deux fois. Seules une page dupliquee et
      les pages d'un PDF ajoute sont recopiees. */
  async export(onProgress, { only = null } = {}) {
    const { PDFDocument, degrees, StandardFonts, rgb } = PDFLib;
    const out = await PDFDocument.load(this.bytes.slice(), { ignoreEncryption: true });
    const helv = await out.embedFont(StandardFonts.Helvetica);
    const ids = (only || this.order).filter((id) => !this.removed.has(id));

    const original = out.getPages();
    const parsed = new Map([[0, out]]);
    const sourceDoc = async (src) => {
      if (!parsed.has(src)) parsed.set(src, await PDFDocument.load(this.sources[src].bytes.slice(), { ignoreEncryption: true }));
      return parsed.get(src);
    };
    // Les copies se font avant de vider l'arbre : copyPages lit les pages par leur rang.
    const used = new Set(), pages = [];
    for (const id of ids) {
      const slot = this.slots.get(id);
      if (slot.blank) { pages.push(slot.blank); continue; }
      if (slot.src === 0 && !used.has(slot.index)) { used.add(slot.index); pages.push(original[slot.index]); continue; }
      pages.push((await out.copyPages(await sourceDoc(slot.src), [slot.index]))[0]);
    }
    for (let i = original.length - 1; i >= 0; i--) out.removePage(i);
    for (let n = 0; n < pages.length; n++) {
      pages[n] = pages[n].width ? out.addPage([pages[n].width, pages[n].height]) : out.addPage(pages[n]);
    }

    const embedded = new Map();
    for (let n = 0; n < ids.length; n++) {
      const idx = ids[n], page = pages[n];
      // La rotation s'applique avant le tri des pages sans retouche : une page simplement
      // pivotee doit l'etre aussi dans le fichier exporte.
      const rot = this.rotations.get(idx) || 0;
      if (rot) page.setRotation(degrees((page.getRotation().angle + rot) % 360));
      const ops = this.opsFor(idx);
      if (!ops.length) continue;
      if (onProgress) onProgress(n / ids.length);
      const { width: pw, height: ph } = await this.pageSize(idx);
      const dpi = await this.detectNativeDpi(idx);

      // Les retouches sont mesurees sur la page telle que pdf.js l'affiche (rotation
      // d'origine appliquee, coin haut gauche du cadre visible). On dessine donc dans ce
      // repere, retourne pour pdf-lib qui compte les y depuis le bas.
      page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(...(await this.viewToUser(idx, ph))));

      const pixelOps = ops.filter((o) => o.type !== "mark");
      for (let i = 0; i < pixelOps.length; i++) {
        const op = pixelOps[i];
        // Une image se pose telle quelle, sans etre rasterisee avec le fond : elle garde
        // sa definition et son format (JPEG pour une photo).
        if (op.type === "image" && op.bitmap) {
          if (!embedded.has(op.bitmap)) embedded.set(op.bitmap, await embedBitmap(out, op.bitmap, !op.signature));
          const b = op.bbox;
          page.drawImage(embedded.get(op.bitmap), { x: b[0], y: ph - b[3], width: b[2] - b[0], height: b[3] - b[1] });
          continue;
        }
        const rect = this.patchRect(op, idx, pw, ph);
        if (!rect) continue;
        const canvas = await this.renderRegion(idx, rect, dpi, false);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        // La zone reprend aussi les retouches precedentes qu'elle chevauche : sinon elle
        // les recouvrirait avec le contenu d'origine de la page.
        this.applyOps(idx, ctx, canvas, rect, dpi / 72, pixelOps.slice(0, i + 1));
        const png = await out.embedPng(await blobBytes(canvas));
        page.drawImage(png, {
          x: rect[0], y: ph - rect[3], width: rect[2] - rect[0], height: rect[3] - rect[1],
        });
        // Couche de texte invisible : la retouche reste selectionnable et cherchable.
        if ((op.text || "").trim()) {
          try {
            page.drawText(sanitize(op.text), {
              x: rect[0] + 1, y: ph - rect[3] + 2, size: Math.max(4, op.size || 10),
              font: helv, color: rgb(0, 0, 0), opacity: 0,
            });
          } catch (_) { /* caractere hors WinAnsi */ }
        }
      }
      // Les annotations en dernier, en vectoriel, au-dessus de toutes les retouches.
      for (const op of ops) if (op.type === "mark") marks.exportTo(page, op, ph);
      page.pushOperators(PDFLib.popGraphicsState());
    }
    return out.save();
  }

  /** Matrice qui ramene le repere d'affichage (en points, y vers le haut, hauteur `h`)
      dans l'espace utilisateur de la page : inverse de la transformation de pdf.js. */
  async viewToUser(idx, h) {
    const page = await this.pdfPage(idx);
    const [a, b, c, d, e, f] = page ? page.getViewport({ scale: 1 }).transform : [1, 0, 0, -1, 0, h];
    const det = a * d - b * c;
    const inv = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
    // D'abord y -> h - y (retour au repere d'affichage), puis l'inverse.
    const flip = [1, 0, 0, -1, 0, h];
    return [
      inv[0] * flip[0] + inv[2] * flip[1], inv[1] * flip[0] + inv[3] * flip[1],
      inv[0] * flip[2] + inv[2] * flip[3], inv[1] * flip[2] + inv[3] * flip[3],
      inv[0] * flip[4] + inv[2] * flip[5] + inv[4], inv[1] * flip[4] + inv[3] * flip[5] + inv[5],
    ];
  }

  /** Zone a reincruster : elle doit couvrir le texte saisi, souvent plus long que celui
      qu'il remplace, sinon la fin des mots serait rognee. */
  patchRect(op, idx, pw, ph) {
    const item = op.itemId ? this.findItem(idx, op.itemId) : null;
    const bbox = op.bbox || item?.bbox;
    if (!bbox) return null;
    let [x0, y0, x1, y1] = bbox;
    if ((op.text || "").trim()) {
      const entry = fonts.variant(op.fontKey || item?.fontKey, !!op.bold, !!op.italic);
      const size = op.size || item?.size || 12;
      const need = fonts.inkWidth(entry, op.text, size) + (op.tracking || 0) * fonts.trackingSlots(op.text);
      const left = op.left ?? item?.inkLeft ?? x0;
      const top = op.top ?? item?.inkTop ?? y0;
      x0 = Math.min(x0, left);
      y0 = Math.min(y0, top - size * 0.3);
      x1 = Math.max(x1, left + need + size * 0.35);
      y1 = Math.max(y1, top + size * 1.4);
    }
    const m = PATCH_MARGIN_PT + 2;
    return [
      Math.max(0, x0 - m), Math.max(0, y0 - m),
      Math.min(pw, x1 + m), Math.min(ph, y1 + m),
    ];
  }
}

async function load(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: "vendor/pdfjs/standard_fonts/",
    isEvalSupported: false,
  }).promise;
  return { bytes, pdf };
}

const sanitize = (s) => (s || "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) || 1;
}

/** Image posee dans le PDF : JPEG pour une photo, PNG pour garder la transparence
    d'une signature. */
async function embedBitmap(out, bitmap, opaque) {
  const c = canvasOf(bitmap.width, bitmap.height);
  const ctx = c.getContext("2d");
  if (opaque) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(bitmap, 0, 0);
  const type = opaque ? "image/jpeg" : "image/png";
  const bytes = await blobBytes(c, type);
  return opaque ? out.embedJpg(bytes) : out.embedPng(bytes);
}

function blobBytes(canvas, type = "image/png") {
  return new Promise((resolve) => {
    canvas.toBlob(async (b) => resolve(new Uint8Array(await b.arrayBuffer())), type, 0.9);
  });
}
