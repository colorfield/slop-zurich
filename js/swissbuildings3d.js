import * as THREE from 'three/webgpu';
import { mx_noise_float, positionWorld, normalWorld, float, smoothstep, fract, step, vertexColor, attribute, vec3, mix } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FRAME } from './zurich-frame.js';
import { ecefToLv95 } from './swiss-projection.js';

// swisstopo swissBUILDINGS3D 3.0: every building of Switzerland with its real roof, as 3D Tiles 1.0 (b3dm with Draco
// glTF, georeferenced in WGS84 ECEF). The tiles overlapping the city are listed by tools/build-swissbuildings3d-index.mjs
// in data/swissbuildings3d-tiles.json; they stream in nearest first and are baked into engine coordinates:
//   x = LV95 east - E0, z = N0 - LV95 north, y = height a.s.l. - H0 (js/zurich-frame.js).
// Each tile gets an exact local affine map (the Jacobian of the rigorous ECEF -> LV95 transformation at its centre: a
// tile spans ~100 m, so the residual is far below a millimetre). Heights come out above the Bessel ellipsoid; the batch
// table's surveyed roof tops (DACH_MAX, metres a.s.l.) calibrate each tile to orthometric heights without a geoid model.

const INDEX_URL = new URL('../data/swissbuildings3d-tiles.json', import.meta.url);

// --- b3dm container ----------------------------------------------------------------------------------------------------
export function parseB3dm(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'b3dm') throw new Error(`not a b3dm tile (${magic})`);
  const ftJson = view.getUint32(12, true), ftBin = view.getUint32(16, true);
  const btJson = view.getUint32(20, true), btBin = view.getUint32(24, true);
  const text = (start, length) => (length ? JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length))) : {});
  const featureTable = text(28, ftJson);
  const batchTable = text(28 + ftJson + ftBin, btJson);
  const glbStart = 28 + ftJson + ftBin + btJson + btBin;
  return { featureTable, batchTable, glb: buffer.slice(glbStart, view.getUint32(8, true)) };
}

// --- Tile frame: glTF (y-up, relative to RTC_CENTER) -> engine ------------------------------------------------------------
const Y_UP_TO_Z_UP = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

// Engine coordinates of a WGS84 ECEF point, heights above the Bessel ellipsoid minus H0 (uncalibrated)
function ecefToEngine(x, y, z) {
  const p = ecefToLv95(x, y, z);
  return [p.E - FRAME.E0, p.h - FRAME.H0, FRAME.N0 - p.N];
}

// Affine Matrix4 mapping ECEF offsets from `center` (an [x, y, z] array) to engine coordinates
export function tileMatrix(center) {
  const [cx, cy, cz] = center;
  const o = ecefToEngine(cx, cy, cz);
  const step = 1;
  const cols = [[step, 0, 0], [0, step, 0], [0, 0, step]].map(([dx, dy, dz]) => {
    const a = ecefToEngine(cx + dx, cy + dy, cz + dz), b = ecefToEngine(cx - dx, cy - dy, cz - dz);
    return [(a[0] - b[0]) / (2 * step), (a[1] - b[1]) / (2 * step), (a[2] - b[2]) / (2 * step)];
  });
  return new THREE.Matrix4().set(
    cols[0][0], cols[1][0], cols[2][0], o[0],
    cols[0][1], cols[1][1], cols[2][1], o[1],
    cols[0][2], cols[1][2], cols[2][2], o[2],
    0, 0, 0, 1
  );
}

