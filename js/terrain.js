import * as THREE from 'three/webgpu';
import { parseTerrain, gridHeight, gridNormal, subdivideTriangles } from './terrain-grid.js';
import { ZURICH_DATA } from './zurich-geodata.js';

// Zurich's relief for the engine (which was written for a flat Manhattan at y = 0).
//  - groundHeight(x, z): the bare-earth surface (swissALTI3D, data/zurich-terrain.bin), exactly as the terrain mesh
//    draws it (see terrain-grid.js).
//  - deckHeight(x, z): the surveyed deck of the bridge under (x, z) (tools/build-zurich-geodata.mjs, roads[].ys), or NaN.
//  - surfaceHeight(x, z, nearY): what an actor at height ~nearY stands on: the deck when on a bridge, unless it is
//    clearly passing underneath (the Hardbrücke spans streets and the tracks).
//  - Static geometry built flat by the engine is laid onto the surface afterwards: drapeOverlay() for ground layers
//    (roads, paths, lawns, rivers: subdivided and lifted vertex by vertex), placeOnTerrain() for everything else
//    (street furniture, trees, facades, …).

const TERRAIN_URL = new URL('../data/zurich-terrain.bin', import.meta.url);

// Heights of the drawn surfaces above the terrain. The engine's flat world has the roadway at 0 and raised sidewalks
// (0.22 m, city-config.js ISLAND_BOUNDS.sidewalkHeight); here the terrain itself is the sidewalk, and the roads are
// laid on it (city-grid.js: 0.06 m layer + drapeOverlay's 0.05 m lift).
export const ROAD_TOP = 0.11;
export const SIDEWALK_TOP = 0;
const ENGINE_SIDEWALK = 0.22;
// Flat-world objects standing on the engine's sidewalks (their base at 0.15-0.3 m) stand on the terrain instead
const sidewalkDrop = (base) => (base >= 0.15 && base <= 0.3 ? ENGINE_SIDEWALK - SIDEWALK_TOP : 0);

async function loadBinary(url) {
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    const b = await readFile(url);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
}

export const TERRAIN = parseTerrain(await loadBinary(TERRAIN_URL));

// Bridgeheads: the survey lowers the ground under bridges towards the river, bridgeheads included. The data tool lists
// where the surveyed road is higher (ZURICH_DATA.terrainPatches); the ground rises smoothly to meet it there (never
// inside the rivers and the lake).
{
  const pip = (ring, x, z) => { let inside = false; for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) { if ((ring[i + 1] > z) !== (ring[j + 1] > z) && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) inside = !inside; } return inside; };
  const inWater = (x, z) => ZURICH_DATA.water.some((w) => pip(w.ring, x, z) && !(w.holes || []).some((h) => pip(h, x, z)));
  const { cols, rows, cell, minX, minZ, heights } = TERRAIN;
  for (const { x, z, h, r } of ZURICH_DATA.terrainPatches || []) {
    for (let j = Math.max(0, Math.ceil((z - r - minZ) / cell)); j <= Math.min(rows - 1, Math.floor((z + r - minZ) / cell)); j++) {
      for (let i = Math.max(0, Math.ceil((x - r - minX) / cell)); i <= Math.min(cols - 1, Math.floor((x + r - minX) / cell)); i++) {
        const nx = minX + i * cell, nz = minZ + j * cell, d = Math.hypot(nx - x, nz - z);
        if (d > r || inWater(nx, nz)) continue;
        const t = 1 - d / r, w = t * t * (3 - 2 * t), k = j * cols + i;
        heights[k] = Math.max(heights[k], heights[k] + (h - heights[k]) * w);
      }
    }
  }
}
export const groundHeight = (x, z) => gridHeight(TERRAIN, x, z);
export const groundNormal = (x, z, out) => gridNormal(TERRAIN, x, z, out);

