/* Objets poses : images, signatures, annotations et blocs de texte ajoutes. Avec l'outil
   Texte, un toucher en selectionne un ; le glisser le deplace, un coin le redimensionne,
   et une barre flottante propose couleur, modification, duplication et suppression,
   comme les objets de Pages ou Keynote.

   Chaque changement remplace l'operation par une copie modifiee (ui.js l'inscrit dans
   l'historique) : annuler rend l'objet exactement tel qu'il etait. */

import * as marks from "./marks.js";
import { paletteFor } from "./annotate.js";

const $ = (id) => document.getElementById(id);
const MIN_SIZE = 6;          // points : en dessous, l'objet ne se saisit plus

let api = null;              // fourni par ui.js : voir init()
let selected = null;         // operation selectionnee

export const isObject = (op) => op.type === "image" || op.type === "mark" || op.type === "add";

/** Cadre d'un objet, en points. */
export function boxOf(op) {
  return op.type === "mark" ? marks.bounds(op) : op.bbox;
}

const strip = (op) => { const out = { ...op }; delete out.uid; return out; };

/** Copie de l'objet ramenee dans le cadre `to`. */
function placed(op, to) {
  if (op.type !== "mark") return { ...strip(op), bbox: to };
  return marks.rescaled(op, marks.bounds(op), to);
}

/** Copie de l'objet decalee de (dx, dy). */
function moved(op, dx, dy) {
  if (op.type !== "mark") {
    const b = op.bbox;
    return { ...strip(op), bbox: [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy] };
  }
  return marks.translated(op, dx, dy);
}

/** Elements de l'overlay pour les objets de la page, au-dessus des zones de texte. */
export function render(overlay) {
  const { width: W, height: H } = api.size();
  if (selected && !api.ops().includes(selected)) selected = null;
  for (const op of api.ops()) {
    if (!isObject(op)) continue;
    const b = boxOf(op);
    const el = document.createElement("div");
    el.className = "obj";
    if (op.type === "mark" && marks.TEXT_KINDS.has(op.kind)) el.classList.add("textual");
    el.style.cssText = `left:${(b[0] / W) * 100}%;top:${(b[1] / H) * 100}%;` +
      `width:${((b[2] - b[0]) / W) * 100}%;height:${((b[3] - b[1]) / H) * 100}%`;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", labelOf(op));
    el.tabIndex = 0;
    if (op === selected) decorate(el);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (api.tool() !== "select" || api.swallowing()) return;
      select(op);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(op); }
    });
    overlay.appendChild(el);
  }
  placeBar();
}

function labelOf(op) {
  if (op.type === "image") return op.signature ? "Signature" : "Image";
  if (op.type === "add") return `Texte « ${op.text} »`;
  return { highlight: "Surlignage", underline: "Soulignement", strike: "Texte barré", ink: "Dessin",
    rect: "Rectangle", ellipse: "Ellipse", arrow: "Flèche", line: "Trait", check: "Coche", cross: "Croix" }[op.kind];
}

export function select(op) {
  api.clearText();
  selected = op;
  api.rerender();
}

export function deselect() {
  if (!selected) return false;
  selected = null;
  $("objBar").hidden = true;
  document.querySelectorAll(".obj.on").forEach((el) => {
    el.classList.remove("on");
    el.querySelectorAll(".handle").forEach((h) => h.remove());
  });
  return true;
}

export const current = () => selected;

/* ---------------------------------------------------------------- manipulation */

function decorate(el) {
  el.classList.add("on");
  const textual = el.classList.contains("textual");
  if (!textual) {
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const h = document.createElement("span");
      h.className = "handle " + corner;
      h.dataset.corner = corner;
      el.appendChild(h);
    }
  }
  if (!textual) el.addEventListener("pointerdown", (e) => startDrag(e, el, e.target.dataset.corner || null));
}

