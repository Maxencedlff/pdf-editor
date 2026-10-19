/* Annotations : surlignage, soulignement, texte barre, crayon, formes, coche et croix.

   Une annotation est une operation `{ type: "mark", kind, ... }` en points PDF, comme les
   autres retouches. Ce module en connait la geometrie (cadre, deplacement, mise a
   l'echelle), le dessin a l'ecran (canvas) et l'export. A l'export elle est dessinee en
   vectoriel par pdf-lib : un surlignage reste net a tous les zooms et le texte du dessous
   reste selectionnable, ce qu'une image incrustee ne permettrait pas.

   Geometrie selon le genre :
   - highlight, underline, strike : `rects`, les lignes de texte couvertes ;
   - ink : `strokes`, des traits [[x, y], ...] ;
   - rect, ellipse, check, cross : `box` ;
   - line, arrow : `p` = [x0, y0, x1, y1]. */

export const TEXT_KINDS = new Set(["highlight", "underline", "strike"]);
export const HIGHLIGHT_ALPHA = 0.4;

/** Cadre englobant, epaisseur du trait comprise. */
export function bounds(op) {
  const xs = [], ys = [];
  const add = (x, y) => { xs.push(x); ys.push(y); };
  if (op.rects) for (const r of op.rects) { add(r[0], r[1]); add(r[2], r[3]); }
  if (op.strokes) for (const s of op.strokes) for (const [x, y] of s) add(x, y);
  if (op.box) { add(op.box[0], op.box[1]); add(op.box[2], op.box[3]); }
  if (op.p) { add(op.p[0], op.p[1]); add(op.p[2], op.p[3]); }
  if (!xs.length) return [0, 0, 0, 0];
  const m = op.kind === "arrow" ? headSize(op) : (op.width || 0) / 2;
  return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
}

/** Copie deplacee de (dx, dy). */
export function translated(op, dx, dy) {
  return mapPoints(op, (x, y) => [x + dx, y + dy]);
}

/** Copie etiree pour que le cadre `from` devienne `to`. */
export function rescaled(op, from, to) {
  const sx = (to[2] - to[0]) / Math.max(1e-6, from[2] - from[0]);
  const sy = (to[3] - to[1]) / Math.max(1e-6, from[3] - from[1]);
  const out = mapPoints(op, (x, y) => [to[0] + (x - from[0]) * sx, to[1] + (y - from[1]) * sy]);
  if (op.kind === "ink") out.width = op.width * Math.sqrt(Math.abs(sx * sy));
  return out;
}

function mapPoints(op, f) {
  const out = { ...op };
  delete out.uid;
  const box = (r) => { const [a, b] = f(r[0], r[1]), [c, d] = f(r[2], r[3]); return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]; };
  if (op.rects) out.rects = op.rects.map(box);
  if (op.box) out.box = box(op.box);
  if (op.p) { const [a, b] = f(op.p[0], op.p[1]), [c, d] = f(op.p[2], op.p[3]); out.p = [a, b, c, d]; }
  if (op.strokes) out.strokes = op.strokes.map((s) => s.map(([x, y]) => f(x, y)));
  return out;
}

const headSize = (op) => Math.max(5, op.width * 3.2);

/* ---------------------------------------------------------------- surlignage du texte */

/** Lignes de texte couvertes par un geste du point `a` au point `b`, comme une selection
    de texte : la premiere ligne part du doigt, les suivantes vont jusqu'au bout, la
    derniere s'arrete sous le doigt. Retourne des cadres [x0, y0, x1, y1] en points. */