// --- Bridge decks -------------------------------------------------------------------------------------------------------
const DECK_CELL = 32;
const deckCells = new Map();
let deckSegments = 0;
for (const list of [ZURICH_DATA.roads, ZURICH_DATA.railways]) {
  for (const r of list) {
    if (!r.bridge || r.tunnel || !r.ys) continue;
    // Carriageway plus the sidewalks city-grid.js lays along it (width / 2 + 2.8 m), or a track bed
    const half = r.width ? r.width / 2 + (/^(footway|path|steps|cycleway|pedestrian)$/.test(r.kind) ? 0.6 : 3.2) : 3;
    for (let i = 0; i + 1 < r.ys.length; i++) {
      const s = { ax: r.pts[i * 2], az: r.pts[i * 2 + 1], bx: r.pts[i * 2 + 2], bz: r.pts[i * 2 + 3], ya: r.ys[i], yb: r.ys[i + 1], half, road: r };
      const ix0 = Math.floor((Math.min(s.ax, s.bx) - half) / DECK_CELL), ix1 = Math.floor((Math.max(s.ax, s.bx) + half) / DECK_CELL);
      const iz0 = Math.floor((Math.min(s.az, s.bz) - half) / DECK_CELL), iz1 = Math.floor((Math.max(s.az, s.bz) + half) / DECK_CELL);
      for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
        const k = ix * 65536 + iz;
        if (!deckCells.has(k)) deckCells.set(k, []);
        deckCells.get(k).push(s);
      }
      deckSegments++;
    }
  }
}

/** Height of the bridge deck under (x, z) (nearest bridge centreline within its half width), or NaN */
export function deckHeight(x, z) {
  const list = deckCells.get(Math.floor(x / DECK_CELL) * 65536 + Math.floor(z / DECK_CELL));
  if (!list) return NaN;
  let best = Infinity, h = NaN;
  for (const s of list) {
    const dx = s.bx - s.ax, dz = s.bz - s.az, L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / L2));
    const d = Math.hypot(s.ax + t * dx - x, s.az + t * dz - z);
    if (d <= s.half && d < best) { best = d; h = s.ya + t * (s.yb - s.ya); }
  }
  return h;
}

/** The surface at (x, z) for something at about `nearY`: a bridge deck, or the ground (also under a bridge) */
export function surfaceHeight(x, z, nearY) {
  const g = groundHeight(x, z);
  const d = deckHeight(x, z);
  if (!(d === d)) return g;
  if (nearY === undefined || d - g < 2) return d > g ? d : g;
  return Math.abs(nearY - d) <= Math.abs(nearY - g) ? d : g;
}

// --- Water level: the river and lake surfaces are the lowest ground within ~12 m (banks and quays rise above) --------
const WATER_LEVEL = (() => {
  const { cols, rows, heights } = TERRAIN, R = 3;
  const tmp = new Float32Array(heights.length), out = new Float32Array(heights.length);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let m = Infinity;
    for (let d = Math.max(0, i - R); d <= Math.min(cols - 1, i + R); d++) m = Math.min(m, heights[j * cols + d]);
    tmp[j * cols + i] = m;
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let m = Infinity;
    for (let d = Math.max(0, j - R); d <= Math.min(rows - 1, j + R); d++) m = Math.min(m, tmp[d * cols + i]);
    out[j * cols + i] = m;
  }
  return { ...TERRAIN, heights: out };
})();
export const waterSurfaceHeight = (x, z) => gridHeight(WATER_LEVEL, x, z);

/**
 * Per-node depths by which the drawn terrain sinks under the ground layers laid on it: the survey has kerb- and
 * rail-sized bumps that a road surface following it vertex by vertex every few metres would let poke through.
 * `strips`: [{ a: {x, z}, b: {x, z}, half }] (nodes within `half` of the centreline sink by `depth`).
 */
export function carveDepths(strips, depth = 0.3) {
  const { cols, rows, cell, minX, minZ } = TERRAIN;
  const depths = new Float32Array(cols * rows);
  for (const { a, b, half } of strips) {
    if (half <= 0) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(a.x, b.x) - half - minX) / cell)), i1 = Math.min(cols - 1, Math.floor((Math.max(a.x, b.x) + half - minX) / cell));
    const j0 = Math.max(0, Math.ceil((Math.min(a.z, b.z) - half - minZ) / cell)), j1 = Math.min(rows - 1, Math.floor((Math.max(a.z, b.z) + half - minZ) / cell));
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = minX + i * cell, z = minZ + j * cell;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
      if (Math.hypot(a.x + t * dx - x, a.z + t * dz - z) <= half) depths[j * cols + i] = Math.max(depths[j * cols + i], depth);
    }
  }
  return depths;
}

