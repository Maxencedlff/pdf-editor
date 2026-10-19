/* Interface : ouverture, analyse, edition, export. Coordonnees en points PDF ; l'affichage
   les convertit par le facteur d'echelle courant, ou en pourcentage de la page pour les
   zones de texte, qui suivent ainsi le zoom sans etre recalculees.

   Organisation :
   - etat (S) et petits utilitaires d'affichage (bandeau, HUD, alerte, menu) ;
   - document : ouverture, rendu, rotation, zoom ;
   - edition : selection, inspecteur, historique annuler / retablir ;
   - pages : miniatures, menu de page ;
   - export et partage ;
   - gestes et raccourcis. */

import * as fonts from "./fonts.js";
import { PdfDoc } from "./doc.js";
import * as native from "./native.js";
import { drawSignature, savedSignature } from "./signature.js";
import * as annotate from "./annotate.js";
import * as objects from "./objects.js";

const $ = (id) => document.getElementById(id);
const IS_APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const FINE = matchMedia("(pointer: fine)");
const WIDE = matchMedia("(min-width: 1000px)");
const SHORT = matchMedia("(max-height: 520px) and (orientation: landscape) and (max-width: 999px)");
const NUM = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const NNBSP = " ";                       // espace fine insecable, avant % et :
const MIN_ZOOM = 0.5, MAX_ZOOM = 5;
/* Plafond de pixels du rendu : au-dela, Safari sur iPhone refuse le canvas (16,7 Mpx) et
   la memoire grimpe sans gain visible. */
const MAX_PIXELS = 12e6;
const INK_PRESETS = ["#111111", "#3a3a3c", "#1d3c8f", "#b3261e", "#1e6b35"];

const S = {
  doc: null, page: 0, zoom: 1, baseScale: 1, tool: "select",
  analysis: null, sel: null, draft: null, busy: false, size: null,
  past: [], future: [],    // historique annuler / retablir
  cleanAt: 0,              // longueur de l'historique au dernier export
  turn: new Map(),         // angle affiche par page, cumule pour animer dans le bon sens
  color: "#111111", origin: null,
  loadToken: 0,
};
let swallowNextClick = false;

/* ================================================================ utilitaires */
const pct = (v) => `${Math.round(v * 100)}${NNBSP}%`;
const pt = (v) => `${NUM.format(v)}${NNBSP}pt`;
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shortcut = (keys) => (IS_APPLE ? keys.replace(/Maj\+/g, "⇧").replace(/Mod\+/g, "⌘") : keys.replace(/Mod\+/g, "Ctrl+"));
const scale = () => S.baseScale * S.zoom;
const rotation = (i = S.page) => S.doc?.rotations.get(i) || 0;
const visiblePages = () => (S.doc ? S.doc.order.filter((i) => !S.doc.removed.has(i)) : []);
const thumbOf = (id) => $("pageList").querySelector(`.thumb[data-id="${id}"]`);
const isDirty = () => S.past.length !== S.cleanAt;
/** Retouche en vigueur sur une zone de texte : la derniere qui la vise. Lue dans les
    operations elles-memes, elle suit sans table a tenir a jour les copies de page et
    l'historique. */
const editOf = (page, itemId) => S.doc.ops.findLast((o) => o.page === page && o.itemId === itemId) || null;
const isSheet = () => !WIDE.matches && !SHORT.matches;
const point = () => (FINE.matches ? "Cliquez" : "Touchez");

function toast(msg, isErr = false) {
  const t = $("toast");
  clearTimeout(t._t);
  $("toastText").textContent = msg;
  t.querySelector("use").setAttribute("href", isErr ? "#i-warn" : "#i-check");
  t.classList.toggle("err", isErr);
  t.classList.remove("leaving");
  t.hidden = false;
  // Relance l'animation d'entree si un bandeau etait deja affiche.
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  t._t = setTimeout(() => {
    t.classList.add("leaving");
    t._t = setTimeout(() => (t.hidden = true), 250);
  }, isErr ? 5000 : 2400);
}

/** Couche d'attente. Elle bloque les clics tout de suite, mais le HUD n'apparait qu'apres
    un court delai : une operation breve ne fait pas clignoter l'ecran. */
function veil(on, text, progress) {
  const v = $("veil");
  if (!on) { clearTimeout(v._t); v.hidden = true; v.classList.remove("show"); return; }
  $("veilText").textContent = text || "Analyse…";
  const wrap = $("progressWrap");
  const hasProgress = progress !== undefined && progress !== null;
  wrap.hidden = !hasProgress;
  if (hasProgress) $("progressBar").style.width = Math.round(progress * 100) + "%";
  if (v.hidden) {
    v.hidden = false;
    clearTimeout(v._t);
    v._t = setTimeout(() => v.classList.add("show"), hasProgress ? 0 : 180);
  }
}

