/* Catalogue de polices et reconnaissance par comparaison d'images.
   Portage du moteur Python : sur un scan, la police d'origine n'existe nulle part dans le
   fichier, on la retrouve en redessinant le texte avec chaque police et en comparant les
   pixels. */

const FAMILIES = [
  ["sans", "Sans (Arial)", "LiberationSans", ["Regular", "Bold", "Italic", "BoldItalic"]],
  ["serif", "Serif (Times)", "LiberationSerif", ["Regular", "Bold", "Italic", "BoldItalic"]],
  ["mono", "Mono (Courier)", "LiberationMono", ["Regular", "Bold", "Italic", "BoldItalic"]],
  ["narrow", "Sans étroit", "LiberationSansNarrow", ["Regular", "Bold", "Italic", "BoldItalic"]],
  ["sans2", "Sans (Verdana)", "DejaVuSans", ["Regular", "Bold", "Oblique", "BoldOblique"]],
  ["serif2", "Serif (DejaVu)", "DejaVuSerif", ["Regular", "Bold", "Italic", "BoldItalic"]],
  ["mono2", "Mono (DejaVu)", "DejaVuSansMono", ["Regular", "Bold", "Oblique", "BoldOblique"]],
];

export const CATALOG = [];
for (const [family, label, base, styles] of FAMILIES) {
  for (const style of styles) {
    const bold = style.includes("Bold");
    const italic = style.includes("Italic") || style.includes("Oblique");
    CATALOG.push({
      key: `${base}-${style}`,
      css: `${base}-${style}`,
      label: label + (bold ? " Gras" : "") + (italic ? " Italique" : ""),
      family, bold, italic,
      file: `fonts/${base}-${style}.woff2`,
    });
  }
}
export const BY_KEY = new Map(CATALOG.map((f) => [f.key, f]));
export const DEFAULT_KEY = "LiberationSans-Regular";

export const resolve = (key) => BY_KEY.get(key) || BY_KEY.get(DEFAULT_KEY);
export function variant(key, bold, italic) {
  const base = resolve(key);
  return CATALOG.find((f) => f.family === base.family && f.bold === bold && f.italic === italic) || base;
}

/* Ponderation calibree par balayage sur des scans simules (bruit + JPEG). */
const W_SHAPE = 0.75, W_ASPECT = 0.25;

let loaded = false;
export async function loadAll() {
  if (loaded) return;
  await Promise.all(
    CATALOG.map(async (f) => {
      const face = new FontFace(f.css, `url(${f.file}) format("woff2")`);
      await face.load();
      document.fonts.add(face);
    })
  );
  loaded = true;
}

/* --------------------------------------------------------------- mesures */
const measureCanvas = document.createElement("canvas");
const mctx = measureCanvas.getContext("2d", { willReadFrequently: true });

export const cssFont = (entry, sizePx) => `${sizePx}px "${entry.css}"`;

export function metrics(entry, text, sizePx) {
  mctx.font = cssFont(entry, sizePx);
  const m = mctx.measureText(text || " ");
  return {
    advance: m.width,
    left: m.actualBoundingBoxLeft,
    right: m.actualBoundingBoxRight,
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
    fontAscent: m.fontBoundingBoxAscent,
  };
}

/** Hauteur d'encre du texte rapportee au corps, pour ces glyphes precis. */
export function inkHeightRatio(entry, text) {
  const REF = 100;
  const m = metrics(entry, text || "X", REF);
  const h = (m.ascent + m.descent) / REF;
  return h > 0.05 ? h : 0.7;
}

/** Largeur du premier au dernier pixel d'encre (pas l'avance typographique). */
export function inkWidth(entry, text, sizePx) {
  const REF = 100;
  const m = metrics(entry, text || " ", REF);
  return ((m.right + m.left) * sizePx) / REF;
}

/** Corps deduit de la hauteur d'encre observee : plus fiable que la largeur, car la
    hauteur ne depend pas de la chasse de la police. */
export function fitSizeByHeight(entry, text, targetH, hint) {
  const t = (text || "").trim();
  if (!t || targetH <= 1) return hint;
  const r = inkHeightRatio(entry, t);
  return r > 0.05 ? targetH / r : hint;
}

/** Nombre d'intervalles ou l'interlettrage s'applique (les espaces en sont exclus :
    les resserrer collerait les mots entre eux). */
export function trackingSlots(text) {
  let n = 0;
  for (let i = 0; i + 1 < (text || "").length; i++) {
    if (!/\s/.test(text[i]) && !/\s/.test(text[i + 1])) n++;
  }
  return n;
}