// --- Terrain mesh (same triangulation as gridHeight), in square chunks for culling ---------------------------------------
// `carve(x, z)`: metres to sink the drawn node by; `depths`: per-node sinking (carveDepths), both optional
export function buildTerrainMeshes(material, { chunk = 64, carve = null, depths = null } = {}) {
  const { cols, rows, cell, minX, minZ, heights } = TERRAIN;
  const meshes = [];
  const n = { x: 0, y: 1, z: 0 };
  for (let j0 = 0; j0 < rows - 1; j0 += chunk) for (let i0 = 0; i0 < cols - 1; i0 += chunk) {
    const nc = Math.min(chunk, cols - 1 - i0) + 1, nr = Math.min(chunk, rows - 1 - j0) + 1;
    const positions = new Float32Array(nc * nr * 3), normals = new Float32Array(nc * nr * 3);
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      const i = i0 + c, j = j0 + r, v = (r * nc + c) * 3;
      const x = minX + i * cell, z = minZ + j * cell;
      positions[v] = x; positions[v + 2] = z;
      positions[v + 1] = heights[j * cols + i] - Math.max(carve ? carve(x, z) : 0, depths ? depths[j * cols + i] : 0);
      // Vertex normal: the average slope around the node (shading only; the surface itself stays planar per triangle)
      const hl = heights[j * cols + Math.max(0, i - 1)], hr = heights[j * cols + Math.min(cols - 1, i + 1)];
      const hu = heights[Math.max(0, j - 1) * cols + i], hd = heights[Math.min(rows - 1, j + 1) * cols + i];
      n.x = (hl - hr) / (2 * cell); n.z = (hu - hd) / (2 * cell); n.y = 1;
      const len = Math.hypot(n.x, n.y, n.z);
      normals[v] = n.x / len; normals[v + 1] = n.y / len; normals[v + 2] = n.z / len;
    }
    const index = new Uint32Array((nc - 1) * (nr - 1) * 6);
    let k = 0;
    for (let r = 0; r < nr - 1; r++) for (let c = 0; c < nc - 1; c++) {
      const a = r * nc + c;
      index[k++] = a; index[k++] = a + nc + 1; index[k++] = a + 1;
      index[k++] = a; index[k++] = a + nc; index[k++] = a + nc + 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    mesh.name = `terrain ${i0}/${j0}`;
    meshes.push(mesh);
  }
  return meshes;
}

// --- Laying flat engine geometry onto the surface -------------------------------------------------------------------------
function interpolateAttribute(attr, weights, sources) {
  const size = attr.itemSize, src = attr.array, n = sources.length;
  const out = new (attr.normalized ? src.constructor : Float32Array)(n * size);
  for (let v = 0; v < n; v++) {
    const base = sources[v] * 3;
    for (let c = 0; c < size; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += weights[v * 3 + k] * src[(base + k) * size + c];
      out[v * size + c] = attr.normalized ? Math.round(s) : s;
    }
  }
  return new THREE.BufferAttribute(out, size, attr.normalized);
}

/**
 * A flat ground layer (built at a small y offset over a flat world) laid on the terrain: subdivided until no edge is
 * longer than `maxEdge` (the city's streets are smooth at that scale), every vertex lifted onto the surface plus `lift`
 * (so that the chords between vertices stay above the ground), with the terrain's normals.
 * `deck`: the layer belongs to a bridge and follows its deck. `surface`: 'ground' (default) or 'water'.
 */
export function drapeOverlay(geometry, { deck = false, surface = 'ground', maxEdge = 8, lift = 0.05 } = {}) {
  const heightAt = deck ? (x, z) => surfaceHeight(x, z) : surface === 'water' ? waterSurfaceHeight : groundHeight;
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const { positions, weights, sources } = subdivideTriangles(g.attributes.position.array, maxEdge);
  const normals = new Float32Array(positions.length);
  const n = { x: 0, y: 1, z: 0 };
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v], z = positions[v + 2];
    positions[v + 1] += heightAt(x, z) + lift;
    groundNormal(x, z, n);
    normals[v] = n.x; normals[v + 1] = n.y; normals[v + 2] = n.z;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  for (const [name, attr] of Object.entries(g.attributes)) {
    if (name !== 'position' && name !== 'normal') out.setAttribute(name, interpolateAttribute(attr, weights, sources));
  }
  out.computeBoundingSphere(); out.computeBoundingBox();
  if (g !== geometry) g.dispose();
  return out;
}

/** Lifts every vertex by the surface height under it (small solids: curbs, walls; `deck` follows bridge decks) */
export function displaceGeometry(geometry, { deck = false } = {}) {
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, p.getY(i) + (deck ? surfaceHeight(x, z) : groundHeight(x, z)));
  }
  p.needsUpdate = true;
  geometry.computeBoundingSphere(); geometry.computeBoundingBox();
  return geometry;
}

const RIGID_RADIUS = 20;
const _box = new THREE.Box3(), _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();
const isIdentity = (m) => m.equals(_m.identity());

