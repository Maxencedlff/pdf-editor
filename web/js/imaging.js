/* Traitement pixel : separation encre/papier, mesures de texture, effacement, redessin.
   Travaille sur des ImageData (RGBA). */

import * as fonts from "./fonts.js";

export function clampBox(box, w, h, pad = 0) {
  let [x0, y0, x1, y1] = box;
  x0 = Math.max(0, Math.min(w - 1, Math.round(x0) - pad));
  y0 = Math.max(0, Math.min(h - 1, Math.round(y0) - pad));
  x1 = Math.max(x0 + 1, Math.min(w, Math.round(x1) + pad));
  y1 = Math.max(y0 + 1, Math.min(h, Math.round(y1) + pad));
  return [x0, y0, x1, y1];
}

/** Extrait une sous-region en niveaux de gris + les canaux RGB. */
export function grayOf(img, box) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0, h = y1 - y0;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let p = ((y + y0) * img.width + x0) * 4;
    for (let x = 0; x < w; x++, p += 4) {
      gray[y * w + x] = (img.data[p] * 299 + img.data[p + 1] * 587 + img.data[p + 2] * 114) / 1000;
    }
  }
  return { gray, w, h };
}

function otsu(gray) {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** Separe encre et papier. Le seuil d'Otsu ne dit pas de quel cote est le texte : on
    tranche en supposant que l'encre est minoritaire. */
export function inkMask(gray, w, h) {
  const thr = otsu(gray);
  const data = new Uint8Array(w * h);
  let dark = 0;
  for (let i = 0; i < gray.length; i++) {
    data[i] = gray[i] <= thr ? 1 : 0;
    dark += data[i];
  }
  if (dark / gray.length > 0.55) {
    for (let i = 0; i < data.length; i++) data[i] = 1 - data[i];
    return { mask: { data, w, h }, darkText: false };
  }
  return { mask: { data, w, h }, darkText: true };
}

function dilate(mask, iterations = 1) {
  let cur = mask.data;
  const { w, h } = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (cur[p] ||
            (x > 0 && cur[p - 1]) || (x < w - 1 && cur[p + 1]) ||
            (y > 0 && cur[p - w]) || (y < h - 1 && cur[p + w])) next[p] = 1;
      }
    }
    cur = next;
  }
  return { data: cur, w, h };
}

function erode(mask) {
  const { w, h } = mask, cur = mask.data;
  const next = new Uint8Array(cur.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (cur[p] && cur[p - 1] && cur[p + 1] && cur[p - w] && cur[p + w]) next[p] = 1;
    }
  }
  return { data: next, w, h };
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.floor(s.length / 2)];
};

/** Couleur de l'encre et du papier dans une zone de texte. */
export function sampleColors(img, box) {
  const b = clampBox(box, img.width, img.height);
  const { gray, w, h } = grayOf(img, b);
  const { mask, darkText } = inkMask(gray, w, h);

  // Coeur du trait : on erode pour ne garder que les pixels pleinement encres, sinon
  // l'antialiasing delave la couleur mesuree.
  let core = erode(mask);
  let count = core.data.reduce((a, v) => a + v, 0);
  if (count < 12) core = mask;

  const chans = [[], [], []];
  const bg = [[], [], []];
  const far = dilate(mask, 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((y + b[1]) * img.width + x + b[0]) * 4;
      const i = y * w + x;
      if (core.data[i]) { chans[0].push(img.data[p]); chans[1].push(img.data[p + 1]); chans[2].push(img.data[p + 2]); }
      else if (!far.data[i]) { bg[0].push(img.data[p]); bg[1].push(img.data[p + 1]); bg[2].push(img.data[p + 2]); }
    }
  }
  const ink = chans[0].length ? chans.map(median) : [0, 0, 0];
  const paper = bg[0].length > 20 ? bg.map(median) : [255, 255, 255];

  // Bruit du papier, mesure hors encre.
  let noise = 99;
  if (bg[0].length > 30) {
    const m = bg[0].reduce((a, v) => a + v, 0) / bg[0].length;
    noise = Math.sqrt(bg[0].reduce((a, v) => a + (v - m) * (v - m), 0) / bg[0].length);
  }
  return { ink, paper, darkText, mask, gray, box: b, noise };
}

