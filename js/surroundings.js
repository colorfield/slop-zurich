import * as THREE from 'three/webgpu';
import { attribute, float, mix, mx_noise_float, normalWorld, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { parseTerrain, gridHeight } from './terrain-grid.js';
import { TERRAIN, groundHeight } from './terrain.js';
import { createWaterMaterial } from './tsl-materials.js';

// The relief around the mapped city (data/zurich-surroundings.bin, tools/build-zurich-surroundings.mjs, swissALTIRegio):
// a mid ring (±12 km at 50 m: the Uetliberg, the Pfannenstiel, the rest of the lake) and a far ring (±91 km at 275 m:
// the Rigi, the Pilatus, the Glarus Alps, the Säntis). Each ring's grid lines up with the edge of the area inside it:
// its nodes on that edge take the inner surface's heights, and a skirt one cell wide runs some metres under the inner
// surface so that the seam never shows the sky. Beyond the city the Earth's curvature (less refraction) lowers the
// horizon: ~250 m at 60 km.

const URL_SURROUNDINGS = new URL('../data/zurich-surroundings.bin', import.meta.url);
const EARTH_RADIUS = 6371000, REFRACTION = 0.13;
const CITY_RADIUS = TERRAIN.maxX; // the curvature is left out within the city (< 0.3 m)

function parseRings(buffer) {
  const rings = [];
  for (let offset = 0; offset < buffer.byteLength;) {
    const view = new DataView(buffer, offset);
    const cols = view.getUint16(4, true), rows = view.getUint16(6, true);
    const bytes = 24 + cols * rows * 2;
    rings.push(parseTerrain(buffer.slice(offset, offset + bytes)));
    offset += bytes;
  }
  return rings;
}

const curvatureDrop = (x, z, inner) => {
  const d = Math.max(0, Math.hypot(x, z) - inner);
  return (d * d * (1 - REFRACTION)) / (2 * EARTH_RADIUS);
};

/**
 * One ring as a mesh: cells inside `hole` ({ minX, maxX, minZ, maxZ }, the area drawn in more detail) are left out but
 * for the skirt along its edge, `skirt` metres down (deep enough not to poke through the inner surface between two of
 * the ring's nodes). `innerHeight(x, z)`: the surface inside the hole, for the seam.
 */
function ringMeshes(grid, hole, innerHeight, materials, skirt) {
  const { cols, rows, cell, minX, minZ, heights } = grid;
  const inside = (x, z) => x > hole.minX + 0.01 && x < hole.maxX - 0.01 && z > hole.minZ + 0.01 && z < hole.maxZ - 0.01;
  const onEdge = (x, z) => !inside(x, z) && x >= hole.minX - 0.01 && x <= hole.maxX + 0.01 && z >= hole.minZ - 0.01 && z <= hole.maxZ + 0.01;
  const positions = new Float32Array(cols * rows * 3), altitudes = new Float32Array(cols * rows), lakes = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, x = minX + i * cell, z = minZ + j * cell;
    let h = heights[k];
    if (onEdge(x, z)) h = innerHeight(x, z);
    else if (inside(x, z)) h = innerHeight(x, z) - skirt; // the skirt, under the inner surface
    // A lake is perfectly level in the survey
    let flat = true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < cols && jj < rows && Math.abs(heights[jj * cols + ii] - heights[k]) > 0.25) flat = false;
    }
    lakes[k] = flat ? 1 : 0;
    altitudes[k] = heights[k];
    positions[k * 3] = x; positions[k * 3 + 1] = h - curvatureDrop(x, z, CITY_RADIUS); positions[k * 3 + 2] = z;
  }
  // Land and lake triangles (all three corners level, outside the city: its lake is drawn by city-grid.js) share the
  // vertices; the lakes take the city's water material so that the Zürichsee runs on seamlessly.
  const land = [], lake = [];
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const x0 = minX + i * cell, z0 = minZ + j * cell;
    // Keep the cells outside the hole and the one-cell band just inside its edge
    const ix = hole.minX + cell - 0.01 <= x0 && x0 + cell <= hole.maxX - cell + 0.01;
    const iz = hole.minZ + cell - 0.01 <= z0 && z0 + cell <= hole.maxZ - cell + 0.01;
    if (ix && iz) continue;
    const a = j * cols + i;
    for (const tri of [[a, a + cols + 1, a + 1], [a, a + cols, a + cols + 1]]) {
      const level = tri.every((v) => lakes[v]) && !inside(positions[tri[0] * 3], positions[tri[0] * 3 + 2]);
      (level ? lake : land).push(...tri);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aAltitude', new THREE.BufferAttribute(altitudes, 1));
  g.setAttribute('aLake', new THREE.BufferAttribute(lakes, 1));
  g.computeBoundingSphere(); g.computeBoundingBox();
  const meshes = [];
  for (const [index, material] of [[land, materials.land], [lake, materials.lake]]) {
    if (!index.length) continue;
    const part = g.clone();
    part.setIndex(new THREE.BufferAttribute(cols * rows > 65535 ? new Uint32Array(index) : new Uint16Array(index), 1));
    part.computeVertexNormals();
    const mesh = new THREE.Mesh(part, material);
    mesh.receiveShadow = material === materials.land;
    meshes.push(mesh);
  }
  return meshes;
}

// Meadows and woods of the plateau, rock above the tree line, snow on the gentler slopes of the high Alps, lakes
// (colours in linear space)
function createMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const altitude = attribute('aAltitude', 'float').add(406);
  const lake = smoothstep(0.6, 1.0, attribute('aLake', 'float'));
  const patches = mx_noise_float(positionWorld.xz.mul(0.002)).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionWorld.xz.mul(0.006)).mul(0.5).add(0.5);
  const slope = float(1).sub(normalWorld.y);
  const meadow = mix(vec3(0.07, 0.12, 0.035), vec3(0.11, 0.15, 0.05), fine);
  const forest = vec3(0.025, 0.05, 0.02);
  const lowland = mix(meadow, forest, smoothstep(0.45, 0.6, patches.add(slope.mul(1.4))));
  const rock = mix(vec3(0.13, 0.12, 0.11), vec3(0.2, 0.19, 0.17), fine);
  const snowline = smoothstep(2300, 2700, altitude.add(fine.mul(250))).mul(smoothstep(0.55, 0.3, slope));
  const ground = mix(mix(lowland, rock, smoothstep(1600, 2100, altitude.add(fine.mul(200)))), vec3(0.85, 0.88, 0.92), snowline);
  m.colorNode = mix(ground, vec3(0.03, 0.07, 0.09), lake);
  m.roughnessNode = mix(float(0.95), float(0.12), lake);
  return m;
}

export async function buildSurroundings(scene) {
  const res = await fetch(URL_SURROUNDINGS);
  if (!res.ok) throw new Error(`${URL_SURROUNDINGS}: ${res.status}`);
  const [mid, far] = parseRings(await res.arrayBuffer());
  const materials = { land: createMaterial(), lake: createWaterMaterial() };
  const group = new THREE.Group();
  group.name = 'surroundings';
  group.userData.terrain = 'absolute';
  const frame = { minX: TERRAIN.minX, maxX: TERRAIN.maxX, minZ: TERRAIN.minZ, maxZ: TERRAIN.maxZ };
  const midBox = { minX: mid.minX, maxX: mid.maxX, minZ: mid.minZ, maxZ: mid.maxZ };
  group.add(...ringMeshes(mid, frame, groundHeight, materials, 15));
  group.add(...ringMeshes(far, midBox, (x, z) => gridHeight(mid, x, z), materials, 40));
  scene.add(group);
  return group;
}
