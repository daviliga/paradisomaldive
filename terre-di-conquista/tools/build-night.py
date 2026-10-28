# Builds night.jpg: NASA city lights at night (three-globe's earth-night.jpg) reprojected to the game's
# Miller projection (centred on 11°E, latitudes 83.5°N..56°S), 4000 px wide like tiles/1.
# Usage: python3 build-night.py
import math
import numpy as np
from PIL import Image

MW, MH = 4000, 1958
LAT_TOP, CENTER = 83.5, 11.0
k = MW / (2 * math.pi)
raw = lambda phi: 1.25 * math.log(math.tan(math.pi / 4 + 0.4 * phi))
y_top = raw(math.radians(LAT_TOP))
lat = 2.5 * np.arctan(np.exp(0.8 * (y_top - (np.arange(MH) + 0.5) / k))) - 0.625 * math.pi
lon = np.radians(CENTER) + (np.arange(MW) + 0.5 - MW / 2) / k
lon = (lon + math.pi) % (2 * math.pi) - math.pi

a = np.asarray(Image.open('node_modules/three-globe/example/img/earth-night.jpg').convert('RGB'), dtype=np.float32)
h, w = a.shape[:2]
u = (lon[None, :] + math.pi) / (2 * math.pi) * w - 0.5
v = (math.pi / 2 - lat[:, None]) / math.pi * h - 0.5
u = np.broadcast_to(u, (MH, MW)); v = np.broadcast_to(v, (MH, MW))
x0 = np.floor(u).astype(int); y0 = np.floor(v).astype(int); fx = (u - x0)[..., None]; fy = (v - y0)[..., None]
x1 = (x0 + 1) % w; x0 %= w; y1 = np.clip(y0 + 1, 0, h - 1); y0 = np.clip(y0, 0, h - 1)
img = (a[y0, x0] * (1 - fx) + a[y0, x1] * fx) * (1 - fy) + (a[y1, x0] * (1 - fx) + a[y1, x1] * fx) * fy
# deepen the dark side a little so the lights stand out, keep the warm sodium colour of the cities
img = np.clip(img * 1.15 - 4, 0, 255)
Image.fromarray(img.astype(np.uint8)).save('../night.jpg', quality=82, optimize=True, progressive=True)
print('night.jpg', Image.open('../night.jpg').size)
