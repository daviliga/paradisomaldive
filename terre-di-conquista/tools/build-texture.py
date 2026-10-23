# Builds earth.jpg: NASA Blue Marble (via three-globe's example textures) reprojected to the
# game's Miller projection (centred on 11°E, latitudes 83.5°N..56°S, 4000 px wide), with
# hillshading from the topology map so mountains stand out.
# Usage: python3 build-texture.py  (after npm install)
import math
import numpy as np
from PIL import Image, ImageFilter

MW, MH = 4000, 1958
LAT_TOP, CENTER = 83.5, 11.0
SRC = 'node_modules/three-globe/example/img/'

k = MW / (2 * math.pi)
raw = lambda phi: 1.25 * math.log(math.tan(math.pi / 4 + 0.4 * phi))
y_top = raw(math.radians(LAT_TOP))
ys = np.arange(MH) + 0.5
lat = 2.5 * np.arctan(np.exp(0.8 * (y_top - ys / k))) - 0.625 * math.pi  # radians
xs = np.arange(MW) + 0.5
lon = np.radians(CENTER) + (xs - MW / 2) / k
lon = (lon + math.pi) % (2 * math.pi) - math.pi


def sample(img, lon, lat):
    a = np.asarray(img, dtype=np.float32)
    h, w = a.shape[:2]
    u = (lon[None, :] + math.pi) / (2 * math.pi) * w - 0.5
    v = (math.pi / 2 - lat[:, None]) / math.pi * h - 0.5
    u = np.broadcast_to(u, (len(lat), len(lon))); v = np.broadcast_to(v, (len(lat), len(lon)))
    x0 = np.floor(u).astype(int); y0 = np.floor(v).astype(int)
    fx = u - x0; fy = v - y0
    x1 = (x0 + 1) % w; x0 = x0 % w
    y0c = np.clip(y0, 0, h - 1); y1c = np.clip(y0 + 1, 0, h - 1)
    if a.ndim == 3: fx = fx[..., None]; fy = fy[..., None]
    top = a[y0c, x0] * (1 - fx) + a[y0c, x1] * fx
    bot = a[y1c, x0] * (1 - fx) + a[y1c, x1] * fx
    return top * (1 - fy) + bot * fy


color = sample(Image.open(SRC + 'earth-blue-marble.jpg').convert('RGB'), lon, lat)
topo = Image.open(SRC + 'earth-topology.png').convert('L').filter(ImageFilter.GaussianBlur(0.8))
elev = sample(topo, lon, lat) / 255.0

# hillshade, light from the north-west
gy, gx = np.gradient(elev * 40.0)
nx, ny, nz = -gx, -gy, np.ones_like(gx)
norm = np.sqrt(nx * nx + ny * ny + nz * nz)
lx, ly, lz = -0.6, -0.6, 0.55
ln = math.sqrt(lx * lx + ly * ly + lz * lz)
shade = (nx * lx + ny * ly + nz * lz) / (norm * ln)
shade = np.clip(shade / (lz / ln), 0.55, 1.45)

land = (elev > 0.002).astype(np.float32)
land = np.asarray(Image.fromarray((land * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5)), dtype=np.float32)[..., None] / 255.0
out = color * (1 + (shade[..., None] - 1) * 0.9 * land)
# deepen the oceans a little and lift contrast on land
sea_tint = np.array([18, 52, 98], dtype=np.float32)
out = out * land + (out * 0.75 + sea_tint * 0.35) * (1 - land)
out = np.clip((out - 128) * 1.08 + 128, 0, 255)

Image.fromarray(out.astype(np.uint8)).save('../earth.jpg', quality=82, optimize=True, progressive=True)
print('earth.jpg', MW, MH)
