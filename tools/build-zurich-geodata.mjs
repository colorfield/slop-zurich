// tools/build-zurich-geodata.mjs — writes js/zurich-geodata.js for the engine's irregular-city data path (GEO.berlin)
// Sources (see package.json "data" scripts):
//   tools/data/cache/osm_zurich.json        OpenStreetMap, query tools/data/q_zurich.overpassql
//   tools/data/cache/osm_zurich_areas.json  OpenStreetMap quarters (Quartiere), query tools/data/q_zurich_areas.overpassql
//   tools/data/cache/zurich_trees.json      Stadt Zürich tree cadastre (tools/fetch-zurich-trees.mjs)
// Frame: js/zurich-frame.js (LV95 offset: x = east, z = south, metres). Buildings are drawn from swisstopo's
// swissBUILDINGS3D at runtime (js/swissbuildings3d.js); the OSM footprints below drive colliders, sidewalks & the
// fallback extrusions. Terrain heights live in data/zurich-terrain.bin (tools/build-zurich-terrain.mjs).
// usage: node tools/build-zurich-geodata.mjs [out.js]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME, WORLD_BOUNDS, lonLatToWorld, lv95ToWorld } from '../js/zurich-frame.js';
import { parseTerrain, gridHeight } from '../js/terrain-grid.js';
import { toWorld, flat, geomPts, inFrame, ringArea, bbox, bboxInFrame, rdp, cleanRing, polygons, clipToFrame } from './osm-geometry.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(DIR, '..', 'js', 'zurich-geodata.js');
const CACHE = path.join(DIR, 'data', 'cache');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'));
const osm = readJson('osm_zurich.json');
const log = (...a) => console.log('[zurich-geodata]', ...a);
const terrainFile = fs.readFileSync(path.join(DIR, '..', 'data', 'zurich-terrain.bin'));
const TERRAIN = parseTerrain(terrainFile.buffer.slice(terrainFile.byteOffset, terrainFile.byteOffset + terrainFile.byteLength));
const r2 = (v) => Math.round(v * 100) / 100;

const r1 = (v) => Math.round(v * 10) / 10;
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

// --- Buildings (footprints; the volumes come from swissBUILDINGS3D) ------------------------------------------------------
const buildings = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node' || !t.building) continue;
  if (t.building === 'roof' || t.building === 'no' || t.building === 'construction') continue;
  if (t.location === 'underground' || (num(t.layer) ?? 0) < 0) continue;
  for (const [i, p] of polygons(e).entries()) {
    const ring = cleanRing(p.ring);
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 6 || !bboxInFrame(bbox(ring))) continue;
    const levels = num(t['building:levels']);
    let h = num(t.height), src = 'height';
    if (h == null && levels != null) { h = levels * 3.2 + (t['roof:shape'] && t['roof:shape'] !== 'flat' ? 3 : 1); src = 'building:levels'; }
    if (h == null) { h = 14; src = 'default'; } // Zurich's inner districts are mostly 4-6 storey blocks
    buildings.push({
      id: `${e.type[0]}${e.id}${i ? '_' + i : ''}`, ring: flat(ring), holes: p.holes.map((hh) => flat(cleanRing(hh))), h: r1(h),
      roofHeight: r1(num(t['roof:height']) ?? 0), roofShape: t['roof:shape'] || 'flat', levels: levels ?? 0,
      name: t.name || '', kind: t.building, heightSource: src
    });
  }
}