/** Alerte modale. Resout avec la `value` du bouton choisi ; Echap vaut Annuler. */
function ask({ title, message, buttons }) {
  return new Promise((resolve) => {
    const layer = $("alertLayer"), box = $("alertBtns");
    const prevFocus = document.activeElement;
    $("alertTitle").textContent = title;
    $("alertMsg").textContent = message || "";
    $("alertMsg").hidden = !message;
    box.innerHTML = "";
    const close = (value) => {
      layer.hidden = true;
      document.removeEventListener("keydown", onKey, true);
      prevFocus?.focus?.();
      resolve(value);
    };
    for (const b of buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = b.label;
      if (b.role) el.className = b.role;
      el.onclick = () => close(b.value);
      box.appendChild(el);
    }
    const cancel = buttons.find((b) => b.role === "cancel");
    const def = buttons.find((b) => b.role === "default" || b.role === "danger") || buttons[buttons.length - 1];
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(cancel?.value ?? null); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(def.value); }
      else if (e.key === "Tab") {
        const all = [...box.children], i = all.indexOf(document.activeElement);
        e.preventDefault();
        all[(i + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    layer.hidden = false;
    box.children[buttons.indexOf(def)]?.focus();
  });
}

/** Menu contextuel. `at` est soit un point {x, y}, soit l'element qui l'ouvre. */
function openMenu(items, at) {
  const layer = $("menuLayer"), menu = $("menu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it === "-") { menu.appendChild(Object.assign(document.createElement("div"), { className: "gap" })); continue; }
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    if (it.danger) b.className = "danger";
    b.disabled = !!it.disabled;
    b.innerHTML = `<span>${esc(it.label)}</span><svg class="sym"><use href="#${it.icon}"/></svg>`;
    b.onclick = () => { closeMenu(); it.run(); };
    menu.appendChild(b);
  }
  layer.hidden = false;
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = r.left, y = r.bottom + 6;
  if (x + mw > vw - 8) x = Math.max(8, r.right - mw);
  if (y + mh > vh - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = Math.min(x, vw - mw - 8) + "px";
  menu.style.top = y + "px";
  menu.style.transformOrigin = `${x <= r.left ? "left" : "right"} ${y > r.top ? "top" : "bottom"}`;
  // Le menu prend le focus sans surligner d'entree, comme sur macOS ; les fleches
  // parcourent ensuite les commandes.
  menu._prev = document.activeElement;
  menu.tabIndex = -1;
  menu.focus({ preventScroll: true });
}
function closeMenu() {
  const layer = $("menuLayer");
  if (layer.hidden) return;
  layer.hidden = true;
  $("menu")._prev?.focus?.({ preventScroll: true });
}

/* ================================================================ ouverture */
async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    return toast("Ce fichier n’est pas un PDF.", true);
  }
  if (S.doc && isDirty()) {
    const go = await ask({
      title: `Ouvrir « ${file.name} » ?`,
      message: "Les modifications du document actuel n’ont pas été exportées et seront perdues.",
      buttons: [{ label: "Annuler", role: "cancel", value: false }, { label: "Ouvrir", role: "danger", value: true }],
    });
    if (!go) return;
  }
  veil(true, "Ouverture…");
  try {
    await fonts.loadAll();
    const doc = await PdfDoc.open(file);
    Object.assign(S, {
      doc, page: 0, zoom: 1, analysis: null, sel: null, draft: null,
      past: [], future: [], cleanAt: 0, turn: new Map(),
    });
    document.body.classList.remove("is-welcome");
    $("drop").hidden = true;
    $("app").hidden = false;
    for (const id of ["tbTools", "tbTrailing", "pagesBtn"]) $(id).hidden = false;
    $("exportBtn").disabled = false;
    updateTitle();
    updateHistory();
    setTool("select");
    if (!WIDE.matches) setSidebar(false);
    await loadPage(0);
    buildThumbs();
  } catch (e) {
    console.error(e);
    toast("Impossible d’ouvrir ce document : " + e.message, true);
  } finally { veil(false); }
}

function updateTitle() {
  if (!S.doc) return;
  const name = S.doc.name.replace(/\.pdf$/i, "");
  $("docTitle").textContent = name;
  $("docTitle").title = S.doc.name;
  const sub = $("docSubtitle");
  sub.hidden = false;
  sub.textContent = isDirty() ? "Modifié" : plural(visiblePages().length, "page");
  document.title = `${name}${isDirty() ? " (modifié)" : ""} — Éditeur PDF`;
}

/* ================================================================ rendu */
function fitScale() {
  const wrap = $("canvasWrap");
  const cs = getComputedStyle(wrap);
  const avail = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const w = rotation() % 180 ? S.size.height : S.size.width;
  return Math.max(0.2, Math.min(1.6, avail / w));
}

/** Dimensionne la page affichee. Le cadre prend l'encombrement de la page pivotee ; la
    page elle-meme garde ses dimensions et tourne en son centre. */
function layout() {
  const k = scale();
  const w = S.size.width * k, h = S.size.height * k;
  const turned = rotation() % 180 !== 0;
  const frame = $("frame"), cv = $("canvas");
  frame.style.width = (turned ? h : w) + "px";
  frame.style.height = (turned ? w : h) + "px";
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  cv.style.setProperty("--rot", (S.turn.get(S.page) ?? rotation()) + "deg");
  $("zoomLabel").textContent = pct(S.zoom);
}

async function loadPage(idx) {
  const token = ++S.loadToken;
  S.page = idx;
  clearSelection();
  S.size = await S.doc.pageSize(idx);
  if (token !== S.loadToken) return;
  S.baseScale = fitScale();
  $("canvasWrap").scrollTo(0, 0);
  updatePager();
  markThumb();
  await renderPage();
  if (token !== S.loadToken) return;

  if (!S.analysis || S.analysis.index !== idx) {
    S.analysis = null;
    renderOverlay();
    veil(true, "Lecture de la page…");
    try {
      const res = await S.doc.analyze(idx, { onProgress: onOcrProgress });
      if (token !== S.loadToken) return;
      S.analysis = res;
    } catch (e) {
      console.error(e); toast(e.message, true); S.analysis = null;
    } finally { if (token === S.loadToken) veil(false); }
  }
  renderOverlay();
  describePage();
}

function onOcrProgress(m) {
  if (m.status === "recognizing text") veil(true, "Reconnaissance du texte…", m.progress);
  else if (/loading|initializ/i.test(m.status)) veil(true, "Préparation de la reconnaissance…", m.progress);
}

async function renderPage() {
  // Plusieurs rendus peuvent se croiser (zoom rapide) : seul le dernier demande s'affiche.
  const token = S.loadToken, mine = (renderPage.n = (renderPage.n || 0) + 1), k = scale();
  let dpi = 72 * k * Math.min(2, window.devicePixelRatio || 1);
  const area = (S.size.width * dpi / 72) * (S.size.height * dpi / 72);
  if (area > MAX_PIXELS) dpi *= Math.sqrt(MAX_PIXELS / area);
  const canvas = await S.doc.renderPage(S.page, dpi, true);
  if (token !== S.loadToken || mine !== renderPage.n) return;
  const target = $("pageCanvas");
  target.width = canvas.width;
  target.height = canvas.height;
  target.getContext("2d").drawImage(canvas, 0, 0);
  layout();
}

function renderOverlay() {
  const ov = $("overlay");
  ov.innerHTML = "";
  if (!S.analysis) return;
  const { width: W, height: H } = S.size;
  for (const it of S.analysis.items) {
    const el = document.createElement("div");
    el.className = "hit";
    el.dataset.id = it.id;
    if (it.source === "ocr" && it.fontScore < 0.38) el.classList.add("low");
    if (S.sel?.id === it.id) el.classList.add("on");
    el.style.cssText =
      `left:${(it.bbox[0] / W) * 100}%;top:${(it.bbox[1] / H) * 100}%;` +
      `width:${((it.bbox[2] - it.bbox[0]) / W) * 100}%;height:${((it.bbox[3] - it.bbox[1]) / H) * 100}%`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `Modifier « ${it.text} »`);
    el.title = it.text;
    el.onclick = (e) => { e.stopPropagation(); if (!swallowNextClick) selectItem(it, el); };
    el.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectItem(it, el); }
    };
    ov.appendChild(el);
  }
  objects.render(ov);
  if (S.draft) drawDraft();
}

/** Cadre pointille du bloc de texte en cours de creation. */
function drawDraft() {
  document.querySelector(".hit.draft")?.remove();
  const { width: W, height: H } = S.size, b = S.draft.bbox;
  const el = document.createElement("div");
  el.className = "hit draft";
  el.style.cssText = `left:${(b[0] / W) * 100}%;top:${(b[1] / H) * 100}%;` +
    `width:${((b[2] - b[0]) / W) * 100}%;height:${((b[3] - b[1]) / H) * 100}%`;
  $("overlay").appendChild(el);
}

/** Resume de la page dans l'inspecteur, quand rien n'est selectionne. */
function describePage() {
  const a = S.analysis;
  const edits = S.doc.opsFor(S.page).length;
  const rows = [];
  if (a) {
    rows.push(["Type", a.mode === "scan" ? "Numérisée" : "Native"]);
    rows.push(["Zones de texte", String(a.items.length)]);
  }
  rows.push(["Retouches", edits ? String(edits) : "Aucune"]);
  if (rotation()) rows.push(["Rotation", `${rotation()}°`]);
  $("pageInfo").innerHTML = rows.map(([k, v]) =>
    `<div class="row"><span class="row-label">${k}</span><span class="row-value"><span>${esc(v)}</span></span></div>`).join("");

  let foot = "";
  if (!a) foot = "";
  else if (!a.items.length) foot = "Aucun texte reconnu. La gomme, l’ajout de texte et l’image restent disponibles.";
  else if (a.mode === "scan") foot = "Le texte a été reconnu sur l’image. Police, encre et papier sont mesurés pour que la retouche se fonde dans le document.";
  else foot = "Le texte provient du PDF. Sa police et sa couleur sont mesurées sur le rendu de la page.";
  if (a?.items.some((it) => it.source === "ocr" && it.fontScore < 0.38)) {
    foot += `<br><br><span class="legend"></span>Police incertaine : vérifiez le résultat.`;
  }
  $("pageFoot").innerHTML = foot;
  $("pageFoot").hidden = !foot;
  $("emptyHint").textContent = `${point()} sur un texte de la page pour le modifier.`;
}

function updatePager() {
  const vis = visiblePages(), pos = vis.indexOf(S.page);
  $("pageLabel").textContent = `${pos + 1} sur ${vis.length}`;
  $("prevPage").disabled = pos <= 0;
  $("nextPage").disabled = pos >= vis.length - 1;
}
function stepPage(dir) {
  const vis = visiblePages(), pos = vis.indexOf(S.page);
  const next = vis[pos + dir];
  if (next !== undefined) loadPage(next);
}

/* ================================================================ selection */
function clearSelection() {
  objects.deselect();
  S.sel = null; S.draft = null;
  document.querySelector(".hit.draft")?.remove();
  $("editor").hidden = true;
  $("inspectorEmpty").hidden = false;
  $("inspector").classList.remove("open");
  $("canvasWrap").style.paddingBottom = "";
  document.querySelectorAll(".hit.on").forEach((e) => e.classList.remove("on"));
  if (document.activeElement && $("inspector").contains(document.activeElement)) document.activeElement.blur();
}

function selectItem(item, el) {
  if (S.tool !== "select") return;
  document.querySelectorAll(".hit.on").forEach((e) => e.classList.remove("on"));
  el?.classList.add("on");
  S.sel = item; S.draft = null;
  // Une zone deja retouchee se rouvre avec les reglages de sa retouche, pas avec les
  // mesures d'origine : sinon appliquer de nouveau les effacerait.
  const op = editOf(S.page, item.id);
  fillEditor(item, op ? { ...item, text: op.text, size: op.size, color: op.color, fontKey: op.fontKey,
    bold: op.bold, italic: op.italic, align: op.align } : item);
  revealAboveSheet(el);
}

/** Sur telephone, la feuille couvre le bas de l'ecran : on fait defiler pour que le texte
    edite reste visible au-dessus d'elle. */
function revealAboveSheet(el) {
  if (!el || !isSheet()) return;
  const wrap = $("canvasWrap");
  const sheetH = $("inspector").offsetHeight;
  wrap.style.paddingBottom = sheetH + 24 + "px";
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    const top = $("bar").offsetHeight + 16;               // sous la barre translucide
    const bottom = window.innerHeight - sheetH - 16;      // au-dessus de la feuille
    if (r.top >= top && r.bottom <= bottom) return;
    // Le texte se place au tiers de l'espace libre, ou en haut s'il est plus haut que lui.
    const target = top + Math.max(0, (bottom - top - r.height) / 3);
    wrap.scrollBy({ top: r.top - target, behavior: "smooth" });
  });
}

