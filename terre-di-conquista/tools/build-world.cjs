// Builds world.js: the real world map split into provinces for Terre di Conquista.
// Countries: Natural Earth 1:50m (world-atlas). Provinces: Voronoi cells around each
// country's largest cities (GeoNames via all-the-cities), clipped to the country border.
// Usage: node build-world.cjs > ../world.js
const topojson = require('topojson-client');
const topoServer = require('topojson-server');
const topoSimplify = require('topojson-simplify');
const d3 = require('d3-geo');
const d3p = require('d3-geo-projection');
const { Delaunay } = require('d3-delaunay');
const pc = require('polygon-clipping');
const iso = require('i18n-iso-countries');
iso.registerLocale(require('i18n-iso-countries/langs/it.json'));
const cities = require('all-the-cities');

const MW = 4000;
const TARGET_PROVINCES = 1300;
const LAT_TOP = 83.5, LAT_BOTTOM = -56;
const EXTRA = { Somaliland: 'SO', Kosovo: 'XK', 'N. Cyprus': 'CY' };
const DROP = new Set(['Antarctica', 'Siachen Glacier', 'Indian Ocean Ter.', 'Fr. S. Antarctic Lands', 'Heard I. and McDonald Is.', 'S. Geo. and the Is.']);
const SHORT = {
  "Stati Uniti d'America": 'Stati Uniti', 'Repubblica Democratica del Congo': 'RD del Congo', 'Repubblica del Congo': 'Congo',
  'Repubblica Centrafricana': 'Centrafrica', 'Birmania  Myanmar': 'Birmania', 'Repubblica di Cina': 'Taiwan',
  'Stati Federati di Micronesia': 'Micronesia', "Territori Britannici dell'Oceano Indiano": 'Chagos',
  "Sant'Elena, Isola di Ascensione e Tristan da Cunha": "Sant'Elena", 'Stato di Palestina': 'Palestina',
  'Isole Marianne Settentrionali': 'Marianne Settentrionali',
};

// --- simplify on the sphere, keeping shared borders consistent
let topo = require('world-atlas/countries-50m.json');
topo = topoSimplify.presimplify(topo);
topo = topoSimplify.simplify(topo, 4e-7);
const features = topojson.feature(topo, topo.objects.countries).features.filter(f => !DROP.has(f.properties.name));

// --- projection: Miller, centred on 11°E so the map edge runs through the Bering Strait
const proj = d3p.geoMiller().rotate([-11, 0]).scale(MW / (2 * Math.PI)).translate([MW / 2, 0]);
const yTop = proj([11, LAT_TOP])[1];
proj.translate([MW / 2, -yTop]);
const MH = Math.round(proj([11, LAT_BOTTOM])[1]);
proj.clipExtent([[0, 0], [MW, MH]]);

const ringArea = r => { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % n]; a += x0 * y1 - x1 * y0; } return a / 2; };
const multiArea = m => m.reduce((s, poly) => s + Math.abs(ringArea(poly[0])) - poly.slice(1).reduce((t, h) => t + Math.abs(ringArea(h)), 0), 0);
function pipRing(x, y, r) { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
const pipMulti = (x, y, m) => m.some(poly => pipRing(x, y, poly[0]) && !poly.slice(1).some(h => pipRing(x, y, h)));

// --- project countries
const countries = [];
for (const f of features) {
  const g = d3p.geoProject(f, proj).geometry;
  if (!g) continue;
  let multi = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  multi = multi.map(p => p.map(r => r.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]))).filter(p => p[0].length >= 4);
  if (!multi.length) continue;
  try { multi = pc.union(multi); } catch (e) { /* keep as is */ }
  const area = multiArea(multi);
  if (area < 0.3) continue;
  const name = f.properties.name;
  const a2 = EXTRA[name] || iso.numericToAlpha2(f.id);
  let it = a2 ? iso.getName(a2, 'it') : null;
  if (name === 'Somaliland') it = 'Somaliland';
  if (name === 'N. Cyprus') it = 'Cipro del Nord';
  if (name === 'Kosovo') it = 'Kosovo';
  it = it || name;
  countries.push({ name: SHORT[it] || it, a2, multi, area, sphere: f });
}

// --- province budget per country (sublinear in area so small states still get a few)
const weight = c => Math.pow(c.area, 0.62);
const totalW = countries.reduce((s, c) => s + weight(c), 0);
const byCountry = new Map();
for (const c of cities) { if (!byCountry.has(c.country)) byCountry.set(c.country, []); byCountry.get(c.country).push(c); }
for (const list of byCountry.values()) list.sort((a, b) => b.population - a.population);

