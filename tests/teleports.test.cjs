const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
let TELEPORT_LOCATIONS, LANDMARK_SITES, blockAt, nearestRoads, WORLD_BOUNDS;
test.before(async () => {
  ({ TELEPORT_LOCATIONS, LANDMARK_SITES, blockAt, nearestRoads } = await import('../js/city-config.js'));
  ({ WORLD_BOUNDS } = await import('../js/zurich-frame.js'));
});

test('every teleport button has a destination on a real roadway inside the mapped city', () => {
  const buttons = [...read('index.html').matchAll(/data-teleport="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(Object.keys(TELEPORT_LOCATIONS).sort(), buttons.sort());
  const [minX, minZ, maxX, maxZ] = WORLD_BOUNDS;
  for (const [name, point] of Object.entries(TELEPORT_LOCATIONS)) {
    assert.ok(Number.isFinite(point.heading), `${name} has a heading`);
    assert.equal(blockAt(point.x, point.z), null, `${name} lands outside buildings and sidewalks`);
    assert.ok(point.x > minX + 50 && point.x < maxX - 50 && point.z > minZ + 50 && point.z < maxZ - 50, `${name} stays inside the city`);
    const nearby = nearestRoads(point.x, point.z, 20);
    assert.ok(nearby.some(({ road, dist }) => dist < road.w / 2), `${name} lands within a street's width`);
  }
});

test('the Grossmünster arrives on the Limmatquai, facing the church', () => {
  const point = TELEPORT_LOCATIONS.grossmuenster;
  const church = LANDMARK_SITES['Grossmünster'];
  assert.ok(nearestRoads(point.x, point.z, 20).some(({ road, dist }) => road.name === 'Limmatquai' && dist < 1));
  const distance = Math.hypot(church.x - point.x, church.z - point.z);
  assert.ok(distance > 20 && distance < 150, `close to the church (${distance.toFixed(0)} m)`);
  const alignment = ((church.x - point.x) * Math.sin(point.heading) + (church.z - point.z) * Math.cos(point.heading)) / distance;
  assert.ok(alignment > 0.9, 'facing the church');
});

test('preset and map teleports share arrival resets and mark the resolved landing point', () => {
  const main = read('js/main.js');
  const start = main.indexOf('  function teleportTo(');
  const end = main.indexOf('  const openMapBtn', start);
  const handlers = new Map();
  const calls = [];
  const landed = { x: -305.7, z: 5210 };
  let map;
  const environment = {
    TELEPORT_LOCATIONS,
    controllerManager: {
      teleportActiveTo: (...args) => { calls.push(['teleport', ...args]); return landed; }
    },
    touchControls: { reset: () => calls.push(['touch']) },
    gamepadControls: { reset: () => calls.push(['gamepad']) },
    cameraSystem: { resetForTeleport: () => calls.push(['camera']) },
    selectCamera: (...args) => calls.push(['selectCamera', ...args]),
    getLocationLabel: (x, z) => `${x}, ${z}`,
    cityBlocks: { allBlocks: [] },
    trafficSystem: {},
    NYCMapSystem: class {
      constructor(options) { this.onTeleport = options.onTeleport; map = this; }
    },
    teleportButtons: Object.keys(TELEPORT_LOCATIONS).map((key) => ({
      getAttribute: () => key,
      addEventListener: (_event, handler) => handlers.set(key, handler)
    })),
    closePopovers: () => {}
  };
  vm.runInNewContext(main.slice(start, end), environment);
  for (const [name, point] of Object.entries(TELEPORT_LOCATIONS)) {
    calls.length = 0;
    handlers.get(name)();
    assert.deepEqual(calls, [
      ['teleport', point.x, point.z, point.heading], ['touch'], ['gamepad'], ['camera'], ['selectCamera', 'chase', true]
    ]);
    assert.equal(map.waypoint.x, landed.x);
    assert.equal(map.waypoint.z, landed.z);
  }
  map.waypoint = { x: 100, z: 200, name: 'inside a building' };
  map.onTeleport(100, 200);
  assert.equal(map.waypoint.x, landed.x, 'map marker follows the safe position returned by the controller');
  assert.equal(map.waypoint.z, landed.z);
  assert.equal(map.waypoint.name, `${landed.x}, ${landed.z}`);
});
