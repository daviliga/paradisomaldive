# Builds the satellite map as an image pyramid:
#   earth.jpg            2000 px overview
#   tiles/1/{x}_{y}.jpg  4000 px wide, 512 px tiles
#   tiles/3/{x}_{y}.jpg  12000 px wide, 512 px tiles, land colour only (the game clips them to
#                        the vector coastline, so coasts stay sharp at any zoom); tiles/3/have.json
#                        lists the tiles that exist (open-sea tiles are skipped)
# Colour: NASA Blue Marble (via three-globe's example textures) reprojected to the game's Miller
# projection (centred on 11°E, latitudes 83.5°N..56°S) with hillshading from the topology map.
# Detail: coastlines are cut from Natural Earth 1:10m land (land10m.json from export-land.cjs) at
# full resolution, land and sea colours are filled past the coast so nothing smears, and a fine
# fractal grain is added to land so zoomed-in views read as terrain instead of blur.
# Usage: node export-land.cjs && python3 build-texture.py
import json, math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

MW, MH = 4000, 1958
LAT_TOP, CENTER = 83.5, 11.0
SRC = 'node_modules/three-globe/example/img/'
OUT = '..'
TILE = 512
TOP = 3  # top level scale relative to MW

Image.MAX_IMAGE_PIXELS = None
k = MW / (2 * math.pi)
raw = lambda phi: 1.25 * math.log(math.tan(math.pi / 4 + 0.4 * phi))
y_top = raw(math.radians(LAT_TOP))
lat = 2.5 * np.arctan(np.exp(0.8 * (y_top - (np.arange(MH) + 0.5) / k))) - 0.625 * math.pi
lon = np.radians(CENTER) + (np.arange(MW) + 0.5 - MW / 2) / k
lon = (lon + math.pi) % (2 * math.pi) - math.pi


def sample(img, lon, lat):
    a = np.asarray(img, dtype=np.float32)
    h, w = a.shape[:2]
    u = np.broadcast_to((lon[None, :] + math.pi) / (2 * math.pi) * w - 0.5, (len(lat), len(lon)))
    v = np.broadcast_to((math.pi / 2 - lat[:, None]) / math.pi * h - 0.5, (len(lat), len(lon)))
    x0 = np.floor(u).astype(int); y0 = np.floor(v).astype(int)
    fx = u - x0; fy = v - y0
    x1 = (x0 + 1) % w; x0 = x0 % w
    y0c = np.clip(y0, 0, h - 1); y1c = np.clip(y0 + 1, 0, h - 1)
    if a.ndim == 3: fx = fx[..., None]; fy = fy[..., None]
    top = a[y0c, x0] * (1 - fx) + a[y0c, x1] * fx
    bot = a[y1c, x0] * (1 - fx) + a[y1c, x1] * fx
    return top * (1 - fy) + bot * fy


def box1d(a, r, axis):
    a = np.swapaxes(a, 0, axis)
    p = np.concatenate([np.repeat(a[:1], r + 1, 0), a, np.repeat(a[-1:], r, 0)], 0)
    c = np.cumsum(p, 0, dtype=np.float64)
    out = (c[2 * r + 1:] - c[:-2 * r - 1]) / (2 * r + 1)
    return np.swapaxes(out.astype(np.float32), 0, axis)


def blur(a, r):
    """Gaussian-like blur of radius ~r: three box passes per axis."""
    b = max(1, int(round(r * 0.87)))
    a = a.astype(np.float32)
    for _ in range(3):
        a = box1d(box1d(a, b, 0), b, 1)
    return a


def fill(color, weight):
    """Extend colours where weight==1 into the rest with normalized convolution at growing radii."""
    out = color * weight[..., None]
    have = weight.copy()
    for r in (2, 5, 12, 30, 80):
        num = blur(color * weight[..., None], r)
        den = blur(weight, r)[..., None]
        est = num / np.maximum(den, 1e-6)
        take = (have < 0.5) & (den[..., 0] > 1e-3)
        out[take] = est[take]
        have[take] = 1
    return out


# --- base colour at 4000 px, with hillshade
color = sample(Image.open(SRC + 'earth-blue-marble.jpg').convert('RGB'), lon, lat)
topo = Image.open(SRC + 'earth-topology.png').convert('L').filter(ImageFilter.GaussianBlur(0.8))
elev = sample(topo, lon, lat) / 255.0
gy, gx = np.gradient(elev * 40.0)
norm = np.sqrt(gx * gx + gy * gy + 1)
lx, ly, lz = -0.6, -0.6, 0.55
ln = math.sqrt(lx * lx + ly * ly + lz * lz)
shade = np.clip(((-gx) * lx + (-gy) * ly + lz) / (norm * ln) / (lz / ln), 0.55, 1.45)

# --- crisp land mask at the top level
land = json.load(open('land10m.json'))
TW, TH = MW * TOP, MH * TOP
mask_img = Image.new('L', (TW, TH), 0)
draw = ImageDraw.Draw(mask_img)
for poly in land['polys']:
    for i, ring in enumerate(poly):
        if len(ring) < 3: continue
        draw.polygon([(x * TOP, y * TOP) for x, y in ring], fill=255 if i == 0 else 0)
