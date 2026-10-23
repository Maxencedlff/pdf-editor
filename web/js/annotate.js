/* Outil Annoter : palette (genre, couleur, epaisseur) et saisie au doigt, a la souris ou
   a l'Apple Pencil. Le geste est dessine en direct sur un canvas transparent pose sur la
   page, puis transforme en operation `mark` (voir marks.js) et confie a ui.js.

   Avec un stylet, seul le stylet dessine : le doigt garde le defilement et le zoom, comme
   dans Notes ou Annoter sur iPad. */

import * as marks from "./marks.js";

const $ = (id) => document.getElementById(id);
const PREFS_KEY = "editeur-pdf.annoter";

export const KINDS = [
  { kind: "highlight", label: "Surligner", icon: "i-highlight" },
  { kind: "underline", label: "Souligner", icon: "i-underline" },
  { kind: "strike", label: "Barrer", icon: "i-strike" },
  { kind: "ink", label: "Crayon", icon: "i-pen" },
  { kind: "rect", label: "Rectangle", icon: "i-square" },
  { kind: "ellipse", label: "Ellipse", icon: "i-circle" },
  { kind: "arrow", label: "Flèche", icon: "i-arrow" },
  { kind: "line", label: "Trait", icon: "i-line" },
  { kind: "check", label: "Coche", icon: "i-check" },
  { kind: "cross", label: "Croix", icon: "i-xmark" },
  { kind: "date", label: "Date du jour", icon: "i-calendar" },
];

export const HIGHLIGHTS = [
  ["#ffd60a", "Jaune"], ["#5edc73", "Vert"], ["#ff7eb6", "Rose"], ["#6ac8ff", "Bleu"], ["#ffa53d", "Orange"],
];
export const INKS = [
  ["#1c1c1e", "Noir"], ["#0a5bd8", "Bleu"], ["#e0262a", "Rouge"], ["#1e8e3e", "Vert"], ["#ff9500", "Orange"],
];
const WIDTHS = [[1, "Fin"], [2, "Moyen"], [3.5, "Épais"]];
const DEFAULT_COLOR = {
  highlight: "#ffd60a", underline: "#e0262a", strike: "#e0262a", ink: "#0a5bd8",
  rect: "#e0262a", ellipse: "#e0262a", arrow: "#e0262a", line: "#1c1c1e",
  check: "#1c1c1e", cross: "#1c1c1e", date: "#1c1c1e",
};

/** Palette d'un genre : couleurs de surligneur ou couleurs d'encre. */
export const paletteFor = (kind) => (kind === "highlight" ? HIGHLIGHTS : INKS);

const state = { kind: "highlight", colors: { ...DEFAULT_COLOR }, width: 2 };
let api = null;          // fourni par ui.js : voir init()
let penSeen = false;

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (p && KINDS.some((k) => k.kind === p.kind)) state.kind = p.kind;
    if (p?.colors) Object.assign(state.colors, p.colors);
    if (WIDTHS.some(([w]) => w === p?.width)) state.width = p.width;
  } catch (_) { /* reglages par defaut */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state)); } catch (_) { /* sans importance */ }
}

export const hintFor = (kind = state.kind) => ({
  highlight: "Glissez sur le texte à surligner.",
  underline: "Glissez sur le texte à souligner.",
  strike: "Glissez sur le texte à barrer.",
  ink: "Dessinez sur la page.",
  rect: "Tracez le rectangle.",
  ellipse: "Tracez l’ellipse.",
  arrow: "Tracez la flèche.",
  line: "Tracez le trait.",
  check: "Touchez la case à cocher.",
  cross: "Touchez la case à marquer.",
  date: "Touchez où écrire la date.",
}[kind]);

/* ---------------------------------------------------------------- palette */

function buildBar() {
  const kinds = $("mkKinds");
  kinds.innerHTML = KINDS.map((k) =>
    `<button type="button" class="mk-kind" data-kind="${k.kind}" aria-pressed="false" aria-label="${k.label}" title="${k.label}">` +
    `<svg class="sym"><use href="#${k.icon}"/></svg></button>`).join("");
  kinds.querySelectorAll(".mk-kind").forEach((b) => (b.onclick = () => setKind(b.dataset.kind)));
  // Le fondu du bord droit signale les outils hors de vue ; il disparait au bout.
  const edge = () => kinds.classList.toggle("at-end", kinds.scrollLeft + kinds.clientWidth >= kinds.scrollWidth - 2);
  kinds.addEventListener("scroll", edge, { passive: true });
  requestAnimationFrame(edge);
  $("mkWidth").onclick = () => {
    const i = WIDTHS.findIndex(([w]) => w === state.width);
    state.width = WIDTHS[(i + 1) % WIDTHS.length][0];
    savePrefs();
    syncBar();
  };
}

function syncBar() {
  document.querySelectorAll(".mk-kind").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === state.kind)));
  const colors = $("mkColors");
  const pal = paletteFor(state.kind);
  colors.innerHTML = pal.map(([c, name]) =>
    `<button type="button" class="mk-color" role="radio" data-color="${c}" aria-label="${name}" title="${name}" ` +
    `aria-checked="${c === state.colors[state.kind]}" style="--c:${c}"></button>`).join("");
  colors.querySelectorAll(".mk-color").forEach((b) => (b.onclick = () => {
    state.colors[state.kind] = b.dataset.color;
    savePrefs();
    syncBar();
  }));
  const usesWidth = ["ink", "rect", "ellipse", "arrow", "line"].includes(state.kind);
  const wb = $("mkWidth");
  wb.hidden = !usesWidth;
  const [, label] = WIDTHS.find(([w]) => w === state.width);
  wb.setAttribute("aria-label", `Épaisseur : ${label}`);
  wb.title = `Épaisseur : ${label}`;
  wb.style.setProperty("--w", `${2 + state.width * 2.2}px`);
  wb.style.setProperty("--c", state.colors[state.kind]);
  api?.onHint(hintFor());
}