const provinces = [];
countries.forEach((C, ci) => {
  const K = Math.max(1, Math.min(70, Math.round(TARGET_PROVINCES * weight(C) / totalW)));
  const dmin = Math.sqrt(C.area / K) * 0.55;
  const cand = (C.a2 && byCountry.get(C.a2)) || [];
  const chosen = [];
  const capital = cand.find(c => c.featureCode === 'PPLC');
  const ordered = capital ? [capital, ...cand.filter(c => c !== capital)] : cand;
  for (const c of ordered) {
    if (chosen.length >= K) break;
    const p = proj(c.loc.coordinates);
    if (!p || !pipMulti(p[0], p[1], C.multi)) continue;
    if (chosen.some(q => (q.p[0] - p[0]) ** 2 + (q.p[1] - p[1]) ** 2 < dmin * dmin)) continue;
    chosen.push({ city: c, p });
  }
  if (!chosen.length) {
    // no usable city: one province for the whole country
    const big = cand[0];
    provinces.push({ ci, name: C.name, pop: big ? big.population : 50000, cap: true, multi: C.multi });
    return;
  }
  // split by landmass: Voronoi only inside the parts that hold chosen cities, so
  // overseas territories and islands never get glued to a far-away city
  const out = [];
  const bboxOf = poly => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const [x, y] of poly[0]) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; return b; };
  const orphans = [];
  for (const poly of C.multi) {
    const here = chosen.filter(c => pipMulti(c.p[0], c.p[1], [poly]));
    if (!here.length) { orphans.push(poly); continue; }
    if (here.length === 1) { out.push({ c: here[0], multi: [poly] }); continue; }
    const b = bboxOf(poly);
    const vor = Delaunay.from(here.map(c => c.p)).voronoi([b[0] - 5, b[1] - 5, b[2] + 5, b[3] + 5]);
    here.forEach((c, i) => {
      const cell = vor.cellPolygon(i);
      if (!cell) return;
      let part;
      try { part = pc.intersection([cell], [poly]); } catch (e) { return; }
      part = part.filter(q => Math.abs(ringArea(q[0])) > 0.05);
      if (part.length) out.push({ c, multi: part });
    });
  }
  for (const poly of orphans) {
    const a = Math.abs(ringArea(poly[0])), b = bboxOf(poly), mx = (b[0] + b[2]) / 2, my = (b[1] + b[3]) / 2;
    let near = null, nd = Infinity;
    for (const o of out) { const d = Math.hypot(o.c.p[0] - mx, o.c.p[1] - my); if (d < nd) { nd = d; near = o; } }
    if (near && (a < 40 && nd < 90)) { near.multi.push(poly); continue; }
    // its own province, named after its biggest town if we know one
    let town = null;
    for (const c of cand) { const p = proj(c.loc.coordinates); if (p && pipMulti(p[0], p[1], [poly])) { town = c; break; } }
    if (!town) for (const c of cities) {
      if (c.population < 20000) continue;
      const lon = c.loc.coordinates[0], lat = c.loc.coordinates[1];
      const p = proj([lon, lat]);
      if (p && p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && pipMulti(p[0], p[1], [poly])) { if (!town || c.population > town.population) town = c; }
    }
    if (a < 4 && near) { near.multi.push(poly); continue; }
    out.push({ c: { city: town || { name: C.name, population: 20000 }, p: [mx, my] }, multi: [poly], orphan: true });
  }
  for (const o of out) provinces.push({ ci, name: o.c.city.name, pop: o.c.city.population, cap: o.c === chosen[0], multi: o.multi });
});

// --- shared topology so borders and adjacency come from common arcs
const fc = { type: 'FeatureCollection', features: provinces.map((p, i) => ({ type: 'Feature', id: i, geometry: { type: 'MultiPolygon', coordinates: p.multi } })) };
const T = topoServer.topology({ p: fc }, 1e5);
const [kx, ky] = T.transform.scale, [tx, ty] = T.transform.translate;
const arcs = T.arcs.map(a => { let x = 0, y = 0; return a.map(([dx, dy]) => { x += dx; y += dy; return [x * kx + tx, y * ky + ty]; }); });
const arcOwners = arcs.map(() => []);
T.objects.p.geometries.forEach((g, i) => {
  const visit = a => Array.isArray(a) ? a.forEach(visit) : arcOwners[a < 0 ? ~a : a].push(i);
  if (g.arcs) visit(g.arcs);
});
const nb = provinces.map(() => new Set());
for (const o of arcOwners) if (o.length === 2 && o[0] !== o[1]) { nb[o[0]].add(o[1]); nb[o[1]].add(o[0]); }

// rings from the topology (quantized), for fills + hit tests
const fillFc = topojson.feature(T, T.objects.p).features;
const enc = ring => { const out = []; let px = 0, py = 0; for (const [x, y] of ring) { const qx = Math.round(x * 2), qy = Math.round(y * 2); if (out.length && qx === px && qy === py) continue; out.push(qx - px, qy - py); px = qx; py = qy; } return out; };

