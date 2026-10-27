// tools/osm-geometry.mjs — OpenStreetMap geometry in the world frame (js/zurich-frame.js), shared by the data tools:
// projection of Overpass `out geom` coordinates, ring simplification, multipolygon assembly and clipping to the frame.
import { WORLD_BOUNDS, lonLatToWorld } from '../js/zurich-frame.js';

const [MIN_X, MIN_Z, MAX_X, MAX_Z] = WORLD_BOUNDS;
const r1 = (v) => Math.round(v * 10) / 10;

export const toWorld = (lon, lat) => { const p = lonLatToWorld(lon, lat); return [p.x, p.z]; };
export const flat = (pts) => pts.flatMap(([x, z]) => [r1(x), r1(z)]);
export const geomPts = (g) => (g || []).map((p) => toWorld(p.lon, p.lat));
export const inFrame = (x, z, margin = 0) => x >= MIN_X - margin && x <= MAX_X + margin && z >= MIN_Z - margin && z <= MAX_Z + margin;

export function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
export function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1 };
}
export const bboxInFrame = (b, margin = 0) => b.x1 >= MIN_X - margin && b.x0 <= MAX_X + margin && b.z1 >= MIN_Z - margin && b.z0 <= MAX_Z + margin;
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const dx = pts[b][0] - pts[a][0], dz = pts[b][1] - pts[a][1];
    const L = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - pts[a][0]) * dz - (pts[i][1] - pts[a][1]) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
export const closed = (r) => r.length > 3 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 0.3;
// Open ring (first point not repeated), simplified
export const cleanRing = (r, eps = 0.4) => {
  const open = closed(r) ? r.slice(0, -1) : r;
  const s = rdp([...open, open[0]], eps).slice(0, -1);
  return s.length >= 3 ? s : open;
};
// Chains outer/inner member ways of a relation into closed rings
export function chainRings(members) {
  const parts = members.filter((m) => m.geometry && m.geometry.length > 1).map((m) => geomPts(m.geometry));
  const rings = [];
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3;
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; guard < 4000 && !near(ring[0], ring[ring.length - 1]); guard++) {
      const end = ring[ring.length - 1];
      const i = parts.findIndex((p) => near(p[0], end) || near(p[p.length - 1], end));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      ring = ring.concat(near(p[0], end) ? p.slice(1) : p.reverse().slice(1));
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings;
}
// Outer rings with their holes: [{ ring, holes }]
export function polygons(e) {
  if (e.type === 'way') {
    const r = geomPts(e.geometry);
    return closed(r) ? [{ ring: r, holes: [] }] : [];
  }
  const outers = chainRings((e.members || []).filter((m) => m.role === 'outer' || m.role === ''));
  const inners = chainRings((e.members || []).filter((m) => m.role === 'inner'));
  return outers.map((ring) => {
    const bb = bbox(ring);
    const holes = inners.filter((h) => h[0][0] >= bb.x0 && h[0][0] <= bb.x1 && h[0][1] >= bb.z0 && h[0][1] <= bb.z1);
    return { ring, holes };
  });
}
// Clips a ring to the frame (plus a margin): the lake, the woods and some parks reach far beyond the mapped city
export function clipToFrame(ring, margin = 20) {
  const edges = [[1, 0, -(MIN_X - margin)], [-1, 0, MAX_X + margin], [0, 1, -(MIN_Z - margin)], [0, -1, MAX_Z + margin]];
  let out = ring;
  for (const [a, b, c] of edges) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i], q = input[(i + 1) % input.length];
      const dp = a * p[0] + b * p[1] + c, dq = a * q[0] + b * q[1] + c;
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    if (out.length < 3) return [];
  }
  return out;
}
