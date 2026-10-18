/* Signature manuscrite : un bloc a dessiner au doigt (ou a la souris), comme celui de
   Annoter sur iOS. Les traits sont gardes sous forme de points, pas d'image : on peut
   changer l'encre apres coup et le rendu final se fait a haute resolution, quelle que
   soit la taille du bloc a l'ecran.

   La derniere signature est memorisee sur l'appareil (localStorage) pour etre reposee
   sans la redessiner. Elle ne quitte jamais l'appareil. */

const STORE_KEY = "editeur-pdf.signature";
const WIDTH = 2.4;          // epaisseur du trait, en points CSS
const OUT_SCALE = 4;        // resolution de l'image produite par rapport au bloc

const $ = (id) => document.getElementById(id);

let strokes = [];           // [[{x, y}, ...], ...] en points CSS du bloc
let ink = "#1c1c1e";
let resolveOpen = null;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && Array.isArray(saved.strokes)) return saved;
  } catch (_) { /* stockage indisponible : on repart d'un bloc vide */ }
  return null;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ink, strokes })); } catch (_) { /* idem */ }
}

/** Trace lisse : courbes passant par le milieu de chaque segment, comme un stylo. */
function drawStrokes(ctx, scale, dx = 0, dy = 0) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = WIDTH * scale;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  for (const s of strokes) {
    const p = (q) => [(q.x - dx) * scale, (q.y - dy) * scale];
    if (s.length === 1) {
      const [x, y] = p(s[0]);
      ctx.beginPath(); ctx.arc(x, y, (WIDTH * scale) / 2, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(...p(s[0]));
    for (let i = 1; i < s.length - 1; i++) {
      const [x, y] = p(s[i]), [nx, ny] = p(s[i + 1]);
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    ctx.lineTo(...p(s[s.length - 1]));
    ctx.stroke();
  }
}

function redraw() {
  const cv = $("sigCanvas");
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  drawStrokes(ctx, dpr);
  const empty = strokes.length === 0;
  $("sigPlaceholder").hidden = !empty;
  $("sigDone").disabled = empty;
  $("sigClear").disabled = empty;
}

/** Image de la signature recadree au plus pres de l'encre, fond transparent. */
async function render() {
  const pts = strokes.flat();
  const pad = WIDTH;
  const x0 = Math.min(...pts.map((p) => p.x)) - pad, y0 = Math.min(...pts.map((p) => p.y)) - pad;
  const x1 = Math.max(...pts.map((p) => p.x)) + pad, y1 = Math.max(...pts.map((p) => p.y)) + pad;
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.ceil((x1 - x0) * OUT_SCALE));
  cv.height = Math.max(1, Math.ceil((y1 - y0) * OUT_SCALE));
  drawStrokes(cv.getContext("2d"), OUT_SCALE, x0, y0);
  return createImageBitmap(cv);
}

function setInk(color) {
  ink = color;
  document.querySelectorAll(".sig-ink").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.ink === color)));
  redraw();
}

function close(value) {
  $("sigLayer").hidden = true;
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", redraw);
  const done = resolveOpen;
  resolveOpen = null;
  done?.(value);
}

function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  const cv = $("sigCanvas");
  let current = null, pid = null;
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * 10) / 10, y: Math.round((e.clientY - r.top) * 10) / 10 };
  };
  cv.addEventListener("pointerdown", (e) => {
    if (pid !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    pid = e.pointerId;
    cv.setPointerCapture(pid);
    current = [at(e)];
    strokes.push(current);
    redraw();
    e.preventDefault();
  });
  cv.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pid) return;
    // Les evenements fusionnes gardent la finesse du trait quand le doigt va vite.
    for (const ev of e.getCoalescedEvents?.() || [e]) current.push(at(ev));
    redraw();
  });
  const end = (e) => { if (e.pointerId === pid) { pid = null; current = null; } };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);

  $("sigCancel").onclick = () => close(null);
  // Effacer oublie aussi la signature enregistree : c'est le moyen de la retirer de l'appareil.
  $("sigClear").onclick = () => {
    strokes = [];
    try { localStorage.removeItem(STORE_KEY); } catch (_) { /* rien a oublier */ }
    redraw();
  };
  $("sigDone").onclick = async () => {
    save();
    close(await render());
  };
  document.querySelectorAll(".sig-ink").forEach((b) => (b.onclick = () => setInk(b.dataset.ink)));
}

/** Signature enregistree prete a poser, sans ouvrir le bloc ; `null` s'il n'y en a pas. */
export async function savedSignature() {
  const saved = load();
  if (!saved?.strokes.length) return null;
  strokes = saved.strokes;
  ink = saved.ink || ink;
  return render();
}

/** Ouvre le bloc de signature. Resout l'image de la signature, ou `null` si annule. */
export function drawSignature() {
  wire();
  const saved = load();
  strokes = saved?.strokes || [];
  $("sigLayer").hidden = false;
  setInk(saved?.ink || ink);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", redraw);
  return new Promise((resolve) => (resolveOpen = resolve));
}
