// The terrain height grid (data/zurich-terrain.bin, written by tools/build-zurich-terrain.mjs) and its exact surface.
// Pure functions shared by the data tools and the browser: no I/O here.
//
// The surface is piecewise planar: every grid cell is split into two triangles along the diagonal from node (i, j) to
// node (i + 1, j + 1). The rendered terrain mesh uses the same triangulation, so groundHeight() is exactly the height
// of the drawn ground.

export function parseTerrain(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'ZTR1') throw new Error(`not a terrain grid (${magic})`);
  const cols = view.getUint16(4, true), rows = view.getUint16(6, true);
  const cell = view.getFloat32(8, true), minX = view.getFloat32(12, true), minZ = view.getFloat32(16, true);
  const scale = view.getFloat32(20, true);
  const raw = new Int16Array(buffer, 24, cols * rows);
  const heights = new Float32Array(cols * rows);
  for (let i = 0; i < heights.length; i++) heights[i] = raw[i] * scale;
  return { cols, rows, cell, minX, minZ, maxX: minX + (cols - 1) * cell, maxZ: minZ + (rows - 1) * cell, heights };
}

// Height of the triangulated surface of `grid` (a parsed terrain, or any { cols, rows, cell, minX, minZ, heights })
export function gridHeight(grid, x, z) {
  const { cols, rows, cell, minX, minZ, heights } = grid;
  let u = (x - minX) / cell, v = (z - minZ) / cell;
  u = u < 0 ? 0 : u > cols - 1 ? cols - 1 : u;
  v = v < 0 ? 0 : v > rows - 1 ? rows - 1 : v;
  let i = Math.floor(u), j = Math.floor(v);
  if (i >= cols - 1) i = cols - 2;
  if (j >= rows - 1) j = rows - 2;
  const fu = u - i, fv = v - j, k = j * cols + i;
  const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + cols], h11 = heights[k + cols + 1];
  return fu >= fv ? h00 + fu * (h10 - h00) + fv * (h11 - h10) : h00 + fv * (h01 - h00) + fu * (h11 - h01);
}

// Unit normal of the surface triangle under (x, z), written into `out` ({ x, y, z })
export function gridNormal(grid, x, z, out = { x: 0, y: 1, z: 0 }) {
  const { cols, rows, cell, minX, minZ, heights } = grid;
  let u = (x - minX) / cell, v = (z - minZ) / cell;
  u = u < 0 ? 0 : u > cols - 1 ? cols - 1 : u;
  v = v < 0 ? 0 : v > rows - 1 ? rows - 1 : v;
  let i = Math.floor(u), j = Math.floor(v);
  if (i >= cols - 1) i = cols - 2;
  if (j >= rows - 1) j = rows - 2;
  const k = j * cols + i;
  const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + cols], h11 = heights[k + cols + 1];
  // Slopes dh/dx, dh/dz of the plane through the three corners of the triangle
  const upper = u - i >= v - j;
  const sx = (upper ? h10 - h00 : h11 - h01) / cell;
  const sz = (upper ? h11 - h10 : h01 - h00) / cell;
  const n = Math.hypot(sx, 1, sz);
  out.x = -sx / n; out.y = 1 / n; out.z = -sz / n;
  return out;
}

// Splits triangles until no edge is longer than `maxEdge` (in x/z), by bisecting the longest edge, so that a flat layer
// can follow the terrain closely once each vertex is lifted onto it. `positions` is a flat [x, y, z, ...] triangle
// list; returns { positions, weights, sources }: the new triangle list (y interpolated), and for every new vertex the
// barycentric weights (3 per vertex) on the vertices of its source triangle (`sources`: source triangle index per new
// vertex), so that any other attribute can be carried over.
export function subdivideTriangles(positions, maxEdge) {
  const max2 = maxEdge * maxEdge;
  const outPos = [], outW = [], outSrc = [];
  const stack = [];
  for (let t = 0, tri = 0; t < positions.length; t += 9, tri++) {
    const v = (k) => [positions[t + k * 3], positions[t + k * 3 + 1], positions[t + k * 3 + 2], k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
    stack.push([v(0), v(1), v(2)]);
    while (stack.length) {
      const [a, b, c] = stack.pop();
      const ab = (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2, bc = (b[0] - c[0]) ** 2 + (b[2] - c[2]) ** 2, ca = (c[0] - a[0]) ** 2 + (c[2] - a[2]) ** 2;
      const longest = Math.max(ab, bc, ca);
      if (longest > max2) {
        // Bisect the longest edge, keeping the winding
        const mid = (p, q) => p.map((x, i) => (x + q[i]) / 2);
        if (longest === ab) { const m = mid(a, b); stack.push([a, m, c], [m, b, c]); }
        else if (longest === bc) { const m = mid(b, c); stack.push([a, b, m], [a, m, c]); }
        else { const m = mid(c, a); stack.push([a, b, m], [m, b, c]); }
        continue;
      }
      for (const p of [a, b, c]) { outPos.push(p[0], p[1], p[2]); outW.push(p[3], p[4], p[5]); outSrc.push(tri); }
    }
  }
  return { positions: new Float32Array(outPos), weights: new Float32Array(outW), sources: new Uint32Array(outSrc) };
}
