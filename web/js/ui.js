/* Interface : ouverture, analyse, edition, export. Coordonnees en points PDF,
   converties a l'affichage par le facteur d'echelle courant. */

import * as fonts from "./fonts.js";
import * as img from "./imaging.js";
import { PdfDoc } from "./doc.js";

const $ = (id) => document.getElementById(id);
const S = {
  doc: null, page: 0, zoom: 1, baseScale: 1, tool: "select",
  analysis: null, sel: null, draft: null, edits: new Map(), busy: false, size: null,
};
let swallowNextClick = false;

/* ------------------------------------------------------------- utilitaires */
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), isErr ? 5200 : 2600);
}
function veil(on, text, progress) {
  $("veilText").textContent = text || "Analyse...";
  $("veil").hidden = !on;
  const wrap = $("progressWrap");
  if (progress === undefined || progress === null) wrap.hidden = true;
  else { wrap.hidden = false; $("progressBar").style.width = Math.round(progress * 100) + "%"; }
}
const status = (html) => ($("status").innerHTML = html || "");
const scale = () => S.baseScale * S.zoom;

/* ------------------------------------------------------------- ouverture */
async function openFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.name) && file.type !== "application/pdf") {
    return toast("Choisissez un fichier PDF.", true);
  }
  veil(true, "Ouverture du document...");
  try {
    await fonts.loadAll();
    S.doc = await PdfDoc.open(file);
    S.page = 0; S.zoom = 1; S.edits = new Map();
    $("fileName").textContent = `${S.doc.name} — ${S.doc.pageCount} page${S.doc.pageCount > 1 ? "s" : ""}`;
    $("drop").hidden = true;
    $("app").hidden = false;
    $("exportBtn").disabled = false;
    $("pagesBtn").hidden = S.doc.pageCount < 2;
    await loadPage(0);
    buildThumbs();
  } catch (e) {
    console.error(e);
    toast("Lecture impossible : " + e.message, true);
  } finally { veil(false); }
}

/* ------------------------------------------------------------- rendu */
function fitScale(pageWidth) {
  const wrap = $("canvasWrap");
  const cs = getComputedStyle(wrap);
  const avail = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return Math.max(0.2, Math.min(1.6, avail / pageWidth));
}

async function loadPage(idx) {
  S.page = idx;
  clearSelection();
  S.size = await S.doc.pageSize(idx);
  S.baseScale = fitScale(S.size.width);
  $("pageLabel").textContent = `${idx + 1}/${S.doc.pageCount}`;
  await renderPage();

  if (!S.analysis || S.analysis.index !== idx) {
    veil(true, "Lecture de la page...");
    try {
      S.analysis = await S.doc.analyze(idx, { onProgress: onOcrProgress });
    } catch (e) {
      console.error(e); toast(e.message, true); S.analysis = null;
    } finally { veil(false); }
  }
  renderOverlay();
  describePage();
  markThumb();
}

function onOcrProgress(m) {
  if (m.status === "recognizing text") veil(true, "Reconnaissance du texte...", m.progress);
  else if (/loading|initializ/i.test(m.status)) veil(true, "Preparation de la reconnaissance...", m.progress);
}

async function renderPage() {
  const dpi = 72 * scale() * Math.min(2, window.devicePixelRatio || 1);
  const canvas = await S.doc.renderPage(S.page, dpi, true);
  const target = $("pageCanvas");
  target.width = canvas.width;
  target.height = canvas.height;
  target.getContext("2d").drawImage(canvas, 0, 0);
  const cssW = S.size.width * scale();
  $("canvas").style.width = cssW + "px";
  target.style.width = cssW + "px";
  $("zoomLabel").textContent = Math.round(S.zoom * 100) + "%";
}

function renderOverlay() {
  const ov = $("overlay");
  ov.innerHTML = "";
  ov.classList.add("show");
  if (!S.analysis) return;
  const k = scale();
  for (const it of S.analysis.items) {
    const el = document.createElement("div");
    el.className = "hit";
    if (it.source === "ocr" && it.fontScore < 0.38) el.classList.add("low");
    if (S.edits.has(it.id)) el.classList.add("edited");
    el.style.cssText =
      `left:${it.bbox[0] * k}px;top:${it.bbox[1] * k}px;` +
      `width:${(it.bbox[2] - it.bbox[0]) * k}px;height:${(it.bbox[3] - it.bbox[1]) * k}px`;
    el.title = it.text;
    el.onclick = (e) => { e.stopPropagation(); selectItem(it, el); };
    ov.appendChild(el);
  }
}