const FAMILIES = fonts.CATALOG.filter((f) => !f.bold && !f.italic);
const familyOf = (key) => fonts.resolve(key).family;
const regularKey = (family) => (FAMILIES.find((f) => f.family === family) || FAMILIES[0]).key;
const fontLabel = (key) => FAMILIES.find((f) => f.family === familyOf(key))?.label || key;

/** `it` porte les mesures (analyse, couleur d'origine) ; `shown` les valeurs a editer. */
function fillEditor(it, shown = it) {
  const isNew = it.source === "new";
  $("inspectorEmpty").hidden = true;
  $("editor").hidden = false;
  $("inspector").classList.add("open");
  $("editorTitle").textContent = isNew ? "Nouveau texte" : "Modifier le texte";
  $("doneBtn").textContent = isNew ? "Ajouter" : "OK";
  $("applyBtn").textContent = isNew ? "Ajouter" : "Appliquer";
  $("txt").value = shown.text || "";
  $("txt").placeholder = isNew ? "Saisissez le texte" : "";
  autosize();
  $("sizeIn").value = NUM.format(Math.round((shown.size ?? 12) * 10) / 10);
  $("fontSel").value = familyOf(shown.fontKey || fonts.DEFAULT_KEY);
  setPressed($("boldBtn"), !!shown.bold);
  setPressed($("italBtn"), !!shown.italic);
  setAlign(shown.align || "left");
  S.origin = it.color && (!isNew || it.color.toLowerCase() !== "#111111") ? it.color : null;
  S.color = shown.color || "#111111";
  buildSwatches();
  $("analysis").innerHTML = isNew ? "" : analysisHtml(it);
}

function analysisHtml(it) {
  // Seuils cales sur de vrais scans : au-dela de 0.55 la police retenue est visuellement
  // juste, en dessous de 0.38 elle merite un coup d'oeil.
  const s = it.fontScore ?? 0;
  const badge = s >= 0.55 ? '<span class="badge good">Fiable</span>'
              : s >= 0.38 ? '<span class="badge mid">Approchée</span>'
                          : '<span class="badge mid">À vérifier</span>';
  const swatch = (hex) => `<i class="dot" style="background:${esc(hex)}"></i><span>${esc(hex.toUpperCase())}</span>`;
  const rows = [
    ["Police reconnue", `<span>${esc(fontLabel(it.fontKey))}</span>`],
    ["Concordance", `${badge}<span>${Math.round(s * 100)}${NNBSP}%</span>`],
    ["Encre", swatch(it.color)],
    ["Papier", swatch(it.paper)],
    ["Taille mesurée", `<span>${pt(it.size)}</span>`],
  ];
  if (it.source === "ocr" && it.conf) rows.push(["Lecture du texte", `<span>${Math.round(it.conf)}${NNBSP}%</span>`]);
  const foot = it.source === "ocr"
    ? "Mesures prises sur l’image de la page numérisée."
    : "Texte natif du PDF. Police et couleur mesurées sur le rendu.";
  return `<div class="group-title">Analyse</div><div class="group">` +
    rows.map(([k, v]) => `<div class="row"><span class="row-label">${k}</span><span class="row-value">${v}</span></div>`).join("") +
    `</div><p class="group-foot">${foot}</p>`;
}

function buildSwatches() {
  const box = $("swatches"), input = $("colorIn");
  const list = [];
  if (S.origin) list.push({ hex: S.origin.toLowerCase(), label: `Couleur d’origine (${S.origin.toUpperCase()})`, origin: true });
  for (const hex of INK_PRESETS) if (!list.some((c) => c.hex === hex)) list.push({ hex, label: hex.toUpperCase() });
  const current = S.color.toLowerCase();
  const isCustom = !list.some((c) => c.hex === current);
  box.innerHTML = "";
  for (const c of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sw" + (c.origin ? " origin" : "");
    b.style.setProperty("--c", c.hex);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(c.hex === current));
    b.setAttribute("aria-label", c.label);
    b.title = c.label;
    b.onclick = () => { S.color = c.hex; buildSwatches(); };
    box.appendChild(b);
  }
  // Le selecteur natif se pose, invisible, sur la pastille arc-en-ciel : le toucher ouvre
  // directement la roue de couleurs du systeme, y compris sur iPhone.
  const custom = document.createElement("label");
  custom.className = "sw custom";
  custom.title = "Autre couleur…";
  custom.setAttribute("role", "radio");
  custom.setAttribute("aria-checked", String(isCustom));
  custom.setAttribute("aria-label", "Autre couleur");
  if (isCustom) custom.style.setProperty("--c", current);
  input.hidden = false;
  input.value = current;
  input.oninput = () => { S.color = input.value; custom.style.setProperty("--c", input.value); };
  input.onchange = () => { S.color = input.value; buildSwatches(); };
  custom.appendChild(input);
  box.appendChild(custom);
}

