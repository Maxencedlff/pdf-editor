/* Interface de la version locale. Calquee sur web/js/ui.js (meme design, memes gestes,
   memes raccourcis) ; seul le moteur change : les analyses, retouches et exports passent
   par le serveur local (static/api.js) au lieu de tourner dans le navigateur.

   Coordonnees en points PDF ; les zones de texte sont placees en pourcentage de la page,
   elles suivent donc le zoom sans etre recalculees.

   Organisation :
   - etat (S) et petits utilitaires d'affichage (bandeau, HUD, alerte, menu) ;
   - document : ouverture, rendu, rotation, zoom ;
   - edition : selection, inspecteur, historique annuler / retablir ;
   - pages : miniatures, menu de page, relecture ;
   - export ;
   - gestes et raccourcis. */

import { LocalDoc, loadConfig, fetchLocalFile } from "./api.js";

const $ = (id) => document.getElementById(id);
const IS_APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const FINE = matchMedia("(pointer: fine)");
const WIDE = matchMedia("(min-width: 1000px)");
const SHORT = matchMedia("(max-height: 520px) and (orientation: landscape) and (max-width: 999px)");
const NUM = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const NNBSP = " ";                       // espace fine insecable, avant % et :
const MIN_ZOOM = 0.5, MAX_ZOOM = 5;
/* Plafond de pixels du rendu : au-dela, Safari sur iPhone refuse le canvas (16,7 Mpx) et
   la memoire grimpe sans gain visible. */
const MAX_PIXELS = 12e6;
const INK_PRESETS = ["#111111", "#3a3a3c", "#1d3c8f", "#b3261e", "#1e6b35"];
const LOW_SCORE = 0.38;                  // en dessous, police OCR a verifier
const BOXES_KEY = "editeur-pdf.zones";   // preference « Afficher les zones »

