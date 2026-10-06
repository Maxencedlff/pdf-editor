/* Editeur PDF local -- interface. Toutes les coordonnees echangees avec le serveur
   sont en points PDF ; l'affichage applique le facteur PPP * zoom. */
"use strict";

const PPP = 1.35;                    // pixels CSS par point a zoom 1
const $ = (id) => document.getElementById(id);

const S = {
  docId: null, name: "", pages: [], page: 0, zoom: 1,
  tool: "select", analysis: null, sel: null, draft: null,
  fonts: [], edits: new Map(),       // item_id -> uid de l'operation
  busy: false,
};

/* ---------------------------------------------------------------- utilitaires */
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), isErr ? 5200 : 2600);
}
function veil(on, text) {
  $("veilText").textContent = text || "Analyse en cours...";
  $("veil").hidden = !on;
}
function status(html) { $("status").innerHTML = html || ""; }

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r;
}

const scale = () => PPP * S.zoom;
const ptToPx = (v) => v * scale();
const pxToPt = (v) => v / scale();

/* ---------------------------------------------------------------- ouverture */
async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) return toast("Choisissez un fichier PDF.", true);
  veil(true, "Ouverture du document...");
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await api("/api/open", { method: "POST", body: fd });
    Object.assign(S, { docId: res.doc_id, name: res.name, pages: res.pages, page: 0, edits: new Map() });
    $("fileName").textContent = `${res.name} — ${res.page_count} page${res.page_count > 1 ? "s" : ""}`;
    $("drop").hidden = true;
    $("app").hidden = false;
    $("exportBtn").disabled = false;
    await buildThumbs();
    await loadPage(0);
  } catch (e) {
    toast(e.message, true);
  } finally {
    veil(false);
  }
}

/* ---------------------------------------------------------------- pages */
async function buildThumbs() {
  const list = $("pageList");
  list.innerHTML = "";
  S.pages.forEach((p, i) => {
    const d = document.createElement("div");
    d.className = "thumb" + (i === S.page ? " on" : "");
    d.innerHTML =
      `<img loading="lazy" src="/api/page/${S.docId}/${i}?dpi=26&v=0" alt="page ${i + 1}">
       <span class="num">${i + 1}</span>
       <span class="pg-tools">
         <button data-act="rotate" title="Pivoter">&#8635;</button>
         <button data-act="delete" title="Supprimer la page">&times;</button>
       </span>`;
    d.onclick = (ev) => {
      const act = ev.target.dataset?.act;
      if (act) { ev.stopPropagation(); pageAction(act, i); }
      else loadPage(i);
    };
    list.appendChild(d);
  });
}