/**
 * Lays an engine-built static subtree (built for a flat world) onto the terrain:
 *  - small objects (< 20 m) and groups of them move rigidly by the surface height under their centre, staying upright;
 *  - instanced meshes move each instance the same way;
 *  - both come down from the engine's raised sidewalks onto the terrain (sidewalkDrop);
 *  - large flat meshes (ground decals: road paint, plazas) are draped; other large merged meshes are displaced per vertex.
 * Subtrees whose userData.terrain is 'absolute' (already in world heights) are left alone.
 */
export function placeOnTerrain(root, stats = { rigid: 0, instances: 0, draped: 0, displaced: 0 }) {
  root.updateMatrixWorld(true);
  const visit = (obj) => {
    if (obj.userData.terrain === 'absolute' || obj.userData.terrainPlaced) return;
    obj.userData.terrainPlaced = true;
    if (obj.isInstancedMesh) {
      if (obj.instanceMatrix.usage === THREE.DynamicDrawUsage) return; // driven every frame by its owner
      _inv.copy(obj.matrixWorld).invert();
      const lifted = new THREE.Vector3();
      for (let i = 0; i < obj.count; i++) {
        obj.getMatrixAt(i, _m);
        _v.setFromMatrixPosition(_m).applyMatrix4(obj.matrixWorld);
        // The world-space lift expressed in the mesh's own frame
        lifted.copy(_v).setY(_v.y + surfaceHeight(_v.x, _v.z) - sidewalkDrop(_v.y)).applyMatrix4(_inv);
        _m.elements[12] = lifted.x; _m.elements[13] = lifted.y; _m.elements[14] = lifted.z;
        obj.setMatrixAt(i, _m);
      }
      obj.instanceMatrix.needsUpdate = true;
      obj.computeBoundingSphere?.(); obj.computeBoundingBox?.();
      stats.instances += obj.count;
      return;
    }
    {
      _box.setFromObject(obj, true);
      const size = _box.isEmpty() ? null : _box.getSize(new THREE.Vector3());
      const radius = size ? Math.hypot(size.x, size.z) / 2 : 0;
      if (!size || radius <= RIGID_RADIUS) {
        const c = size ? _box.getCenter(new THREE.Vector3()) : _v.setFromMatrixPosition(obj.matrixWorld);
        const dy = surfaceHeight(c.x, c.z) - (size ? sidewalkDrop(_box.min.y) : 0);
        // Rigid lift in the parent's frame (parents here are plain, unrotated groups)
        obj.position.y += dy;
        obj.updateMatrixWorld(true);
        stats.rigid++;
        return;
      }
      if ((obj.isMesh || obj.isLine || obj.isPoints) && obj.geometry?.attributes?.position) {
        if (!isIdentity(obj.matrixWorld)) {
          obj.geometry.applyMatrix4(obj.matrixWorld);
          obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1);
          if (obj.parent) { obj.applyMatrix4(_inv.copy(obj.parent.matrixWorld).invert()); }
          obj.updateMatrixWorld(true);
        }
        const flat = size.y < 0.6 && obj.isMesh;
        if (flat) { const g = drapeOverlay(obj.geometry, { deck: !!obj.userData.deck, maxEdge: 16 }); if (g !== obj.geometry) { obj.geometry.dispose(); obj.geometry = g; } stats.draped++; }
        else { displaceGeometry(obj.geometry, { deck: true }); stats.displaced++; }
      }
      for (const child of [...obj.children]) visit(child);
    }
  };
  visit(root);
  return stats;
}

export const TERRAIN_INFO = { cols: TERRAIN.cols, rows: TERRAIN.rows, cell: TERRAIN.cell, deckSegments };

/** Shifts flat-world colliders ({ minX, maxX, minZ, maxZ, minY?, maxY }) onto the terrain: from the lowest ground under
 * the footprint up to the height above the highest. `baseY` keeps the shift (heights relative to the ground: maxY - baseY). */
export function liftColliders(colliders) {
  for (const c of colliders) {
    if (c.baseY !== undefined) continue;
    let lo = Infinity, hi = -Infinity;
    for (const x of [c.minX, (c.minX + c.maxX) / 2, c.maxX]) for (const z of [c.minZ, (c.minZ + c.maxZ) / 2, c.maxZ]) {
      const h = surfaceHeight(x, z);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    c.baseY = lo;
    c.minY = (c.minY ?? 0) + lo;
    c.maxY = (c.maxY ?? 0) + hi;
  }
  return colliders;
}