/** Flou du scan, mesure sur la largeur des transitions encre/papier.
    Un contour net ne compte qu'un ou deux pixels intermediaires ; un scan empate en compte
    bien plus. Le rapport a la longueur du contour donne l'ordre de grandeur du flou. */
export function blurSigma(gray, mask) {
  const ink = [], bgv = [];
  for (let i = 0; i < gray.length; i++) (mask.data[i] ? ink : bgv).push(gray[i]);
  if (ink.length < 8 || bgv.length < 16) return 0;
  const inkL = median(ink), paperL = median(bgv);
  const span = Math.abs(paperL - inkL);
  if (span < 25) return 0;
  const lo = Math.min(inkL, paperL) + 0.3 * span, hi = Math.min(inkL, paperL) + 0.7 * span;
  let mid = 0;
  for (const v of gray) if (v > lo && v < hi) mid++;
  const er = erode(mask);
  let edge = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] && !er.data[i]) edge++;
  if (edge < 8) return 0;
  return Math.max(0, Math.min(2.2, (0.5 * mid) / edge));
}

/* --------------------------------------------------------------- effacement */
function rngFrom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const gauss = (rnd) => {
  const u = Math.max(1e-9, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** Efface une zone en reconstituant le fond.
    Faute d'inpainting, on interpole le fond depuis les bords du masque, horizontalement et
    verticalement : sur du texte pose sur un papier, le resultat est indiscernable. Le grain
    est ensuite redonne, car une surface lisse au milieu d'un papier numerise se repere
    aussitot. */
export function erase(img, box, seed = 1) {
  const b = clampBox(box, img.width, img.height, 2);
  const { gray, w, h } = grayOf(img, b);
  const { mask } = inkMask(gray, w, h);
  const cover = mask.data.reduce((a, v) => a + v, 0) / mask.data.length;
  const hole = dilate(mask, 2);

  // Couleur et grain du fond, mesures hors encre.
  const bgPix = [[], [], []];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (hole.data[y * w + x]) continue;
      const p = ((y + b[1]) * img.width + x + b[0]) * 4;
      bgPix[0].push(img.data[p]); bgPix[1].push(img.data[p + 1]); bgPix[2].push(img.data[p + 2]);
    }
  }
  const fill = bgPix[0].length > 8 ? bgPix.map(median) : [255, 255, 255];
  let grain = 0;
  if (bgPix[0].length > 30) {
    const m = bgPix[0].reduce((a, v) => a + v, 0) / bgPix[0].length;
    grain = Math.min(24, Math.sqrt(bgPix[0].reduce((a, v) => a + (v - m) * (v - m), 0) / bgPix[0].length));
  }

  const flat = cover > 0.62 || bgPix[0].length < 30;
  const rnd = rngFrom(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!flat && !hole.data[i]) continue;
      const p = ((y + b[1]) * img.width + x + b[0]) * 4;
      let col = fill;
      if (!flat) {
        col = interpolate(img, b, hole, x, y, w, h) || fill;
      }
      const n = grain > 0.6 ? gauss(rnd) * grain : 0;
      img.data[p] = Math.max(0, Math.min(255, col[0] + n));
      img.data[p + 1] = Math.max(0, Math.min(255, col[1] + n));
      img.data[p + 2] = Math.max(0, Math.min(255, col[2] + n));
    }
  }
  return grain;
}

/** Moyenne ponderee des premiers pixels de fond rencontres dans les quatre directions. */
function interpolate(img, b, hole, x, y, w, h) {
  const acc = [0, 0, 0];
  let weight = 0;
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dx, dy] of dirs) {
    let cx = x + dx, cy = y + dy, steps = 1;
    while (cx >= 0 && cy >= 0 && cx < w && cy < h && hole.data[cy * w + cx] && steps < 90) {
      cx += dx; cy += dy; steps++;
    }
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    const p = ((cy + b[1]) * img.width + cx + b[0]) * 4;
    const wt = 1 / steps;
    acc[0] += img.data[p] * wt; acc[1] += img.data[p + 1] * wt; acc[2] += img.data[p + 2] * wt;
    weight += wt;
  }
  return weight ? [acc[0] / weight, acc[1] / weight, acc[2] / weight] : null;
}