function setPressed(btn, on) { btn.setAttribute("aria-pressed", String(on)); }
const isPressed = (btn) => btn.getAttribute("aria-pressed") === "true";
function setAlign(a) {
  document.querySelectorAll("[data-align]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.align === a)));
}
const currentAlign = () => document.querySelector('[data-align][aria-checked="true"]')?.dataset.align || "left";
function autosize() {
  const t = $("txt");
  t.style.height = "auto";
  t.style.height = t.scrollHeight + "px";
}
function readSize(fallback) {
  const v = parseFloat(String($("sizeIn").value).replace(",", "."));
  return Number.isFinite(v) ? Math.max(3, Math.min(200, v)) : fallback;
}
function stepSize(delta) {
  const v = Math.round((readSize(12) + delta) * 2) / 2;
  $("sizeIn").value = NUM.format(Math.max(3, Math.min(200, v)));
}

/* ================================================================ edition */
async function applyEdit({ close = false } = {}) {
  if (S.busy) return;
  const base = S.sel || S.draft;
  if (!base) return;
  const isNew = base.source === "new";
  const common = {
    page: S.page,
    text: $("txt").value,
    size: readSize(base.size || 12),
    color: S.color,
    fontKey: regularKey($("fontSel").value),
    bold: isPressed($("boldBtn")),
    italic: isPressed($("italBtn")),
    align: currentAlign(),
  };

  const prev = !isNew ? editOf(S.page, base.id) : base.replacing || null;
  // Rien de change : on ne fabrique pas de retouche, qui re-dessinerait le texte a
  // l'identique et laisserait une trace dans l'historique.
  const ref = prev || base;
  const unchanged = !isNew && common.text === base.text && Math.abs(common.size - (ref.size ?? 12)) < 0.05 &&
    familyOf(common.fontKey) === familyOf(ref.fontKey) && common.bold === !!ref.bold &&
    common.italic === !!ref.italic && common.color.toLowerCase() === (ref.color || "").toLowerCase() &&
    common.align === (ref.align || "left");
  if (unchanged || (isNew && !common.text.trim())) {
    if (close || isNew) clearSelection();
    return;
  }

  const op = isNew
    ? { type: "add", bbox: fitAdded(base.bbox, common), ...common }
    : {
        type: "text", itemId: base.id, bbox: base.bbox,
        tracking: base.tracking || 0, blur: base.blur || 0, grain: base.grain || 0,
        left: base.inkLeft ?? base.bbox[0], top: base.inkTop ?? base.bbox[1],
        ...common,
      };

  S.busy = true;
  $("applyBtn").disabled = $("doneBtn").disabled = true;
  try {
    // Une nouvelle version prend la place de l'ancienne : l'ordre de superposition ne
    // change pas, et Annuler le rend tel quel.
    if (prev) S.doc.replaceOp(prev, op);
    else S.doc.addOp(op);
    record({ type: "op", page: S.page, op, replaced: prev || null, itemId: isNew ? null : base.id, prevText: base.text });
    if (!isNew) base.text = op.text;
    await refreshCurrent();
    if (close || isNew) clearSelection();
  } catch (e) {
    console.error(e); toast(e.message, true);
  } finally {
    S.busy = false;
    $("applyBtn").disabled = $("doneBtn").disabled = false;
  }
}

/** Un bloc ajoute s'elargit pour contenir son texte, dans la limite de la page : son
    cadre sert aussi a le selectionner et a le deplacer ensuite. */
function fitAdded(bbox, t) {
  const need = fonts.inkWidth(fonts.variant(t.fontKey, t.bold, t.italic), t.text, t.size) + t.size * 0.4;
  return [bbox[0], bbox[1], Math.min(S.size.width, Math.max(bbox[2], bbox[0] + need)), bbox[3]];
}

/** Redessine la page courante apres une retouche, sans perdre la selection. */
async function refreshCurrent() {
  await renderPage();
  renderOverlay();
  if (!S.sel && !S.draft) describePage();
  refreshThumb(S.page);
}

/* --- historique ---
   Chaque action est une entree reversible : retouche (avec celle qu'elle remplace),
   rotation ou suppression de page. Annuler la deplace vers `future`, Retablir la rejoue. */
function record(entry) {
  S.past.push(entry);
  S.future = [];
  updateHistory();
}

function updateHistory() {
  $("undoBtn").disabled = !S.past.length;
  $("redoBtn").disabled = !S.future.length;
  updateTitle();
}

async function undo() { await travel(S.past, S.future, false); }
async function redo() { await travel(S.future, S.past, true); }

async function travel(from, to, forward) {
  if (S.busy || !S.doc || !from.length) return;
  const e = from.pop();
  to.push(e);
  S.busy = true;
  try {
    if (e.type === "op") {
      const item = e.itemId ? S.doc.findItem(e.page, e.itemId) : null;
      // `op` nul : suppression d'un objet ; `replaced` nul : ajout. Les deux : modification,
      // faite a la meme place pour garder l'ordre de superposition.
      const [gone, back] = forward ? [e.replaced, e.op] : [e.op, e.replaced];
      if (gone && back) S.doc.replaceOp(gone, back);
      else if (back) S.doc.ops.splice(e.index ?? S.doc.ops.length, 0, back);
      else if (gone) S.doc.removeOp(gone.uid);
      if (item) item.text = forward ? e.op.text : e.prevText;
      S.busy = false;
      if (e.page !== S.page) await loadPage(e.page);
      else { clearSelection(); await refreshCurrent(); }
    } else if (e.type === "rotate") {
      S.busy = false;
      if (e.page !== S.page) await loadPage(e.page);
      applyRotation(e.page, forward ? e.to : e.from, forward ? e.delta : -e.delta);
    } else if (e.type === "pages") {
      S.busy = false;
      S.doc.order = [...(forward ? e.after : e.before)];
      buildThumbs();
      const vis = visiblePages();
      const want = forward ? e.show : e.from;
      await loadPage(vis.includes(want) ? want : vis.includes(S.page) ? S.page : vis[0]);
    } else if (e.type === "remove") {
      S.busy = false;
      if (forward) await hidePage(e.page);
      else await showPage(e.page);
    }
  } finally {
    S.busy = false;
    updateHistory();
  }
}

/* ================================================================ outils de zone */
const HINTS = {
  erase: "Faites glisser sur la zone à effacer.",
  add: "Tracez le cadre du nouveau texte.",
  image: "Tracez l’emplacement de l’image.",
  sign: "Touchez où signer.",
};
const TOOL_CLASSES = ["tool-erase", "tool-add", "tool-image", "tool-sign", "tool-mark"];

function setTool(name) {
  S.tool = name;
  document.querySelectorAll("[data-tool]").forEach((b) => setPressed(b, b.dataset.tool === name));
  objects.deselect();
  $("canvas").classList.remove(...TOOL_CLASSES);
  if (name !== "select") { $("canvas").classList.add("tool-" + name); clearSelection(); }
  $("hint").hidden = name === "select";
  $("hintText").textContent = name === "mark" ? annotate.hintFor() : HINTS[name] || "";
  $("hintAlt").hidden = name !== "sign";
  annotate.show(name === "mark");
  $("stage").classList.toggle("has-hint", name !== "select");
  $("pager").hidden = name === "mark";
}

/** Bouton d'outil. « Signer » pose la signature enregistree, ou ouvre d'abord le bloc pour
    la dessiner ; les autres outils s'activent et se desactivent d'un toucher. */
async function pickTool(name) {
  if (S.tool === name && name !== "select") return setTool("select");
  if (name !== "sign") return setTool(name);
  const sig = (await savedSignature()) || (await drawSignature());
  if (!sig) return setTool("select");
  S.signature = sig;
  setTool("sign");
}

async function redrawSignature() {
  const sig = await drawSignature();
  if (sig) S.signature = sig;
}

/** Point de l'ecran -> coordonnees dans la page affichee (avant rotation), en pixels. */
function toLocal(clientX, clientY) {
  const r = $("frame").getBoundingClientRect();
  const dx = clientX - (r.left + r.width / 2), dy = clientY - (r.top + r.height / 2);
  const a = (-(S.turn.get(S.page) ?? rotation()) * Math.PI) / 180;
  const k = scale();
  return {
    x: dx * Math.cos(a) - dy * Math.sin(a) + (S.size.width * k) / 2,
    y: dx * Math.sin(a) + dy * Math.cos(a) + (S.size.height * k) / 2,
  };
}

function initMarquee() {
  const cv = $("canvas"), mq = $("marquee");
  let start = null, pid = null;
  const clamp = (p) => {
    const k = scale();
    return { x: Math.max(0, Math.min(S.size.width * k, p.x)), y: Math.max(0, Math.min(S.size.height * k, p.y)) };
  };
  const draw = (p) => Object.assign(mq.style, {
    left: Math.min(p.x, start.x) + "px", top: Math.min(p.y, start.y) + "px",
    width: Math.abs(p.x - start.x) + "px", height: Math.abs(p.y - start.y) + "px",
  });
  const cancel = () => { start = null; pid = null; mq.hidden = true; };

  cv.addEventListener("pointerdown", (e) => {
    if (S.tool === "select" || S.tool === "mark" || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (start) { cancel(); return; }           // second doigt : c'est un pincement
    start = clamp(toLocal(e.clientX, e.clientY));
    pid = e.pointerId;
    cv.setPointerCapture(pid);
    mq.hidden = false;
    draw(start);
    e.preventDefault();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== pid) return;
    draw(clamp(toLocal(e.clientX, e.clientY)));
  });
  cv.addEventListener("pointercancel", cancel);
  cv.addEventListener("pointerup", async (e) => {
    if (!start || e.pointerId !== pid) return;
    const p = clamp(toLocal(e.clientX, e.clientY));
    const box = [Math.min(p.x, start.x), Math.min(p.y, start.y), Math.max(p.x, start.x), Math.max(p.y, start.y)];
    cancel();
    const tap = box[2] - box[0] < 8 || box[3] - box[1] < 8;
    if (tap && S.tool !== "sign") return;
    // Un trace se termine par un evenement `click` : sans ce garde-fou, il
    // deselectionnerait aussitot le bloc que le trace vient de creer.
    swallowNextClick = true;
    setTimeout(() => (swallowNextClick = false), 400);
    const k = scale();
    const bbox = box.map((v) => v / k);
    if (S.tool === "erase") await eraseZone(bbox);
    else if (S.tool === "add") newTextBlock(bbox);
    else if (S.tool === "image") insertImage(bbox);
    else if (S.tool === "sign") await placeSignature(bbox, tap);
  });
}

async function eraseZone(bbox) {
  const op = { type: "erase", page: S.page, bbox };
  S.doc.addOp(op);
  record({ type: "op", page: S.page, op, replaced: null, itemId: null });
  await refreshCurrent();
}

/** Texte le plus proche d'un cadre : un bloc ajoute reprend sa police et son encre, pour
    se fondre dans le document plutot que d'imposer un Arial noir. */
function nearestItem(bbox) {
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  let best = null, bestD = Infinity;
  for (const it of S.analysis?.items || []) {
    const dx = Math.max(0, it.bbox[0] - cx, cx - it.bbox[2]);
    const dy = (it.bbox[1] + it.bbox[3]) / 2 - cy;
    const d = Math.hypot(dx * 0.5, dy);
    if (d < bestD) { bestD = d; best = it; }
  }
  return best;
}

function newTextBlock(bbox) {
  setTool("select");
  S.sel = null;
  // Corps de depart : celui du texte voisin, sans deborder du cadre trace.
  const near = nearestItem(bbox);
  const fit = (bbox[3] - bbox[1]) * 0.75;
  const size = Math.max(6, Math.min(72, Math.round((near ? Math.min(near.size, fit) : fit) * 2) / 2));
  S.draft = {
    source: "new", bbox, size, text: "",
    color: near?.color || "#111111", fontKey: near?.fontKey || fonts.DEFAULT_KEY,
    bold: false, italic: false,
  };
  fillEditor(S.draft);
  drawDraft();
  if (isSheet()) $("canvasWrap").style.paddingBottom = $("inspector").offsetHeight + 24 + "px";
  setTimeout(() => $("txt").focus(), isSheet() ? 320 : 0);
}

/** Pose une image dans un cadre de la page : elle y tient entiere, proportions
    conservees, centree. */
async function placeBitmap(bitmap, bbox, extra = {}) {
  const bw = bbox[2] - bbox[0], bh = bbox[3] - bbox[1];
  const k = Math.min(bw / bitmap.width, bh / bitmap.height);
  const w = bitmap.width * k, h = bitmap.height * k;
  const x = bbox[0] + (bw - w) / 2, y = bbox[1] + (bh - h) / 2;
  const op = { type: "image", page: S.page, bbox: [x, y, x + w, y + h], bitmap, ...extra };
  S.doc.addOp(op);
  record({ type: "op", page: S.page, op, replaced: null, itemId: null });
  await refreshCurrent();
}

function insertImage(bbox) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try { await placeBitmap(await readImage(f), bbox); }
    catch (e) { console.error(e); toast("Cette image ne peut pas être lue.", true); }
  };
  inp.click();
  setTool("select");
}