function describePage() {
  if (!S.analysis) return status("");
  const a = S.analysis;
  if (!a.items.length) {
    return status("Aucun texte reconnu — la gomme, l'ajout de texte et l'insertion d'image restent disponibles.");
  }
  const kind = a.mode === "scan"
    ? `<b>page scannee</b> — texte reconnu, police et couleur mesurees sur l'image`
    : `<b>page native</b> — texte du PDF, couleur et police mesurees sur le rendu`;
  status(`${kind} · ${a.items.length} zone${a.items.length > 1 ? "s" : ""}`);
}

/* ------------------------------------------------------------- selection */
function clearSelection() {
  S.sel = null; S.draft = null;
  $("editor").hidden = true;
  $("inspectorEmpty").hidden = false;
  $("inspector").classList.remove("open");
  document.querySelectorAll(".hit.on").forEach((e) => e.classList.remove("on"));
}

function selectItem(item, el) {
  document.querySelectorAll(".hit.on").forEach((e) => e.classList.remove("on"));
  el?.classList.add("on");
  S.sel = item; S.draft = null;
  fillEditor(item);
}

function fillEditor(it) {
  $("inspectorEmpty").hidden = true;
  $("editor").hidden = false;
  $("inspector").classList.add("open");
  $("txt").value = it.text || "";
  $("sizeIn").value = Math.round((it.size ?? 12) * 10) / 10;
  $("colorIn").value = it.color || "#111111";
  $("fontSel").value = it.fontKey || fonts.DEFAULT_KEY;
  $("boldBtn").classList.toggle("on", !!it.bold);
  $("italBtn").classList.toggle("on", !!it.italic);
  setAlign(it.align || "left");

  const d = $("detected");
  if (it.source === "new") {
    d.innerHTML = "Nouveau bloc de texte.";
  } else {
    // Seuils cales sur de vrais scans : au-dela de 0.55 la police retenue est visuellement
    // juste, en dessous de 0.38 elle merite un coup d'oeil.
    const s = it.fontScore ?? 0;
    const tag = s >= 0.55 ? '<span class="tag good">fiable</span>'
              : s >= 0.38 ? '<span class="tag mid">approximatif</span>'
                          : '<span class="tag mid">a verifier</span>';
    d.innerHTML =
      `Mesure sur l'image ${tag}<br>Police probable <b>${fontLabel(it.fontKey)}</b>` +
      ` · concordance ${(s * 100).toFixed(0)}%<br>` +
      `Encre <b>${it.color}</b> · papier <b>${it.paper}</b> · corps <b>${it.size.toFixed(1)} pt</b>` +
      (it.conf ? `<br>Confiance de lecture <b>${it.conf}%</b>` : "");
  }
}

const fontLabel = (k) => fonts.BY_KEY.get(k)?.label || k;
const setAlign = (a) =>
  document.querySelectorAll("[data-align]").forEach((b) => b.classList.toggle("on", b.dataset.align === a));
const currentAlign = () => document.querySelector("[data-align].on")?.dataset.align || "left";

/* ------------------------------------------------------------- edition */
async function applyEdit() {
  if (S.busy) return;
  const base = S.sel || S.draft;
  if (!base) return;
  const common = {
    page: S.page,
    text: $("txt").value,
    size: parseFloat($("sizeIn").value) || base.size || 12,
    color: $("colorIn").value,
    fontKey: $("fontSel").value,
    bold: $("boldBtn").classList.contains("on"),
    italic: $("italBtn").classList.contains("on"),
    align: currentAlign(),
  };
  const op = base.source === "new"
    ? { type: "add", bbox: base.bbox, ...common }
    : {
        type: "text", itemId: base.id, bbox: base.bbox,
        tracking: base.tracking || 0, blur: base.blur || 0, grain: base.grain || 0,
        left: base.inkLeft ?? base.bbox[0], top: base.inkTop ?? base.bbox[1],
        ...common,
      };

  S.busy = true;
  $("applyBtn").disabled = true;
  try {
    const prev = base.id && S.edits.get(base.id);
    if (prev) S.doc.removeOp(prev);
    const uid = S.doc.addOp(op);
    if (base.id) S.edits.set(base.id, uid);
    if (base.source !== "new") base.text = op.text;
    await renderPage();
    renderOverlay();
    refreshThumb(S.page);
    $("undoBtn").disabled = false;
    toast("Modification appliquee");
    if (base.source === "new") clearSelection();
  } catch (e) {
    console.error(e); toast(e.message, true);
  } finally { S.busy = false; $("applyBtn").disabled = false; }
}

async function undo() {
  const removed = S.doc?.undo();
  if (!removed) return toast("Rien a annuler");
  for (const [k, v] of S.edits) if (v === removed.uid) S.edits.delete(k);
  if (removed.page !== S.page) await loadPage(removed.page);
  else { await renderPage(); renderOverlay(); refreshThumb(S.page); }
  $("undoBtn").disabled = S.doc.ops.length === 0;
  toast("Derniere modification annulee");
}