// centre: pole of the largest ring approximated by its area centroid, nudged inside
function labelPoint(multi) {
  let best = null, ba = -1;
  for (const poly of multi) { const a = Math.abs(ringArea(poly[0])); if (a > ba) { ba = a; best = poly; } }
  const r = best[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < r.length - 1; i++) { const [x0, y0] = r[i], [x1, y1] = r[i + 1], f = x0 * y1 - x1 * y0; a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f; }
  let c = Math.abs(a) > 1e-6 ? [cx / (3 * a), cy / (3 * a)] : r[0];
  if (!pipMulti(c[0], c[1], [best])) {
    let bd = Infinity, bp = r[0];
    for (let i = 0; i < r.length - 1; i++) { const m = [(r[i][0] + r[i + 1][0]) / 2, (r[i][1] + r[i + 1][1]) / 2]; const d = (m[0] - c[0]) ** 2 + (m[1] - c[1]) ** 2; if (d < bd) { bd = d; bp = m; } }
    c = bp;
  }
  return c;
}

// --- sea routes between separate landmasses
const comp = new Int32Array(provinces.length).fill(-1);
let nc = 0;
for (let i = 0; i < provinces.length; i++) if (comp[i] < 0) { const q = [i]; comp[i] = nc; while (q.length) { const a = q.pop(); for (const b of nb[a]) if (comp[b] < 0) { comp[b] = nc; q.push(b); } } nc++; }
const coastPts = [];
arcs.forEach((a, k) => { if (arcOwners[k].length === 1) a.forEach((p, j) => { if (j % 2 === 0) coastPts.push([p[0], p[1], arcOwners[k][0]]); }); });
const R = 45, grid = new Map(), gk = (x, y) => Math.floor(x / R) + ',' + Math.floor(y / R);
for (const p of coastPts) { const k = gk(p[0], p[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
const wrapDx = dx => { dx = Math.abs(dx); return Math.min(dx, MW - dx); };
const best = new Map();
function consider(p, q) {
  const ca = comp[p[2]], cb = comp[q[2]];
  if (ca === cb) return;
  const d = Math.hypot(wrapDx(p[0] - q[0]), p[1] - q[1]);
  if (d > R) return;
  const key = ca < cb ? ca + ',' + cb : cb + ',' + ca;
  const cur = best.get(key);
  if (!cur || d < cur.d) best.set(key, { d, a: p[2], b: q[2], ca, cb });
}
for (const p of coastPts) {
  const gx = Math.floor(p[0] / R), gy = Math.floor(p[1] / R), cols = Math.ceil(MW / R);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const list = grid.get(((gx + dx + cols) % cols) + ',' + (gy + dy));
    if (list) for (const q of list) consider(p, q);
  }
}
const routes = [];
const addRoute = (a, b) => { routes.push([a, b]); nb[a].add(b); nb[b].add(a); };
for (const r of best.values()) addRoute(r.a, r.b);
// make everything reachable: join remaining groups by their closest coastal points
const parent = [...Array(nc).keys()], find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
for (const r of best.values()) parent[find(r.ca)] = find(r.cb);
for (;;) {
  const root = find(comp[0]);
  const inMain = coastPts.filter(p => find(comp[p[2]]) === root), outside = coastPts.filter(p => find(comp[p[2]]) !== root);
  if (!outside.length) break;
  let bd = Infinity, bp = null;
  for (let i = 0; i < outside.length; i += 3) for (let j = 0; j < inMain.length; j += 3) {
    const p = outside[i], q = inMain[j], d = Math.hypot(wrapDx(p[0] - q[0]), p[1] - q[1]);
    if (d < bd) { bd = d; bp = [p[2], q[2]]; }
  }
  addRoute(bp[0], bp[1]);
  parent[find(comp[bp[0]])] = root;
}

// --- output
const out = {
  W: MW, H: MH,
  countries: countries.map(c => ({ n: c.name, a: c.a2 || '' })),
  p: provinces.map((p, i) => {
    const g = fillFc[i].geometry;
    const multi = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const c = labelPoint(multi);
    return { n: p.name, c: p.ci, pop: p.pop, k: p.cap ? 1 : 0, a: Math.round(multiArea(multi)), x: Math.round(c[0]), y: Math.round(c[1]), r: multi.map(poly => poly.map(enc)), nb: [...nb[i]] };
  }),
  arcs: arcs.map((a, k) => ({ o: arcOwners[k], d: enc(a) })).filter(a => a.o.length),
  routes,
};
process.stderr.write(`countries ${countries.length}, provinces ${provinces.length}, arcs ${out.arcs.length}, routes ${routes.length}, H ${MH}\n`);
process.stdout.write('window.WORLD=' + JSON.stringify(out) + ';\n');