async function pageAction(action, index) {
  if (action === "delete" && !confirm(`Supprimer la page ${index + 1} du document exporte ?`)) return;
  try {
    await api(`/api/pages/${S.docId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, index, angle: 90 }),
    });
    refreshThumb(index);
    if (index === S.page) await loadPage(S.page, true);
    toast(action === "rotate" ? "Page pivotee" : "Page retiree de l'export");
  } catch (e) { toast(e.message, true); }
}

function refreshThumb(i) {
  const img = $("pageList").children[i]?.querySelector("img");
  if (img) img.src = `/api/page/${S.docId}/${i}?dpi=26&v=${Date.now()}`;
}

async function loadPage(idx, keepAnalysis) {
  S.page = idx;
  clearSelection();
  [...$("pageList").children].forEach((c, i) => c.classList.toggle("on", i === idx));
  const meta = S.pages[idx];
  const cv = $("canvas");
  cv.style.width = ptToPx(meta.width) + "px";
  cv.style.height = ptToPx(meta.height) + "px";
  await refreshImage();

  if (!keepAnalysis || !S.analysis || S.analysis.index !== idx) {
    veil(true, "Lecture de la page (OCR si necessaire)...");
    try {
      S.analysis = await api(`/api/analyze/${S.docId}/${idx}`);
    } catch (e) {
      toast(e.message, true); S.analysis = null;
    } finally { veil(false); }
  }
  renderOverlay();
  describePage();
}

function describePage() {
  if (!S.analysis) return status("");
  const a = S.analysis;
  if (!a.items.length) {
    return status(
      "Aucun texte reconnu sur cette page — vous pouvez tout de meme utiliser la gomme, " +
      "ajouter du texte ou inserer une image."
    );
  }
  const kind = a.mode === "scan"
    ? `<b>page scannee</b> — texte reconnu par OCR, police et couleur mesurees sur l'image (${a.native_dpi} dpi)`
    : "<b>page native</b> — texte vectoriel, la police d'origine du PDF est reutilisee";
  status(`${kind} · ${a.items.length} zone${a.items.length > 1 ? "s" : ""} de texte`);
}

async function reanalyze(force) {
  if (!S.docId) return;
  veil(true, force === "ocr" ? "Relecture par OCR..." : "Relecture de la page...");
  try {
    S.analysis = await api(`/api/analyze/${S.docId}/${S.page}?force=${force}`);
    clearSelection();
    renderOverlay();
    describePage();
    toast(`${S.analysis.items.length} zone(s) reconnue(s)`);
  } catch (e) {
    toast(e.message, true);
  } finally { veil(false); }
}

async function refreshImage() {
  const meta = S.pages[S.page];
  const dpi = Math.min(300, 72 * PPP * S.zoom * Math.min(2, window.devicePixelRatio || 1));
  const img = $("pageImg");
  await new Promise((res) => {
    img.onload = img.onerror = res;
    img.src = `/api/page/${S.docId}/${S.page}?dpi=${dpi.toFixed(0)}&v=${Date.now()}`;
  });
  $("canvas").style.width = ptToPx(meta.width) + "px";
  $("canvas").style.height = ptToPx(meta.height) + "px";
}

/* ---------------------------------------------------------------- overlay */
function renderOverlay() {
  const ov = $("overlay");
  ov.innerHTML = "";
  ov.classList.toggle("show", $("showBoxes").checked);
  if (!S.analysis) return;
  for (const it of S.analysis.items) {
    const [x0, y0, x1, y1] = it.bbox;
    const el = document.createElement("div");
    el.className = "hit";
    if (it.font_score < 0.38 && it.source === "ocr") el.classList.add("low");
    if (S.edits.has(it.id)) el.classList.add("edited");
    el.style.cssText = `left:${ptToPx(x0)}px;top:${ptToPx(y0)}px;` +
                       `width:${ptToPx(x1 - x0)}px;height:${ptToPx(y1 - y0)}px`;
    el.title = it.text;
    el.onclick = (e) => { e.stopPropagation(); selectItem(it, el); };
    ov.appendChild(el);
  }
}

function clearSelection() {
  S.sel = null; S.draft = null;
  $("editor").hidden = true;
  $("inspectorEmpty").hidden = false;
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
  $("txt").value = it.text || "";
  $("sizeIn").value = it.size ?? 12;
  $("colorIn").value = it.color || "#111111";
  $("fontSel").value = it.font_key || S.fonts[0]?.key;
  $("boldBtn").classList.toggle("on", !!it.bold);
  $("italBtn").classList.toggle("on", !!it.italic);
  setAlign(it.align || "left");

  const d = $("detected");
  if (it.source === "ocr") {
    // Seuils cales sur de vrais scans : au-dela de 0.55 la police retenue est
    // visuellement juste, en dessous de 0.38 elle merite un coup d'oeil.
    const s = it.font_score ?? 0;
    const tag = s >= 0.55 ? '<span class="tag good">fiable</span>'
              : s >= 0.38 ? '<span class="tag mid">approximatif</span>'
                          : '<span class="tag mid">a verifier</span>';
    d.innerHTML =
      `Mesure sur le scan ${tag}<br>
       Police probable <b>${fontLabel(it.font_key)}</b> · concordance ${(s * 100).toFixed(0)}%<br>
       Encre <b>${it.color}</b> · papier <b>${it.paper}</b> · corps <b>${it.size} pt</b><br>
       Confiance OCR <b>${it.conf ?? "?"}%</b>`;
  } else if (it.source === "new") {
    d.innerHTML = "Nouveau bloc de texte.";
  } else {
    d.innerHTML = `Texte vectoriel · police du PDF <b>${it.pdf_font || "inconnue"}</b><br>
      Elle est reutilisee telle quelle si elle contient les caracteres saisis.`;
  }
}

const fontLabel = (k) => S.fonts.find((f) => f.key === k)?.label || k;
function setAlign(a) {
  document.querySelectorAll("[data-align]").forEach((b) => b.classList.toggle("on", b.dataset.align === a));
}
const currentAlign = () => document.querySelector("[data-align].on")?.dataset.align || "left";

/* ---------------------------------------------------------------- edition */
async function applyEdit() {
  if (S.busy) return;
  const base = S.sel || S.draft;
  if (!base) return;
  const text = $("txt").value;
  const common = {
    page: S.page,
    text,
    size: parseFloat($("sizeIn").value) || base.size || 12,
    color: $("colorIn").value,
    font_key: $("fontSel").value,
    bold: $("boldBtn").classList.contains("on"),
    italic: $("italBtn").classList.contains("on"),
    align: currentAlign(),
  };
  let op;
  if (base.source === "new") {
    op = { type: "add_text", bbox: base.bbox, ...common };
  } else {
    op = {
      type: "text", item_id: base.id, bbox: base.bbox, paper: base.paper,
      tracking: base.tracking || 0,
      // Texture du scan : le texte redessine doit subir le meme flou et le meme grain.
      blur: base.blur || 0, grain: base.grain || 0,
      left: base.ink_left ?? base.left ?? base.bbox[0],
      top: base.ink_top, baseline: base.baseline,
      font_key_changed: $("fontSel").value !== base.font_key,
      ...common,
    };
  }
  S.busy = true;
  $("applyBtn").disabled = true;
  try {
    const prev = base.id && S.edits.get(base.id);
    if (prev) await api(`/api/op/${S.docId}/delete/${prev}`, { method: "POST" });
    const res = await api(`/api/op/${S.docId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op),
    });
    if (base.id) S.edits.set(base.id, res.uid);
    if (base.source !== "new") base.text = text;
    await refreshImage();
    refreshThumb(S.page);
    renderOverlay();
    $("undoBtn").disabled = false;
    toast("Modification appliquee");
    if (base.source === "new") clearSelection();
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.busy = false;
    $("applyBtn").disabled = false;
  }
}

async function undo() {
  try {
    const r = await api(`/api/undo/${S.docId}`, { method: "POST" });
    if (r.removed) {
      for (const [k, v] of S.edits) if (v === r.removed.uid) S.edits.delete(k);
      const p = r.removed.page ?? S.page;
      if (p !== S.page) await loadPage(p);
      else { await refreshImage(); refreshThumb(S.page); renderOverlay(); }
    }
    $("undoBtn").disabled = r.count === 0;
    toast(r.removed ? "Derniere modification annulee" : "Rien a annuler");
  } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------------- outils zone */
function setTool(name) {
  S.tool = name;
  document.querySelectorAll(".tool[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === name));
  const cv = $("canvas");
  cv.className = "canvas" + (name === "select" ? "" : " tool-" + name);
  if (name !== "select") clearSelection();
}

/* Un tracé se termine par un evenement `click` sur l'overlay : sans ce garde-fou, il
   deselectionnerait aussitot le bloc que le trace vient de creer. */
let swallowNextClick = false;

function initMarquee() {
  const cv = $("canvas"), mq = $("marquee");
  let start = null;
  cv.addEventListener("mousedown", (e) => {
    if (S.tool === "select" || e.button !== 0) return;
    const r = cv.getBoundingClientRect();
    start = { x: e.clientX - r.left, y: e.clientY - r.top };
    mq.hidden = false;
    Object.assign(mq.style, { left: start.x + "px", top: start.y + "px", width: "0px", height: "0px" });
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!start) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    Object.assign(mq.style, {
      left: Math.min(x, start.x) + "px", top: Math.min(y, start.y) + "px",
      width: Math.abs(x - start.x) + "px", height: Math.abs(y - start.y) + "px",
    });
  });
  window.addEventListener("mouseup", async (e) => {
    if (!start) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const box = [Math.min(x, start.x), Math.min(y, start.y), Math.max(x, start.x), Math.max(y, start.y)];
    start = null; mq.hidden = true;
    if (box[2] - box[0] < 6 || box[3] - box[1] < 6) return;
    swallowNextClick = true;
    const bbox = box.map(pxToPt);
    if (S.tool === "erase") await eraseZone(bbox);
    else if (S.tool === "add") newTextBlock(bbox);
    else if (S.tool === "image") await insertImage(bbox);
  });
}

async function eraseZone(bbox) {
  try {
    await api(`/api/op/${S.docId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "erase", page: S.page, bbox, mode: "smart" }),
    });
    await refreshImage(); refreshThumb(S.page);
    $("undoBtn").disabled = false;
    toast("Zone effacee");
  } catch (e) { toast(e.message, true); }
}

