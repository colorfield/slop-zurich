// tools/update-swissbuildings3d.mjs — refreshes data/swissbuildings3d/: the swisstopo swissBUILDINGS3D 3.0 3D Tiles
// (b3dm leaves, Draco glTF) that overlap the world frame, from the newest release published on 3d.geo.admin.ch.
// The game loads the copies stored in the repository; run this deliberately to move to a new release, then check the
// city and commit the result (npm run update:buildings).
// Writes data/swissbuildings3d/index.json ({ release, base, tiles: [{ u, x, z }] }, tile centres in world coordinates
// so that the browser loads the nearest first) and data/swissbuildings3d/tiles/<z>/<x>/<y>.b3dm. Every tile is
// checked (b3dm header and length) before the previous copy is replaced; nothing changes if any download fails.
// usage: node tools/update-swissbuildings3d.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME, lonLatToWorld } from '../js/zurich-frame.js';
import { lv95ToWgs84 } from '../js/swiss-projection.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, '..', 'data', 'swissbuildings3d');
const ROOT = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json';
const CONCURRENCY = 8;
const deg = (r) => (r * 180) / Math.PI;
const log = (...a) => console.log('[swissbuildings3d]', ...a);

const [minE, minN, maxE, maxN] = FRAME.lv95;
const corners = [[minE, minN], [maxE, minN], [minE, maxN], [maxE, maxN]].map(([e, n]) => lv95ToWgs84(e, n));
const W = Math.min(...corners.map((c) => c.lon)), E = Math.max(...corners.map((c) => c.lon));
const S = Math.min(...corners.map((c) => c.lat)), N = Math.max(...corners.map((c) => c.lat));
const overlaps = (r) => deg(r[2]) >= W && deg(r[0]) <= E && deg(r[3]) >= S && deg(r[1]) <= N;

async function fetchRetry(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url).catch((error) => ({ ok: false, status: error.message }));
    if (res.ok) return res;
    if (attempt === 4) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
}
const getJson = async (url) => (await fetchRetry(url)).json();

// The root references the dated releases (e.g. 20260520/tileset.json): take the newest
const releases = [];
(function collect(node) {
  if (node.content?.uri) releases.push(node.content.uri);
  for (const c of node.children || []) collect(c);
})((await getJson(ROOT)).root);
const release = releases.sort().at(-1);
const base = new URL(release, ROOT).href;
const releaseDir = new URL('.', base).href;
const releaseName = release.split('/')[0];
const previous = fs.existsSync(path.join(OUT, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8')).release : null;
log(`newest release ${releaseName}${previous ? `, stored ${previous}` : ''}`);

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
    tiles.push({ u: new URL(uri, url).href.slice(releaseDir.length), x: Math.round(c.x), z: Math.round(c.z) });
  }
  await Promise.all((node.children || []).map((c) => visit(c, url)));
}
await visit((await getJson(base)).root, base);
tiles.sort((a, b) => a.u.localeCompare(b.u));
log(`${tiles.length} tiles overlap the city`);

// Download into a staging directory, check every tile, then swap it in
const staging = `${OUT}.staging`;
fs.rmSync(staging, { recursive: true, force: true });
let next = 0, bytes = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < tiles.length) {
    const t = tiles[next++];
    const buf = Buffer.from(await (await fetchRetry(releaseDir + t.u)).arrayBuffer());
    if (buf.toString('ascii', 0, 4) !== 'b3dm' || buf.readUInt32LE(8) !== buf.length) throw new Error(`${t.u}: not a complete b3dm tile`);
    const file = path.join(staging, 'tiles', t.u);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    bytes += buf.length;
  }
}));
fs.writeFileSync(path.join(staging, 'index.json'), JSON.stringify({
  source: 'swisstopo swissBUILDINGS3D 3.0 (3D Tiles)', origin: releaseDir, release: releaseName,
  fetched: new Date().toISOString().slice(0, 10), base: 'tiles/', tiles
}));
fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(staging, OUT);
log(`stored release ${releaseName}: ${tiles.length} tiles, ${(bytes / 1048576).toFixed(1)} MB -> ${OUT}`);