function hash(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// Zurich palette: light plaster and sandstone facades, clay-tile and copper roofs, grey flat roofs
const color = new THREE.Color();
function facadeColor(seed, kind) {
  const r = hash(seed + 1), s = hash(seed * 7 + 3);
  if (/Kirche|Kapelle/.test(kind)) return color.setHSL(0.09 + s * 0.03, 0.08, 0.58 + r * 0.08);
  if (r < 0.45) return color.setHSL(0.10 + s * 0.04, 0.18 + r * 0.2, 0.74 + s * 0.12); // cream / ochre plaster
  if (r < 0.75) return color.setHSL(0.08 + s * 0.06, 0.04 + s * 0.06, 0.70 + r * 0.12); // light grey / white
  if (r < 0.9) return color.setHSL(0.07 + s * 0.03, 0.22, 0.56 + s * 0.12); // sandstone
  return color.setHSL(0.02 + s * 0.04, 0.26, 0.48 + s * 0.12); // muted red / rose
}
function roofColor(seed, pitched) {
  const r = hash(seed * 13 + 5), s = hash(seed * 3 + 11);
  if (!pitched) return color.setHSL(0.1, 0.03, 0.42 + r * 0.14); // gravel / membrane flat roofs
  if (r < 0.78) return color.setHSL(0.025 + s * 0.025, 0.45 + r * 0.15, 0.32 + s * 0.08); // clay tiles
  if (r < 0.9) return color.setHSL(0.47 + s * 0.04, 0.22, 0.42 + s * 0.08); // weathered copper
  return color.setHSL(0.6, 0.06, 0.28 + s * 0.06); // slate / eternit
}

// Bakes a decoded tile into one engine-space geometry: position, vertex colour, and the height above the building's
// surveyed ground point (aGround: storey lines and shop windows follow the street, whatever the terrain does).
export function bakeTile(gltf, tile, stats) {
  const { featureTable, batchTable } = tile;
  const rtc = featureTable.RTC_CENTER || [0, 0, 0];
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (!meshes.length) return null;
  // Tile centre in ECEF: RTC_CENTER plus the first mesh's node offset
  const firstNode = new THREE.Vector3().setFromMatrixPosition(meshes[0].matrixWorld).applyMatrix4(Y_UP_TO_Z_UP);
  const center = [rtc[0] + firstNode.x, rtc[1] + firstNode.y, rtc[2] + firstNode.z];
  const toEngine = tileMatrix(center)
    .multiply(new THREE.Matrix4().makeTranslation(rtc[0] - center[0], rtc[1] - center[1], rtc[2] - center[2]))
    .multiply(Y_UP_TO_Z_UP);

  let total = 0;
  for (const m of meshes) total += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
  const positions = new Float32Array(total * 3);
  const batchOf = new Uint32Array(total);
  const normalsY = new Float32Array(total);
  const v = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  let k = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const full = new THREE.Matrix4().multiplyMatrices(toEngine, m.matrixWorld);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(full);
    const pos = g.attributes.position, nor = g.attributes.normal, bid = g.attributes._batchid;
    const index = g.index;
    const n = index ? index.count : pos.count;
    for (let t = 0; t < n; t++) {
      const i = index ? index.getX(t) : t;
      v.fromBufferAttribute(pos, i).applyMatrix4(full);
      positions[k * 3] = v.x; positions[k * 3 + 1] = v.y; positions[k * 3 + 2] = v.z;
      normalsY[k] = nor ? nrm.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize().y : 0;
      batchOf[k] = bid ? Math.round(bid.getX(i)) : 0;
      k++;
    }
  }

  // Vertical calibration: surveyed roof tops against the baked (ellipsoidal) ones
  const roofTop = batchTable.DACH_MAX || [];
  const maxY = new Map();
  for (let i = 0; i < total; i++) maxY.set(batchOf[i], Math.max(maxY.get(batchOf[i]) ?? -Infinity, positions[i * 3 + 1]));
  const diffs = [];
  for (const [b, y] of maxY) if (Number.isFinite(roofTop[b])) diffs.push(roofTop[b] - FRAME.H0 - y);
  const local = median(diffs);
  if (local != null) stats.offsets.push(local);
  const dy = local ?? median(stats.offsets) ?? 0;

  const ground = batchTable.GELAENDEPUNKT || [];
  const kinds = batchTable.OBJEKTART || [];
  const egids = batchTable.EGID || [];
  const colors = new Uint8Array(total * 4);
  const above = new Float32Array(total);
  let minY = Infinity;
  for (let i = 0; i < total; i++) {
    const b = batchOf[i];
    const y = positions[i * 3 + 1] + dy;
    positions[i * 3 + 1] = y;
    minY = Math.min(minY, y);
    const base = Number.isFinite(ground[b]) ? ground[b] - FRAME.H0 : y;
    above[i] = y - base;
    const seed = (egids[b] || 0) * 31 + b + (tile.seed || 0);
    const roof = normalsY[i] > 0.35;
    const c = roof ? roofColor(seed, normalsY[i] < 0.97) : facadeColor(seed, kinds[b] || '');
    colors[i * 4] = c.r * 255; colors[i * 4 + 1] = c.g * 255; colors[i * 4 + 2] = c.b * 255; colors[i * 4 + 3] = roof ? 255 : 0;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4, true));
  geometry.setAttribute('aGround', new THREE.BufferAttribute(above, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  geometry.userData = { buildings: maxY.size, calibration: dy, minY };
  return geometry;
}

function createMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, flatShading: true });
  const above = attribute('aGround', 'float');
  const roof = vertexColor().a;
  // A soft grain, storey lines and window bays on the facades (none on roofs or the ground floor's plinth)
  const grain = mx_noise_float(positionWorld.mul(0.6)).mul(0.08).add(0.96);
  const wall = step(normalWorld.y.abs(), 0.35).mul(float(1).sub(roof));
  const along = positionWorld.x.mul(normalWorld.z.abs()).add(positionWorld.z.mul(normalWorld.x.abs()));
  const u = fract(along.div(2.9)), v = fract(above.div(3.15));
  const upper = step(3.6, above);
  const win = smoothstep(0.2, 0.25, u).mul(smoothstep(0.8, 0.75, u)).mul(smoothstep(0.3, 0.35, v)).mul(smoothstep(0.85, 0.8, v));
  const glass = win.mul(wall).mul(upper);
  const shop = step(0.6, above).mul(step(above, 3.0)).mul(wall).mul(smoothstep(0.08, 0.12, u)).mul(smoothstep(0.92, 0.88, u));
  const base = vertexColor().rgb.mul(grain);
  m.colorNode = mix(mix(base, vec3(0.12, 0.14, 0.16), glass.mul(0.8)), vec3(0.16, 0.17, 0.18), shop.mul(0.7));
  m.roughnessNode = mix(float(0.92), float(0.25), glass.add(shop).min(1));
  return m;
}