/* ------------------------------------------------------------- outils zone */
function setTool(name) {
  S.tool = name;
  document.querySelectorAll(".tool[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === name));
  $("canvas").className = "canvas" + (name === "select" ? "" : " tool-" + name);
  if (name !== "select") clearSelection();
}

function initMarquee() {
  const cv = $("canvas"), mq = $("marquee");
  let start = null;
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  const begin = (e) => {
    if (S.tool === "select") return;
    start = pos(e);
    mq.hidden = false;
    Object.assign(mq.style, { left: start.x + "px", top: start.y + "px", width: "0px", height: "0px" });
    e.preventDefault();
  };
  const move = (e) => {
    if (!start) return;
    const p = pos(e);
    Object.assign(mq.style, {
      left: Math.min(p.x, start.x) + "px", top: Math.min(p.y, start.y) + "px",
      width: Math.abs(p.x - start.x) + "px", height: Math.abs(p.y - start.y) + "px",
    });
    e.preventDefault();
  };
  const end = async (e) => {
    if (!start) return;
    const p = e.changedTouches ? (() => {
      const r = cv.getBoundingClientRect(), t = e.changedTouches[0];
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    })() : pos(e);
    const box = [Math.min(p.x, start.x), Math.min(p.y, start.y), Math.max(p.x, start.x), Math.max(p.y, start.y)];
    start = null; mq.hidden = true;
    if (box[2] - box[0] < 8 || box[3] - box[1] < 8) return;
    // Un trace se termine par un evenement `click` : sans ce garde-fou, il
    // deselectionnerait aussitot le bloc que le trace vient de creer.
    swallowNextClick = true;
    const k = scale();
    const bbox = box.map((v) => v / k);
    if (S.tool === "erase") await eraseZone(bbox);
    else if (S.tool === "add") newTextBlock(bbox);
    else if (S.tool === "image") await insertImage(bbox);
  };
  cv.addEventListener("mousedown", begin);
  cv.addEventListener("touchstart", begin, { passive: false });
  window.addEventListener("mousemove", move);
  window.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("mouseup", end);
  window.addEventListener("touchend", end);
}

async function eraseZone(bbox) {
  S.doc.addOp({ type: "erase", page: S.page, bbox });
  await renderPage(); refreshThumb(S.page);
  $("undoBtn").disabled = false;
  toast("Zone effacee");
}

function newTextBlock(bbox) {
  S.sel = null;
  S.draft = { source: "new", bbox, size: 12, color: "#111111", fontKey: $("fontSel").value, text: "" };
  fillEditor(S.draft);
  $("txt").focus();
  setTool("select");
}

async function insertImage(bbox) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      const bitmap = await createImageBitmap(f);
      const ratio = bitmap.height / bitmap.width;
      const w = bbox[2] - bbox[0];
      S.doc.addOp({ type: "image", page: S.page, bbox: [bbox[0], bbox[1], bbox[2], bbox[1] + w * ratio], bitmap });
      await renderPage(); refreshThumb(S.page);
      $("undoBtn").disabled = false;
      toast("Image inseree");
    } catch (e) { toast("Image illisible", true); }
  };
  inp.click();
  setTool("select");
}

/* ------------------------------------------------------------- pages */
async function buildThumbs() {
  const list = $("pageList");
  list.innerHTML = "";
  for (let i = 0; i < S.doc.pageCount; i++) {
    const d = document.createElement("div");
    d.className = "thumb" + (i === S.page ? " on" : "");
    d.dataset.index = i;
    d.innerHTML = `<canvas></canvas><span class="num">${i + 1}</span>
      <span class="pg-tools"><button data-act="rotate" title="Pivoter">&#8635;</button>
      <button data-act="delete" title="Retirer">&times;</button></span>`;
    d.onclick = async (ev) => {
      const act = ev.target.dataset?.act;
      if (act) { ev.stopPropagation(); await pageAction(act, i); return; }
      $("pageList").classList.remove("open");
      await loadPage(i);
    };
    list.appendChild(d);
    refreshThumb(i);
  }
}

async function refreshThumb(i) {
  const el = $("pageList").children[i];
  if (!el) return;
  const canvas = await S.doc.renderPage(i, 24, true);
  const target = el.querySelector("canvas");
  target.width = canvas.width; target.height = canvas.height;
  target.getContext("2d").drawImage(canvas, 0, 0);
}

function markThumb() {
  [...$("pageList").children].forEach((c, i) => c.classList.toggle("on", i === S.page));
}

async function pageAction(action, index) {
  if (action === "rotate") {
    S.doc.rotations.set(index, ((S.doc.rotations.get(index) || 0) + 90) % 360);
    toast("La page sera pivotee dans le fichier exporte");
  } else if (action === "delete") {
    if (S.doc.pageCount - S.doc.removed.size <= 1) return toast("Derniere page restante", true);
    if (!confirm(`Retirer la page ${index + 1} du fichier exporte ?`)) return;
    S.doc.removed.add(index);
    $("pageList").children[index].style.opacity = 0.35;
    toast("Page retiree de l'export");
  }
}

