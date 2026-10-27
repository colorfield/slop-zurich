import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { register } from 'node:module';
import { wgs84ToLv95, lv95ToWgs84 } from '../js/swiss-projection.js';
import { FRAME, WORLD_BOUNDS, lv95ToWorld } from '../js/zurich-frame.js';
import { parseTerrain, gridHeight } from '../js/terrain-grid.js';
import { ZURICH_DATA } from '../js/zurich-geodata.js';

const terrainFile = fs.readFileSync(new URL('../data/zurich-terrain.bin', import.meta.url));
const TERRAIN = parseTerrain(terrainFile.buffer.slice(terrainFile.byteOffset, terrainFile.byteOffset + terrainFile.byteLength));
const heightAt = (E, N) => { const p = lv95ToWorld(E, N); return gridHeight(TERRAIN, p.x, p.z) + FRAME.H0; };

test('WGS84 -> LV95 matches swisstopo REFRAME to the millimetre, and round-trips', () => {
  // https://geodesy.geo.admin.ch/reframe/wgs84tolv95
  for (const [lon, lat, E, N] of [[8.54, 47.37, 2683186.285581739, 1247156.7439824815], [8.505, 47.361, 2680556.51552824, 1246119.6876790135]]) {
    const p = wgs84ToLv95(lon, lat);
    assert.ok(Math.abs(p.E - E) < 0.002 && Math.abs(p.N - N) < 0.002, `${lon}, ${lat}: ${p.E}, ${p.N}`);
    const back = lv95ToWgs84(p.E, p.N);
    assert.ok(Math.abs(back.lon - lon) < 1e-7 && Math.abs(back.lat - lat) < 1e-7);
  }
});

test('the terrain grid covers the frame with plausible Zurich heights', () => {
  const [minX, minZ, maxX, maxZ] = WORLD_BOUNDS;
  assert.equal(TERRAIN.minX, minX);
  assert.equal(TERRAIN.minZ, minZ);
  assert.equal(TERRAIN.maxX, maxX);
  assert.equal(TERRAIN.maxZ, maxZ);
  // Lake level, the old town, the ETH terrace (swissALTI3D, m a.s.l.)
  assert.ok(Math.abs(heightAt(2683500, 1246000) - 405.9) < 0.5, 'Zürichsee');
  assert.ok(Math.abs(heightAt(2683238, 1247488) - 428) < 3, 'Lindenhof');
  assert.ok(heightAt(2683650, 1247900) > 440, 'Polyterrasse above the old town');
});

test('every bridge has a deck height per point, never below the terrain it spans', () => {
  for (const r of [...ZURICH_DATA.roads, ...ZURICH_DATA.railways]) {
    if (!r.bridge) continue;
    assert.equal(r.ys?.length, r.pts.length / 2, `${r.id} ${r.name}`);
    // (points are rounded to 0.1 m, so the terrain is sampled a few centimetres off on slopes)
    r.ys.forEach((y, i) => assert.ok(y >= gridHeight(TERRAIN, r.pts[i * 2], r.pts[i * 2 + 1]) - 0.1, `${r.id} ${r.name} point ${i}`));
  }
});

test('the Hardbrücke spans the tracks well above them; the Limmat bridges stay near the quays', () => {
  const hard = ZURICH_DATA.roads.filter((r) => r.name === 'Hardbrücke' && r.bridge && r.kind === 'primary');
  const clearance = Math.max(...hard.flatMap((r) => r.ys.map((y, i) => y - gridHeight(TERRAIN, r.pts[i * 2], r.pts[i * 2 + 1]))));
  assert.ok(clearance > 8, `Hardbrücke clearance ${clearance.toFixed(1)} m`);
  for (const name of ['Quaibrücke', 'Rathausbrücke', 'Münsterbrücke']) {
    for (const r of ZURICH_DATA.roads.filter((q) => q.name === name && q.bridge)) {
      assert.ok(Math.max(...r.ys) < 6, `${name} at most a few metres above the lake level`);
    }
  }
  // The boardwalk along the Schanzengraben, under trees (the surface model reads their crowns 11-19 m up); its stairs
  // climb to the street bridges
  for (const r of ZURICH_DATA.roads.filter((q) => q.name === 'Schanzengrabenpromenade' && q.bridge)) {
    r.ys.forEach((y, i) => assert.ok(y - gridHeight(TERRAIN, r.pts[i * 2], r.pts[i * 2 + 1]) < 5, `Schanzengrabenpromenade ${r.id} point ${i} by the canal, not in the treetops`));
  }
});