const S = {
  doc: null, page: 0, zoom: 1, baseScale: 1, tool: "select",
  analysis: null, sel: null, draft: null, busy: false, size: null,
  fonts: [],               // catalogue du serveur (/api/config)
  edits: new Map(),        // id de zone -> { op, uid } en vigueur
  past: [], future: [],    // historique annuler / retablir
  cleanAt: 0,              // longueur de l'historique au dernier export
  turn: new Map(),         // angle affiche par page, cumule pour animer dans le bon sens
  color: "#111111", origin: null,
  loadToken: 0, renderSeq: 0,
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
const visiblePages = () => (S.doc ? [...Array(S.doc.pageCount).keys()].filter((i) => !S.doc.removed.has(i)) : []);
const isDirty = () => S.past.length !== S.cleanAt;
const isSheet = () => !WIDE.matches && !SHORT.matches;
const point = () => (FINE.matches ? "Cliquez" : "Touchez");
const isLow = (it) => it.source === "ocr" && (it.font_score ?? 1) < LOW_SCORE;
/** Messages du serveur ecrits sans accents (code) : on retablit les plus courants. */
const frMessage = (m) => String(m || "").replace(/\bprotege\b/g, "protégé").replace(/\bderniere\b/g, "dernière")
  .replace(/\bexpire\b/g, "expiré").replace(/\bOperation\b/g, "Opération").replace(/'/g, "’");

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
const fail = (e, prefix = "") => { console.error(e); toast(prefix + frMessage(e.message), true); };

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

/* ================================================================ polices */
/* Le serveur decrit chaque fichier (famille + graisse + italique). Le menu ne montre que les
   familles ; Gras et Italique choisissent ensuite la variante. */
const families = () => S.fonts.filter((f) => !f.bold && !f.italic);
const entryOf = (key) => S.fonts.find((f) => f.key === key) || families()[0];
const familyOf = (key) => entryOf(key)?.family;
const variantKey = (family, bold, italic) =>
  (S.fonts.find((f) => f.family === family && f.bold === bold && f.italic === italic) ||
   families().find((f) => f.family === family) || families()[0]).key;
const cleanLabel = (label) => label.replace(/etroit/g, "étroit");
const fontLabel = (key) => cleanLabel(families().find((f) => f.family === familyOf(key))?.label || key || "");
const defaultKey = () => (S.fonts.find((f) => f.key === "LiberationSans-Regular") || families()[0])?.key;

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
    const doc = await LocalDoc.open(file);
    Object.assign(S, {
      doc, page: 0, zoom: 1, analysis: null, sel: null, draft: null,
      edits: new Map(), past: [], future: [], cleanAt: 0, turn: new Map(),
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
    fail(e, "Impossible d’ouvrir ce document : ");
  } finally { veil(false); }
}

/** Ouverture directe : /?file=<chemin local du PDF>, chemin Windows ou WSL. */
async function openFromUrl() {
  const path = new URLSearchParams(location.search).get("file");
  if (!path) return;
  try {
    await openFile(await fetchLocalFile(path));
  } catch (e) {
    fail(e, `Impossible d’ouvrir « ${path.split(/[\\/]/).pop()} » : `);
  }
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
  S.size = S.doc.pageSize(idx);
  S.baseScale = fitScale();
  layout();
  $("canvasWrap").scrollTo(0, 0);
  updatePager();
  markThumb();

  const known = S.doc.analyses.has(idx);
  if (!known) {
    S.analysis = null;
    renderOverlay();
    veil(true, "Lecture de la page…");
  }
  try {
    // Rendu et analyse en parallele : sur un scan, l'OCR est le plus long des deux.
    const [, res] = await Promise.all([renderPage(), S.doc.analyze(idx)]);
    if (token !== S.loadToken) return;
    S.analysis = res;
  } catch (e) {
    if (token === S.loadToken) { fail(e); S.analysis = null; }
  } finally { if (token === S.loadToken) veil(false); }
  if (token !== S.loadToken) return;
  renderOverlay();
  describePage();
}

/** Dessine la page courante. Le serveur livre l'image deja pivotee ; on la remet droite
    dans le canvas, la rotation etant affichee (et animee) par CSS comme dans la version
    web, ce qui garde les zones de texte alignees sur leurs coordonnees d'origine. */
async function renderPage() {
  const token = S.loadToken, seq = ++S.renderSeq, idx = S.page, k = scale();
  let dpi = 72 * k * Math.min(2, window.devicePixelRatio || 1);
  const area = (S.size.width * dpi / 72) * (S.size.height * dpi / 72);
  if (area > MAX_PIXELS) dpi *= Math.sqrt(MAX_PIXELS / area);
  const rot = rotation(idx);
  const bmp = await S.doc.renderPage(idx, dpi);
  // Un rendu plus recent (zoom, retouche, autre page) a deja pris la place : on jette.
  if (token !== S.loadToken || seq !== S.renderSeq || rot !== rotation(idx)) { bmp.close?.(); return; }
  const turned = rot % 180 !== 0;
  const target = $("pageCanvas");
  target.width = turned ? bmp.height : bmp.width;
  target.height = turned ? bmp.width : bmp.height;
  const ctx = target.getContext("2d");
  ctx.save();
  ctx.translate(target.width / 2, target.height / 2);
  ctx.rotate((-rot * Math.PI) / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  ctx.restore();
  bmp.close?.();
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
    if (isLow(it)) el.classList.add("low");
    if (S.sel?.id === it.id) el.classList.add("on");
    el.style.cssText =
      `left:${(it.bbox[0] / W) * 100}%;top:${(it.bbox[1] / H) * 100}%;` +
      `width:${((it.bbox[2] - it.bbox[0]) / W) * 100}%;height:${((it.bbox[3] - it.bbox[1]) / H) * 100}%`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `Modifier « ${it.text} »`);
    el.title = it.text;
    el.onclick = (e) => { e.stopPropagation(); selectItem(it, el); };
    el.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectItem(it, el); }
    };
    ov.appendChild(el);
  }
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
    if (a.mode === "scan" && a.native_dpi) rows.push(["Résolution du scan", `${Math.round(a.native_dpi)}${NNBSP}ppp`]);
  }
  rows.push(["Retouches", edits ? String(edits) : "Aucune"]);
  if (rotation()) rows.push(["Rotation", `${rotation()}°`]);
  $("pageInfo").innerHTML = rows.map(([k, v]) =>
    `<div class="row"><span class="row-label">${k}</span><span class="row-value"><span>${esc(v)}</span></span></div>`).join("");

  let foot = "";
  if (!a) foot = "";
  else if (!a.items.length) foot = "Aucun texte reconnu. La gomme, l’ajout de texte et l’image restent disponibles.";
  else if (a.mode === "scan") foot = "Le texte a été reconnu sur l’image. Police, encre et papier sont mesurés pour que la retouche se fonde dans le document.";
  else foot = "Le texte provient du PDF. Il est réécrit en vectoriel avec la police d’origine.";
  if (a?.items.some(isLow)) {
    foot += `<br><br><span class="legend"></span>Police incertaine : vérifiez le résultat.`;
  }
  $("pageFoot").innerHTML = foot;
  $("pageFoot").hidden = !foot;
  $("emptyHint").textContent = `${point()} sur un texte de la page pour le modifier.`;

  // Relecture dans l'autre regime : utile quand un scan porte une couche de texte
  // invisible de mauvaise qualite, ou qu'une page native a ete mal decoupee.
  const relire = $("relireBtn");
  relire.disabled = !a;
  relire.textContent = a?.mode === "scan" ? "Relire la page en texte natif" : "Relire la page en OCR";
  $("actionsFoot").textContent = a?.mode === "scan"
    ? "Utilise le texte enregistré dans le PDF plutôt que la reconnaissance sur l’image."
    : "Reconnaît le texte sur l’image de la page, comme pour un document numérisé.";
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