// --- Roads & railways ---------------------------------------------------------------------------------------------------
const WIDTH = { motorway: 14, trunk: 12, primary: 10, secondary: 8, tertiary: 7, residential: 6, unclassified: 6, living_street: 5, service: 3.5, pedestrian: 6, cycleway: 2.5, footway: 2, path: 1.5, steps: 2.5, track: 3 };
const LANES = { motorway: 4, trunk: 4, primary: 2, secondary: 2, tertiary: 2, residential: 2, unclassified: 2, living_street: 1, service: 1 };
const DRIVABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street']);
const RAIL = /^(rail|light_rail|tram|subway|funicular|narrow_gauge)$/;
function noteLevel(e, pts, kept, record, bridge, tunnel) {
  if (!e.nodes || e.nodes.length !== pts.length) return;
  const minor = MINOR.test(e.tags.highway || '');
  if (bridge) {
    const index = new Map(pts.map((p, i) => [p, i]));
    deckWays.push({ record, nodes: e.nodes, pts, kept: kept.map((p) => index.get(p)), minor });
  } else if (!tunnel) for (const id of e.nodes) (minor ? minorGroundNodes : groundNodes).add(id);
}
const drivable = [];
const deckWays = []; // every rendered bridge way: { record, nodes, pts (full), kept (indices of the simplified points), minor }
// Nodes of rendered ways at ground level. Paths & steps often hang off a bridge's side (stairs down to the street or the
// platforms below), so they only anchor footbridges, never road or rail decks.
const groundNodes = new Set(), minorGroundNodes = new Set();
const MINOR = /^(footway|path|steps|cycleway|pedestrian|track|service|elevator)$/;
const roads = [];
const railways = [];
const signals = [];
const fountains = [];
const tramStops = [];
let trees = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node') {
    const [x, z] = toWorld(e.lon, e.lat);
    if (!inFrame(x, z)) continue;
    if (t.natural === 'tree') trees.push({ x: r1(x), z: r1(z), h: r1(num(t.height) ?? 10) });
    else if (t.highway === 'traffic_signals') signals.push({ x: r1(x), z: r1(z) });
    else if (t.amenity === 'fountain') fountains.push({ x: r1(x), z: r1(z), name: t.name || '' });
    else if (t.railway === 'tram_stop') tramStops.push({ x: r1(x), z: r1(z), name: t.name || '' });
    continue;
  }
  if (e.type !== 'way' || !e.geometry) continue;
  const pts = geomPts(e.geometry);
  if (!bboxInFrame(bbox(pts), 50)) continue;
  const bridge = !!t.bridge && t.bridge !== 'no' && t.bridge !== 'culvert';
  // Below ground counts as a tunnel: the engine has no underground, and the terrain tool fills the open cuts leading
  // there (the Bahnhofquai underpass, the ramps to the HB's underground stations)
  const tunnel = (!!t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') || t.covered === 'yes' || t.location === 'underground' ||
    (!bridge && (num(t.layer) ?? 0) < 0);
  const layer = num(t.layer) ?? (bridge ? 1 : tunnel ? -1 : 0);
  if (t.railway && RAIL.test(t.railway)) {
    if (t.service === 'yard' || t.service === 'siding' || t.service === 'spur') {
      if (t.railway !== 'rail') continue;
    }
    const kept = rdp(pts, 0.5);
    const record = { id: `w${e.id}`, pts: flat(kept), bridge, tunnel, layer, kind: t.railway, name: t.name || '' };
    railways.push(record);
    noteLevel(e, pts, kept, record, bridge, tunnel);
    continue;
  }
  if (!t.highway || /^(proposed|construction|platform|bus_stop|corridor|elevator|raceway|bridleway)$/.test(t.highway)) continue;
  // Zurich maps its crosswalks as footways across the carriageway: the engine paints its own (and would take them
  // for sidewalks in the middle of the street)
  if (t.footway === 'crossing' || t.cycleway === 'crossing' || t.path === 'crossing') continue;
  const kind = t.highway.replace(/_link$/, '') in WIDTH ? t.highway : 'service';
  const base = kind.replace(/_link$/, '');
  const lanes = num(t.lanes) ?? LANES[base] ?? 1;
  const width = num(t.width) ?? Math.max(WIDTH[base] ?? 3, lanes * 3);
  const oneway = t.oneway === 'yes' || t.oneway === '-1' || t.oneway === '1' || t.junction === 'roundabout';
  // Zurich's tram streets: the tracks share the carriageway (OSM railway=tram ways run along them)
  const kept = rdp(pts, 0.5);
  const record = { id: `w${e.id}`, pts: flat(kept), bridge, tunnel, layer, name: t.name || '', width: r1(width), lanes, oneway, reverse: t.oneway === '-1', kind, nodeIds: e.nodes || [] };
  roads.push(record);
  noteLevel(e, pts, kept, record, bridge, tunnel);
  if (DRIVABLE.has(kind) && !tunnel && t.access !== 'no' && t.motor_vehicle !== 'no' && e.nodes && e.nodes.length === e.geometry.length) {
    drivable.push({ name: t.name || '', width: r1(width), lanes, dir: !oneway ? 0 : t.oneway === '-1' ? -1 : 1, nodes: e.nodes, pts, bridge });
  }
}