export function textRects(items, a, b) {
  const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  const lines = items
    .filter((it) => it.bbox[3] > top && it.bbox[1] < bottom + 0.5)
    .sort((p, q) => p.bbox[1] - q.bbox[1] || p.bbox[0] - q.bbox[0]);
  if (!lines.length) return [];
  const [start, end] = a.y <= b.y ? [a, b] : [b, a];
  const firstTop = lines[0].bbox[1], lastTop = lines[lines.length - 1].bbox[1];
  const single = lines.every((l) => Math.abs(l.bbox[1] - firstTop) < 2);
  return lines.map((l) => {
    let [x0, , x1] = l.bbox;
    if (single) {
      x0 = Math.max(x0, Math.min(a.x, b.x));
      x1 = Math.min(x1, Math.max(a.x, b.x));
    } else {
      if (Math.abs(l.bbox[1] - firstTop) < 2) x0 = Math.max(x0, start.x);
      if (Math.abs(l.bbox[1] - lastTop) < 2) x1 = Math.min(x1, end.x);
    }
    // Un geste qui couvre presque toute la ligne la prend entiere : le doigt est imprecis.
    const w = l.bbox[2] - l.bbox[0];
    if (x0 - l.bbox[0] < w * 0.06) x0 = l.bbox[0];
    if (l.bbox[2] - x1 < w * 0.06) x1 = l.bbox[2];
    return lineBox(l, x0, x1);
  }).filter((r) => r[2] - r[0] > 1);
}

/** Bande verticale d'une ligne : de la hauteur des majuscules a un peu sous la ligne de
    base, sans le large interligne que les boites natives incluent. */
function lineBox(item, x0, x1) {
  const size = item.size || (item.bbox[3] - item.bbox[1]) * 0.8;
  const top = (item.inkTop ?? item.bbox[1]) - size * 0.12;
  const bottom = Math.min(item.bbox[3], top + size * 1.18);
  return [x0, top, x1, bottom];
}

/* ---------------------------------------------------------------- dessin a l'ecran */

/** Dessine l'annotation dans un contexte 2D. `X` et `Y` convertissent des points en
    pixels du canvas, `k` est le nombre de pixels par point. */