function newTextBlock(bbox) {
  S.sel = null;
  S.draft = { source: "new", bbox, size: 12, color: "#111111", font_key: $("fontSel").value, text: "" };
  fillEditor(S.draft);
  $("txt").focus();
  setTool("select");
}

async function insertImage(bbox) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    const data = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(f);
    });
    try {
      await api(`/api/op/${S.docId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "image", page: S.page, bbox, data, keep_ratio: true }),
      });
      await refreshImage(); refreshThumb(S.page);
      $("undoBtn").disabled = false;
      toast("Image inseree");
    } catch (e) { toast(e.message, true); }
  };
  inp.click();
  setTool("select");
}

/* ---------------------------------------------------------------- demarrage */
async function boot() {
  try {
    const cfg = await api("/api/config");
    S.fonts = cfg.fonts;
    $("fontSel").innerHTML = cfg.fonts.map((f) => `<option value="${f.key}">${f.label}</option>`).join("");
  } catch (_) { toast("Serveur injoignable.", true); }

  $("picker").onchange = (e) => openFile(e.target.files[0]);
  $("picker2").onchange = (e) => openFile(e.target.files[0]);
  $("applyBtn").onclick = applyEdit;
  $("cancelBtn").onclick = clearSelection;
  $("undoBtn").onclick = undo;
  $("exportBtn").onclick = () => {
    toast("Preparation du PDF...");
    window.location = `/api/export/${S.docId}`;
  };
  $("boldBtn").onclick = () => $("boldBtn").classList.toggle("on");
  $("italBtn").onclick = () => $("italBtn").classList.toggle("on");
  document.querySelectorAll("[data-align]").forEach((b) => (b.onclick = () => setAlign(b.dataset.align)));
  document.querySelectorAll(".tool[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $("showBoxes").onchange = renderOverlay;
  $("ocrBtn").onclick = () => reanalyze(S.analysis?.mode === "scan" ? "native" : "ocr");
  $("zoomIn").onclick = () => setZoom(S.zoom * 1.25);
  $("zoomOut").onclick = () => setZoom(S.zoom / 1.25);
  $("overlay").onclick = () => {
    if (swallowNextClick) { swallowNextClick = false; return; }
    clearSelection();
  };

  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
  document.addEventListener("drop", (e) => openFile(e.dataTransfer?.files?.[0]));

  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); applyEdit(); }
    else if (e.key === "Escape") clearSelection();
    else if (!typing && S.docId) {
      if (e.key === "ArrowRight" && S.page < S.pages.length - 1) loadPage(S.page + 1);
      if (e.key === "ArrowLeft" && S.page > 0) loadPage(S.page - 1);
    }
  });

  initMarquee();
  openFromUrl();
}

/* Ouverture directe : /?file=<chemin local du PDF> */
async function openFromUrl() {
  const path = new URLSearchParams(location.search).get("file");
  if (!path) return;
  try {
    const r = await fetch(`/api/local?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error("Fichier introuvable : " + path);
    const name = path.split(/[\\/]/).pop();
    await openFile(new File([await r.blob()], name, { type: "application/pdf" }));
  } catch (e) {
    toast(e.message, true);
  }
}

async function setZoom(z) {
  S.zoom = Math.max(0.35, Math.min(4, z));
  $("zoomLabel").textContent = Math.round(S.zoom * 100) + "%";
  if (!S.docId) return;
  await refreshImage();
  renderOverlay();
}

boot();
