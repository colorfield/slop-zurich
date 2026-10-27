// tools/build-zurich-surroundings.mjs — writes data/zurich-surroundings.bin: the relief around the mapped city, from
// swisstopo swissALTIRegio (10 m, one cloud-optimised GeoTIFF for Switzerland and its borders, read from the
// overview matching each ring with HTTP range requests). Two square rings, centred on the frame, whose grids line up
// with each other and with the frame's edges (js/surroundings.js stitches them):
//   mid: ±12.1 km at 50 m (the Uetliberg, the Zürichberg, the Pfannenstiel, the lake)
//   far: ±90.75 km at 275 m (the Rigi, the Pilatus, the Glarus Alps, the Säntis on the horizon)
// File layout (little endian), per ring: 'ZTR1' header and int16 heights as in data/zurich-terrain.bin (scale 0.2 m),
// the mid ring first.
// usage: node tools/build-zurich-surroundings.mjs [out.bin]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromUrl } from 'geotiff';
import { FRAME } from '../js/zurich-frame.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(DIR, '..', 'data', 'zurich-surroundings.bin');
const COG = 'https://data.geo.admin.ch/ch.swisstopo.swissaltiregio/swissaltiregio/swissaltiregio_2056_5728.tif';
const RINGS = [{ name: 'mid', half: 12100, cell: 50 }, { name: 'far', half: 90750, cell: 275 }];
const SCALE = 0.2;
const log = (...a) => console.log('[zurich-surroundings]', ...a);

const tiff = await fromUrl(COG);
const images = [];
for (let i = 0; i < await tiff.getImageCount(); i++) images.push(await tiff.getImage(i));
const [x0, , x1, y1] = images[0].getBoundingBox();
const nodata = images[0].getGDALNoData();
const cx = (FRAME.lv95[0] + FRAME.lv95[2]) / 2, cy = (FRAME.lv95[1] + FRAME.lv95[3]) / 2;
const buffers = [];
for (const { name, half, cell } of RINGS) {
  const n = Math.round((2 * half) / cell) + 1;
  // The coarsest overview still at least as fine as the ring, read over the ring's extent (plus a margin)
  const image = images.filter((im) => (x1 - x0) / im.getWidth() <= cell).at(-1);
  const res = (x1 - x0) / image.getWidth();
  const E0 = cx - half - 2 * cell, N1 = cy + half + 2 * cell, E1 = cx + half + 2 * cell, N0 = cy - half - 2 * cell;
  const win = [Math.max(0, Math.floor((E0 - x0) / res)), Math.max(0, Math.floor((y1 - N1) / res)),
    Math.min(image.getWidth(), Math.ceil((E1 - x0) / res)), Math.min(image.getHeight(), Math.ceil((y1 - N0) / res))];
  const [raster] = await image.readRasters({ window: win });
  const w = win[2] - win[0], h = win[3] - win[1];
  const sample = (E, N) => {
    // bilinear between pixel centres
    const u = (E - x0) / res - win[0] - 0.5, v = (y1 - N) / res - win[1] - 0.5;
    const i = Math.max(0, Math.min(w - 2, Math.floor(u))), j = Math.max(0, Math.min(h - 2, Math.floor(v)));
    const fu = Math.min(1, Math.max(0, u - i)), fv = Math.min(1, Math.max(0, v - j));
    const at = (a, b) => { const z = raster[b * w + a]; return z === nodata || z < -100 || z > 9000 ? NaN : z; };
    const z = (at(i, j) * (1 - fu) + at(i + 1, j) * fu) * (1 - fv) + (at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu) * fv;
    return Number.isFinite(z) ? z : FRAME.H0; // beyond the survey (far corners abroad): lake level, under the haze
  };
  const heights = new Int16Array(n * n);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    // Rows run from north (z = -half) to south, like the terrain grid
    const H = sample(cx - half + i * cell, cy + half - j * cell);
    lo = Math.min(lo, H); hi = Math.max(hi, H);
    heights[j * n + i] = Math.round((H - FRAME.H0) / SCALE);
  }
  const header = Buffer.alloc(24);
  header.write('ZTR1', 0, 'ascii');
  header.writeUInt16LE(n, 4); header.writeUInt16LE(n, 6);
  header.writeFloatLE(cell, 8);
  header.writeFloatLE(cx - FRAME.E0 - half, 12); header.writeFloatLE(FRAME.N0 - cy - half, 16);
  header.writeFloatLE(SCALE, 20);
  buffers.push(header, Buffer.from(heights.buffer));
  log(`${name}: ${n}x${n} @ ${cell} m from the ${res} m overview, heights ${lo.toFixed(0)}..${hi.toFixed(0)} m a.s.l.`);
}
fs.writeFileSync(OUT, Buffer.concat(buffers));
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB)`);