/** Relit la page courante dans l'autre regime (OCR ou texte natif). */
async function reanalyze(force) {
  if (!S.doc || S.busy || !S.analysis) return;
  force ||= S.analysis.mode === "scan" ? "native" : "ocr";
  const token = S.loadToken;
  S.busy = true;
  veil(true, force === "ocr" ? "Reconnaissance du texte…" : "Lecture du texte natif…");
  try {
    const a = await S.doc.analyze(S.page, force);
    if (token !== S.loadToken) return;
    S.analysis = a;
    clearSelection();
    renderOverlay();
    describePage();
    const n = a.items.length;
    toast(n ? `${plural(n, "zone")} de texte reconnue${n > 1 ? "s" : ""}` : "Aucun texte reconnu");
  } catch (e) {
    fail(e);
  } finally { S.busy = false; veil(false); }
}

/* ================================================================ selection */
function clearSelection() {
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
  fillEditor(item);
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
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top")) || 44;
    const visibleTop = r.top - (wrap.getBoundingClientRect().top + 60);
    const limit = window.innerHeight - sheetH - 24;
    if (r.bottom > limit) wrap.scrollBy({ top: r.bottom - limit + 16, behavior: "smooth" });
    else if (visibleTop < top) wrap.scrollBy({ top: visibleTop - top, behavior: "smooth" });
  });
}

/** Etat affiche d'une zone : celui de la retouche en vigueur s'il y en a une, sinon celui
    mesure a l'analyse. Rouvrir une zone deja retouchee montre donc ses vrais reglages. */
function currentState(it) {
  const op = it.source === "new" ? null : S.edits.get(it.id)?.op;
  if (!op) return it;
  const { text, size, color, font_key, bold, italic, align } = op;
  return { ...it, text, size, color, font_key, bold, italic, align };
}

function fillEditor(it) {
  const isNew = it.source === "new";
  const v = currentState(it);
  $("inspectorEmpty").hidden = true;
  $("editor").hidden = false;
  $("inspector").classList.add("open");
  $("editorTitle").textContent = isNew ? "Nouveau texte" : "Modifier le texte";
  $("doneBtn").textContent = isNew ? "Ajouter" : "OK";
  $("applyBtn").textContent = isNew ? "Ajouter" : "Appliquer";
  $("txt").value = v.text || "";
  $("txt").placeholder = isNew ? "Saisissez le texte" : "";
  autosize();
  $("sizeIn").value = NUM.format(Math.round((v.size ?? 12) * 10) / 10);
  $("fontSel").value = familyOf(v.font_key || defaultKey());
  setPressed($("boldBtn"), !!v.bold);
  setPressed($("italBtn"), !!v.italic);
  setAlign(v.align || "left");
  // La pastille « couleur d'origine » garde la couleur mesuree, meme apres retouche.
  S.origin = it.color && (!isNew || it.color.toLowerCase() !== "#111111") ? it.color : null;
  S.color = v.color || "#111111";
  buildSwatches();
  $("analysis").innerHTML = isNew ? "" : analysisHtml(it);
}