/* --------------------------------------------------------------- redessin */
/** Retrouve la baseline a partir du haut d'encre observe, via les metriques de la police. */
export function baselineFromInk(entry, text, sizePx, inkTop) {
  const m = fonts.metrics(entry, text || "X", sizePx);
  return inkTop + m.ascent;
}

/** Dessine du texte en lui faisant subir la meme chaine que le document d'origine.
    Un scan n'est pas flou, il est aliase : ses transitions encre/papier tiennent en un
    pixel, la ou le rendu d'une police les etale en un degrade regulier. C'est cet ecart de
    nettete, plus que la forme des lettres, qui trahit une retouche. */
export function drawText(img, opts) {
  const {
    text, entry, sizePx, color, x, baseline,
    align = "left", boxRight = null, tracking = 0, blur = 0, grain = 0, seed = 1,
  } = opts;
  if (!text) return;

  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.font = fonts.cssFont(entry, sizePx);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#000";

  const m = fonts.metrics(entry, text, sizePx);
  const width = m.advance + tracking * fonts.trackingSlots(text);
  let ox = x + m.left;
  if ((align === "center" || align === "right") && boxRight !== null) {
    const span = boxRight - x;
    ox = x + m.left + (span - width) * (align === "center" ? 0.5 : 1);
  }

  if (Math.abs(tracking) < 0.05) {
    ctx.fillText(text, ox, baseline);
  } else {
    // Pas d'interlettrage portable en canvas : on avance glyphe par glyphe.
    let cx = ox;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      ctx.fillText(ch, cx, baseline);
      const next = i + 1 < text.length ? text[i + 1] : " ";
      cx += ctx.measureText(ch).width + (/\s/.test(ch) || /\s/.test(next) ? 0 : tracking);
    }
  }

  const layer = ctx.getImageData(0, 0, c.width, c.height);
  const n = img.width * img.height;
  const alpha = new Float32Array(n);
  let any = false;
  for (let i = 0, p = 3; i < n; i++, p += 4) {
    const a = layer.data[p] / 255;
    alpha[i] = a;
    if (a > 0.02) any = true;
  }
  if (!any) return;

  const rnd = rngFrom(seed);
  const k = Math.max(1, Math.min(7, 0.75 / Math.max(blur, 0.12)));
  const noiseAmp = 0.1 + (grain / 255) * 2;
  for (let i = 0; i < n; i++) {
    let a = alpha[i];
    if (a <= 0.001 && a >= 0) {
      if (a === 0) continue;
    }
    // Irregularites d'encrage, puis durcissement : combines, ils donnent les bords
    // legerement dechiquetes d'un caractere imprime puis numerise.
    a += gauss(rnd) * noiseAmp;
    if (blur > 0.6) a = alpha[i];
    else a = (a - 0.5) * k + 0.5;
    alpha[i] = Math.max(0, Math.min(1, a));
  }

  const sensor = grain > 0.6 ? grain * 0.7 : 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = alpha[i];
    if (a <= 0.002) continue;
    const ns = sensor ? gauss(rnd) * sensor : 0;
    img.data[p] = Math.max(0, Math.min(255, img.data[p] * (1 - a) + color[0] * a + ns));
    img.data[p + 1] = Math.max(0, Math.min(255, img.data[p + 1] * (1 - a) + color[1] * a + ns));
    img.data[p + 2] = Math.max(0, Math.min(255, img.data[p + 2] * (1 - a) + color[2] * a + ns));
  }
}

export const hexOf = (rgb) =>
  "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
export const rgbOf = (hex) => {
  const s = (hex || "#000000").replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) || 0);
};