let gltfLoader = null;
function loaderFor() {
  if (gltfLoader) return gltfLoader;
  const draco = new DRACOLoader().setDecoderPath(new URL('libs/draco/gltf/', import.meta.resolve('three/addons/')).href);
  gltfLoader = new GLTFLoader().setDRACOLoader(draco);
  return gltfLoader;
}

async function fetchBuffer(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return await res.arrayBuffer();
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

/**
 * Streams the city's swissBUILDINGS3D tiles into `scene`, nearest to `center` first.
 * Returns { group, ready, done }: `ready` resolves once every tile within `nearRadius` is in (or rejects when the
 * service can't be reached at all), `done` once all tiles are.
 */
export function streamSwissBuildings(scene, { center = { x: 0, z: 0 }, nearRadius = 450, concurrency = 8, onProgress } = {}) {
  const group = new THREE.Group();
  group.name = 'swissbuildings3d';
  group.userData.terrain = 'absolute'; // baked in world heights
  scene.add(group);
  const material = createMaterial();
  const stats = { offsets: [], buildings: 0, failed: 0 };
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  const done = (async () => {
    const index = await (await fetch(INDEX_URL)).json();
    const tiles = index.tiles.map((t, i) => ({ ...t, seed: i * 977, d: Math.hypot(t.x - center.x, t.z - center.z) })).sort((a, b) => a.d - b.d);
    const near = tiles.filter((t) => t.d <= nearRadius).length || Math.min(tiles.length, 12);
    let next = 0, loaded = 0, settled = 0;
    const settle = () => {
      settled++;
      onProgress?.(loaded, tiles.length);
      if (settled === near) (loaded ? resolveReady(group) : rejectReady(new Error('no swissBUILDINGS3D tile could be loaded')));
    };
    const worker = async () => {
      while (next < tiles.length) {
        const t = tiles[next++];
        try {
          const tile = parseB3dm(await fetchBuffer(index.base + t.u));
          const gltf = await loaderFor().parseAsync(tile.glb, '');
          const geometry = bakeTile(gltf, { ...tile, seed: t.seed }, stats);
          if (geometry) {
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = t.u;
            mesh.castShadow = mesh.receiveShadow = true;
            group.add(mesh);
            stats.buildings += geometry.userData.buildings;
          }
          loaded++;
        } catch (error) {
          stats.failed++;
          if (stats.failed <= 3) console.warn('[swissbuildings3d]', t.u, error);
        }
        settle();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    group.userData = { terrain: 'absolute', city: 'Zürich', source: `swisstopo swissBUILDINGS3D 3.0 (${index.release})`, tiles: loaded, failed: stats.failed, buildings: stats.buildings, calibration: median(stats.offsets) };
    console.info(`[swissbuildings3d] ${loaded}/${tiles.length} tiles, ${stats.buildings} buildings, height calibration ${median(stats.offsets)?.toFixed(2)} m`);
    return group;
  })();
  done.catch((error) => rejectReady(error));
  return { group, ready, done };
}