// --- Street centreline graph: ways cut at every node shared by two ways (and at their ends) ----------------------------
// links: [node a, node b, name index, width, lanes, direction (1: a -> b, -1: b -> a, 0: both), inner shape points [x, z, ...],
//         1 when on a bridge]
const roadGraph = (() => {
  const uses = new Map();
  for (const w of drivable) for (const id of new Set(w.nodes)) uses.set(id, (uses.get(id) || 0) + 1);
  const ids = new Map();
  const nodes = [];
  const names = [];
  const nameIds = new Map();
  const nodeOf = (id, p) => { if (!ids.has(id)) { ids.set(id, nodes.length / 2); nodes.push(r1(p[0]), r1(p[1])); } return ids.get(id); };
  const nameOf = (n) => { if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); } return nameIds.get(n); };
  const links = [];
  for (const w of drivable) {
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const last = i === w.nodes.length - 1;
      if (!last && uses.get(w.nodes[i]) < 2 && w.nodes[i] !== w.nodes[0]) continue;
      if (w.nodes[i] === w.nodes[start]) { start = i; continue; }
      const seg = w.pts.slice(start, i + 1);
      const inner = rdp(seg, 0.4).slice(1, -1).flatMap(([x, z]) => [r1(x), r1(z)]);
      const link = [nodeOf(w.nodes[start], seg[0]), nodeOf(w.nodes[i], seg[seg.length - 1]), nameOf(w.name), w.width, w.lanes, w.dir, inner];
      if (w.bridge) link.push(1); // on a bridge deck (heights: the matching roads[].ys)
      links.push(link);
      start = i;
    }
  }
  return { nodes, links, names };
})();

// --- Water, parks & woods ------------------------------------------------------------------------------------------------
const water = [];
const parks = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node') continue;
  const isWater = t.natural === 'water' || /^(riverbank|dock)$/.test(t.waterway || '');
  const isWood = /^(wood|scrub)$/.test(t.natural || '') || t.landuse === 'forest';
  const isPark = isWood || /^(park|garden|playground|pitch)$/.test(t.leisure || '') ||
    /^(grass|recreation_ground|cemetery|village_green|meadow)$/.test(t.landuse || '') || t.natural === 'grassland';
  if (!isWater && !isPark) continue;
  if (t.location === 'underground' || t.tunnel === 'culvert') continue;
  for (const p of polygons(e)) {
    const ring = clipToFrame(cleanRing(p.ring, 0.6));
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 20) continue;
    const holes = p.holes.map((h) => clipToFrame(cleanRing(h, 0.6))).filter((h) => h.length >= 3).map(flat);
    if (isWater) water.push({ id: `water${water.length}`, ring: flat(ring), holes, name: t.name || '', kind: t.water || t.waterway || 'water' });
    else parks.push({ id: `${e.type[0]}${e.id}`, ring: flat(ring), holes, name: t.name || '', kind: isWood ? 'wood' : t.leisure || t.landuse || t.natural });
  }
}