function setKind(kind) {
  state.kind = kind;
  savePrefs();
  syncBar();
}

export function show(on) {
  $("markBar").hidden = !on;
  if (on) { syncBar(); $("mkKinds").dispatchEvent(new Event("scroll")); }
  if (!on) clearLive();
}

/* ---------------------------------------------------------------- saisie */

/** Canvas d'apercu : il couvre la page et suit sa taille a l'ecran. */
function liveCtx() {
  const cv = $("liveCanvas");
  const k = api.scale(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(api.size().width * k * dpr), h = Math.round(api.size().height * k * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const f = k * dpr;
  return { ctx, X: (x) => x * f, Y: (y) => y * f, f };
}

function clearLive() {
  const cv = $("liveCanvas");
  cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
}

/** Point de l'ecran -> point de la page, en points PDF. */
function ptAt(e) {
  const p = api.toLocal(e.clientX, e.clientY), k = api.scale();
  const { width, height } = api.size();
  return { x: Math.max(0, Math.min(width, p.x / k)), y: Math.max(0, Math.min(height, p.y / k)) };
}

/** Operation correspondant au geste en cours ; `null` si le geste ne produit rien. */
function build(kind, a, b, stroke, tap) {
  const color = state.colors[kind];
  const width = state.width;
  const box = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
  if (marks.TEXT_KINDS.has(kind)) {
    if (tap) return null;
    let rects = marks.textRects(api.items(), a, b);
    // Pas de texte reconnu sous le geste (photo, scan illisible) : on suit le doigt.
    if (!rects.length) {
      const h = Math.max(box[3] - box[1], 11);
      const cy = (box[1] + box[3]) / 2;
      rects = [[box[0], cy - h / 2, box[2], cy + h / 2]];
      if (box[2] - box[0] < 4) return null;
    }
    return { type: "mark", kind, color, rects };
  }
  if (kind === "ink") {
    const pts = marks.simplify(stroke, 0.6 / Math.max(0.5, api.scale()));
    return { type: "mark", kind, color, width, strokes: [pts] };
  }
  if (kind === "check" || kind === "cross") {
    let b2 = box;
    if (tap || box[2] - box[0] < 4) {
      const s = Math.max(9, Math.min(16, (api.nearestSize(a) || 11) * 0.9));
      b2 = [a.x - s / 2, a.y - s / 2, a.x + s / 2, a.y + s / 2];
    }
    const s = Math.max(b2[2] - b2[0], b2[3] - b2[1]);
    return { type: "mark", kind, color, width: Math.max(1, s * 0.11), box: b2 };
  }
  if (tap) return null;
  if (kind === "line" || kind === "arrow") {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 3) return null;
    return { type: "mark", kind, color, width, p: [a.x, a.y, b.x, b.y] };
  }
  if (box[2] - box[0] < 3 || box[3] - box[1] < 3) return null;
  return { type: "mark", kind, color, width, box };
}

function wireInput() {
  const cv = $("canvas");
  let g = null;   // geste en cours : { id, kind, a, b, stroke, moved }

  const preview = () => {
    const { ctx, X, Y, f } = liveCtx();
    const op = build(g.kind, g.a, g.b, g.stroke, false);
    if (op) marks.draw(ctx, op, X, Y, f);
  };

  cv.addEventListener("pointerdown", (e) => {
    if (api.tool() !== "mark" || g) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.pointerType === "pen") penSeen = true;
    // Avec un stylet, le doigt sert a naviguer.
    if (penSeen && e.pointerType === "touch") return;
    const a = ptAt(e);
    g = { id: e.pointerId, kind: state.kind, a, b: a, stroke: [[a.x, a.y]], moved: false };
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  cv.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.id) return;
    for (const ev of e.getCoalescedEvents?.() || [e]) {
      const p = ptAt(ev);
      g.b = p;
      if (g.kind === "ink") g.stroke.push([p.x, p.y]);
    }
    if (Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) * api.scale() > 4) g.moved = true;
    if (g.moved) preview();
  });

  const finish = async (e, cancelled) => {
    if (!g || e.pointerId !== g.id) return;
    const { kind, a, b, stroke, moved } = g;
    g = null;
    clearLive();
    if (cancelled) return;
    api.swallowClick();
    if (kind === "date") { await api.addDate(a); return; }
    const op = build(kind, a, b, stroke, !moved);
    if (op) await api.commit(op);
  };
  cv.addEventListener("pointerup", (e) => finish(e, false));
  cv.addEventListener("pointercancel", (e) => finish(e, true));
  // Un second doigt annule le trace : c'est un pincement pour zoomer.
  cv.addEventListener("touchstart", (e) => {
    if (g && e.touches.length > 1) { g = null; clearLive(); }
  }, { passive: true });
}

/** `deps` : { tool, scale, size, toLocal, items, nearestSize, commit, addDate, onHint, swallowClick } */
export function init(deps) {
  api = deps;
  loadPrefs();
  buildBar();
  wireInput();
}