function analysisHtml(it) {
  const swatch = (hex) => `<i class="dot" style="background:${esc(hex)}"></i><span>${esc(hex.toUpperCase())}</span>`;
  const rows = [];
  let foot;
  if (it.source === "ocr") {
    // Seuils cales sur de vrais scans : au-dela de 0.55 la police retenue est visuellement
    // juste, en dessous de 0.38 elle merite un coup d'oeil.
    const s = it.font_score ?? 0;
    const badge = s >= 0.55 ? '<span class="badge good">Fiable</span>'
                : s >= LOW_SCORE ? '<span class="badge mid">Approchée</span>'
                                 : '<span class="badge mid">À vérifier</span>';
    rows.push(
      ["Police reconnue", `<span>${esc(fontLabel(it.font_key))}</span>`],
      ["Concordance", `${badge}<span>${Math.round(s * 100)}${NNBSP}%</span>`],
      ["Encre", swatch(it.color)],
      ["Papier", swatch(it.paper)],
      ["Taille mesurée", `<span>${pt(it.size)}</span>`],
    );
    if (it.conf) rows.push(["Lecture du texte", `<span>${Math.round(it.conf)}${NNBSP}%</span>`]);
    foot = "Mesures prises sur l’image de la page numérisée.";
  } else {
    // Texte vectoriel : la police du PDF est connue, inutile de parler de concordance.
    const pdfFont = (it.pdf_font || "").split("+").pop();
    if (pdfFont) rows.push(["Police du PDF", `<span>${esc(pdfFont)}</span>`]);
    rows.push(
      ["Police de secours", `<span>${esc(fontLabel(it.font_key))}</span>`],
      ["Encre", swatch(it.color)],
      ["Taille", `<span>${pt(it.size)}</span>`],
    );
    foot = "Texte réécrit en vectoriel avec la police d’origine. Si elle ne contient pas un caractère saisi, ou si vous changez de police, la police de secours prend le relais.";
  }
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
  const bold = isPressed($("boldBtn")), italic = isPressed($("italBtn"));
  const common = {
    page: S.page,
    text: $("txt").value,
    size: readSize(base.size || 12),
    color: S.color,
    font_key: variantKey($("fontSel").value, bold, italic),
    bold, italic,
    align: currentAlign(),
  };

  const prev = !isNew ? S.edits.get(base.id) || null : null;
  // Rien de change : on ne fabrique pas de retouche, qui re-dessinerait le texte a
  // l'identique et laisserait une trace dans l'historique.
  const ref = prev?.op || base;
  const unchanged = !isNew && common.text === (ref.text ?? base.text) && Math.abs(common.size - (ref.size ?? 12)) < 0.05 &&
    familyOf(common.font_key) === familyOf(ref.font_key) && common.bold === !!ref.bold &&
    common.italic === !!ref.italic && common.color.toLowerCase() === (ref.color || "").toLowerCase() &&
    common.align === (ref.align || "left");
  if (unchanged || (isNew && !common.text.trim())) {
    if (close || isNew) clearSelection();
    return;
  }

  const op = isNew
    ? { type: "add_text", bbox: base.bbox, ...common }
    : {
        type: "text", item_id: base.id, bbox: base.bbox, paper: base.paper,
        // Texture du scan : le texte redessine doit subir le meme flou et le meme grain.
        tracking: base.tracking || 0, blur: base.blur || 0, grain: base.grain || 0,
        left: base.ink_left ?? base.left ?? base.bbox[0], top: base.ink_top, baseline: base.baseline,
        // Police changee : le serveur abandonne la police embarquee du PDF.
        font_key_changed: common.font_key !== base.font_key,
        ...common,
      };

  S.busy = true;
  $("applyBtn").disabled = $("doneBtn").disabled = true;
  veil(true, "Application…");
  try {
    if (prev) await S.doc.deleteOp(prev.uid);
    const cur = { op, uid: await S.doc.addOp(op) };
    if (!isNew) S.edits.set(base.id, cur);
    record({ type: "op", page: S.page, cur, replaced: prev, itemId: isNew ? null : base.id, prevText: base.text, nextText: op.text });
    if (!isNew) base.text = op.text;
    await refreshCurrent();
    if (close || isNew) clearSelection();
  } catch (e) {
    fail(e);
  } finally {
    S.busy = false;
    veil(false);
    $("applyBtn").disabled = $("doneBtn").disabled = false;
  }
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
   rotation ou suppression de page. Annuler la deplace vers `future`, Retablir la rejoue.
   Le serveur ne sait que supprimer une operation : retablir la renvoie a l'identique, et
   elle recoit un nouvel uid (les objets `cur` / `replaced` sont partages avec S.edits,
   la mise a jour de l'uid y est donc visible aussitot). */
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
  const e = from[from.length - 1];
  S.busy = true;
  veil(true, forward ? "Rétablissement…" : "Annulation…");
  try {
    if (e.type === "op") {
      const doc = S.doc, item = e.itemId ? doc.findItem(e.page, e.itemId) : null;
      if (forward) {
        if (e.replaced) await doc.deleteOp(e.replaced.uid);
        e.cur.uid = await doc.addOp(e.cur.op);
        if (e.itemId) S.edits.set(e.itemId, e.cur);
        if (item) item.text = e.nextText;
      } else {
        await doc.deleteOp(e.cur.uid);
        if (e.replaced) e.replaced.uid = await doc.addOp(e.replaced.op);
        if (e.itemId) e.replaced ? S.edits.set(e.itemId, e.replaced) : S.edits.delete(e.itemId);
        if (item) item.text = e.prevText;
      }
      from.pop(); to.push(e);
      S.busy = false;
      if (e.page !== S.page) await loadPage(e.page);
      else { clearSelection(); await refreshCurrent(); }
    } else if (e.type === "rotate") {
      const delta = forward ? e.delta : -e.delta;
      await S.doc.rotate(e.page, delta);
      from.pop(); to.push(e);
      S.busy = false;
      if (e.page !== S.page) await loadPage(e.page);
      applyRotation(e.page, delta);
    } else if (e.type === "remove") {
      S.busy = false;
      if (forward) await hidePage(e.page);
      else await showPage(e.page);
      from.pop(); to.push(e);
    }
  } catch (err) {
    fail(err);
  } finally {
    S.busy = false;
    veil(false);
    updateHistory();
  }
}

/* ================================================================ outils de zone */
const HINTS = {
  erase: "Faites glisser sur la zone à effacer.",
  add: "Tracez le cadre du nouveau texte.",
  image: "Tracez l’emplacement de l’image.",
};

function setTool(name) {
  S.tool = name;
  document.querySelectorAll("[data-tool]").forEach((b) => setPressed(b, b.dataset.tool === name));
  $("canvas").classList.remove("tool-erase", "tool-add", "tool-image");
  if (name !== "select") { $("canvas").classList.add("tool-" + name); clearSelection(); }
  $("hint").hidden = name === "select";
  $("hintText").textContent = HINTS[name] || "";
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
    if (S.tool === "select" || (e.pointerType === "mouse" && e.button !== 0)) return;
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
    if (box[2] - box[0] < 8 || box[3] - box[1] < 8) return;
    // Un trace se termine par un evenement `click` : sans ce garde-fou, il
    // deselectionnerait aussitot le bloc que le trace vient de creer.
    swallowNextClick = true;
    setTimeout(() => (swallowNextClick = false), 400);
    const k = scale();
    const bbox = box.map((v) => v / k);
    if (S.tool === "erase") await eraseZone(bbox);
    else if (S.tool === "add") newTextBlock(bbox);
    else if (S.tool === "image") insertImage(bbox);
  });
}