const terrainPatches = []; // bridgeheads where the terrain must rise to the surveyed road ({ x, z, h, r })
// --- Bridge decks ---------------------------------------------------------------------------------------------------------
// The terrain model is bare earth: under a bridge it holds the river or the tracks below. Nodes shared with a way at
// ground level are anchored to the terrain; the spans take the surface model sampled at their nodes
// (tools/fetch-bridge-decks.mjs, swissSURFACE3D); nodes without a (credible) sample are solved on the graph of bridge
// ways, interpolated harmonically (inverse-length weights), i.e. linearly along each chain.
{
  const DECKS = path.join(CACHE, 'bridge_decks.json');
  const surveyed = fs.existsSync(DECKS) ? JSON.parse(fs.readFileSync(DECKS, 'utf8')).decks : {};
  const pos = new Map(), adj = new Map(), majorDeck = new Set();
  // Under a tree the surface model reads the crown, not the deck (the Schanzengrabenpromenade, a boardwalk along the
  // canal, measured 11-19 m up): samples more than 3 m up within a municipal tree's crown are ignored.
  const TREE_CELL = 32, crowns = new Map();
  const treeFile = path.join(CACHE, 'zurich_trees.json');
  for (const t of fs.existsSync(treeFile) ? JSON.parse(fs.readFileSync(treeFile, 'utf8')).trees : []) {
    if (!t.crown) continue;
    const { x, z } = lv95ToWorld(t.E, t.N), k = `${Math.floor(x / TREE_CELL)}/${Math.floor(z / TREE_CELL)}`;
    if (!crowns.has(k)) crowns.set(k, []);
    crowns.get(k).push({ x, z, r: t.crown / 2 });
  }
  const underCrown = ([x, z]) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const t of crowns.get(`${Math.floor(x / TREE_CELL) + i}/${Math.floor(z / TREE_CELL) + j}`) || []) if (Math.hypot(t.x - x, t.z - z) < t.r) return true;
    }
    return false;
  };
  const link = (a, b, w) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push([b, w]); };
  for (const way of deckWays) {
    way.nodes.forEach((id, i) => { pos.set(id, way.pts[i]); if (!way.minor) majorDeck.add(id); });
    for (let i = 1; i < way.nodes.length; i++) {
      const w = 1 / Math.max(0.5, Math.hypot(way.pts[i][0] - way.pts[i - 1][0], way.pts[i][1] - way.pts[i - 1][1]));
      link(way.nodes[i - 1], way.nodes[i], w); link(way.nodes[i], way.nodes[i - 1], w);
    }
  }
  const ground = (id) => gridHeight(TERRAIN, pos.get(id)[0], pos.get(id)[1]);
  const pip = (ring, x, z) => { let inside = false; for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) { if ((ring[i + 1] > z) !== (ring[j + 1] > z) && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) inside = !inside; } return inside; };
  const inWater = ([x, z]) => water.some((w) => pip(w.ring, x, z) && !w.holes.some((h) => pip(h, x, z)));
  const h = new Map(), anchored = new Set();
  let measured = 0, canopy = 0;
  for (const [id] of adj) if (Number.isFinite(surveyed[id]) && surveyed[id] - FRAME.H0 - ground(id) > 3 && underCrown(pos.get(id))) { delete surveyed[id]; canopy++; }
  for (const [id, edges] of adj) {
    // Abutments: where a bridge meets a way at ground level (on land: tram tracks mapped across a bridge without the
    // bridge tag don't count), and the loose ends of bridge chains. They sit at ground level, except that
    // swissALTI3D removes bridges and interpolates the ground beneath them, which also pulls the bridgeheads down
    // towards the river: there the survey, when credible, sets the abutment, and the terrain is raised to meet it.
    const loose = new Set(edges.map(([b]) => b)).size < 2;
    const onLand = !inWater(pos.get(id));
    const junction = onLand && (groundNodes.has(id) || (!majorDeck.has(id) && minorGroundNodes.has(id)));
    if (junction || loose) {
      anchored.add(id);
      const g = ground(id), survey = surveyed[id] - FRAME.H0;
      if (survey - g > 0.4 && survey - g < 4) {
        h.set(id, survey);
        if (onLand) terrainPatches.push({ x: r1(pos.get(id)[0]), z: r1(pos.get(id)[1]), h: r2(survey), r: 15 });
      } else h.set(id, g);
    } else if (Number.isFinite(surveyed[id])) { anchored.add(id); h.set(id, Math.max(surveyed[id] - FRAME.H0, ground(id))); measured++; }
  }
  // Components without any anchor (e.g. a footbridge mapped on its own) start from their highest ground point
  const seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = [], stack = [start];
    seen.add(start);
    while (stack.length) { const id = stack.pop(); comp.push(id); for (const [b] of adj.get(id)) if (!seen.has(b)) { seen.add(b); stack.push(b); } }
    const top = Math.max(...comp.map(ground));
    for (const id of comp) if (!h.has(id)) h.set(id, comp.some((c) => anchored.has(c)) ? ground(id) : top);
  }
  const solve = () => {
    for (let iter = 0; iter < 4000; iter++) {
      let change = 0;
      for (const [id, edges] of adj) {
        if (anchored.has(id)) continue;
        let sw = 0, sh = 0;
        for (const [b, w] of edges) { sw += w; sh += w * h.get(b); }
        const v = sh / sw;
        change = Math.max(change, Math.abs(v - h.get(id)));
        h.set(id, v);
      }
      if (change < 0.001) break;
    }
  };
  // Samples that disagree with their neighbours (a bus, a branch, a gap in the surface model) by more than a bridge's
  // possible gradient are dropped and re-solved from the rest.
  let rejected = 0;
  for (let pass = 0; pass < 3; pass++) {
    solve();
    for (const [id, edges] of adj) {
      if (!anchored.has(id) || !Number.isFinite(surveyed[id])) continue;
      let sw = 0, sh = 0, len = 0;
      for (const [b, w] of edges) { sw += w; sh += w * h.get(b); len += 1 / w; }
      if (Math.abs(h.get(id) - sh / sw) > 1.5 + 0.12 * (len / edges.length)) { anchored.delete(id); rejected++; }
    }
  }
  solve();
  const smooth = h;
  for (const way of deckWays) {
    // Decks never dip below the terrain they cross; heights in the world frame (above FRAME.H0)
    way.record.ys = way.kept.map((i) => r2(Math.max(smooth.get(way.nodes[i]), gridHeight(TERRAIN, way.pts[i][0], way.pts[i][1]))));
  }
  log(`bridge decks: ${deckWays.length} ways, ${adj.size} nodes (${measured - rejected} surveyed, ${rejected} rejected samples, ${canopy} under trees), ${terrainPatches.length} bridgeheads raised`);
}

