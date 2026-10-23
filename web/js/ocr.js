/* Lecture du texte d'une page scannee (Tesseract compile en WebAssembly). */

const MIN_CONF = 35;
let workerPromise = null;

/** Le worker est cree une seule fois : son initialisation telecharge le moteur et les
    donnees de langue, ce qui pese quelques megaoctets. */
export function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker(["fra", "eng"], 1, {
      workerPath: "vendor/tesseract/worker.min.js",
      corePath: "vendor/tesseract/",
      langPath: "vendor/tessdata",
      gzip: true,
      logger: (m) => {
        if (onProgress && m.status) onProgress(m);
      },
    }).catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

/** Pente de la ligne en degres, d'apres les centres des mots.
    Sur un document photographie de travers elle vaut quelques degres ; la retirer evite de
    confondre cette rotation avec un texte italique. */
function lineSlope(words) {
  if (words.length < 2) return 0;
  const xs = words.map((w) => (w.bbox[0] + w.bbox[2]) / 2);
  const ys = words.map((w) => (w.bbox[1] + w.bbox[3]) / 2);
  const n = xs.length;
  const mx = xs.reduce((a, v) => a + v, 0) / n;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den < 1e-6) return 0;
  return (Math.atan(num / den) * 180) / Math.PI;
}

/** Coupe une ligne la ou un large blanc separe deux colonnes.
    Tesseract rend "Total a payer      1 350,00 EUR" comme une seule ligne ; la traiter d'un
    bloc rendrait le libelle et le montant inseparables a l'edition. */
function splitColumns(words) {
  if (words.length < 2) return words.length ? [words] : [];
  const heights = words.map((w) => w.bbox[3] - w.bbox[1]).sort((a, b) => a - b);
  const ref = heights[Math.floor(heights.length / 2)] || 10;
  const out = [];
  let cur = [words[0]];
  for (let i = 1; i < words.length; i++) {
    if (words[i].bbox[0] - words[i - 1].bbox[2] > ref * 1.8) { out.push(cur); cur = [words[i]]; }
    else cur.push(words[i]);
  }
  out.push(cur);
  return out.filter((c) => c.length);
}

/** Retourne les lignes lues : {text, bbox, conf, words, slope}. */
export async function ocrLines(canvas, onProgress) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(canvas, {}, { blocks: true });

  const raw = [];
  const collect = (line) => {
    const words = (line.words || [])
      .filter((w) => (w.text || "").trim() && w.confidence >= MIN_CONF)
      .map((w) => ({ text: w.text.trim(), bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1], conf: w.confidence }));
    if (words.length) raw.push(words);
  };
  for (const block of data.blocks || []) {
    for (const par of block.paragraphs || []) for (const line of par.lines || []) collect(line);
  }

  const lines = [];
  for (const words of raw) {
    words.sort((a, b) => a.bbox[0] - b.bbox[0]);
    for (const seg of splitColumns(words)) {
      const bbox = [
        Math.min(...seg.map((w) => w.bbox[0])), Math.min(...seg.map((w) => w.bbox[1])),
        Math.max(...seg.map((w) => w.bbox[2])), Math.max(...seg.map((w) => w.bbox[3])),
      ];
      lines.push({
        text: seg.map((w) => w.text).join(" "),
        bbox,
        conf: Math.round(seg.reduce((a, w) => a + w.conf, 0) / seg.length),
        words: seg,
        slope: lineSlope(seg),
      });
    }
  }
  return lines;
}