test('one stands on a bridge over the water, never under it; under the Hardbrücke, the streets stay on the ground', async () => {
  // js/terrain.js only draws with three.js inside its functions: an empty stand-in lets Node load its height functions
  const three = encodeURIComponent('export class Box3 {} export class Vector3 {} export class Matrix4 {}');
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return s === 'three/webgpu' ? { url: 'data:text/javascript,${three}', shortCircuit: true } : next(s, c); }`)}`);
  const { groundHeight, deckHeight, surfaceHeight } = await import('../js/terrain.js');
  const quai = ZURICH_DATA.roads.find((r) => r.name === 'Quaibrücke' && r.bridge);
  const mid = (r, i = 0) => ({ x: (r.pts[i * 2] + r.pts[i * 2 + 2]) / 2, z: (r.pts[i * 2 + 1] + r.pts[i * 2 + 3]) / 2 });
  const q = mid(quai), qDeck = deckHeight(q.x, q.z), qWater = groundHeight(q.x, q.z);
  assert.ok(qDeck - qWater > 2, 'the Quaibrücke clears the water');
  assert.equal(surfaceHeight(q.x, q.z, qWater), qDeck, 'from the water level, the Quaibrücke deck');
  // (the Hardbrücke also crosses the Limmat at its northern end: over the tracks, south of it)
  const limmat = ZURICH_DATA.water.find((w) => w.name === 'Limmat').ring;
  const southOfLimmat = (p) => p.z > Math.max(...limmat.filter((_, i) => i % 2 && Math.abs(limmat[i - 1] - p.x) < 50));
  const hard = ZURICH_DATA.roads.filter((r) => r.name === 'Hardbrücke' && r.bridge && r.kind === 'primary')
    .flatMap((r) => r.ys.slice(1).map((_, i) => mid(r, i))).filter(southOfLimmat)
    .map((p) => ({ ...p, d: deckHeight(p.x, p.z), g: groundHeight(p.x, p.z) })).sort((a, b) => b.d - b.g - (a.d - a.g))[0];
  assert.ok(hard.d - hard.g > 8, 'the Hardbrücke over the tracks');
  assert.equal(surfaceHeight(hard.x, hard.z, hard.g), hard.g, 'under the Hardbrücke');
  assert.equal(surfaceHeight(hard.x, hard.z, hard.d), hard.d, 'on the Hardbrücke');
});

test('the city keeps its landmarks, quarters, trees and road graph', () => {
  for (const name of ['Grossmünster', 'Fraumünster', 'Zürich HB', 'ETH Hauptgebäude', 'Opernhaus', 'Prime Tower']) {
    assert.ok(ZURICH_DATA.landmarks[name], name);
  }
  const quarters = ZURICH_DATA.meta.areas.map((a) => a.name);
  for (const name of ['City', 'Lindenhof', 'Rathaus', 'Hochschulen', 'Langstrasse', 'Enge']) assert.ok(quarters.includes(name), name);
  assert.ok(ZURICH_DATA.trees.length > 10000, 'municipal tree cadastre');
  const { nodes, links } = ZURICH_DATA.roadGraph;
  for (const l of links) assert.ok(l[0] * 2 < nodes.length && l[1] * 2 < nodes.length);
  assert.ok(!ZURICH_DATA.roads.some((r) => r.kind === 'footway' && /crossing/.test(r.name)), 'no crosswalk ways');
});

test('the swissBUILDINGS3D tiles are stored in the repository, complete', () => {
  const dir = new URL('../data/swissbuildings3d/', import.meta.url);
  const index = JSON.parse(fs.readFileSync(new URL('index.json', dir), 'utf8'));
  assert.match(index.release, /^\d{8}$/);
  assert.ok(index.tiles.length > 500);
  for (const t of index.tiles) {
    const buf = fs.readFileSync(new URL(index.base + t.u, dir));
    assert.equal(buf.toString('ascii', 0, 4), 'b3dm', t.u);
    assert.equal(buf.readUInt32LE(8), buf.length, `${t.u} is complete`);
  }
});
