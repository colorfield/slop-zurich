// Import stubs for js/terrain.js and js/zurich-frame.js: a flat world at y = 0 without bridges, so that the engine's
// unit tests keep testing behaviour (the relief has its own tests: terrain-grid.test.mjs, zurich.test.mjs).
const terrain = {
  groundHeight: () => 0,
  surfaceHeight: () => 0,
  deckHeight: () => NaN,
  deckHalfWidth: () => 3,
  waterSurfaceHeight: () => 0,
  // The engine's own flat world: roadway at 0, raised sidewalks
  ROAD_TOP: 0,
  SIDEWALK_TOP: 0.22
};
const frame = {
  FRAME: { E0: 2683000, N0: 1247700, H0: 406 },
  lv95ToWorld: (E, N) => ({ x: E - 2683000, z: 1247700 - N })
};
module.exports = { flatTerrainImports: { './terrain.js': terrain, './zurich-frame.js': frame } };
