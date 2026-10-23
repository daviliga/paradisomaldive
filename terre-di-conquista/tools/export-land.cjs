// Writes land10m.json: Natural Earth 1:10m land and lakes, projected to game coordinates
// (same Miller projection as build-world.cjs). Used by build-texture.py for crisp coastlines.
const topojson = require('topojson-client');
const d3p = require('d3-geo-projection');
const fs = require('fs');

const MW = 4000, LAT_TOP = 83.5, LAT_BOTTOM = -56;
const proj = d3p.geoMiller().rotate([-11, 0]).scale(MW / (2 * Math.PI)).translate([MW / 2, 0]);
proj.translate([MW / 2, -proj([11, LAT_TOP])[1]]);
const MH = Math.round(proj([11, LAT_BOTTOM])[1]);
proj.clipExtent([[0, 0], [MW, MH]]);

const land = require('world-atlas/land-10m.json');
const g = d3p.geoProject(topojson.feature(land, land.objects.land), proj);
const polys = [];
const add = geom => {
  if (!geom) return;
  if (geom.type === 'Polygon') polys.push(geom.coordinates);
  else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
  else if (geom.type === 'GeometryCollection') geom.geometries.forEach(add);
};
(g.features || [g]).forEach(f => add(f.geometry || f));
// clipping Antarctica can yield an inverted ring covering the whole map: drop it
const full = p => { const xs = p[0].map(q => q[0]), ys = p[0].map(q => q[1]); return Math.max(...xs) - Math.min(...xs) >= MW - 1 && Math.max(...ys) - Math.min(...ys) >= MH - 1; };
for (let i = polys.length - 1; i >= 0; i--) if (full(polys[i])) polys.splice(i, 1);
const round = r => r.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
fs.writeFileSync('land10m.json', JSON.stringify({ W: MW, H: MH, polys: polys.map(p => p.map(round)) }));
console.log('polygons', polys.length, 'H', MH);
