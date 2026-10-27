import * as THREE from 'three/webgpu';
import { float, mix, mx_noise_float, normalGeometry, positionGeometry, positionWorld, smoothstep, step, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ZURICH_DATA } from './zurich-geodata.js';
import { drapeOverlay, surfaceHeight, ROAD_TOP } from './terrain.js';

// Zurich's tracks and trams (OSM railway=tram / rail in js/zurich-geodata.js):
//  - the rails of the VBZ's metre-gauge tram network in the streets, and the SBB's standard-gauge lines on their
//    ballast (the HB's track field, the lines to Oerlikon and Enge), laid on the terrain or the bridge decks;
//  - blue and white articulated trams (five ~7 m sections, each following the track, so a tram bends through the
//    curves) running on the right-hand track of double lines (the direction of a track is inferred from the parallel
//    one), stopping at the tram stops and keeping their distance.

const TRAM_SECTIONS = 5, SECTION = 7.3, GAP = 0.25, PITCH = SECTION + GAP; // ~37 m, like a Flexity
const TRAM_COUNT = 40;
const MAX_SPEED = 13, ACCEL = 1.1, BRAKE = 1.4, HEADWAY = 18, DWELL = [12, 22];

// --- Track network ---------------------------------------------------------------------------------------------------------
function polyline(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], z: flat[i + 1] });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1] };
}

// Position and unit direction at distance s along a way
function pointAt(way, s, out) {
  const { pts, cum } = way;
  s = Math.max(0, Math.min(way.len, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1e-6, t = (s - cum[i - 1]) / seg;
  out.x = a.x + (b.x - a.x) * t; out.z = a.z + (b.z - a.z) * t;
  out.dx = (b.x - a.x) / seg; out.dz = (b.z - a.z) / seg;
  return out;
}

function buildNetwork() {
  const ways = ZURICH_DATA.railways.filter((r) => r.kind === 'tram' && !r.tunnel && r.pts.length >= 4).map((r) => ({ ...polyline(r.pts), id: r.id, bridge: r.bridge, stops: [], dirs: 0 }));
  // Ends meeting at the same OSM node share their (rounded) coordinates
  const key = (p) => `${Math.round(p.x * 2)},${Math.round(p.z * 2)}`;
  const nodes = new Map();
  for (const w of ways) {
    for (const [end, p] of [[0, w.pts[0]], [1, w.pts[w.pts.length - 1]]]) {
      const k = key(p);
      if (!nodes.has(k)) nodes.set(k, []);
      nodes.get(k).push({ way: w, end });
    }
    w.ends = [key(w.pts[0]), key(w.pts[w.pts.length - 1])];
  }
  // Right-hand running: a track whose parallel twin lies on its left is run in its drawing direction (dirs = 1),
  // with the twin on its right against it (-1); single track both ways (0)
  const CELL = 16, grid = new Map();
  ways.forEach((w) => w.pts.forEach((p, i) => {
    if (!i) return;
    const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ w, i });
  }));
  const probe = {};
  for (const w of ways) {
    let left = 0, right = 0;
    for (let f = 0.2; f < 0.9; f += 0.2) {
      const m = pointAt(w, w.len * f, probe), lx = m.dz, lz = -m.dx;
      for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
        for (const { w: o, i } of grid.get(`${Math.floor(m.x / CELL) + gx},${Math.floor(m.z / CELL) + gz}`) || []) {
          if (o === w) continue;
          const a = o.pts[i - 1], b = o.pts[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1e-9;
          if (Math.abs((ex * m.dx + ez * m.dz) / Math.sqrt(L2)) < 0.9) continue; // not parallel
          const t = Math.max(0, Math.min(1, ((m.x - a.x) * ex + (m.z - a.z) * ez) / L2));
          const px = a.x + ex * t - m.x, pz = a.z + ez * t - m.z, d = Math.hypot(px, pz);
          if (d < 2 || d > 5) continue;
          if (px * lx + pz * lz > 0) left++; else right++;
        }
      }
    }
    w.dirs = left > right ? 1 : right > left ? -1 : 0;
  }
  // Tram stops within 4 m of a track, as distances along it
  for (const stop of ZURICH_DATA.tramStops) {
    for (const w of ways) {
      for (let i = 1; i < w.pts.length; i++) {
        const a = w.pts[i - 1], b = w.pts[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1e-9;
        const t = Math.max(0, Math.min(1, ((stop.x - a.x) * ex + (stop.z - a.z) * ez) / L2));
        if (Math.hypot(a.x + ex * t - stop.x, a.z + ez * t - stop.z) < 4) { w.stops.push(w.cum[i - 1] + Math.sqrt(L2) * t); break; }
      }
    }
  }
  for (const w of ways) w.stops.sort((p, q) => p - q);
  return { ways, nodes };
}

// --- Track geometry ----------------------------------------------------------------------------------------------------------
function strips(list, offsets, width, y) {
  const geometries = [];
  for (const r of list) {
    const deck = !!r.bridge;
    const positions = [];
    for (let i = 2; i < r.pts.length; i += 2) {
      const ax = r.pts[i - 2], az = r.pts[i - 1], bx = r.pts[i], bz = r.pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      for (const o of offsets) {
        const p = (s, side) => [(s ? bx : ax) + nx * (o + side * width / 2), y, (s ? bz : az) + nz * (o + side * width / 2)];
        positions.push(...p(0, -1), ...p(1, -1), ...p(1, 1), ...p(0, -1), ...p(1, 1), ...p(0, 1));
      }
    }
    if (!positions.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(positions.length).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
    geometries.push(drapeOverlay(g, { deck, maxEdge: 4 }));
    g.dispose();
  }
  return geometries.length ? mergeGeometries(geometries, false) : null;
}

function buildTracks(group) {
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0x9a9da2, roughness: 0.32, metalness: 0.85 });
  const ballast = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  ballast.colorNode = mix(vec3(0.09, 0.08, 0.07), vec3(0.16, 0.14, 0.12), mx_noise_float(positionWorld.xz.mul(3.1)).mul(0.5).add(0.5));
  const tram = ZURICH_DATA.railways.filter((r) => r.kind === 'tram' && !r.tunnel);
  const rail = ZURICH_DATA.railways.filter((r) => /^(rail|narrow_gauge)$/.test(r.kind) && !r.tunnel);
  const parts = [
    [strips(rail, [0], 3.2, 0.03), ballast],
    [strips(rail, [-0.7175, 0.7175], 0.075, 0.1), steel],
    [strips(tram, [-0.5, 0.5], 0.075, 0.075), steel] // metre gauge, flush with the road
  ];
  for (const [geometry, material] of parts) {
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

// --- Trams -------------------------------------------------------------------------------------------------------------------
// VBZ livery: white body, blue skirt and stripe, dark glazing, grey roof (colours in linear space)
function createTramMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.1 });
  const y = positionGeometry.y, side = float(1).sub(step(0.7, normalGeometry.y.abs()));
  const glazing = smoothstep(1.28, 1.32, y).mul(smoothstep(2.62, 2.58, y)).mul(side);
  const skirt = smoothstep(0.98, 0.94, y);
  const stripe = smoothstep(2.78, 2.8, y).mul(smoothstep(2.95, 2.93, y)).mul(side);
  const roof = step(0.7, normalGeometry.y);
  const white = vec3(0.82, 0.83, 0.84), blue = vec3(0.0, 0.07, 0.32);
  const body = mix(mix(white, blue, skirt.add(stripe).min(1)), vec3(0.015, 0.02, 0.03), glazing);
  m.colorNode = mix(body, vec3(0.25, 0.26, 0.27), roof);
  m.roughnessNode = mix(float(0.4), float(0.08), glazing);
  m.metalnessNode = mix(float(0.1), float(0.6), glazing);
  return m;
}