export function trackingFor(entry, text, sizePx, targetW) {
  const n = trackingSlots(text);
  if (n < 1 || targetW <= 1) return 0;
  const natural = inkWidth(entry, text, sizePx);
  const limit = sizePx * 0.06;
  return Math.max(-limit, Math.min(limit, (targetW - natural) / n));
}

/* --------------------------------------------------------------- masques */
/** Masque binaire du texte rendu seul : {data: Uint8Array, w, h}. */
export function renderMask(entry, text, sizePx, blur = 0) {
  const pad = Math.ceil(sizePx * 0.4) + 4;
  mctx.font = cssFont(entry, sizePx);
  const m = mctx.measureText(text || " ");
  const w = Math.ceil(m.width) + 2 * pad;
  const h = Math.ceil(sizePx * 2.2) + 2 * pad;
  const c = document.createElement("canvas");
  c.width = Math.max(8, w);
  c.height = Math.max(8, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.font = cssFont(entry, sizePx);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#000";
  if (blur > 0.05) ctx.filter = `blur(${blur}px)`;
  ctx.fillText(text, pad, pad + sizePx);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const out = new Uint8Array(c.width * c.height);
  for (let i = 0, p = 3; i < out.length; i++, p += 4) out[i] = img.data[p] > 96 ? 1 : 0;
  return { data: out, w: c.width, h: c.height };
}

export function inkBBox(mask) {
  let x0 = mask.w, y0 = mask.h, x1 = -1, y1 = -1;
  for (let y = 0; y < mask.h; y++) {
    const row = y * mask.w;
    for (let x = 0; x < mask.w; x++) {
      if (mask.data[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

export function cropInk(mask) {
  const bb = inkBBox(mask);
  if (!bb) return null;
  const w = bb.x1 - bb.x0, h = bb.y1 - bb.y0;
  if (w < 2 || h < 2) return null;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = mask.data[(y + bb.y0) * mask.w + (x + bb.x0)];
  }
  return { data: out, w, h };
}

/** Mise a l'echelle au plus proche voisin, suffisante pour des masques binaires. */
export function scaleMask(mask, factor) {
  if (Math.abs(factor - 1) < 0.02) return mask;
  const w = Math.max(2, Math.round(mask.w * factor));
  const h = Math.max(2, Math.round(mask.h * factor));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mask.h - 1, Math.floor((y * mask.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mask.w - 1, Math.floor((x * mask.w) / w));
      out[y * w + x] = mask.data[sy * mask.w + sx];
    }
  }
  return { data: out, w, h };
}

/** IoU des formes, apres recalage du candidat sur la largeur de la reference.
    Le recalage absorbe la derive d'espacement ; la chasse perdue ici est reintroduite
    separement par aspectScore. */
function shapeIoU(a, b) {
  if (a.w !== b.w) b = scaleMask(b, a.w / b.w);
  const h = Math.min(a.h, b.h), w = Math.min(a.w, b.w);
  let inter = 0, union = 0;
  for (let y = 0; y < Math.max(a.h, b.h); y++) {
    for (let x = 0; x < Math.max(a.w, b.w); x++) {
      const va = y < a.h && x < a.w ? a.data[y * a.w + x] : 0;
      const vb = y < b.h && x < b.w ? b.data[y * b.w + x] : 0;
      if (va && vb) inter++;
      if (va || vb) union++;
    }
  }
  void h; void w;
  return union ? inter / union : 0;
}

const aspectScore = (wr, wc) => (wr < 1 || wc < 1 ? 0 : Math.exp(-3 * Math.abs(Math.log(wr / wc))));

/** Inclinaison des futs en degres (0 = droit, ~8-12 = italique).
    On cisaille le masque et on garde l'angle qui aligne le mieux les traits verticaux :
    mesure directe, insensible au flou, la ou la comparaison de formes prend un scan bave
    pour de l'italique gras. */
export function estimateSlant(mask) {
  if (mask.h < 8 || mask.w < 8) return 0;
  let bestA = 0, bestE = -1;
  for (let ang = -20; ang <= 20; ang += 2) {
    const t = Math.tan((ang * Math.PI) / 180);
    const pad = Math.ceil(Math.abs(t) * mask.h) + 2;
    const cols = new Float64Array(mask.w + pad);
    for (let y = 0; y < mask.h; y++) {
      const dx = Math.round((y - mask.h / 2) * t) + Math.floor(pad / 2);
      const row = y * mask.w;
      for (let x = 0; x < mask.w; x++) {
        if (mask.data[row + x]) {
          const p = x + dx;
          if (p >= 0 && p < cols.length) cols[p]++;
        }
      }
    }
    let e = 0;
    for (const v of cols) e += v * v;
    if (e > bestE) { bestE = e; bestA = ang; }
  }
  return bestA;
}

/** Demi-epaisseur du trait rapportee a la hauteur d'encre.
    Approximee par erosions successives : le nombre d'erosions qu'un trait supporte avant
    de disparaitre donne son epaisseur, sans transformee de distance. */
export function strokeRatio(mask) {
  if (mask.h < 4) return 0;
  let cur = mask.data, total = 0, layers = 0;
  for (let i = 0; i < 8; i++) {
    let count = 0;
    const next = new Uint8Array(cur.length);
    for (let y = 1; y < mask.h - 1; y++) {
      for (let x = 1; x < mask.w - 1; x++) {
        const p = y * mask.w + x;
        if (cur[p] && cur[p - 1] && cur[p + 1] && cur[p - mask.w] && cur[p + mask.w]) {
          next[p] = 1; count++;
        }
      }
    }
    if (!count) break;
    total += count; layers++;
    cur = next;
  }
  void total;
  return layers / mask.h;
}

function looksBold(ref, text, blur) {
  const probe = {};
  for (const bold of [false, true]) {
    const entry = variant(DEFAULT_KEY, bold, false);
    const size = ref.h / Math.max(0.05, inkHeightRatio(entry, text));
    let m = cropInk(renderMask(entry, text, Math.min(300, Math.max(6, Math.round(size))), blur));
    if (!m) return null;
    if (m.h !== ref.h) m = scaleMask(m, ref.h / m.h);
    probe[bold] = strokeRatio(m);
  }
  const gap = probe[true] - probe[false];
  if (gap < 0.004) return null;
  const observed = strokeRatio(ref);
  const dThin = Math.abs(observed - probe[false]), dThick = Math.abs(observed - probe[true]);
  // On ne tranche que si l'ecart est franc : sur un scan bruite l'epaisseur oscille assez
  // pour qu'un depart serre se trompe une fois sur deux.
  if (Math.min(dThin, dThick) > 0.45 * gap) return null;
  return dThick < dThin;
}

/** Devine la police d'un texte scanne.
    `samples` porte sur quelques mots isoles : sur une ligne entiere, un ecart d'espacement
    minime decale la fin du trace et fait s'effondrer le recouvrement de toutes les polices
    a la fois, si bien que le classement ne veut plus rien dire. */
export function identify(samples, { lineSlope = 0, blur = 0, noise = 0 } = {}) {
  const prepared = [];
  for (const { mask, text } of samples) {
    const t = (text || "").trim();
    const ref = mask ? cropInk(mask) : null;
    if (!ref || t.length < 2 || ref.h < 5) continue;
    prepared.push({ ref, text: t.slice(0, 40), boost: Math.max(1, 24 / ref.h) });
  }
  if (!prepared.length) return { entry: resolve(null), score: 0 };

  let pool = CATALOG;
  const first = prepared[0];
  if (first.text.length >= 5 && first.ref.h >= 12) {
    // Filtre asymetrique : "droit" est une conclusion sure, "penche" ne l'est pas, car il
    // reste une rotation residuelle possible sur un document photographie de travers.
    const residual = Math.abs(estimateSlant(first.ref) - lineSlope);
    if (residual < 4) {
      const subset = pool.filter((f) => !f.italic);
      if (subset.length) pool = subset;
    }
    if (first.ref.h >= 20 && noise < 2) {
      const wantBold = looksBold(first.ref, first.text, blur);
      if (wantBold !== null) {
        const subset = pool.filter((f) => f.bold === wantBold);
        if (subset.length) pool = subset;
      }
    }
  }

  let best = resolve(null), bestScore = -1;
  for (const entry of pool) {
    let total = 0, weight = 0;
    for (const { ref, text, boost } of prepared) {
      // Rendu a la taille reellement observee, avec le flou mesure : le candidat subit
      // alors les memes pertes que le scan.
      const size = ref.h / Math.max(0.05, inkHeightRatio(entry, text));
      let cand = cropInk(renderMask(entry, text, Math.min(300, Math.max(6, Math.round(size))), blur));
      if (!cand) continue;
      let refUp = scaleMask(ref, boost);
      cand = scaleMask(cand, boost);
      if (cand.h !== refUp.h) cand = scaleMask(cand, refUp.h / cand.h);
      const score = W_SHAPE * shapeIoU(refUp, cand) + W_ASPECT * aspectScore(refUp.w, cand.w);
      total += score * text.length;
      weight += text.length;
    }
    if (weight && total / weight > bestScore) { bestScore = total / weight; best = entry; }
  }
  return { entry: best, score: Math.max(0, bestScore) };
}
