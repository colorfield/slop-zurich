// tools/fetch-bridge-decks.mjs — writes tools/data/cache/bridge_decks.json: the surveyed deck height (m a.s.l.) at every
// node of the city's OSM bridge ways, sampled from swisstopo swissSURFACE3D Raster (0.5 m digital surface model: unlike
// the bare-earth swissALTI3D it contains the bridges). Only small windows around the bridges are read from the
// cloud-optimised GeoTIFFs (HTTP range requests), not the whole 1 km tiles.
// A low percentile of the surface within 1 m of each node skips lamps and branches; a tram or a bus covering a node
// makes a spike that tools/build-zurich-geodata.mjs rejects against the neighbouring nodes (a wider radius would read
// the water beside a carriageway mapped along the edge of a bridge).
// usage: node tools/fetch-bridge-decks.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromUrl } from 'geotiff';
import { FRAME } from '../js/zurich-frame.js';
import { wgs84ToLv95, lv95ToWgs84 } from '../js/swiss-projection.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'cache');
const OUT = path.join(CACHE, 'bridge_decks.json');
const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d-raster/items';
const RADIUS = 1, PERCENTILE = 0.25, PAD = 4;
const log = (...a) => console.log('[bridge-decks]', ...a);

const osm = JSON.parse(fs.readFileSync(path.join(CACHE, 'osm_zurich.json'), 'utf8'));
const [minE, minN, maxE, maxN] = FRAME.lv95;

// Bridge nodes (LV95), grouped by bridge way
const ways = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type !== 'way' || !e.geometry || !t.bridge || t.bridge === 'no' || t.bridge === 'culvert') continue;
  if (!t.highway && !t.railway) continue;
  const nodes = e.geometry.map((p, i) => ({ id: e.nodes[i], ...wgs84ToLv95(p.lon, p.lat) }));
  if (!nodes.some((p) => p.E >= minE && p.E <= maxE && p.N >= minN && p.N <= maxN)) continue;
  ways.push(nodes);
}
log(`${ways.length} bridge ways`);

// Latest 1 km DSM tile of each kilometre square
const corners = [[minE, minN], [maxE, minN], [minE, maxN], [maxE, maxN]].map(([e, n]) => lv95ToWgs84(e, n));
const bbox = [Math.min(...corners.map((c) => c.lon)), Math.min(...corners.map((c) => c.lat)), Math.max(...corners.map((c) => c.lon)), Math.max(...corners.map((c) => c.lat))].join(',');
const latest = new Map();
for (let url = `${STAC}?bbox=${bbox}&limit=100`; url;) {
  const page = await (await fetch(url)).json();
  for (const f of page.features) {
    const m = /_(\d{4})_(\d{4})-(\d{4})$/.exec(f.id);
    const asset = Object.entries(f.assets).find(([k]) => /_0\.5_2056_5728\.tif$/.test(k));
    if (!m || !asset) continue;
    const key = `${m[2]}-${m[3]}`;
    if (!latest.has(key) || latest.get(key).year < +m[1]) latest.set(key, { year: +m[1], href: asset[1].href });
  }
  url = page.links?.find((l) => l.rel === 'next')?.href;
}
log(`DSM tiles: ${[...latest].map(([k, t]) => `${k}@${t.year}`).join(' ')}`);

const images = new Map();
async function imageFor(key) {
  if (!images.has(key)) images.set(key, fromUrl(latest.get(key).href).then((tiff) => tiff.getImage()));
  return images.get(key);
}

const decks = {};
let windows = 0;
for (const nodes of ways) {
  // One window per (way, tile) pair
  const byTile = new Map();
  for (const p of nodes) {
    const key = `${Math.floor(p.E / 1000)}-${Math.floor(p.N / 1000)}`;
    if (!latest.has(key)) continue;
    if (!byTile.has(key)) byTile.set(key, []);
    byTile.get(key).push(p);
  }
  for (const [key, pts] of byTile) {
    const image = await imageFor(key);
    const [x0, , , y1] = image.getBoundingBox();
    const res = image.getResolution()[0];
    const w = image.getWidth(), h = image.getHeight();
    const col = (E) => Math.min(w, Math.max(0, Math.floor((E - x0) / res)));
    const row = (N) => Math.min(h, Math.max(0, Math.floor((y1 - N) / res)));
    const win = [col(Math.min(...pts.map((p) => p.E)) - PAD), row(Math.max(...pts.map((p) => p.N)) + PAD), col(Math.max(...pts.map((p) => p.E)) + PAD), row(Math.min(...pts.map((p) => p.N)) - PAD)];
    if (win[2] <= win[0] || win[3] <= win[1]) continue;
    const [raster] = await image.readRasters({ window: win });
    windows++;
    const ww = win[2] - win[0];
    for (const p of pts) {
      const values = [];
      const c0 = Math.floor((p.E - RADIUS - x0) / res) - win[0], c1 = Math.floor((p.E + RADIUS - x0) / res) - win[0];
      const r0 = Math.floor((y1 - p.N - RADIUS) / res) - win[1], r1 = Math.floor((y1 - p.N + RADIUS) / res) - win[1];
      for (let r = Math.max(0, r0); r <= Math.min(win[3] - win[1] - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(ww - 1, c1); c++) {
          const E = x0 + (win[0] + c + 0.5) * res, N = y1 - (win[1] + r + 0.5) * res;
          const v = raster[r * ww + c];
          if (Math.hypot(E - p.E, N - p.N) <= RADIUS && v > 0) values.push(v);
        }
      }
      if (values.length < 4) continue;
      values.sort((a, b) => a - b);
      decks[p.id] = Math.round(values[Math.floor(values.length * PERCENTILE)] * 100) / 100;
    }
  }
}
fs.writeFileSync(OUT, JSON.stringify({ source: 'swisstopo swissSURFACE3D Raster', tiles: Object.fromEntries(latest), decks }));
log(`${Object.keys(decks).length} deck heights from ${windows} windows -> ${OUT}`);
