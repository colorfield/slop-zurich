import { wgs84ToLv95, lv95ToWgs84 } from './swiss-projection.js';

// The Zurich world frame, shared by the data tools and the browser.
// 1 unit = 1 m, x = LV95 east, z = LV95 south (grid north = -z), y = height above the lake (Zürichsee ≈ 406 m a.s.l.).
// The origin (LV95 2683000 / 1247700) lies by the Bahnhofstrasse at the Seidengasse, 300 m south of the HB; LV95 is
// a conformal metric grid, so the frame is a plain offset.
export const FRAME = {
  name: 'Zürich · Innenstadt',
  E0: 2683000,
  N0: 1247700,
  H0: 406,
  // LV95 extent of the mapped city [minE, minN, maxE, maxN]
  lv95: [2681100, 1245800, 2684900, 1249600],
  // Grid spacing of the terrain model (tools/build-zurich-terrain.mjs)
  terrainCell: 4
};

export const lv95ToWorld = (east, north) => ({ x: east - FRAME.E0, z: FRAME.N0 - north });
export const worldToLv95 = (x, z) => ({ E: FRAME.E0 + x, N: FRAME.N0 - z });
export const lonLatToWorld = (lon, lat) => { const p = wgs84ToLv95(lon, lat); return lv95ToWorld(p.E, p.N); };
export const worldToLonLat = (x, z) => { const p = worldToLv95(x, z); return lv95ToWgs84(p.E, p.N); };

// World bounds [minX, minZ, maxX, maxZ]
export const WORLD_BOUNDS = [
  FRAME.lv95[0] - FRAME.E0, FRAME.N0 - FRAME.lv95[3], FRAME.lv95[2] - FRAME.E0, FRAME.N0 - FRAME.lv95[1]
];