// --- Quarters (Quartiere, OSM admin_level 10) -----------------------------------------------------------------------------
const areas = [];
for (const e of readJson('osm_zurich_areas.json').elements) {
  const name = e.tags?.name;
  if (!name) continue;
  const polys = polygons(e).map((p) => ({ ring: flat(cleanRing(p.ring, 2)), holes: p.holes.map((h) => flat(cleanRing(h, 2))) }));
  if (polys.length) areas.push({ id: name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '_'), name, polygons: polys });
}

// --- Landmarks: footprints of named buildings (by OSM name, or by id when unnamed) ------------------------------------------------------------------------------
const LANDMARKS = {
  'Grossmünster': ['Grossmünster'],
  'Fraumünster': ['Fraumünster', 'Fraumünsterkirche'],
  'St. Peter': ['St. Peter', 'Kirche St. Peter'],
  'Zürich HB': ['Zürich HB', 'Zürich Hauptbahnhof', 'r5708936'], // the station building is an unnamed relation
  'Landesmuseum': ['Landesmuseum', 'Landesmuseum Zürich', 'Schweizerisches Nationalmuseum'],
  'ETH Hauptgebäude': ['ETH Hauptgebäude (HG)', 'ETH Hauptgebäude'],
  'Opernhaus': ['Opernhaus', 'Opernhaus Zürich'],
  'Kunsthaus': ['Kunsthaus', 'Kunsthaus Zürich'],
  'Rathaus': ['Rathaus', 'Rathaus Zürich'],
  'Prime Tower': ['Prime Tower'],
  'Predigerkirche': ['Predigerkirche'],
  'Wasserkirche': ['Wasserkirche'],
  'Stadthaus': ['Stadthaus'],
  'Schauspielhaus': ['Schauspielhaus', 'Schauspielhaus Pfauen'],
  'Kongresshaus': ['Kongresshaus Zürich', 'Tonhalle']
};
const landmarks = {};
for (const b of buildings) {
  const key = Object.keys(LANDMARKS).find((k) => LANDMARKS[k].includes(b.name) || LANDMARKS[k].includes(b.id));
  if (!key) continue;
  const pts = [];
  for (let i = 0; i < b.ring.length; i += 2) pts.push([b.ring[i], b.ring[i + 1]]);
  const bb = bbox(pts);
  const area = Math.abs(ringArea(pts));
  if (landmarks[key] && landmarks[key].area >= area) continue;
  landmarks[key] = { x: r1((bb.x0 + bb.x1) / 2), z: r1((bb.z0 + bb.z1) / 2), w: r1(bb.x1 - bb.x0), d: r1(bb.z1 - bb.z0), h: b.h, area: Math.round(area), ring: b.ring };
}