/** Un toucher pose la signature a la taille d'une signature manuscrite (environ 5 cm de
    large sur une page A4), centree sur le doigt ; un cadre trace impose sa taille. */
async function placeSignature(bbox, tap) {
  const sig = S.signature;
  if (!sig) return;
  if (tap) {
    const cx = bbox[0], cy = bbox[1];
    const w = Math.min(S.size.width * 0.28, S.size.width - 8);
    const h = (w * sig.height) / sig.width;
    const x = Math.max(4, Math.min(S.size.width - w - 4, cx - w / 2));
    const y = Math.max(4, Math.min(S.size.height - h - 4, cy - h / 2));
    bbox = [x, y, x + w, y + h];
  }
  setTool("select");
  await placeBitmap(sig, bbox, { signature: true });
}

/* ================================================================ objets et annotations */

/** Ajoute une operation a la page courante, avec son entree d'historique. */
async function addOpHere(op) {
  op.page = S.page;
  S.doc.addOp(op);
  record({ type: "op", page: S.page, op, replaced: null, itemId: null });
  await refreshCurrent();
  return op;
}

/** Remplace (ou supprime, si `next` est nul) un objet pose sur la page. */
async function replaceOpHere(old, next) {
  if (next) {
    next.page = old.page;
    S.doc.replaceOp(old, next);
    record({ type: "op", page: old.page, op: next, replaced: old, itemId: null });
  } else {
    const index = S.doc.ops.indexOf(old);
    S.doc.removeOp(old.uid);
    record({ type: "op", page: old.page, op: null, replaced: old, itemId: null, index });
  }
  await refreshCurrent();
  return next;
}

/** Date du jour ecrite a l'endroit touche, dans la police et l'encre du texte voisin. */
async function addDate(p) {
  const text = new Date().toLocaleDateString("fr-FR");
  const near = nearestItem([p.x, p.y, p.x, p.y]);
  const size = Math.max(7, Math.min(20, near?.size || 11));
  const fontKey = near?.fontKey || fonts.DEFAULT_KEY;
  const w = fonts.inkWidth(fonts.variant(fontKey, false, false), text, size) + size * 0.5;
  const bbox = [p.x, p.y - size * 0.75, Math.min(S.size.width, p.x + w), p.y + size * 0.65];
  await addOpHere({ type: "add", bbox, text, size, color: near?.color || "#111111", fontKey,
    bold: false, italic: false, align: "left" });
}

/** Rouvre l'editeur sur un bloc de texte ajoute : le valider remplace le bloc. */
function editAdded(op) {
  setTool("select");
  objects.deselect();
  S.sel = null;
  S.draft = { ...op, source: "new", replacing: op };
  fillEditor(S.draft);
  drawDraft();
  if (isSheet()) $("canvasWrap").style.paddingBottom = $("inspector").offsetHeight + 24 + "px";
  setTimeout(() => $("txt").focus(), isSheet() ? 320 : 0);
}

/** Selectionne la zone de texte sous un point de la page. */
function editTextAt(p) {
  const it = (S.analysis?.items || []).find((i) => p.x >= i.bbox[0] && p.x <= i.bbox[2] && p.y >= i.bbox[1] && p.y <= i.bbox[3]);
  if (!it) return;
  selectItem(it, document.querySelector(`.hit[data-id="${it.id}"]`));
}

function initObjects() {
  const swallow = () => { swallowNextClick = true; setTimeout(() => (swallowNextClick = false), 400); };
  annotate.init({
    tool: () => S.tool, scale, size: () => S.size, toLocal,
    items: () => S.analysis?.items || [],
    nearestSize: (p) => nearestItem([p.x, p.y, p.x, p.y])?.size,
    commit: addOpHere, addDate,
    onHint: (t) => { if (S.tool === "mark") $("hintText").textContent = t; },
    swallowClick: swallow,
  });
  objects.init({
    tool: () => S.tool, size: () => S.size, scale, toLocal,
    ops: () => (S.doc ? S.doc.opsFor(S.page) : []),
    replace: replaceOpHere, add: addOpHere, editAdded,
    rerender: renderOverlay,
    clearText: () => { if (S.sel || S.draft) clearSelection(); },
    editTextAt, swallow, swallowing: () => swallowNextClick,
  });
}

/* ================================================================ pages */
let thumbObserver = null;

function buildThumbs() {
  const list = $("pageList");
  list.innerHTML = "";
  thumbObserver?.disconnect();
  // Les miniatures ne sont dessinees qu'a l'approche de l'ecran : un document de cent
  // pages s'ouvre aussi vite qu'un document d'une page.
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) refreshThumb(+en.target.dataset.id);
  }, { root: list, rootMargin: "400px 0px" });

  for (const id of S.doc.order) {
    const d = document.createElement("div");
    d.className = "thumb";
    d.dataset.id = id;
    d.hidden = S.doc.removed.has(id);
    d.innerHTML = `<div class="sheet"><canvas width="112" height="150"></canvas>
      <button type="button" class="more" aria-label="Options de la page"><svg class="sym"><use href="#i-dots"/></svg></button></div>
      <span class="num"></span>`;
    d.onclick = (ev) => {
      if (swallowNextClick) return;
      if (ev.target.closest(".more")) { ev.stopPropagation(); pageMenu(id, ev.target.closest(".more")); return; }
      if (!WIDE.matches) setSidebar(false);
      if (id !== S.page) loadPage(id);
    };
    // Chrome sur Android envoie `contextmenu` a l'appui long, pendant qu'on souleve la
    // miniature pour la glisser : le menu ne doit pas s'ouvrir par-dessus.
    d.oncontextmenu = (ev) => { ev.preventDefault(); if (!d._gesture) pageMenu(id, { x: ev.clientX, y: ev.clientY }); };
    initThumbDrag(d, id);
    list.appendChild(d);
    thumbObserver.observe(d);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "add-pages";
  add.innerHTML = `<svg class="sym"><use href="#i-plus"/></svg><span>Ajouter des pages</span>`;
  add.onclick = () => addPagesMenu(add);
  list.appendChild(add);
  numberThumbs();
  markThumb();
}

function numberThumbs() {
  const vis = visiblePages();
  $("pageList").querySelectorAll(".thumb").forEach((el) => {
    const n = vis.indexOf(+el.dataset.id) + 1;
    el.querySelector(".num").textContent = n || "";
    el.querySelector(".more").setAttribute("aria-label", `Options de la page ${n}`);
    el.setAttribute("aria-label", `Page ${n}`);
  });
}