/** Ajoute une operation de zone (gomme, image) et l'inscrit dans l'historique. */
async function addZoneOp(op, label) {
  if (S.busy) return;
  S.busy = true;
  veil(true, label);
  try {
    const cur = { op, uid: await S.doc.addOp(op) };
    record({ type: "op", page: op.page, cur, replaced: null, itemId: null });
    await refreshCurrent();
  } catch (e) {
    fail(e);
  } finally { S.busy = false; veil(false); }
}

const eraseZone = (bbox) => addZoneOp({ type: "erase", page: S.page, bbox, mode: "smart" }, "Effacement…");

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
    color: near?.color || "#111111",
    // Famille du voisin, en romain : Gras et Italique restent des choix explicites.
    font_key: near ? variantKey(familyOf(near.font_key), false, false) : defaultKey(),
    bold: false, italic: false,
  };
  fillEditor(S.draft);
  drawDraft();
  if (isSheet()) $("canvasWrap").style.paddingBottom = $("inspector").offsetHeight + 24 + "px";
  setTimeout(() => $("txt").focus(), isSheet() ? 320 : 0);
}

function insertImage(bbox) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    let data, bitmap;
    try {
      [data, bitmap] = await Promise.all([
        new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(f);
        }),
        createImageBitmap(f),
      ]);
    } catch (e) { console.error(e); return toast("Cette image ne peut pas être lue.", true); }
    // L'image tient dans le cadre trace, proportions conservees, centree.
    const bw = bbox[2] - bbox[0], bh = bbox[3] - bbox[1];
    const k = Math.min(bw / bitmap.width, bh / bitmap.height);
    const w = bitmap.width * k, h = bitmap.height * k;
    const x = bbox[0] + (bw - w) / 2, y = bbox[1] + (bh - h) / 2;
    bitmap.close?.();
    await addZoneOp({ type: "image", page: S.page, bbox: [x, y, x + w, y + h], data, keep_ratio: true }, "Insertion de l’image…");
  };
  inp.click();
  setTool("select");
}

