import assert from 'node:assert/strict';
import test from 'node:test';
import { gridHeight, gridNormal, subdivideTriangles, fillCuts } from '../js/terrain-grid.js';

// A small rough grid: 9 x 7 nodes, 4 m cells, pseudo-random heights with a quay-like step
const cols = 9, rows = 7, cell = 4;
const heights = new Float32Array(cols * rows);
for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
  heights[j * cols + i] = Math.sin(i * 1.7 + j * 0.9) * 3 + (i > 4 ? -3.5 : 0) + j * 0.4;
}
const grid = { cols, rows, cell, minX: -10, minZ: 20, heights };

test('the surface passes through every node and is planar inside each triangle', () => {
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    assert.ok(Math.abs(gridHeight(grid, -10 + i * cell, 20 + j * cell) - heights[j * cols + i]) < 1e-5);
  }
  // Inside the upper triangle (fu >= fv) of cell (2, 3) the height is linear in x and z
  const h = (x, z) => gridHeight(grid, x, z);
  const x0 = -10 + 2 * cell, z0 = 20 + 3 * cell;
  const a = h(x0 + 2, z0 + 0.5), c = h(x0 + 3.5, z0 + 1.5);
  assert.ok(Math.abs(h(x0 + 2.75, z0 + 1) - (a + c) / 2) < 1e-4);
});

test('the normal matches the slope of the surface', () => {
  const n = gridNormal(grid, 3.3, 31.1);
  const e = 0.01, dx = (gridHeight(grid, 3.3 + e, 31.1) - gridHeight(grid, 3.3 - e, 31.1)) / (2 * e);
  const dz = (gridHeight(grid, 3.3, 31.1 + e) - gridHeight(grid, 3.3, 31.1 - e)) / (2 * e);
  assert.ok(Math.abs(-n.x / n.y - dx) < 1e-3 && Math.abs(-n.z / n.y - dz) < 1e-3);
});

test('subdivision bounds the edges, keeps the area and the winding, and carries barycentric weights', () => {
  const tris = new Float32Array([
    -9.3, 0.07, 21.2, 3.3, 0.07, 44.6, 20.1, 0.07, 23.9, // a large road-like triangle
    0.5, 0.02, 30.5, 0.9, 0.02, 31.4, 1.5, 0.02, 30.7 // a small one, left whole
  ]);
  const { positions, weights, sources } = subdivideTriangles(tris, 4);
  assert.equal(positions.length % 9, 0);
  assert.equal(weights.length, positions.length);
  assert.equal(sources.length, positions.length / 3);
  const signed = (p, t) => ((p[t + 3] - p[t]) * (p[t + 8] - p[t + 2]) - (p[t + 6] - p[t]) * (p[t + 5] - p[t + 2])) / 2;
  const before = signed(tris, 0) + signed(tris, 9);
  let after = 0;
  for (let t = 0; t < positions.length; t += 9) {
    after += signed(positions, t);
    assert.equal(Math.sign(signed(positions, t)), Math.sign(signed(tris, sources[t / 3] * 9)), 'winding kept');
    for (const [i, j] of [[0, 3], [3, 6], [6, 0]]) {
      assert.ok(Math.hypot(positions[t + i] - positions[t + j], positions[t + i + 2] - positions[t + j + 2]) <= 4 + 1e-6);
    }
  }
  assert.ok(Math.abs(before - after) < 1e-3, `${before} vs ${after}`);
  assert.equal(sources.filter((s) => s === 1).length, 3, 'small triangle untouched');
  for (let v = 0; v < sources.length; v++) {
    const s = sources[v] * 9;
    const x = weights[v * 3] * tris[s] + weights[v * 3 + 1] * tris[s + 3] + weights[v * 3 + 2] * tris[s + 6];
    assert.ok(Math.abs(x - positions[v * 3]) < 1e-4);
  }
});

test('fillCuts raises the trench leading to a seed, not the hollows beyond it nor the skipped ground', () => {
  // 40 x 20 nodes, 4 m cells, level at 5 m. A street runs along z = 40 from x = 0 to 156: a 3 m trench from x = 8 to
  // 72 (the seed, a tunnel mouth, at x = 72), another hollow from x = 104 to 132; the trench's far end (x = 8) is skipped.
  const g = { cols: 40, rows: 20, cell: 4, minX: 0, minZ: 0, heights: new Float32Array(800).fill(5) };
  const node = (x, z) => (z / 4) * 40 + x / 4;
  for (let x = 8; x <= 132; x += 4) for (const z of [36, 40, 44]) if (x <= 72 || x >= 104) g.heights[node(x, z)] = 2;
  const before = Float32Array.from(g.heights);
  const n = fillCuts(g, [{ pts: [0, 40, 156, 40], half: 6 }], { seeds: [{ x: 72, z: 40, r: 6 }], skip: (x) => x === 8 });
  assert.ok(n > 0);
  for (let x = 16; x <= 68; x += 4) assert.ok(g.heights[node(x, 40)] > 4, `trench at x = ${x}: ${g.heights[node(x, 40)]}`);
  assert.equal(g.heights[node(8, 40)], 2, 'skipped node');
  for (let x = 104; x <= 132; x += 4) assert.equal(g.heights[node(x, 40)], 2, `hollow beyond the trench at x = ${x}`);
  for (let k = 0; k < before.length; k++) assert.ok(g.heights[k] >= before[k], 'only raises');
});