async function refreshThumb(i) {
  const el = thumbOf(i);
  if (!el || el.hidden) return;
  const size = await S.doc.pageSize(i);
  const px = 112 * Math.min(2, window.devicePixelRatio || 1);
  const src = await S.doc.renderPage(i, (72 * px) / Math.max(size.width, size.height * 0.75), true);
  const rot = rotation(i);
  const target = el.querySelector("canvas");
  const turned = rot % 180 !== 0;
  target.width = turned ? src.height : src.width;
  target.height = turned ? src.width : src.height;
  const ctx = target.getContext("2d");
  ctx.save();
  ctx.translate(target.width / 2, target.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
  el.dataset.drawn = "1";
}

/** Glisser une miniature la deplace. A la souris le glisser suffit ; au doigt il faut
    d'abord un appui long, comme sur l'ecran d'accueil de l'iPhone : relache sans bouger,
    l'appui long ouvre le menu de la page. */
function initThumbDrag(el, id) {
  let pid = null, startY = 0, startX = 0, lifted = false, dragging = false, timer = null, rafScroll = 0, lastY = 0;
  const list = $("pageList");
  const reset = () => {
    clearTimeout(timer); cancelAnimationFrame(rafScroll);
    el.classList.remove("lifted", "dragging");
    el.style.transform = "";
    list.querySelectorAll(".drop-before,.drop-after").forEach((t) => t.classList.remove("drop-before", "drop-after"));
    pid = null; lifted = dragging = false;
    el._gesture = false;
  };
  const target = (y) => {
    const others = [...list.querySelectorAll(".thumb:not([hidden])")].filter((t) => t !== el);
    for (const t of others) {
      const r = t.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { t, before: true };
    }
    return { t: others[others.length - 1], before: false };
  };
  const mark = (y) => {
    list.querySelectorAll(".drop-before,.drop-after").forEach((t) => t.classList.remove("drop-before", "drop-after"));
    const { t, before } = target(y);
    t?.classList.add(before ? "drop-before" : "drop-after");
  };
  // Pres des bords, la liste defile toute seule pour atteindre les pages hors de vue.
  const autoScroll = () => {
    const r = list.getBoundingClientRect(), edge = 48;
    const v = lastY < r.top + edge ? -(r.top + edge - lastY) / 4 : lastY > r.bottom - edge ? (lastY - r.bottom + edge) / 4 : 0;
    if (v) { list.scrollTop += v; mark(lastY); }
    rafScroll = requestAnimationFrame(autoScroll);
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".more") || (e.pointerType === "mouse" && e.button !== 0) || pid !== null) return;
    pid = e.pointerId; startX = e.clientX; startY = lastY = e.clientY;
    el._gesture = e.pointerType !== "mouse";
    if (e.pointerType !== "mouse") {
      timer = setTimeout(() => { lifted = true; navigator.vibrate?.(8); el.classList.add("lifted"); }, 420);
    }
  });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pid) return;
    const far = Math.hypot(e.clientX - startX, e.clientY - startY) > 8;
    if (!dragging) {
      if (!far) return;
      if (e.pointerType !== "mouse" && !lifted) { reset(); return; }   // simple defilement
      dragging = true;
      el.setPointerCapture(pid);
      el.classList.add("dragging");
      rafScroll = requestAnimationFrame(autoScroll);
    }
    lastY = e.clientY;
    el.style.transform = `translateY(${e.clientY - startY}px)`;
    mark(e.clientY);
  });
  el.addEventListener("touchmove", (e) => { if (lifted) e.preventDefault(); }, { passive: false });
  el.addEventListener("pointerup", (e) => {
    if (e.pointerId !== pid) return;
    const wasLifted = lifted, wasDragging = dragging;
    const drop = dragging ? target(e.clientY) : null;
    reset();
    if (wasDragging && drop?.t) {
      swallowNextClick = true; setTimeout(() => (swallowNextClick = false), 400);
      const order = S.doc.order.filter((x) => x !== id);
      const pos = order.indexOf(+drop.t.dataset.id) + (drop.before ? 0 : 1);
      changePages(() => S.doc.movePage(id, pos), id);
    } else if (wasLifted) {
      swallowNextClick = true; setTimeout(() => (swallowNextClick = false), 400);
      pageMenu(id, { x: e.clientX, y: e.clientY });
    }
  });
  el.addEventListener("pointercancel", reset);
}

function markThumb() {
  $("pageList").querySelectorAll(".thumb").forEach((c) => {
    const on = +c.dataset.id === S.page;
    c.classList.toggle("on", on);
    c.setAttribute("aria-current", on ? "page" : "false");
    if (on) c.scrollIntoView({ block: "nearest" });
  });
}

function pageMenu(i, at) {
  const vis = visiblePages(), pos = vis.indexOf(i);
  const lastOne = vis.length <= 1;
  openMenu([
    { label: "Pivoter à gauche", icon: "i-rot-l", run: () => rotatePage(i, -90) },
    { label: "Pivoter à droite", icon: "i-rot-r", run: () => rotatePage(i, 90) },
    "-",
    { label: "Monter", icon: "i-chev-up", disabled: pos <= 0, run: () => changePages(() => S.doc.movePage(i, S.doc.order.indexOf(vis[pos - 1])), i) },
    { label: "Descendre", icon: "i-chev-down", disabled: pos >= vis.length - 1, run: () => changePages(() => S.doc.movePage(i, S.doc.order.indexOf(vis[pos + 1])), i) },
    { label: "Dupliquer", icon: "i-copy", run: () => changePages(() => S.doc.duplicate(i)) },
    { label: "Insérer une page blanche", icon: "i-doc", run: async () => {
      const size = await S.doc.pageSize(i);
      changePages(() => S.doc.insertBlank(i, size));
    } },
    { label: "Exporter cette page", icon: "i-share", run: () => exportPdf({ only: [i] }) },
    "-",
    { label: "Supprimer la page", icon: "i-trash", danger: true, disabled: lastOne, run: () => removePage(i) },
  ], at);
}

function addPagesMenu(at) {
  const after = visiblePages().at(-1);
  openMenu([
    { label: "Page blanche", icon: "i-doc", run: async () => {
      const size = await S.doc.pageSize(S.page);
      changePages(() => S.doc.insertBlank(after, size));
    } },
    { label: "Pages d’un autre PDF…", icon: "i-plus", run: () => pickFile("application/pdf,.pdf", insertPdf) },
    { label: "Photo ou numérisation…", icon: "i-photo", run: () => pickFile("image/*", insertPhotoPage) },
  ], at);
}

function pickFile(accept, then) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = accept;
  inp.onchange = () => inp.files[0] && then(inp.files[0]);
  inp.click();
}

/** Modification de la liste des pages (ajout, copie, deplacement), reversible : l'ordre
    d'avant et d'apres est garde dans l'historique. `fn` retourne la page a afficher. */
async function changePages(fn, show) {
  const before = [...S.doc.order], from = S.page;
  const res = await fn();
  const target = show ?? (Array.isArray(res) ? res[0] : res);
  if (before.join() === S.doc.order.join()) return;
  record({ type: "pages", before, after: [...S.doc.order], show: target, from });
  buildThumbs();
  updateTitle();
  if (target !== undefined && target !== S.page) await loadPage(target);
  else { updatePager(); markThumb(); }
}

async function insertPdf(file) {
  if (S.busy) return;
  veil(true, "Ajout des pages…");
  S.busy = true;
  try {
    let ids = [];
    await changePages(async () => (ids = await S.doc.insertPdf(file, visiblePages().at(-1))));
    toast(`${plural(ids.length, "page")} ajoutée${ids.length > 1 ? "s" : ""}`);
  } catch (e) {
    console.error(e); toast("Ce PDF ne peut pas être ajouté : " + e.message, true);
  } finally { S.busy = false; veil(false); }
}

/** Image d'un fichier, ramenee a une definition raisonnable : une photo d'iPhone decodee
    pese pres de 50 Mo, et la WebView ferme l'app au-dela de quelques-unes. 2 400 px sur
    le grand cote restent nets imprimes en pleine page. */
async function readImage(file, maxSide = 2400) {
  const full = await createImageBitmap(file);
  const k = maxSide / Math.max(full.width, full.height);
  if (k >= 1) return full;
  const small = await createImageBitmap(full, { resizeWidth: Math.round(full.width * k), resizeHeight: Math.round(full.height * k), resizeQuality: "high" });
  full.close();
  return small;
}

/** Photo (ou document photographie) en nouvelle page A4, dans le sens de l'image. */
async function insertPhotoPage(file) {
  try {
    const bitmap = await readImage(file);
    const portrait = bitmap.height >= bitmap.width;
    const size = portrait ? { width: 595.28, height: 841.89 } : { width: 841.89, height: 595.28 };
    const m = 18, k = Math.min((size.width - 2 * m) / bitmap.width, (size.height - 2 * m) / bitmap.height);
    const w = bitmap.width * k, h = bitmap.height * k;
    const x = (size.width - w) / 2, y = (size.height - h) / 2;
    await changePages(() => {
      const id = S.doc.insertBlank(visiblePages().at(-1), size);
      S.doc.addOp({ type: "image", page: id, bbox: [x, y, x + w, y + h], bitmap });
      return id;
    });
  } catch (e) { console.error(e); toast("Cette image ne peut pas être lue.", true); }
}

async function rotatePage(i, delta) {
  const from = rotation(i), to = (from + delta + 360) % 360;
  record({ type: "rotate", page: i, from, to, delta });
  if (i !== S.page) await loadPage(i);
  applyRotation(i, to, delta);
}

function applyRotation(i, angle, delta) {
  if (angle) S.doc.rotations.set(i, angle); else S.doc.rotations.delete(i);
  S.turn.set(i, (S.turn.get(i) ?? 0) + delta);
  refreshThumb(i);
  if (i !== S.page) return;
  const cv = $("canvas");
  cv.classList.add("turning");
  S.baseScale = fitScale();
  layout();
  clearTimeout(cv._t);
  cv._t = setTimeout(async () => { cv.classList.remove("turning"); await renderPage(); }, 420);
  if (!S.sel && !S.draft) describePage();
}

