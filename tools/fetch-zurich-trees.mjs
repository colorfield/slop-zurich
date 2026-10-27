// tools/fetch-zurich-trees.mjs — writes tools/data/cache/zurich_trees.json from the City of Zurich tree cadastre
// (Grün Stadt Zürich, Baumkataster, open data: https://data.stadt-zuerich.ch/dataset/geo_baumkataster), clipped to the
// world frame. Each tree keeps its LV95 position, crown diameter, planting year, genus and category.
// usage: node tools/fetch-zurich-trees.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME } from '../js/zurich-frame.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'data', 'cache', 'zurich_trees.json');
const WFS = 'https://www.ogd.stadt-zuerich.ch/wfs/geoportal/Baumkataster';
const [minE, minN, maxE, maxN] = FRAME.lv95;

// The service answers WFS 1.1.0 (MapServer); one request returns the whole perimeter.
const params = new URLSearchParams({
  service: 'WFS', version: '1.1.0', request: 'GetFeature', typename: 'baumkataster_baumstandorte',
  srsName: 'EPSG:2056', bbox: `${minE},${minN},${maxE},${maxN},EPSG:2056`, outputFormat: 'GeoJSON', maxFeatures: '200000'
});
const res = await fetch(`${WFS}?${params}`);
if (!res.ok) throw new Error(`${WFS}: ${res.status}`);
const { features } = await res.json();
const trees = features.map((f) => {
  const [E, N] = f.geometry.coordinates;
  const p = f.properties;
  return { E: Math.round(E * 10) / 10, N: Math.round(N * 10) / 10, crown: p.kronendurchmesser ?? null, planted: p.pflanzjahr ?? null, genus: p.baumgattunglat || '', category: p.kategorie || '' };
});
console.log(`[zurich-trees] ${trees.length} trees`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ source: WFS, fetched: new Date().toISOString().slice(0, 10), trees }));
console.log(`[zurich-trees] wrote ${OUT}`);