/* ================================================================ pages */
let thumbObserver = null;
let thumbQueue = Promise.resolve();

function buildThumbs() {
  const list = $("pageList");
  list.innerHTML = "";
  thumbObserver?.disconnect();
  // Les miniatures ne sont dessinees qu'a l'approche de l'ecran : un document de cent
  // pages s'ouvre aussi vite qu'un document d'une page.
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting && !en.target.dataset.drawn) refreshThumb(+en.target.dataset.index);
    }
  }, { root: list, rootMargin: "400px 0px" });

  for (let i = 0; i < S.doc.pageCount; i++) {
    const d = document.createElement("div");
    d.className = "thumb";
    d.dataset.index = i;
    d.innerHTML = `<div class="sheet"><canvas width="112" height="150"></canvas>
      <button type="button" class="more" aria-label="Options de la page"><svg class="sym"><use href="#i-dots"/></svg></button></div>
      <span class="num"></span>`;
    d.onclick = (ev) => {
      if (ev.target.closest(".more")) { ev.stopPropagation(); pageMenu(i, ev.target.closest(".more")); return; }
      if (!WIDE.matches) setSidebar(false);
      if (i !== S.page) loadPage(i);
    };
    d.oncontextmenu = (ev) => { ev.preventDefault(); pageMenu(i, { x: ev.clientX, y: ev.clientY }); };
    longPress(d, (x, y) => pageMenu(i, { x, y }));
    list.appendChild(d);
    thumbObserver.observe(d);
  }
  numberThumbs();
  markThumb();
}

function numberThumbs() {
  const vis = visiblePages();
  [...$("pageList").children].forEach((el, i) => {
    const n = vis.indexOf(i) + 1;
    el.querySelector(".num").textContent = n || "";
    el.querySelector(".more").setAttribute("aria-label", `Options de la page ${n}`);
    el.setAttribute("aria-label", `Page ${n}`);
  });
}

/** Les miniatures passent une par une : le serveur rend aussi la page affichee, inutile
    de l'encombrer de dix requetes simultanees. */
function refreshThumb(i) {
  thumbQueue = thumbQueue.then(() => drawThumb(i)).catch((e) => console.warn("miniature", i, e));
  return thumbQueue;
}

async function drawThumb(i) {
  const el = $("pageList").children[i];
  if (!el || el.hidden || !S.doc) return;
  const size = S.doc.pageSize(i);
  const px = 112 * Math.min(2, window.devicePixelRatio || 1);
  // Le serveur livre la miniature deja pivotee : on la dessine telle quelle.
  const src = await S.doc.renderPage(i, (72 * px) / Math.max(size.width, size.height * 0.75));
  const target = el.querySelector("canvas");
  target.width = src.width;
  target.height = src.height;
  target.getContext("2d").drawImage(src, 0, 0);
  src.close?.();
  el.dataset.drawn = "1";
}

function markThumb() {
  [...$("pageList").children].forEach((c, i) => {
    const on = i === S.page;
    c.classList.toggle("on", on);
    c.setAttribute("aria-current", on ? "page" : "false");
    if (on) c.scrollIntoView({ block: "nearest" });
  });
}

function pageMenu(i, at) {
  const lastOne = visiblePages().length <= 1;
  const items = [
    { label: "Pivoter à gauche", icon: "i-rot-l", run: () => rotatePage(i, -90) },
    { label: "Pivoter à droite", icon: "i-rot-r", run: () => rotatePage(i, 90) },
  ];
  // Relecture : seulement pour la page affichee, dont on connait le regime d'analyse.
  if (i === S.page && S.analysis) {
    items.push({
      label: S.analysis.mode === "scan" ? "Relire en texte natif" : "Relire en OCR",
      icon: "i-wand", run: () => reanalyze(),
    });
  }
  items.push("-", { label: "Supprimer la page", icon: "i-trash", danger: true, disabled: lastOne, run: () => removePage(i) });
  openMenu(items, at);
}