mask_img = mask_img.filter(ImageFilter.GaussianBlur(0.7))
mask_base = np.asarray(mask_img.resize((MW, MH), Image.BOX), dtype=np.float32) / 255.0

# land colours: shaded, slightly contrasted, filled out past the coast
land_col = color * (1 + (shade[..., None] - 1) * 0.9)
land_col = np.clip((land_col - 128) * 1.08 + 128, 0, 255)
land_w = (blur(mask_base, 1.5) > 0.97).astype(np.float32)
land_fill = fill(land_col, land_w)

# sea colours: deeper blue, lighter teal in shallow coastal water
sea_w = (blur(mask_base, 2.5) < 0.01).astype(np.float32)
sea_fill = fill(color, sea_w)
sea_fill = sea_fill * 0.72 + np.array([16, 48, 92], np.float32) * 0.36
near = blur(mask_base, 5)
sea_fill += np.clip(near * 2.2, 0, 1)[..., None] * np.array([10, 38, 44], np.float32)
sea_fill = np.clip(sea_fill, 0, 255)

LAND = Image.fromarray(land_fill.astype(np.uint8))
SEA = Image.fromarray(sea_fill.astype(np.uint8))
del color, land_col, land_fill, sea_fill


# --- fine terrain grain in base-map coordinates (consistent across levels)
def hash2(ix, iy):
    h = (ix * 374761393 + iy * 668265263) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def value_noise(u, v):
    iu = np.floor(u).astype(np.int64); iv = np.floor(v).astype(np.int64)
    fu = u - iu; fv = v - iv
    fu = fu * fu * (3 - 2 * fu); fv = fv * fv * (3 - 2 * fv)
    a = hash2(iu, iv); b = hash2(iu + 1, iv); c = hash2(iu, iv + 1); d = hash2(iu + 1, iv + 1)
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv


def grain(x0, y0, w, h, f):
    u = (x0 + np.arange(w) + 0.5)[None, :] / f
    v = (y0 + np.arange(h) + 0.5)[:, None] / f
    u = np.broadcast_to(u, (h, w)); v = np.broadcast_to(v, (h, w))
    g = np.zeros((h, w), np.float32)
    for period, amp in ((3.0, 0.5), (1.0, 0.3), (0.33, 0.2)):
        g += (value_noise(u / period, v / period) - 0.5) * amp
    return g


def render_land(f, x0, y0, w, h):
    box = (x0 / f, y0 / f, (x0 + w) / f, (y0 + h) / f)
    l = np.asarray(LAND.resize((w, h), Image.BICUBIC, box=box), np.float32)
    l = l * (1 + grain(x0, y0, w, h, f)[..., None] * 0.16)
    return Image.fromarray(np.clip(l, 0, 255).astype(np.uint8))


def has_land(f, x0, y0, w, h):
    pad = 24
    mb = (max(0, (x0 - pad) * TOP // f), max(0, (y0 - pad) * TOP // f), min(TW, (x0 + w + pad) * TOP // f), min(TH, (y0 + h + pad) * TOP // f))
    return mask_img.crop(mb).getextrema()[1] > 0


def render(f, x0, y0, w, h):
    box = (x0 / f, y0 / f, (x0 + w) / f, (y0 + h) / f)
    l = np.asarray(LAND.resize((w, h), Image.BICUBIC, box=box), np.float32)
    s = np.asarray(SEA.resize((w, h), Image.BICUBIC, box=box), np.float32)
    mb = (x0 * TOP / f, y0 * TOP / f, (x0 + w) * TOP / f, (y0 + h) * TOP / f)
    m = np.asarray(mask_img.resize((w, h), Image.BILINEAR if f >= TOP else Image.BOX, box=mb), np.float32)[..., None] / 255.0
    if f >= 1:
        l = l * (1 + grain(x0, y0, w, h, f)[..., None] * (0.16 if f >= TOP else 0.08))
    return Image.fromarray(np.clip(l * m + s * (1 - m), 0, 255).astype(np.uint8))


render(0.5, 0, 0, MW // 2, round(MH / 2)).save(os.path.join(OUT, 'earth.jpg'), quality=80, optimize=True, progressive=True)
for f in (1, TOP):
    LW, LH = MW * f, MH * f
    d = os.path.join(OUT, 'tiles', str(f))
    os.makedirs(d, exist_ok=True)
    have = []
    for ty in range(math.ceil(LH / TILE)):
        for tx in range(math.ceil(LW / TILE)):
            x0, y0 = tx * TILE, ty * TILE
            w, h = min(TILE, LW - x0), min(TILE, LH - y0)
            if f == TOP:
                if not has_land(f, x0, y0, w, h): continue
                img = render_land(f, x0, y0, w, h)
            else:
                img = render(f, x0, y0, w, h)
            img.save(os.path.join(d, f'{tx}_{ty}.jpg'), quality=76, optimize=True)
            have.append(f'{tx}_{ty}')
    if f == TOP:
        json.dump(have, open(os.path.join(d, 'have.json'), 'w'))
    print('level', f, len(have), 'tiles')
