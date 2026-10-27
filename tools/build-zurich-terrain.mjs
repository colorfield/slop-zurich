// tools/build-zurich-terrain.mjs — writes data/zurich-terrain.bin from swisstopo swissALTI3D (2 m cloud-optimised GeoTIFFs)
// The digital terrain model (bare earth: no buildings, no bridges) is resampled onto the world frame's terrain grid
// (js/zurich-frame.js: FRAME.terrainCell metres) and stored as heights above FRAME.H0 in centimetres.
//
// The bare-earth model keeps the open cuts that lead underground (the Bahnhofquai underpass, the ramps to the HB's
// underground stations and car parks, ShopVille's stairs): narrow trenches between retaining walls that a 4 m grid
// turns into lumps under the streets drawn over them. The engine has no underground, so these pits are filled from the
// ground around them (OSM ways in tunnels or below ground, tools/data/cache/osm_zurich.json).
//
// File layout (little endian): 'ZTR1', uint16 cols, uint16 rows, float32 cell (m), float32 minX, float32 minZ,
// float32 scale (m per unit), then int16 heights row-major, row j at z = minZ + j * cell, column i at x = minX + i * cell.
// usage: node tools/build-zurich-terrain.mjs [out.bin]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer } from 'geotiff';
import { FRAME, WORLD_BOUNDS, worldToLv95, lonLatToWorld } from '../js/zurich-frame.js';
import { polygons, bbox as ringBox } from './osm-geometry.mjs';
import { lv95ToWgs84 } from '../js/swiss-projection.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(DIR, '..', 'data', 'zurich-terrain.bin');
const CACHE = path.join(DIR, 'data', 'cache', 'swissalti3d');
const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissalti3d/items';
const log = (...a) => console.log('[zurich-terrain]', ...a);
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// --- 1 km tiles covering the frame (latest acquisition of each), 2 m resolution ----------------------------------------
const [minE, minN, maxE, maxN] = FRAME.lv95;
const corners = [[minE, minN], [maxE, minN], [minE, maxN], [maxE, maxN]].map(([e, n]) => lv95ToWgs84(e, n));
const bbox = [
  Math.min(...corners.map((c) => c.lon)), Math.min(...corners.map((c) => c.lat)),
  Math.max(...corners.map((c) => c.lon)), Math.max(...corners.map((c) => c.lat))
].join(',');
const latest = new Map();
for (let url = `${STAC}?bbox=${bbox}&limit=100`; url;) {
  const page = await (await fetch(url)).json();
  for (const f of page.features) {
    const m = /_(\d{4})_(\d{4})-(\d{4})$/.exec(f.id);
    if (!m) continue;
    const [, year, e, n] = m;
    if (+e * 1000 + 1000 <= minE || +e * 1000 >= maxE || +n * 1000 + 1000 <= minN || +n * 1000 >= maxN) continue;
    const asset = Object.entries(f.assets).find(([k]) => /_2_2056_5728\.tif$/.test(k));
    const key = `${e}-${n}`;
    if (asset && (!latest.has(key) || latest.get(key).year < +year)) latest.set(key, { year: +year, e: +e, n: +n, href: asset[1].href });
  }
  url = page.links?.find((l) => l.rel === 'next')?.href;
}
log(`${latest.size} tiles:`, [...latest].map(([k, t]) => `${k}@${t.year}`).join(' '));

