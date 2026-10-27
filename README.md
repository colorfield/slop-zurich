# Slop Zürich

A simulation of Zurich's inner city built with [three.js](https://threejs.org/), WebGPURenderer and TSL. Explore the
Altstadt, the Limmat, the Bahnhofstrasse, the lake front, the ETH terrace and Zurich-West on foot, by car, by bicycle
or cargo bike, or by helicopter, at 1:1 and **on the real relief**.

Based on [Slop New York](https://github.com/mrdoob/slop-newyork) by mrdoob, through the irregular-city data path of the
Berlin and Warsaw forks and [Slop Utrecht](https://github.com/bertt/slop-utrecht) by bertt. More cities in
[Slop Cities](https://github.com/zz85/slop-cities).

## What makes it Zurich

- **swisstopo swissBUILDINGS3D 3.0**: every building with its real roof, from the 3D Tiles (b3dm, Draco) of
  `3d.geo.admin.ch` stored in the repository and streamed into the scene nearest first. Each tile gets an exact local
  affine map from the rigorous ECEF → LV95 transformation, and its heights are calibrated on the surveyed roof tops
  (`DACH_MAX`) rather than on a geoid model. The OSM footprints remain as colliders and as the fallback when the
  tiles can't be loaded.
- **swisstopo swissALTI3D**: the terrain model (2 m, resampled to a 4 m grid) under everything: streets, parks,
  rivers, quays and the slopes of the Zürichberg. Cars pitch and roll with the streets, pedestrians' feet find the
  ground, the helicopter's floor is the relief.
- **Bridges at their real height**: the terrain model is bare earth (it holds the river or the tracks under a bridge),
  so deck heights are sampled from **swissSURFACE3D Raster** at every bridge node, checked against the neighbouring
  nodes and interpolated along each bridge chain. The Hardbrücke spans the tracks ~12 m up; vehicles and pedestrians
  keep to the level they are on (over or under a bridge).
- **The horizon**: the relief around the city from **swissALTIRegio** (10 m), in two rings stitched to the city's
  terrain: ±12 km at 50 m (the Uetliberg, the Pfannenstiel, the rest of the lake) and ±91 km at 275 m (the Rigi, the
  Pilatus, the Glarus Alps, the Säntis), lowered by the Earth's curvature, under a lighter haze than New York's.
- **Trams and tracks**: the rails of the VBZ's metre-gauge network in the streets and of the SBB lines on their
  ballast, and 40 blue and white articulated trams (five sections bending through the curves) on the right-hand track
  of the double lines, stopping at the tram stops and keeping their distance (`js/trams.js`).
- **LV95 world frame**: 1 unit = 1 m, `x = E − 2683000`, `z = 1247700 − N`, `y = height − 406 m` (lake level). The
  WGS84 ↔ LV95 transformation (`js/swiss-projection.js`) matches swisstopo REFRAME to the millimetre.
- **City of Zurich tree cadastre** (16,000 park and street trees, sized from their surveyed crowns), the official
  quarters (Quartiere) for place names, and teleports and viewpoints for the HB, Grossmünster, Fraumünster,
  Paradeplatz, Bellevue, Bürkliplatz, Kunsthaus, ETH, Langstrasse, Enge and the Prime Tower.

## Run it

Any static server will do, for example:

```sh
npm run serve          # python3 -m http.server 8765 → http://127.0.0.1:8765/
npm install && npm test
```

A WebGPU-capable browser is needed (recent Chrome, Edge or Safari).

## Publish

The site is static, with relative paths, so it runs from any sub-path such as `https://<user>.github.io/slop-zurich/`.
`.github/workflows/pages.yml` runs the tests on every push to `main`, then publishes `index.html`, `css`, `js`,
`assets` and `data` (about 72 MB) to GitHub Pages. In the repository settings, set **Pages > Build and deployment >
Source** to **GitHub Actions**.

## Data

The generated data is committed (`js/zurich-geodata.js`, `data/zurich-terrain.bin`, `data/zurich-surroundings.bin`,
`data/swissbuildings3d/`); the raw downloads go to `tools/data/cache/` (not committed). To rebuild everything:

```sh
npm install
npm run data
```

| Step | Script | Source |
| --- | --- | --- |
| `data:osm`, `data:areas` | `tools/overpass.sh` + `tools/data/q_zurich*.overpassql` | OpenStreetMap (Overpass API) |
| `data:trees` | `tools/fetch-zurich-trees.mjs` | Stadt Zürich, Baumkataster (WFS) |
| `data:terrain` | `tools/build-zurich-terrain.mjs` | swisstopo swissALTI3D (STAC, cloud-optimised GeoTIFF) |
| `data:decks` | `tools/fetch-bridge-decks.mjs` | swisstopo swissSURFACE3D Raster (HTTP range reads around the bridges) |
| `data:geo` | `tools/build-zurich-geodata.mjs` | all of the above → `js/zurich-geodata.js` |
| `data:surroundings` | `tools/build-zurich-surroundings.mjs` | swisstopo swissALTIRegio (cloud-optimised GeoTIFF overviews) |

The buildings are a copy of one swissBUILDINGS3D release (`data/swissbuildings3d/index.json` names it), so the game
never depends on swisstopo's servers. Moving to a newer release is deliberate:

```sh
npm run update:buildings   # tools/update-swissbuildings3d.mjs: the newest release's tiles over the city (~56 MB)
```

It downloads and checks every tile before replacing the stored copy; look at the city, then commit.

The mapped area is LV95 E 2681100–2684900, N 1245800–1249600 (3.8 × 3.8 km), set in `js/zurich-frame.js`.

## How the relief fits a flat-world engine

The engine was written for Manhattan at `y = 0`. `js/terrain.js` provides `groundHeight`, `deckHeight` and
`surfaceHeight(x, z, nearY)` (the deck or the ground, whichever is nearest the current height), and lays the static
scenery onto the terrain once it is built: ground layers (roads, paths, lawns, rivers) are subdivided and lifted
vertex by vertex, while the terrain mesh sinks a little under them; solids (curbs, quay walls) are displaced;
street furniture, trees and other small objects are lifted rigidly, upright. Vehicles, pedestrians, the player, the
cameras, the shadows and the colliders query the same surface.

## Ideas

- SWISSIMAGE orthophotos on the ground and the roofs.
- The VBZ lines and timetables (GTFS) for the trams, and the trams as obstacles for the traffic and the player.
- The Polybahn, the Dolderbahn and the lake boats.

## License and data

The code is available under the [MIT License](LICENSE).

Data: © [swisstopo](https://www.swisstopo.admin.ch/) (swissBUILDINGS3D 3.0, swissALTI3D, swissSURFACE3D, swissALTIRegio, open
government data), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL),
[Stadt Zürich](https://data.stadt-zuerich.ch/dataset/geo_baumkataster) open government data (Baumkataster). Third-party
data and dependencies retain their respective licenses.