async function removePage(i) {
  if (visiblePages().length <= 1) return;
  record({ type: "remove", page: i });
  await hidePage(i);
  toast(`Page supprimée. ${shortcut("Mod+Z")} pour annuler.`);
}

async function hidePage(i) {
  const vis = visiblePages();
  const pos = vis.indexOf(i);
  S.doc.removed.add(i);
  const el = thumbOf(i);
  el.classList.add("leaving");
  setTimeout(() => { if (S.doc.removed.has(i)) el.hidden = true; }, 250);
  numberThumbs();
  updateTitle();
  if (i === S.page) await loadPage(vis[pos + 1] ?? vis[pos - 1]);
  else updatePager();
}

async function showPage(i) {
  S.doc.removed.delete(i);
  const el = thumbOf(i);
  el.hidden = false;
  el.classList.remove("leaving");
  numberThumbs();
  refreshThumb(i);
  updateTitle();
  await loadPage(i);
}

function setSidebar(open) {
  const btn = $("pagesBtn");
  if (WIDE.matches) {
    document.body.classList.toggle("no-sidebar", !open);
  } else {
    $("pageList").classList.toggle("open", open);
    $("scrim").hidden = !open;
    if (open) markThumb();
  }
  btn.setAttribute("aria-pressed", String(open));
  btn.setAttribute("aria-label", open ? "Masquer les pages" : "Afficher les pages");
}
const sidebarOpen = () => (WIDE.matches ? !document.body.classList.contains("no-sidebar") : $("pageList").classList.contains("open"));

/* ================================================================ export */
async function exportPdf({ only = null } = {}) {
  if (!S.doc || S.busy) return;
  veil(true, "Préparation du PDF…", 0);
  let file;
  S.busy = true;
  try {
    const bytes = await S.doc.export((p) => veil(true, "Préparation du PDF…", p), { only });
    const base = S.doc.name.replace(/\.pdf$/i, "");
    const name = only
      ? `${base} (page ${visiblePages().indexOf(only[0]) + 1}).pdf`
      : base + (S.past.length ? " (modifié)" : "") + ".pdf";
    file = new File([bytes], name, { type: "application/pdf" });
  } catch (e) {
    console.error(e);
    veil(false);
    return toast("L’export a échoué : " + e.message, true);
  } finally { S.busy = false; }
  veil(false);
  // Une page exportee seule n'enregistre pas le document : il reste « modifie ».
  const saved = () => { if (!only) { S.cleanAt = S.past.length; updateTitle(); } };

  // Dans l'app iOS, la feuille de partage native : le telechargement n'existe pas.
  if (native.isNative) {
    try {
      if (await native.shareFile(file)) saved();
    } catch (e) { console.error(e); toast("Le partage a échoué : " + e.message, true); }
    return;
  }

  // Au doigt, la feuille de partage du systeme (Enregistrer dans Fichiers, Mail…) ; a la
  // souris, un telechargement classique.
  if (!FINE.matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      saved();
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
      if (e.name === "NotAllowedError") {
        // La preparation a pris trop de temps : Safari n'accepte plus le geste d'origine.
        // Un nouveau toucher, sur l'alerte, relance le partage.
        const again = await ask({
          title: "Le PDF est prêt",
          message: file.name,
          buttons: [{ label: "Annuler", role: "cancel", value: false }, { label: "Partager", role: "default", value: true }],
        });
        if (!again) return;
        try { await navigator.share({ files: [file], title: file.name }); saved(); return; }
        catch (e2) { if (e2.name === "AbortError") return; }
      }
    }
  }
  download(file);
  saved();
  toast(`« ${file.name} » exporté`);
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ================================================================ zoom et gestes */
/** Change le zoom en gardant immobile le point (clientX, clientY) de l'ecran. Avec
    `live`, on etire l'image deja rendue : la redessiner a chaque etape du geste le
    rendrait saccade. Le rendu net suit a la fin du geste. */
function zoomAround(z, clientX, clientY, live = false) {
  if (!S.doc) return;
  const wrap = $("canvasWrap"), frame = $("frame");
  const before = frame.getBoundingClientRect();
  const fx = (clientX - before.left) / before.width, fy = (clientY - before.top) / before.height;
  S.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  layout();
  const after = frame.getBoundingClientRect();
  wrap.scrollLeft += after.left + fx * after.width - clientX;
  wrap.scrollTop += after.top + fy * after.height - clientY;
  clearTimeout(zoomAround._t);
  zoomAround._t = setTimeout(() => renderPage(), live ? 220 : 0);
}

function zoomCentered(z) {
  const r = $("canvasWrap").getBoundingClientRect();
  zoomAround(z, r.left + r.width / 2, r.top + Math.min(r.height / 2, 400));
}

/** Pincement a deux doigts et double-tap : sur un A4 ramene a la largeur d'un telephone,
    une ligne de texte fait moins de dix pixels de haut, intouchable au doigt sans zoom. */
function initGestures() {
  const wrap = $("canvasWrap");
  let startDist = 0, startZoom = 1, pinching = false;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

  // Pendant le geste, la page est seulement agrandie par une transformation CSS, que la
  // carte graphique suit image par image ; la mise en page, le defilement et le rendu net
  // n'ont lieu qu'une fois, au lacher. Les deux doigts deplacent aussi la page, comme
  // dans Photos.
  const frame = $("frame");
  let startMid = null, lastMid = null, ratio = 1, fx = 0, fy = 0, sx = 0, sy = 0;
  wrap.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 2 || !S.doc || pinching) return;
    pinching = true;
    startDist = dist(e.touches) || 1;
    startZoom = S.zoom;
    startMid = lastMid = mid(e.touches);
    ratio = 1;
    const r = frame.getBoundingClientRect();
    fx = (startMid.x - r.left) / r.width; fy = (startMid.y - r.top) / r.height;
    // Sur iPhone, un premier doigt a pu lancer le defilement avant que le second se pose :
    // on le fige, et l'ecart deja parcouru est compense dans la transformation.
    sx = wrap.scrollLeft; sy = wrap.scrollTop;
    wrap.style.overflow = "hidden";
    frame.style.transformOrigin = `${startMid.x - r.left}px ${startMid.y - r.top}px`;
    frame.style.willChange = "transform";
    $("objBar").hidden = true;
    e.preventDefault();
  }, { passive: false });
  wrap.addEventListener("touchmove", (e) => {
    if (!pinching) return;
    e.preventDefault();
    if (e.touches.length !== 2) return;
    lastMid = mid(e.touches);
    ratio = Math.max(MIN_ZOOM / startZoom, Math.min(MAX_ZOOM / startZoom, dist(e.touches) / startDist));
    const dx = lastMid.x - startMid.x + (wrap.scrollLeft - sx), dy = lastMid.y - startMid.y + (wrap.scrollTop - sy);
    frame.style.transform = `translate(${dx}px, ${dy}px) scale(${ratio})`;
  }, { passive: false });
  const endPinch = (e) => {
    if (!pinching || e.touches.length >= 2) return;
    pinching = false;
    lastTap = 0;
    // Le doigt leve en dernier ne doit pas selectionner le texte sous lui.
    swallowNextClick = true; setTimeout(() => (swallowNextClick = false), 400);
    // Le point de la page qui etait sous les doigts au depart finit la ou ils sont : c'est
    // la que la transformation l'affichait.
    frame.style.transform = frame.style.transformOrigin = frame.style.willChange = "";
    wrap.style.overflow = "";
    S.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, startZoom * ratio));
    layout();
    const after = frame.getBoundingClientRect();
    wrap.scrollLeft += after.left + fx * after.width - lastMid.x;
    wrap.scrollTop += after.top + fy * after.height - lastMid.y;
    renderPage();
    renderOverlay();
  };
  wrap.addEventListener("touchend", endPinch);
  wrap.addEventListener("touchcancel", endPinch);

  // Double-tap hors d'une zone de texte : bascule entre pleine largeur et zoom de lecture,
  // centre sur le point touche.
  let lastTap = 0, tapX = 0, tapY = 0, moved = false;
  wrap.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) { moved = false; tapX = e.touches[0].clientX; tapY = e.touches[0].clientY; }
  }, { passive: true });
  wrap.addEventListener("touchmove", () => { moved = true; }, { passive: true });
  wrap.addEventListener("touchend", (e) => {
    if (e.touches.length || pinching || moved || S.tool !== "select" || e.target.closest(".hit")) return;
    const now = Date.now();
    if (now - lastTap < 300) {
      e.preventDefault();
      zoomAround(S.zoom > 1.4 ? 1 : 2.2, tapX, tapY);
      lastTap = 0;
    } else lastTap = now;
  });

  // Pincement au trackpad (Ctrl + molette, convention des navigateurs) et Ctrl + molette.
  wrap.addEventListener("wheel", (e) => {
    if (!e.ctrlKey || !S.doc) return;
    e.preventDefault();
    zoomAround(S.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY, true);
  }, { passive: false });
}

