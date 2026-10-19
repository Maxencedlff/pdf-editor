// Tests de la geometrie des annotations (logique pure, sans navigateur) :
//   node --test tests/web/
import { test } from "node:test";
import assert from "node:assert/strict";
import * as marks from "../../web/js/marks.js";

const line = (y, x0 = 50, x1 = 300) => ({ bbox: [x0, y, x1, y + 14], inkTop: y + 2, size: 11 });

test("un geste sur une ligne la surligne entre les deux doigts", () => {
  const r = marks.textRects([line(100)], { x: 100, y: 107 }, { x: 200, y: 107 });
  assert.equal(r.length, 1);
  assert.deepEqual([r[0][0], r[0][2]], [100, 200]);
});

test("un geste presque bout a bout prend la ligne entiere", () => {
  const [r] = marks.textRects([line(100)], { x: 55, y: 107 }, { x: 296, y: 107 });
  assert.deepEqual([r[0], r[2]], [50, 300]);
});

test("sur plusieurs lignes : debut au doigt, lignes du milieu entieres, fin au doigt", () => {
  const items = [line(100), line(120), line(140)];
  const r = marks.textRects(items, { x: 150, y: 105 }, { x: 120, y: 145 });
  assert.equal(r.length, 3);
  assert.deepEqual([r[0][0], r[0][2]], [150, 300]);
  assert.deepEqual([r[1][0], r[1][2]], [50, 300]);
  assert.deepEqual([r[2][0], r[2][2]], [50, 120]);
});

test("le cadre d'un rectangle compte l'epaisseur du trait", () => {
  assert.deepEqual(marks.bounds({ kind: "rect", width: 2, box: [10, 10, 50, 30] }), [9, 9, 51, 31]);
});

test("deplacer puis agrandir un trait garde sa forme", () => {
  const op = { type: "mark", kind: "ink", width: 2, uid: "x", strokes: [[[0, 0], [10, 10]]] };
  const moved = marks.translated(op, 5, 5);
  assert.deepEqual(moved.strokes[0], [[5, 5], [15, 15]]);
  assert.equal(moved.uid, undefined, "une copie est une nouvelle operation");
  const big = marks.rescaled(moved, [5, 5, 15, 15], [5, 5, 25, 25]);
  assert.deepEqual(big.strokes[0], [[5, 5], [25, 25]]);
  assert.equal(big.width, 4);
});

test("simplifier retire les points serres mais garde les extremites", () => {
  const s = [[0, 0], [0.1, 0], [0.2, 0], [5, 0], [5.1, 0]];
  assert.deepEqual(marks.simplify(s, 1), [[0, 0], [5, 0], [5.1, 0]]);
});