function tramSectionGeometry() {
  const g = new THREE.BoxGeometry(2.4, 3.15, SECTION, 1, 4, 1);
  g.translate(0, 0.3 + 3.15 / 2, 0); // low floor, 0.3 m above the rails
  return g;
}

export function buildTrams(scene) {
  const group = new THREE.Group();
  group.name = 'ZurichTrams';
  group.userData.terrain = 'absolute';
  buildTracks(group);
  const { ways, nodes } = buildNetwork();
  const sections = new THREE.InstancedMesh(tramSectionGeometry(), createTramMaterial(), TRAM_COUNT * TRAM_SECTIONS);
  sections.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sections.castShadow = sections.receiveShadow = true;
  sections.frustumCulled = false;
  group.add(sections);
  scene.add(group);

  const runnable = ways.filter((w) => w.len > 40);
  const totalLen = runnable.reduce((a, w) => a + w.len, 0);
  const rand = (() => { let s = 20260520; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 1) >>> 0) / 4294967296; })();
  const pickWay = () => { let r = rand() * totalLen; for (const w of runnable) if ((r -= w.len) <= 0) return w; return runnable[0]; };

  // The way a tram enters from (way, end) heading out of the node: straightest continuations first, with variety
  function nextWay(way, end) {
    const here = pointAt(way, end ? way.len : 0, {});
    const hx = end ? here.dx : -here.dx, hz = end ? here.dz : -here.dz;
    const options = [];
    for (const c of nodes.get(way.ends[end]) || []) {
      if (c.way === way) continue;
      const dir = c.end === 0 ? 1 : -1;
      if (c.way.dirs && c.way.dirs !== dir) continue;
      const p = pointAt(c.way, c.end ? c.way.len : 0, {});
      const cos = hx * p.dx * dir + hz * p.dz * dir;
      if (cos > 0.5) options.push({ way: c.way, dir, weight: cos * cos });
    }
    if (!options.length) return null;
    let r = rand() * options.reduce((a, o) => a + o.weight, 0);
    for (const o of options) if ((r -= o.weight) <= 0) return o;
    return options[0];
  }

  // A tram somewhere on the network, its sections following the front's trail (laid straight along the way to start)
  function place(t) {
    const way = pickWay();
    Object.assign(t, { way, dir: way.dirs || (rand() < 0.5 ? 1 : -1), s: way.len * (0.2 + rand() * 0.6), speed: MAX_SPEED * 0.5, dwell: 0, served: null, trail: [], y: undefined });
    const p = pointAt(way, t.s, {});
    for (let d = PITCH * TRAM_SECTIONS + 2; d >= 0; d -= 1) t.trail.push({ x: p.x - p.dx * t.dir * d, z: p.z - p.dz * t.dir * d });
    return t;
  }
  const trams = Array.from({ length: TRAM_COUNT }, () => place({}));

  const probe = {}, m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scale = new THREE.Vector3(1, 1, 1), euler = new THREE.Euler(0, 0, 0, 'YXZ');
  // Point at distance d behind the front along the trail (front last)
  function behind(trail, d, out) {
    for (let i = trail.length - 1; i > 0; i--) {
      const a = trail[i], b = trail[i - 1], L = Math.hypot(a.x - b.x, a.z - b.z);
      if (d <= L) { const f = d / (L || 1); out.x = a.x + (b.x - a.x) * f; out.z = a.z + (b.z - a.z) * f; return out; }
      d -= L;
    }
    out.x = trail[0].x; out.z = trail[0].z;
    return out;
  }

  function update(dt) {
    for (const t of trams) {
      // Next stop ahead on this way, and the tram ahead on the same track
      const ahead = t.way.stops.filter((s) => (s - t.s) * t.dir > 0.5 && s !== t.served).map((s) => Math.abs(s - t.s));
      let limit = MAX_SPEED;
      if (ahead.length) limit = Math.min(limit, Math.sqrt(2 * BRAKE * Math.max(0, Math.min(...ahead) - 0.5)));
      for (const o of trams) {
        if (o === t || o.way !== t.way || o.dir !== t.dir) continue;
        const gap = (o.s - t.s) * t.dir - PITCH * TRAM_SECTIONS;
        if (gap > -PITCH * TRAM_SECTIONS && gap < 200) limit = Math.min(limit, Math.sqrt(2 * BRAKE * Math.max(0, gap - HEADWAY)));
      }
      if (t.dwell > 0) { t.dwell -= dt; t.speed = 0; continue; }
      t.speed = t.speed < limit ? Math.min(limit, t.speed + ACCEL * dt) : Math.max(limit, t.speed - BRAKE * 2 * dt);
      if (ahead.length && Math.min(...ahead) < 0.8 && t.speed < 0.3) {
        t.served = t.way.stops.find((s) => Math.abs(s - t.s) < 0.8) ?? null;
        t.dwell = DWELL[0] + rand() * (DWELL[1] - DWELL[0]);
      }
      t.s += t.speed * dt * t.dir;
      // Leaving the way: on to the next one; at a dead end (a depot, the edge of the map) the tram starts over elsewhere
      if (t.s > t.way.len || t.s < 0) {
        const end = t.s > t.way.len ? 1 : 0;
        const over = end ? t.s - t.way.len : -t.s;
        const next = nextWay(t.way, end);
        if (!next) { place(t); continue; }
        t.way = next.way; t.dir = next.dir; t.s = next.dir > 0 ? over : next.way.len - over;
        t.served = null;
      }
      const front = pointAt(t.way, t.s, probe);
      const last = t.trail[t.trail.length - 1];
      if (Math.hypot(front.x - last.x, front.z - last.z) > 0.5) {
        t.trail.push({ x: front.x, z: front.z });
        if (t.trail.length > 120) t.trail.splice(0, t.trail.length - 120);
      }
    }
    // Sections: centred between their couplings along the trail, upright on the surface they cross
    let k = 0;
    const a = {}, b = {};
    for (const t of trams) {
      const front = pointAt(t.way, t.s, probe);
      const trail = [...t.trail, { x: front.x, z: front.z }];
      for (let n = 0; n < TRAM_SECTIONS; n++) {
        behind(trail, n * PITCH, a);
        behind(trail, n * PITCH + SECTION, b);
        const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
        const ya = surfaceHeight(a.x, a.z, t.y), yb = surfaceHeight(b.x, b.z, t.y);
        if (n === 0) t.y = ya;
        euler.set(Math.atan2(yb - ya, SECTION), Math.atan2(a.x - b.x, a.z - b.z), 0);
        sections.setMatrixAt(k++, m.compose(pos.set(cx, (ya + yb) / 2 + ROAD_TOP + 0.015, cz), q.setFromEuler(euler), scale)); // on the rails' heads
      }
    }
    sections.count = k;
    sections.instanceMatrix.needsUpdate = true;
  }
  update(0);
  group.userData.stats = { trams: TRAM_COUNT, ways: ways.length, stops: ways.reduce((a, w) => a + w.stops.length, 0) };
  return { group, update, trams };
}
