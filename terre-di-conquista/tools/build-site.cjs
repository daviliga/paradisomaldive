// Builds a standalone website (for GitHub Pages) from the game folder:
// index.html is a page body without <head>, so it gets wrapped in a full document here.
// Usage: node terre-di-conquista/tools/build-site.cjs <out-dir>
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || '_site');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const body = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
// everything before the first <style> is head material: title, metas, links
const cut = body.indexOf('<style>');
const head = body.slice(0, cut), rest = body.slice(cut);
const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head.trim()}
</head>
<body>
${rest}
</body>
</html>
`;
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const f of ['world.js', 'earth.jpg', 'night.jpg', 'manifest.webmanifest', 'sw.js']) fs.copyFileSync(path.join(src, f), path.join(out, f));
for (const d of ['tiles', 'icons']) fs.cpSync(path.join(src, d), path.join(out, d), { recursive: true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('site written to', out);
