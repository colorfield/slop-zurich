// tools/build-swissbuildings3d-index.mjs — writes data/swissbuildings3d-tiles.json: the swissBUILDINGS3D 3.0 3D Tiles
// (b3dm leaves) that overlap the world frame, with their centres in world coordinates so that the browser can load the
// nearest ones first without walking the tileset hierarchy (dozens of nested tileset JSON files) at every start.
// usage: node tools/build-swissbuildings3d-index.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME, lonLatToWorld } from '../js/zurich-frame.js';
import { lv95ToWgs84 } from '../js/swiss-projection.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, '..', 'data', 'swissbuildings3d-tiles.json');
const ROOT = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json';
const deg = (r) => (r * 180) / Math.PI;

const [minE, minN, maxE, maxN] = FRAME.lv95;
const corners = [[minE, minN], [maxE, minN], [minE, maxN], [maxE, maxN]].map(([e, n]) => lv95ToWgs84(e, n));
const W = Math.min(...corners.map((c) => c.lon)), E = Math.max(...corners.map((c) => c.lon));
const S = Math.min(...corners.map((c) => c.lat)), N = Math.max(...corners.map((c) => c.lat));
const overlaps = (r) => deg(r[2]) >= W && deg(r[0]) <= E && deg(r[3]) >= S && deg(r[1]) <= N;

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt === 4) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
}

// The root references one dated release (e.g. 20260520/tileset.json): take the newest.
const root = await getJson(ROOT);
const releases = [];
(function collect(node) {
  if (node.content?.uri) releases.push(node.content.uri);
  for (const c of node.children || []) collect(c);
})(root.root);
const release = releases.sort().at(-1);
const base = new URL(release, ROOT).href;

const tiles = [];
async function visit(node, url) {
  const region = node.boundingVolume?.region;
  if (!region || !overlaps(region)) return;
  const uri = node.content?.uri;
  if (uri?.endsWith('.json')) {
    const sub = new URL(uri, url).href;
    await visit((await getJson(sub)).root, sub);
  } else if (uri) {
    const c = lonLatToWorld(deg((region[0] + region[2]) / 2), deg((region[1] + region[3]) / 2));
    tiles.push({ u: new URL(uri, url).href.slice(new URL('.', base).href.length), x: Math.round(c.x), z: Math.round(c.z) });
  }
  await Promise.all((node.children || []).map((c) => visit(c, url)));
}
await visit((await getJson(base)).root, base);
tiles.sort((a, b) => a.u.localeCompare(b.u));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ source: 'swisstopo swissBUILDINGS3D 3.0 (3D Tiles)', base: new URL('.', base).href, release: release.split('/')[0], tiles }));
console.log(`[swissbuildings3d-index] ${tiles.length} tiles of release ${release} -> ${OUT}`);