async function rotatePage(i, delta) {
  if (S.busy || !S.doc) return;
  S.busy = true;
  try {
    await S.doc.rotate(i, delta);
    record({ type: "rotate", page: i, delta });
  } catch (e) { S.busy = false; return fail(e); }
  S.busy = false;
  if (i !== S.page) await loadPage(i);
  applyRotation(i, delta);
}

/** Affiche une rotation deja enregistree par le serveur : la page tourne en CSS (dans le
    sens du geste), puis est redessinee nette a sa nouvelle echelle. */
function applyRotation(i, delta) {
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
  if (visiblePages().length <= 1 || S.busy) return;
  try {
    await hidePage(i);
  } catch (e) { return fail(e); }
  record({ type: "remove", page: i });
  toast(`Page supprimée. ${shortcut("Mod+Z")} pour annuler.`);
}

async function hidePage(i) {
  const vis = visiblePages();
  const pos = vis.indexOf(i);
  await S.doc.remove(i);
  const el = $("pageList").children[i];
  el.classList.add("leaving");
  setTimeout(() => { if (S.doc.removed.has(i)) el.hidden = true; }, 250);
  numberThumbs();
  updateTitle();
  if (i === S.page) await loadPage(vis[pos + 1] ?? vis[pos - 1]);
  else updatePager();
}

async function showPage(i) {
  await S.doc.restore(i);
  const el = $("pageList").children[i];
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
async function exportPdf() {
  if (!S.doc || S.busy) return;
  S.busy = true;
  veil(true, "Préparation du PDF…");
  let file;
  try {
    const blob = await S.doc.export();
    const name = S.doc.name.replace(/\.pdf$/i, "") + (S.past.length ? " (modifié)" : "") + ".pdf";
    file = new File([blob], name, { type: "application/pdf" });
  } catch (e) {
    return fail(e, "L’export a échoué : ");
  } finally { S.busy = false; veil(false); }

  // Au doigt, la feuille de partage du systeme (Enregistrer dans Fichiers, Mail…) ; a la
  // souris, un telechargement classique.
  if (!FINE.matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      S.cleanAt = S.past.length; updateTitle();
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
        try { await navigator.share({ files: [file], title: file.name }); S.cleanAt = S.past.length; updateTitle(); return; }
        catch (e2) { if (e2.name === "AbortError") return; }
      }
    }
  }
  download(file);
  S.cleanAt = S.past.length;
  updateTitle();
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
  // Le rendu passe par le serveur : on attend un peu meme hors geste, pour qu'une rafale
  // de clics sur « Agrandir » ne declenche qu'un seul rendu.
  zoomAround._t = setTimeout(() => renderPage().catch((e) => console.warn(e)), live ? 220 : 60);
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

  wrap.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 2 || !S.doc) return;
    pinching = true;
    startDist = dist(e.touches);
    startZoom = S.zoom;
    e.preventDefault();
  }, { passive: false });
  wrap.addEventListener("touchmove", (e) => {
    if (!pinching || e.touches.length !== 2) return;
    const m = mid(e.touches);
    zoomAround(startZoom * (dist(e.touches) / (startDist || 1)), m.x, m.y, true);
    e.preventDefault();
  }, { passive: false });
  const endPinch = (e) => { if (pinching && e.touches.length < 2) { pinching = false; lastTap = 0; } };
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

/** Appui long au doigt : ouvre le menu contextuel, comme sur iOS. */
function longPress(el, fn) {
  let t = null, x = 0, y = 0;
  el.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    x = e.touches[0].clientX; y = e.touches[0].clientY;
    t = setTimeout(() => { t = null; navigator.vibrate?.(8); fn(x, y); }, 480);
  }, { passive: true });
  const stop = () => { clearTimeout(t); t = null; };
  el.addEventListener("touchmove", (e) => {
    if (Math.hypot(e.touches[0].clientX - x, e.touches[0].clientY - y) > 8) stop();
  }, { passive: true });
  el.addEventListener("touchend", (e) => { if (t === null && !e.target.closest(".more")) e.preventDefault(); stop(); });
  el.addEventListener("touchcancel", stop);
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
      if (S.tool !== "select") return setTool("select");
      if (S.sel || S.draft) return clearSelection();
      if (!WIDE.matches && sidebarOpen()) return setSidebar(false);
      return;
    }
    if (mod && k === "o") { e.preventDefault(); return $("picker").click(); }
    if (!S.doc) return;

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
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); stepPage(1); }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); stepPage(-1); }
  });
}