// --- Decode every tile into one 2 m mosaic (pixel centres at odd metres) -----------------------------------------------
const tiles = new Map();
for (const [key, t] of latest) {
  const file = path.join(CACHE, path.basename(new URL(t.href).pathname));
  if (!fs.existsSync(file)) {
    const res = await fetch(t.href);
    if (!res.ok) throw new Error(`${t.href}: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const buf = fs.readFileSync(file);
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const image = await tiff.getImage();
  const [x0, y0, x1, y1] = image.getBoundingBox();
  const [raster] = await image.readRasters();
  tiles.set(key, { x0, y0, x1, y1, w: image.getWidth(), h: image.getHeight(), raster, nodata: image.getGDALNoData() });
}
function sample2m(e, n) {
  const t = tiles.get(`${Math.floor(e / 1000)}-${Math.floor(n / 1000)}`);
  if (!t) return NaN;
  const res = (t.x1 - t.x0) / t.w;
  const i = Math.min(t.w - 1, Math.max(0, Math.floor((e - t.x0) / res)));
  const j = Math.min(t.h - 1, Math.max(0, Math.floor((t.y1 - n) / res)));
  const v = t.raster[j * t.w + i];
  return v === t.nodata || v < -1000 ? NaN : v;
}
// Bilinear between the four nearest 2 m pixel centres
function heightAt(e, n) {
  const fe = e - 1, fn = n - 1;
  const e0 = Math.floor(fe / 2) * 2 + 1, n0 = Math.floor(fn / 2) * 2 + 1;
  const te = (e - e0) / 2, tn = (n - n0) / 2;
  const h00 = sample2m(e0, n0), h10 = sample2m(e0 + 2, n0), h01 = sample2m(e0, n0 + 2), h11 = sample2m(e0 + 2, n0 + 2);
  return (h00 * (1 - te) + h10 * te) * (1 - tn) + (h01 * (1 - te) + h11 * te) * tn;
}

// --- Resample onto the world grid ----------------------------------------------------------------------------------------
const cell = FRAME.terrainCell, scale = 0.01;
const [minX, minZ, maxX, maxZ] = WORLD_BOUNDS;
const cols = Math.round((maxX - minX) / cell) + 1, rows = Math.round((maxZ - minZ) / cell) + 1;
const H = new Float64Array(cols * rows);
let lo = Infinity, hi = -Infinity, missing = 0;
for (let j = 0; j < rows; j++) {
  for (let i = 0; i < cols; i++) {
    const { E, N } = worldToLv95(minX + i * cell, minZ + j * cell);
    let h = heightAt(E, N);
    if (!Number.isFinite(h)) { missing++; h = FRAME.H0; }
    lo = Math.min(lo, h); hi = Math.max(hi, h);
    H[j * cols + i] = h;
  }
}

// --- Fill the open cuts to the underground ----------------------------------------------------------------------------------
// Candidates: nodes within a few metres of a way in a tunnel or below ground, outside the rivers and the lake (the
// S-Bahn runs under the Sihl and the Limmat). A candidate is a pit when it lies 0.8 m or more under the median of the
// ground 12-24 m around it (so the hills over real tunnels stay); pits are filled by harmonic interpolation from the
// ground around them.
const osm = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'cache', 'osm_zurich.json'), 'utf8'));
const water = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node' || !(t.natural === 'water' || /^(riverbank|dock)$/.test(t.waterway || ''))) continue;
  for (const p of polygons(e)) water.push({ ...p, box: ringBox(p.ring) });
}
const pip = (ring, x, z) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if ((ring[i][1] > z) !== (ring[j][1] > z) && x < ((ring[j][0] - ring[i][0]) * (z - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) inside = !inside;
  }
  return inside;
};
const inWater = (x, z) => water.some((w) => x >= w.box.x0 && x <= w.box.x1 && z >= w.box.z0 && z <= w.box.z1 &&
  pip(w.ring, x, z) && !w.holes.some((h) => pip(h, x, z)));
const candidate = new Uint8Array(cols * rows);
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type !== 'way' || !e.geometry || !(t.highway || t.railway)) continue;
  const below = (t.tunnel && t.tunnel !== 'no') || t.covered === 'yes' || t.location === 'underground' || parseFloat(t.layer) < 0;
  if (!below || (t.bridge && t.bridge !== 'no')) continue;
  const half = (parseFloat(t.width) || (t.railway ? 6 : t.highway === 'steps' || t.highway === 'footway' ? 3 : 8)) / 2 + 3;
  const pts = e.geometry.map((p) => lonLatToWorld(p.lon, p.lat));
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    const i0 = Math.max(0, Math.ceil((Math.min(a.x, b.x) - half - minX) / cell)), i1 = Math.min(cols - 1, Math.floor((Math.max(a.x, b.x) + half - minX) / cell));
    const j0 = Math.max(0, Math.ceil((Math.min(a.z, b.z) - half - minZ) / cell)), j1 = Math.min(rows - 1, Math.floor((Math.max(a.z, b.z) + half - minZ) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = minX + i * cell, z = minZ + j * cell, f = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
      if (!candidate[j * cols + i] && Math.hypot(a.x + f * dx - x, a.z + f * dz - z) <= half && !inWater(x, z)) candidate[j * cols + i] = 1;
    }
  }
}
const pit = new Uint8Array(cols * rows);
let pits = 0;
for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
  const k = j * cols + i;
  if (!candidate[k]) continue;
  const ring = [];
  for (let dj = -6; dj <= 6; dj++) for (let di = -6; di <= 6; di++) {
    const r = Math.hypot(di, dj) * cell, ii = i + di, jj = j + dj;
    if (r >= 12 && r <= 24 && ii >= 0 && jj >= 0 && ii < cols && jj < rows && !candidate[jj * cols + ii]) ring.push(H[jj * cols + ii]);
  }
  if (ring.length < 8) continue;
  ring.sort((p, q) => p - q);
  if (H[k] < ring[ring.length >> 1] - 0.8) { pit[k] = 1; pits++; }
}
// Grow the pits by a node so that their slopes go too, then fill them
const fill = Uint8Array.from(pit);
for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
  const k = j * cols + i;
  if (!pit[k] && candidate[k] && (pit[k - 1] || pit[k + 1] || pit[k - cols] || pit[k + cols])) fill[k] = 1;
}
const filled = [];
for (let k = 0; k < fill.length; k++) if (fill[k]) filled.push(k);
for (let iter = 0; iter < 400; iter++) {
  for (const k of filled) {
    const i = k % cols, j = (k - i) / cols;
    let sum = 0, n = 0;
    for (const nk of [i > 0 ? k - 1 : -1, i < cols - 1 ? k + 1 : -1, j > 0 ? k - cols : -1, j < rows - 1 ? k + cols : -1]) if (nk >= 0) { sum += H[nk]; n++; }
    H[k] = Math.max(H[k], sum / n);
  }
}
log(`filled ${filled.length} nodes of open cuts to the underground (${pits} pits)`);

const heights = new Int16Array(cols * rows);
for (let k = 0; k < heights.length; k++) heights[k] = Math.round((H[k] - FRAME.H0) / scale);
const header = Buffer.alloc(24);
header.write('ZTR1', 0, 'ascii');
header.writeUInt16LE(cols, 4); header.writeUInt16LE(rows, 6);
header.writeFloatLE(cell, 8); header.writeFloatLE(minX, 12); header.writeFloatLE(minZ, 16); header.writeFloatLE(scale, 20);
fs.writeFileSync(OUT, Buffer.concat([header, Buffer.from(heights.buffer)]));
log(`wrote ${OUT}: ${cols}x${rows} @ ${cell} m, ${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB, ` +
  `heights ${lo.toFixed(1)}..${hi.toFixed(1)} m a.s.l., ${missing} missing`);