// --- Municipal trees (Stadt Zürich Baumkataster) replace the sparser OSM trees ----------------------------------------------
// Height from the surveyed crown diameter (broad urban limes, planes & chestnuts: roughly 1.3x the crown + trunk),
// else from the planting year.
const TREES = path.join(CACHE, 'zurich_trees.json');
if (fs.existsSync(TREES)) {
  const year = new Date().getFullYear();
  const { trees: city } = JSON.parse(fs.readFileSync(TREES, 'utf8'));
  trees = city.map((g) => {
    const { x, z } = lv95ToWorld(g.E, g.N);
    const h = g.crown ? Math.min(30, 3 + g.crown * 1.3) : g.planted ? Math.min(24, 4 + (year - g.planted) * 0.4) : 10;
    return { x: r1(x), z: r1(z), h: r1(h), crown: g.crown ?? null, street: g.category === 'Strassenbaum' };
  }).filter((t) => inFrame(t.x, t.z));
  log(`using ${trees.length} municipal trees`);
}

const data = {
  meta: {
    name: FRAME.name, city: 'Zürich',
    bounds: WORLD_BOUNDS,
    lv95: FRAME.lv95,
    frame: `x = LV95 east - ${FRAME.E0}, z = ${FRAME.N0} - LV95 north, metres; y = height - ${FRAME.H0} m a.s.l.`,
    coordinateSystem: 'x east, z south, metres (Swiss LV95 grid)',
    origin: { E: FRAME.E0, N: FRAME.N0, H: FRAME.H0 },
    sources: [
      { name: 'OpenStreetMap contributors', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors' },
      { name: 'Stadt Zürich, Grün Stadt Zürich: Baumkataster', license: 'CC0 (Open Government Data Stadt Zürich)', url: 'https://data.stadt-zuerich.ch/dataset/geo_baumkataster' },
      { name: 'swisstopo swissALTI3D (terrain, data/zurich-terrain.bin)', license: 'OGD swisstopo', attribution: '© swisstopo' },
      { name: 'swisstopo swissBUILDINGS3D 3.0 (buildings, streamed)', license: 'OGD swisstopo', attribution: '© swisstopo' }
    ],
    areas,
    counts: { buildings: buildings.length, roads: roads.length, water: water.length, parks: parks.length, railways: railways.length, trees: trees.length, signals: signals.length, fountains: fountains.length, tramStops: tramStops.length }
  },
  buildings, roads, water, parks, railways, trees, signals, fountains, tramStops, landmarks, roadGraph, terrainPatches
};
fs.writeFileSync(OUT, `// js/zurich-geodata.js — GENERATED by tools/build-zurich-geodata.mjs, do not edit by hand.\n// Zürich inner city in the LV95 world frame of js/zurich-frame.js. © OpenStreetMap contributors (ODbL), Stadt Zürich (OGD), swisstopo.\nexport const ZURICH_DATA = ${JSON.stringify(data)};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`, JSON.stringify(data.meta.counts));
log('landmarks:', Object.keys(landmarks).join(', '), '| missing:', Object.keys(LANDMARKS).filter((k) => !landmarks[k]).join(', '));
log('areas:', areas.map((a) => a.name).join(', '));