function startDrag(e, el, corner) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const op = selected, from = boxOf(op), k = api.scale();
  const start = api.toLocal(e.clientX, e.clientY);
  const keepRatio = op.type === "image" || ["check", "cross"].includes(op.kind);
  const { width: W, height: H } = api.size();
  let box = from, dragging = false;
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  e.stopPropagation();

  const onMove = (ev) => {
    const p = api.toLocal(ev.clientX, ev.clientY);
    const dx = (p.x - start.x) / k, dy = (p.y - start.y) / k;
    if (!dragging && Math.hypot(dx, dy) * k < 3) return;
    dragging = true;
    if (!corner) {
      // L'objet reste sur la page : il peut en toucher les bords, pas les depasser.
      const cx = Math.max(-from[0], Math.min(W - from[2], dx));
      const cy = Math.max(-from[1], Math.min(H - from[3], dy));
      box = [from[0] + cx, from[1] + cy, from[2] + cx, from[3] + cy];
    } else {
      let [x0, y0, x1, y1] = from;
      if (corner.includes("w")) x0 = Math.min(x1 - MIN_SIZE, from[0] + dx); else x1 = Math.max(x0 + MIN_SIZE, from[2] + dx);
      if (corner.includes("n")) y0 = Math.min(y1 - MIN_SIZE, from[1] + dy); else y1 = Math.max(y0 + MIN_SIZE, from[3] + dy);
      if (keepRatio) {
        const r = (from[2] - from[0]) / (from[3] - from[1]);
        const w = Math.max(x1 - x0, (y1 - y0) * r), h = w / r;
        if (corner.includes("w")) x0 = x1 - w; else x1 = x0 + w;
        if (corner.includes("n")) y0 = y1 - h; else y1 = y0 + h;
      }
      box = [x0, y0, x1, y1];
    }
    el.style.left = (box[0] / W) * 100 + "%";
    el.style.top = (box[1] / H) * 100 + "%";
    el.style.width = ((box[2] - box[0]) / W) * 100 + "%";
    el.style.height = ((box[3] - box[1]) / H) * 100 + "%";
    $("objBar").hidden = true;
  };
  const onUp = async () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    if (!dragging) return;
    api.swallow();
    const next = corner ? placed(op, box) : moved(op, box[0] - from[0], box[1] - from[1]);
    selected = await api.replace(op, next);
    api.rerender();
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}

/* ---------------------------------------------------------------- barre d'actions */

function placeBar() {
  const bar = $("objBar");
  if (!selected || !document.querySelector(".obj.on")) { bar.hidden = true; return; }
  const op = selected;
  const textual = op.type === "mark" && marks.TEXT_KINDS.has(op.kind);
  const colors = op.type === "mark" ? paletteFor(op.kind) : [];
  bar.innerHTML =
    colors.map(([c, name]) => `<button type="button" class="ob-color" data-color="${c}" aria-label="${name}" title="${name}" ` +
      `aria-pressed="${c === op.color}" style="--c:${c}"></button>`).join("") +
    (colors.length ? `<span class="ob-sep"></span>` : "") +
    (textual ? `<button type="button" class="ob-btn" data-act="text">Modifier le texte</button>` : "") +
    (op.type === "add" ? `<button type="button" class="ob-btn" data-act="edit">Modifier</button>` : "") +
    (!textual ? `<button type="button" class="ob-btn" data-act="dup" aria-label="Dupliquer" title="Dupliquer"><svg class="sym"><use href="#i-copy"/></svg></button>` : "") +
    `<button type="button" class="ob-btn danger" data-act="del" aria-label="Supprimer" title="Supprimer"><svg class="sym"><use href="#i-trash"/></svg></button>`;

  bar.querySelectorAll(".ob-color").forEach((b) => (b.onclick = async () => {
    selected = await api.replace(op, { ...strip(op), color: b.dataset.color });
    api.rerender();
  }));
  bar.querySelector('[data-act="del"]').onclick = removeSelected;
  const act = (name, fn) => { const b = bar.querySelector(`[data-act="${name}"]`); if (b) b.onclick = fn; };
  act("dup", async () => {
    const b = boxOf(op), { width: W, height: H } = api.size();
    const dx = b[2] + 14 <= W ? 14 : -14, dy = b[3] + 14 <= H ? 14 : -14;
    selected = await api.add(moved(op, dx, dy));
    api.rerender();
  });
  act("edit", () => api.editAdded(op));
  act("text", () => {
    const r = op.rects[0];
    deselect();
    api.editTextAt({ x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 });
  });
  bar.hidden = false;
  positionBar();
}

/** La barre se place au-dessus de l'objet, ou dessous s'il n'y a pas la place en haut. */
export function positionBar() {
  const bar = $("objBar"), el = document.querySelector(".obj.on");
  if (bar.hidden || !el) return;
  const r = el.getBoundingClientRect(), br = bar.getBoundingClientRect();
  const topLimit = $("bar").getBoundingClientRect().bottom + 8;
  let y = r.top - br.height - 10;
  if (y < topLimit) y = r.bottom + 10;
  const x = Math.max(8, Math.min(window.innerWidth - br.width - 8, r.left + r.width / 2 - br.width / 2));
  bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

export async function removeSelected() {
  if (!selected) return false;
  const op = selected;
  deselect();
  await api.replace(op, null);
  api.rerender();
  return true;
}

/** `deps` : { tool, size, scale, ops, toLocal, replace, add, editAdded, rerender,
    clearText, editTextAt, swallow, swallowing } */
export function init(deps) {
  api = deps;
  $("canvasWrap").addEventListener("scroll", positionBar, { passive: true });
  window.addEventListener("resize", positionBar);
}