/* ------------------------------------------------------------- export */
async function exportPdf() {
  if (!S.doc) return;
  veil(true, "Preparation du PDF...", 0);
  try {
    const bytes = await S.doc.export((p) => veil(true, "Preparation du PDF...", p));
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (S.doc.name || "document.pdf").replace(/\.pdf$/i, "") + "-modifie.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast("PDF telecharge");
  } catch (e) {
    console.error(e); toast("Export impossible : " + e.message, true);
  } finally { veil(false); }
}

/* ------------------------------------------------------------- demarrage */
function boot() {
  $("fontSel").innerHTML = fonts.CATALOG.map((f) => `<option value="${f.key}">${f.label}</option>`).join("");
  $("picker").onchange = (e) => openFile(e.target.files[0]);
  $("applyBtn").onclick = applyEdit;
  $("cancelBtn").onclick = clearSelection;
  $("undoBtn").onclick = undo;
  $("exportBtn").onclick = exportPdf;
  $("boldBtn").onclick = () => $("boldBtn").classList.toggle("on");
  $("italBtn").onclick = () => $("italBtn").classList.toggle("on");
  document.querySelectorAll("[data-align]").forEach((b) => (b.onclick = () => setAlign(b.dataset.align)));
  document.querySelectorAll(".tool[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $("pagesBtn").onclick = () => $("pageList").classList.toggle("open");
  $("zoomIn").onclick = () => setZoom(S.zoom * 1.25);
  $("zoomOut").onclick = () => setZoom(S.zoom / 1.25);
  $("prevPage").onclick = () => S.page > 0 && loadPage(S.page - 1);
  $("nextPage").onclick = () => S.page < S.doc.pageCount - 1 && loadPage(S.page + 1);
  $("overlay").onclick = () => {
    if (swallowNextClick) { swallowNextClick = false; return; }
    clearSelection();
  };
  $("sheetGrip").onclick = clearSelection;

  ["dragenter", "dragover"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.remove("hot"); }));
  document.addEventListener("drop", (e) => openFile(e.dataTransfer?.files?.[0]));

  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); applyEdit(); }
    else if (e.key === "Escape") clearSelection();
    else if (!typing && S.doc) {
      if (e.key === "ArrowRight" && S.page < S.doc.pageCount - 1) loadPage(S.page + 1);
      if (e.key === "ArrowLeft" && S.page > 0) loadPage(S.page - 1);
    }
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!S.doc || !S.size) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      S.baseScale = fitScale(S.size.width);
      await renderPage();
      renderOverlay();
    }, 180);
  });

  initMarquee();
  initPinch();
  window.__ready = true;
}

/** Pincement a deux doigts et double-tap : sur un A4 ramene a la largeur d'un telephone,
    une ligne de texte fait moins de dix pixels de haut, intouchable au doigt sans zoom. */
function initPinch() {
  const wrap = $("canvasWrap");
  let startDist = 0, startZoom = 1, pinching = false;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  wrap.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 2) return;
    pinching = true;
    startDist = dist(e.touches);
    startZoom = S.zoom;
    e.preventDefault();
  }, { passive: false });

  wrap.addEventListener("touchmove", (e) => {
    if (!pinching || e.touches.length !== 2) return;
    const ratio = dist(e.touches) / (startDist || 1);
    S.zoom = Math.max(0.5, Math.min(5, startZoom * ratio));
    // Pendant le geste on se contente d'etirer l'image deja rendue : la redessiner a
    // chaque image rendrait le pincement saccade.
    const cssW = S.size.width * scale();
    $("canvas").style.width = cssW + "px";
    $("pageCanvas").style.width = cssW + "px";
    $("zoomLabel").textContent = Math.round((S.zoom) * 100) + "%";
    e.preventDefault();
  }, { passive: false });

  const endPinch = async () => {
    if (!pinching) return;
    pinching = false;
    await renderPage();
    renderOverlay();
  };
  wrap.addEventListener("touchend", endPinch);
  wrap.addEventListener("touchcancel", endPinch);

  let lastTap = 0;
  wrap.addEventListener("touchend", (e) => {
    if (e.touches.length || pinching) return;
    const now = Date.now();
    if (now - lastTap < 300) { setZoom(S.zoom > 1.4 ? 1 : 2.2); lastTap = 0; }
    else lastTap = now;
  });
}

async function setZoom(z) {
  S.zoom = Math.max(0.5, Math.min(4, z));
  if (!S.doc) return;
  await renderPage();
  renderOverlay();
}

boot();
export { S, openFile, loadPage, applyEdit, setTool, exportPdf };