export function draw(ctx, op, X, Y, k) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ctx.fillStyle = op.color;
  ctx.lineWidth = Math.max(0.6, (op.width || 1) * k);
  const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(X(x0), Y(y0)); ctx.lineTo(X(x1), Y(y1)); ctx.stroke(); };

  switch (op.kind) {
    case "highlight":
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      for (const r of op.rects) ctx.fillRect(X(r[0]), Y(r[1]), (r[2] - r[0]) * k, (r[3] - r[1]) * k);
      break;
    case "underline":
    case "strike":
      for (const r of op.rects) {
        const h = r[3] - r[1];
        ctx.lineWidth = Math.max(0.8, h * 0.075) * k;
        ctx.lineCap = "butt";
        const y = op.kind === "underline" ? r[3] - h * 0.13 : r[1] + h * 0.55;
        line(r[0], y, r[2], y);
      }
      break;
    case "ink":
      for (const s of op.strokes) smoothPath(ctx, s.map(([x, y]) => [X(x), Y(y)]));
      break;
    case "rect": {
      const [x0, y0, x1, y1] = op.box;
      ctx.strokeRect(X(x0), Y(y0), (x1 - x0) * k, (y1 - y0) * k);
      break;
    }
    case "ellipse": {
      const [x0, y0, x1, y1] = op.box;
      ctx.beginPath();
      ctx.ellipse(X((x0 + x1) / 2), Y((y0 + y1) / 2), ((x1 - x0) / 2) * k, ((y1 - y0) / 2) * k, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "line":
      line(...op.p);
      break;
    case "arrow":
      line(...op.p);
      for (const [hx, hy] of arrowHead(op)) line(op.p[2], op.p[3], hx, hy);
      break;
    case "check":
    case "cross":
      for (const s of glyph(op)) line(...s);
      break;
  }
  ctx.restore();
}

/** Trace lisse : courbes passant par le milieu de chaque segment. */
function smoothPath(ctx, pts) {
  if (pts.length === 1) {
    ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  ctx.lineTo(...pts[pts.length - 1]);
  ctx.stroke();
}

function arrowHead(op) {
  const [x0, y0, x1, y1] = op.p;
  const a = Math.atan2(y1 - y0, x1 - x0), h = headSize(op), spread = 0.45;
  return [
    [x1 - h * Math.cos(a - spread), y1 - h * Math.sin(a - spread)],
    [x1 - h * Math.cos(a + spread), y1 - h * Math.sin(a + spread)],
  ];
}

/** Segments d'une coche ou d'une croix inscrites dans leur cadre. */
function glyph(op) {
  const [x0, y0, x1, y1] = op.box, w = x1 - x0, h = y1 - y0;
  if (op.kind === "cross") return [[x0, y0, x1, y1], [x0, y1, x1, y0]];
  return [[x0, y0 + h * 0.55, x0 + w * 0.38, y1], [x0 + w * 0.38, y1, x1, y0]];
}

/* ---------------------------------------------------------------- export vectoriel */

/** Dessine l'annotation sur une page pdf-lib. `ph` est la hauteur de la page : pdf-lib
    compte les y depuis le bas, nos points depuis le haut. */
export function exportTo(page, op, ph) {
  const { rgb, LineCapStyle, BlendMode } = PDFLib;
  const color = rgbOf(op.color, rgb);
  const w = op.width || 1;
  const Y = (y) => ph - y;
  const line = (x0, y0, x1, y1, thickness = w, cap = LineCapStyle.Round) =>
    page.drawLine({ start: { x: x0, y: Y(y0) }, end: { x: x1, y: Y(y1) }, thickness, color, lineCap: cap });

  switch (op.kind) {
    case "highlight":
      for (const r of op.rects) {
        page.drawRectangle({
          x: r[0], y: Y(r[3]), width: r[2] - r[0], height: r[3] - r[1],
          color, opacity: HIGHLIGHT_ALPHA, blendMode: BlendMode.Multiply,
        });
      }
      break;
    case "underline":
    case "strike":
      for (const r of op.rects) {
        const h = r[3] - r[1];
        const y = op.kind === "underline" ? r[3] - h * 0.13 : r[1] + h * 0.55;
        line(r[0], y, r[2], y, Math.max(0.8, h * 0.075), LineCapStyle.Butt);
      }
      break;
    case "ink":
      for (const s of op.strokes) {
        if (s.length === 1) {
          page.drawCircle({ x: s[0][0], y: Y(s[0][1]), size: w / 2, color });
          continue;
        }
        page.drawSvgPath(svgPath(s), { x: 0, y: ph, borderColor: color, borderWidth: w, borderLineCap: LineCapStyle.Round });
      }
      break;
    case "rect": {
      const [x0, y0, x1, y1] = op.box;
      page.drawRectangle({ x: x0, y: Y(y1), width: x1 - x0, height: y1 - y0, borderColor: color, borderWidth: w });
      break;
    }
    case "ellipse": {
      const [x0, y0, x1, y1] = op.box;
      page.drawEllipse({
        x: (x0 + x1) / 2, y: Y((y0 + y1) / 2), xScale: (x1 - x0) / 2, yScale: (y1 - y0) / 2,
        borderColor: color, borderWidth: w,
      });
      break;
    }
    case "line":
      line(...op.p);
      break;
    case "arrow":
      line(...op.p);
      for (const [hx, hy] of arrowHead(op)) line(op.p[2], op.p[3], hx, hy);
      break;
    case "check":
    case "cross":
      for (const s of glyph(op)) line(...s);
      break;
  }
}

/** Chemin SVG lisse equivalent a `smoothPath`, en coordonnees de page (y vers le bas). */
function svgPath(pts) {
  const f = (v) => Math.round(v * 100) / 100;
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    d += ` Q ${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return d + ` L ${f(lx)} ${f(ly)}`;
}

function rgbOf(hex, rgb) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Simplifie un trait a main levee : retire les points trop proches les uns des autres,
    qui alourdissent le fichier sans changer le dessin. */
export function simplify(stroke, minDist) {
  if (stroke.length < 3) return stroke;
  const out = [stroke[0]];
  for (let i = 1; i < stroke.length - 1; i++) {
    const [px, py] = out[out.length - 1], [x, y] = stroke[i];
    if (Math.hypot(x - px, y - py) >= minDist) out.push(stroke[i]);
  }
  out.push(stroke[stroke.length - 1]);
  return out;
}
