"""Render a deterministic, local aerial terrain texture for the synthetic village.

Run with Python, Pillow and NumPy. All geography is illustrative; fixture positions
are kept clear so the interactive map can draw buildings and operational layers.
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SCALE = 2
W, H = 1200, 760
rng = np.random.default_rng(20261009)
data = json.loads((ROOT / "fixtures/bundle.json").read_text())


def noise(size):
    grid = rng.random((max(2, H // size), max(2, W // size)))
    return np.asarray(
        Image.fromarray((grid * 255).astype("uint8")).resize(
            (W * SCALE, H * SCALE), Image.Resampling.BICUBIC
        ),
        dtype=float,
    ) / 255


yy, xx = np.mgrid[0:H * SCALE, 0:W * SCALE] / SCALE
n = noise(170) * .48 + noise(70) * .28 + noise(25) * .16 + noise(7) * .08
ridge = (
    .65 * np.exp(-((yy - (75 + 60 * np.sin(xx / 140))) / 140) ** 2)
    + .42 * np.exp(-((xx - 45 - 20 * np.sin(yy / 65)) / 120) ** 2)
    + .35 * np.exp(-((xx - 1170) / 115) ** 2)
    + .35 * np.exp(-((xx - 485) / 85) ** 2 - ((yy - 505) / 120) ** 2)
)
height = n * .45 + ridge
dy, dx = np.gradient(height)
shade = np.clip(1 + (dx * -85 + dy * -110), .70, 1.25)
forest = ridge + n * .40 > .40
grain = rng.normal(0, 2.1, (H * SCALE, W * SCALE))
pixels = np.zeros((H * SCALE, W * SCALE, 3))
for channel, (wood, soil) in enumerate([(51, 142), (76, 134), (44, 89)]):
    pixels[:, :, channel] = (np.where(forest, wood, soil) + n * 27) * shade + grain
terrain = Image.fromarray(np.clip(pixels, 0, 255).astype("uint8"))
draw = ImageDraw.Draw(terrain)


def poly(points):
    return [(round(x * SCALE), round(y * SCALE)) for x, y in points]


# Small cultivated parcels, crop furrows, drainage strips and orchard rows.
for row in range(10):
    for col in range(16):
        x = col * 78 + float(rng.uniform(-9, 9))
        y = 195 + row * 59 + float(rng.uniform(-6, 6))
        cx, cy = min(W - 1, max(0, int(x + 35))), min(H - 1, max(0, int(y + 25)))
        if y > 750 or forest[cy * SCALE, cx * SCALE]:
            continue
        width, depth = float(rng.uniform(52, 74)), float(rng.uniform(37, 53))
        points = [(x, y), (x + width, y - 5), (x + width + 4, y + depth), (x + 3, y + depth + 4)]
        mask = Image.new("L", terrain.size)
        ImageDraw.Draw(mask).polygon(poly(points), fill=230)
        palette = [(144, 136, 88), (132, 129, 73), (157, 148, 103), (108, 119, 69), (158, 138, 91)]
        base = np.array(palette[int(rng.integers(len(palette)))])
        patch = np.zeros_like(pixels)
        stripe = np.sin((xx + yy * .12) * 2.7) * 4 + np.sin(yy * .65) * 2
        for c in range(3):
            patch[:, :, c] = (base[c] + n * 13 + stripe + grain) * np.clip(shade, .85, 1.13)
        terrain.paste(Image.fromarray(np.clip(patch, 0, 255).astype("uint8")), (0, 0), mask)
        draw = ImageDraw.Draw(terrain)
        draw.line(poly(points + [points[0]]), fill=(89, 99, 61), width=3)
        if rng.random() < .2:
            for ox in range(8, int(width - 6), 13):
                for oy in range(8, int(depth - 4), 13):
                    px, py = (x + ox) * SCALE, (y + oy) * SCALE
                    draw.ellipse((px - 4, py - 4, px + 7, py + 7), fill=(45, 66, 36))
                    draw.ellipse((px - 5, py - 5, px + 3, py + 3), fill=(86, 108, 51))


def segment_distance(x, y, a, b):
    vx, vy = b[0] - a[0], b[1] - a[1]
    f = np.clip(((x - a[0]) * vx + (y - a[1]) * vy) / max(1, vx * vx + vy * vy), 0, 1)
    return np.hypot(x - (a[0] + f * vx), y - (a[1] + f * vy))


# Leave the road network, river and household plots unobstructed.
clearance = np.full((H * SCALE, W * SCALE), 1000.)
for road in data["map"]["roads"]:
    for a, b in zip(road["points"], road["points"][1:]):
        clearance = np.minimum(clearance, segment_distance(xx, yy, a, b))
river_clearance = np.full_like(clearance, 1000.)
for a, b in zip(data["map"]["river"], data["map"]["river"][1:]):
    river_clearance = np.minimum(river_clearance, segment_distance(xx, yy, a, b))
plots = [h["demoPosition"] for h in data["households"]]
plots += [s["demoLocation"] for s in data["shelters"]]
for p in plots:
    forest[np.hypot(xx - p["x"], yy - p["y"]) < 19] = False

# Export the same tree cover used by the aerial texture. Fire can travel only
# between adjacent wooded cells; roads, water and cleared household plots break
# the fuel network. A conservative cell threshold keeps flames off bare edges.
cell_size = 4
fuel_pixels = forest & (clearance >= 12) & (river_clearance >= 20)
block = cell_size * SCALE
fuel_grid = fuel_pixels.reshape(H // cell_size, block, W // cell_size, block).mean(axis=(1, 3)) >= .95
fuel_runs = []
for row in fuel_grid:
    runs = []
    start = None
    for x, wooded in enumerate(np.append(row, False)):
        if wooded and start is None:
            start = x
        elif not wooded and start is not None:
            runs.extend([start, x - start])
            start = None
    fuel_runs.append(runs)
fuel_output = ROOT / "fe/src/components/map/forest-fuel.json"
fuel_output.write_text(json.dumps({"width": W, "height": H, "cellSize": cell_size, "rows": fuel_runs}, separators=(",", ":")) + "\n")

# Mottled canopy sprites have irregular silhouettes, directional light and
# branch-scale shading, avoiding the flat circles of a diagrammatic map.
trees = Image.new("RGBA", terrain.size)
crowns = []
for variant in range(100):
    size = 36
    ty, tx = np.mgrid[-1:1:complex(size), -1:1:complex(size)]
    radial = np.hypot(tx, ty)
    angle = np.arctan2(ty, tx)
    outline = .78 + .09 * np.sin(angle * 7 + variant) + .07 * np.cos(angle * 11 + variant)
    alpha = np.clip((outline - radial) * 100, 0, 1)
    small_noise = np.asarray(Image.fromarray((rng.random((12, 12)) * 255).astype('uint8')).resize((size, size), Image.Resampling.BICUBIC)) / 255
    leaf_noise = rng.normal(0, 4, (size, size))
    light = np.clip(1.2 - radial * .38 - tx * .18 - ty * .22 + (small_noise - .5) * .75, .38, 1.5)
    sprite = np.zeros((size, size, 4), dtype='uint8')
    tint = float(rng.uniform(.85, 1.13))
    for c, value in enumerate([63, 84, 44]):
        sprite[:, :, c] = np.clip(value * light * tint + leaf_noise, 0, 255)
    sprite[:, :, 3] = (alpha * 255).astype('uint8')
    crowns.append(Image.fromarray(sprite))
shadow = Image.new('RGBA', (40, 40))
ImageDraw.Draw(shadow).ellipse((7, 7, 34, 34), fill=(12, 22, 12, 125))
shadow = shadow.filter(ImageFilter.GaussianBlur(2.5))
for _ in range(35000):
    x, y = float(rng.uniform(0, W)), float(rng.uniform(0, H))
    ix, iy = int(x * SCALE), int(y * SCALE)
    if not forest[iy, ix] or clearance[iy, ix] < 12 or river_clearance[iy, ix] < 20:
        continue
    diameter = int(rng.uniform(7, 13) * SCALE)
    px, py = int(x * SCALE - diameter / 2), int(y * SCALE - diameter / 2)
    trees.alpha_composite(shadow.resize((diameter + 6, diameter + 6)), (px + 2, py + 3))
    trees.alpha_composite(crowns[int(rng.integers(len(crowns)))].resize((diameter, diameter), Image.Resampling.LANCZOS), (px, py))
terrain = Image.alpha_composite(terrain.convert("RGBA"), trees)
draw = ImageDraw.Draw(terrain)

# Gravel driveways and concrete aprons connect each rural house to nearby roads.
road_segments = [(a, b) for r in data["map"]["roads"] if not r["blocked"] for a, b in zip(r["points"], r["points"][1:])]
for p in plots:
    candidates = []
    for a, b in road_segments:
        vx, vy = b[0] - a[0], b[1] - a[1]
        f = np.clip(((p["x"] - a[0]) * vx + (p["y"] - a[1]) * vy) / max(1, vx * vx + vy * vy), 0, 1)
        q = (a[0] + f * vx, a[1] + f * vy)
        candidates.append((np.hypot(q[0] - p["x"], q[1] - p["y"]), q))
    _, q = min(candidates)
    draw.line(poly([(p["x"], p["y"]), q]), fill=(162, 152, 119, 170), width=4)
    px, py = p["x"] * SCALE, p["y"] * SCALE
    draw.rounded_rectangle((px - 22, py - 18, px + 24, py + 23), radius=4, fill=(164, 159, 137, 225))

# A few glasshouses and outbuildings enrich the agricultural landscape.
for x, y in [(180, 415), (200, 555), (790, 558), (850, 418), (530, 360), (975, 560)]:
    for k in range(3):
        px, py = (x + k * 13) * SCALE, y * SCALE
        draw.rounded_rectangle((px + 3, py + 3, px + 20, py + 57), radius=7, fill=(31, 42, 36, 120))
        draw.rounded_rectangle((px, py, px + 17, py + 53), radius=7, fill=(191, 198, 176, 255))
        draw.line((px + 6, py + 4, px + 6, py + 48), fill=(232, 231, 208), width=2)
        for sy in range(8, 48, 9):
            draw.line((px + 1, py + sy, px + 15, py + sy), fill=(140, 156, 142), width=1)

terrain = terrain.convert("RGB").filter(ImageFilter.UnsharpMask(radius=1, percent=115, threshold=3))
output = ROOT / "fe/public/map/village-terrain.webp"
output.parent.mkdir(parents=True, exist_ok=True)
terrain.save(output, "WEBP", quality=88, method=6)
print(f"Rendered {output.relative_to(ROOT)} · {terrain.width}×{terrain.height} · {output.stat().st_size:,} bytes")
