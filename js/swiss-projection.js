// Rigorous WGS84 <-> Swiss LV95 (EPSG:2056) transformation, shared by the build tools and the browser.
// Datum: CH1903+ is WGS84/ETRS89 shifted by a constant geocentric translation; projection: the Swiss oblique conformal
// cylinder on the Bessel 1841 ellipsoid. Formulas: swisstopo, "Formulas and constants for the calculation of the
// Swiss conformal cylindrical projection and for the transformation between coordinate systems".

const WGS84 = { a: 6378137, e2: 0.00669437999014 };
const BESSEL = { a: 6377397.155, e2: 0.006674372230614 };
// CH1903+ geocentric = WGS84 geocentric - SHIFT
const SHIFT = [674.374, 15.056, 405.346];

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Projection constants (centre: old observatory of Bern)
const PHI0 = rad(46 + 57 / 60 + 8.66 / 3600);
const LAM0 = rad(7 + 26 / 60 + 22.5 / 3600);
const E = Math.sqrt(BESSEL.e2);
const R = (BESSEL.a * Math.sqrt(1 - BESSEL.e2)) / (1 - BESSEL.e2 * Math.sin(PHI0) ** 2);
const ALPHA = Math.sqrt(1 + (BESSEL.e2 / (1 - BESSEL.e2)) * Math.cos(PHI0) ** 4);
const B0 = Math.asin(Math.sin(PHI0) / ALPHA);
const K = Math.log(Math.tan(Math.PI / 4 + B0 / 2)) - ALPHA * Math.log(Math.tan(Math.PI / 4 + PHI0 / 2)) +
  ((ALPHA * E) / 2) * Math.log((1 + E * Math.sin(PHI0)) / (1 - E * Math.sin(PHI0)));

export function geodeticToEcef(lat, lon, h, ell = WGS84) {
  const n = ell.a / Math.sqrt(1 - ell.e2 * Math.sin(lat) ** 2);
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - ell.e2) + h) * Math.sin(lat)];
}

export function ecefToGeodetic(x, y, z, ell = WGS84) {
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  let lat = Math.atan2(z, p * (1 - ell.e2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const n = ell.a / Math.sqrt(1 - ell.e2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (ell.e2 * n) / (n + h)));
  }
  return { lat, lon, h };
}

// Bessel geodetic (radians) -> LV95 easting / northing (metres)
export function besselToLv95(lat, lon) {
  const S = ALPHA * Math.log(Math.tan(Math.PI / 4 + lat / 2)) -
    ((ALPHA * E) / 2) * Math.log((1 + E * Math.sin(lat)) / (1 - E * Math.sin(lat))) + K;
  const b = 2 * (Math.atan(Math.exp(S)) - Math.PI / 4);
  const l = ALPHA * (lon - LAM0);
  const lBar = Math.atan(Math.sin(l) / (Math.sin(B0) * Math.tan(b) + Math.cos(B0) * Math.cos(l)));
  const bBar = Math.asin(Math.cos(B0) * Math.sin(b) - Math.sin(B0) * Math.cos(b) * Math.cos(l));
  return { E: 2600000 + R * lBar, N: 1200000 + (R / 2) * Math.log((1 + Math.sin(bBar)) / (1 - Math.sin(bBar))) };
}

// LV95 easting / northing -> Bessel geodetic (radians)
export function lv95ToBessel(east, north) {
  const lBar = (east - 2600000) / R;
  const bBar = 2 * (Math.atan(Math.exp((north - 1200000) / R)) - Math.PI / 4);
  const b = Math.asin(Math.cos(B0) * Math.sin(bBar) + Math.sin(B0) * Math.cos(bBar) * Math.cos(lBar));
  const l = Math.atan(Math.sin(lBar) / (Math.cos(B0) * Math.cos(lBar) - Math.sin(B0) * Math.tan(bBar)));
  const lon = LAM0 + l / ALPHA;
  let lat = b;
  for (let i = 0; i < 8; i++) {
    const S = (Math.log(Math.tan(Math.PI / 4 + b / 2)) - K) / ALPHA + E * Math.log(Math.tan(Math.PI / 4 + Math.asin(E * Math.sin(lat)) / 2));
    lat = 2 * Math.atan(Math.exp(S)) - Math.PI / 2;
  }
  return { lat, lon };
}

// WGS84 geocentric (metres) -> LV95 { E, N, h } (h: height above the Bessel ellipsoid)
export function ecefToLv95(x, y, z) {
  const g = ecefToGeodetic(x - SHIFT[0], y - SHIFT[1], z - SHIFT[2], BESSEL);
  return { ...besselToLv95(g.lat, g.lon), h: g.h };
}

// WGS84 longitude / latitude (degrees) -> LV95 { E, N }
export function wgs84ToLv95(lon, lat, h = 0) {
  const [x, y, z] = geodeticToEcef(rad(lat), rad(lon), h, WGS84);
  return ecefToLv95(x, y, z);
}

// LV95 { E, N } -> WGS84 { lon, lat } (degrees)
export function lv95ToWgs84(east, north, h = 0) {
  const g = lv95ToBessel(east, north);
  const [x, y, z] = geodeticToEcef(g.lat, g.lon, h, BESSEL);
  const w = ecefToGeodetic(x + SHIFT[0], y + SHIFT[1], z + SHIFT[2], WGS84);
  return { lon: deg(w.lon), lat: deg(w.lat) };
}