/** Glisser la feuille vers le bas la ferme, comme une feuille iOS. */
function initSheetDrag() {
  const head = $("sheetHead"), sheet = $("inspector");
  let y0 = null, dy = 0, t0 = 0;
  head.addEventListener("pointerdown", (e) => {
    if (!isSheet() || e.target.closest("button")) return;
    y0 = e.clientY; dy = 0; t0 = performance.now();
    head.setPointerCapture(e.pointerId);
    sheet.classList.add("dragging");
  });
  head.addEventListener("pointermove", (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 === null) return;
    const speed = dy / Math.max(1, performance.now() - t0);
    y0 = null;
    sheet.classList.remove("dragging");
    sheet.style.transform = "";
    if (dy > 110 || speed > 0.6) clearSelection();
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
}

/** Clavier virtuel : la feuille d'edition remonte au-dessus plutot que d'etre masquee. */
function initKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", (kb > 60 ? kb : 0) + "px");
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
}

/* ================================================================ demarrage */
function initDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (++depth === 1) document.body.classList.add("dropping");
  });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("dragleave", () => {
    if (--depth <= 0) { depth = 0; document.body.classList.remove("dropping"); }
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("dropping");
    openFile(e.dataTransfer?.files?.[0]);
  });
}

function initShortcuts() {
  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();

    if (e.key === "Escape") {
      if (!$("menuLayer").hidden) return closeMenu();
      if (objects.deselect()) return;
      if (S.tool !== "select") return setTool("select");
      if (S.sel || S.draft) return clearSelection();
      if (!WIDE.matches && sidebarOpen()) return setSidebar(false);
      return;
    }
    if (mod && k === "o") { e.preventDefault(); return $("picker").click(); }
    if (!S.doc || S.busy) return;

    if (mod && e.key === "Enter") { e.preventDefault(); return applyEdit(); }
    // Dans un champ, Cmd+Z annule la saisie : c'est le comportement natif attendu.
    if (mod && k === "z" && !typing) { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && k === "y" && !typing) { e.preventDefault(); return redo(); }
    if (mod && (k === "s" || k === "e")) { e.preventDefault(); return exportPdf(); }
    if (mod && (e.key === "+" || e.key === "=")) { e.preventDefault(); return zoomCentered(S.zoom * 1.25); }
    if (mod && e.key === "-") { e.preventDefault(); return zoomCentered(S.zoom / 1.25); }
    if (mod && e.key === "0") { e.preventDefault(); return zoomCentered(1); }
    if (mod && !e.shiftKey && (k === "r" || k === "l")) { e.preventDefault(); return rotatePage(S.page, k === "r" ? 90 : -90); }
    if (mod || typing || e.altKey) return;
    if ((e.key === "Delete" || e.key === "Backspace") && objects.current()) { e.preventDefault(); return objects.removeSelected(); }
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); stepPage(1); }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); stepPage(-1); }
  });
}

function boot() {
  document.body.classList.add("is-welcome");
  $("fontSel").innerHTML = FAMILIES.map((f) => `<option value="${f.family}">${esc(f.label)}</option>`).join("");

  // Info-bulles avec le raccourci du systeme (Cmd sur Apple, Ctrl ailleurs).
  const tips = {
    pagesBtn: "Pages", undoBtn: `Annuler (${shortcut("Mod+Z")})`, redoBtn: `Rétablir (${shortcut("Maj+Mod+Z")})`,
    exportBtn: `Exporter le PDF (${shortcut("Mod+S")})`, zoomIn: `Agrandir (${shortcut("Mod++")})`,
    zoomOut: `Réduire (${shortcut("Mod+-")})`, zoomLabel: `Ajuster à la largeur (${shortcut("Mod+0")})`,
    prevPage: "Page précédente (←)", nextPage: "Page suivante (→)",
  };
  for (const [id, t] of Object.entries(tips)) $(id).title = t;
  const toolTips = { select: "Modifier le texte", erase: "Gomme", add: "Ajouter du texte", mark: "Annoter", sign: "Signer", image: "Image" };
  document.querySelectorAll(".tb-btn[data-tool]").forEach((b) => (b.title = toolTips[b.dataset.tool]));

  $("picker").onchange = (e) => { openFile(e.target.files[0]); e.target.value = ""; };
  $("editor").onsubmit = (e) => { e.preventDefault(); applyEdit(); };
  $("doneBtn").onclick = () => applyEdit({ close: true });
  $("cancelBtn").onclick = clearSelection;
  $("closeBtn").onclick = clearSelection;
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("exportBtn").onclick = () => exportPdf();
  $("boldBtn").onclick = () => setPressed($("boldBtn"), !isPressed($("boldBtn")));
  $("italBtn").onclick = () => setPressed($("italBtn"), !isPressed($("italBtn")));
  $("sizeUp").onclick = () => stepSize(0.5);
  $("sizeDown").onclick = () => stepSize(-0.5);
  $("sizeIn").onblur = () => ($("sizeIn").value = NUM.format(readSize(12)));
  $("txt").oninput = autosize;
  document.querySelectorAll("[data-align]").forEach((b) => (b.onclick = () => setAlign(b.dataset.align)));
  document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => pickTool(b.dataset.tool)));
  $("hintAlt").onclick = redrawSignature;
  $("hintDone").onclick = () => setTool("select");
  $("pagesBtn").onclick = () => setSidebar(!sidebarOpen());
  $("scrim").onclick = () => setSidebar(false);
  $("zoomIn").onclick = () => zoomCentered(S.zoom * 1.25);
  $("zoomOut").onclick = () => zoomCentered(S.zoom / 1.25);
  $("zoomLabel").onclick = () => zoomCentered(1);
  $("prevPage").onclick = () => stepPage(-1);
  $("nextPage").onclick = () => stepPage(1);
  // Les objets poses passent avant le texte quand le toucher tombe sur eux (leur trait,
  // leurs lignes) : la phase de capture les sert avant les zones de texte.
  $("overlay").addEventListener("click", (e) => {
    if (S.tool !== "select" || swallowNextClick || !S.doc) return;
    const p = toLocal(e.clientX, e.clientY), k = scale();
    const op = objects.hitTest({ x: p.x / k, y: p.y / k }, 10 / k);
    if (!op) return;
    e.stopPropagation();
    objects.select(op, { x: p.x / k, y: p.y / k });
  }, true);
  $("overlay").onclick = () => {
    if (swallowNextClick) { swallowNextClick = false; return; }
    clearSelection();
  };
  $("menu").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...$("menu").querySelectorAll("button:not(:disabled)")];
    const i = all.indexOf(document.activeElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1 + (i < 0 ? 1 : 0))) % all.length]?.focus();
  });
  $("menuLayer").addEventListener("pointerdown", (e) => { if (e.target === $("menuLayer")) closeMenu(); });
  $("menuLayer").addEventListener("contextmenu", (e) => { e.preventDefault(); closeMenu(); });
  window.addEventListener("blur", closeMenu);

  window.addEventListener("beforeunload", (e) => {
    if (S.doc && isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

  // Recalage sur la largeur disponible : fenetre redimensionnee, panneau replie,
  // rotation de l'ecran. La hauteur seule (clavier qui s'ouvre) ne declenche rien.
  let lastW = 0, fitTimer = null;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (!S.doc || !S.size || w === lastW) { lastW = w; return; }
    lastW = w;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(async () => { S.baseScale = fitScale(); layout(); await renderPage(); }, 140);
  }).observe($("canvasWrap"));
  WIDE.addEventListener("change", () => {
    if (!S.doc) return;
    $("pageList").classList.remove("open");
    $("scrim").hidden = true;
    document.body.classList.remove("no-sidebar");
    setSidebar(WIDE.matches);
  });
  FINE.addEventListener("change", () => S.doc && describePage());

  initDrop();
  initShortcuts();
  initMarquee();
  initObjects();
  initGestures();
  // Safari zoomerait toute l'interface sur un pincement hors de la page (barres, feuille).
  for (const t of ["gesturestart", "gesturechange"]) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  initSheetDrag();
  initKeyboardInset();
  native.onOpenDocument(openFile);
  window.__ready = true;
}

boot();
export { S, openFile, loadPage, applyEdit, setTool, exportPdf, undo, redo, rotatePage, removePage };