/** Interrupteur « Afficher les zones », memorise pour ce navigateur. */
function initBoxesSwitch() {
  const sw = $("showBoxes");
  let on = false;
  try { on = localStorage.getItem(BOXES_KEY) === "1"; } catch (_) { /* stockage indisponible */ }
  sw.checked = on;
  $("overlay").classList.toggle("show", on);
  sw.onchange = () => {
    $("overlay").classList.toggle("show", sw.checked);
    try { localStorage.setItem(BOXES_KEY, sw.checked ? "1" : "0"); } catch (_) { /* idem */ }
  };
}

async function boot() {
  document.body.classList.add("is-welcome");

  // Info-bulles avec le raccourci du systeme (Cmd sur Apple, Ctrl ailleurs).
  const tips = {
    pagesBtn: "Pages", undoBtn: `Annuler (${shortcut("Mod+Z")})`, redoBtn: `Rétablir (${shortcut("Maj+Mod+Z")})`,
    exportBtn: `Exporter le PDF (${shortcut("Mod+S")})`, zoomIn: `Agrandir (${shortcut("Mod++")})`,
    zoomOut: `Réduire (${shortcut("Mod+-")})`, zoomLabel: `Ajuster à la largeur (${shortcut("Mod+0")})`,
    prevPage: "Page précédente (←)", nextPage: "Page suivante (→)",
  };
  for (const [id, t] of Object.entries(tips)) $(id).title = t;
  const toolTips = { select: "Modifier le texte", erase: "Gomme", add: "Ajouter du texte", image: "Image ou signature" };
  document.querySelectorAll(".tb-btn[data-tool]").forEach((b) => (b.title = toolTips[b.dataset.tool]));

  $("picker").onchange = (e) => { openFile(e.target.files[0]); e.target.value = ""; };
  $("editor").onsubmit = (e) => { e.preventDefault(); applyEdit(); };
  $("doneBtn").onclick = () => applyEdit({ close: true });
  $("cancelBtn").onclick = clearSelection;
  $("closeBtn").onclick = clearSelection;
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("exportBtn").onclick = exportPdf;
  $("relireBtn").onclick = () => reanalyze();
  $("boldBtn").onclick = () => setPressed($("boldBtn"), !isPressed($("boldBtn")));
  $("italBtn").onclick = () => setPressed($("italBtn"), !isPressed($("italBtn")));
  $("sizeUp").onclick = () => stepSize(0.5);
  $("sizeDown").onclick = () => stepSize(-0.5);
  $("sizeIn").onblur = () => ($("sizeIn").value = NUM.format(readSize(12)));
  $("txt").oninput = autosize;
  document.querySelectorAll("[data-align]").forEach((b) => (b.onclick = () => setAlign(b.dataset.align)));
  document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(S.tool === b.dataset.tool && b.dataset.tool !== "select" ? "select" : b.dataset.tool)));
  $("hintDone").onclick = () => setTool("select");
  $("pagesBtn").onclick = () => setSidebar(!sidebarOpen());
  $("scrim").onclick = () => setSidebar(false);
  $("zoomIn").onclick = () => zoomCentered(S.zoom * 1.25);
  $("zoomOut").onclick = () => zoomCentered(S.zoom / 1.25);
  $("zoomLabel").onclick = () => zoomCentered(1);
  $("prevPage").onclick = () => stepPage(-1);
  $("nextPage").onclick = () => stepPage(1);
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
    fitTimer = setTimeout(async () => { S.baseScale = fitScale(); layout(); await renderPage().catch(console.warn); }, 140);
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
  initGestures();
  initSheetDrag();
  initKeyboardInset();
  initBoxesSwitch();

  try {
    S.fonts = (await loadConfig()).fonts;
    $("fontSel").innerHTML = families().map((f) => `<option value="${esc(f.family)}">${esc(cleanLabel(f.label))}</option>`).join("");
  } catch (e) {
    console.error(e);
    toast("Le serveur local ne répond pas. Relancez l’Éditeur PDF.", true);
  }
  window.__ready = true;
  await openFromUrl();
}

boot();
export { S, openFile, loadPage, applyEdit, setTool, exportPdf, undo, redo, rotatePage, removePage, reanalyze };
