"""Draw the menu-bar mark at an exact pixel size.

A 16pt menu-bar glyph cannot be a downscaled app icon: the strokes turn grey and
the shapes merge. This draws the 32-unit grid directly at the target resolution,
with 4×4 supersampling, in black with alpha (a macOS template image).

usage: python3 scripts/tray-icon.py <out.png> <size>
"""

import sys

namespace = {"__name__": "icon"}
exec(open("scripts/icon-alpha.py").read().replace("main()\n", ""), namespace)

# The mark on a 32-unit grid: two brackets and a square, as filled rounded rects.
# A 26×26 mark on the 32-unit grid: the file is drawn at 16pt, so this fills 13pt
# of the 16pt slot — the same height as the menu-bar icons next to it.
RECTS = [
    (3, 3, 4, 26, 1.4),
    (3, 3, 7, 4, 1.4),
    (3, 25, 7, 4, 1.4),
    (25, 3, 4, 26, 1.4),
    (22, 3, 7, 4, 1.4),
    (22, 25, 7, 4, 1.4),
]

# The same caret as the app icon: two thick strokes meeting at a point.
CARET = [(12.5, 11.5), (19, 16), (12.5, 20.5)]
CARET_HALF_WIDTH = 2.1


def inside(x, y, rect):
    rx, ry, rw, rh, radius = rect
    cx, cy = rx + rw / 2, ry + rh / 2
    dx, dy = abs(x - cx), abs(y - cy)
    if dx > rw / 2 or dy > rh / 2:
        return False
    # Distance to the corner circle centre, with the straight parts collapsed.
    qx, qy = max(dx - (rw / 2 - radius), 0), max(dy - (rh / 2 - radius), 0)
    return qx * qx + qy * qy <= radius * radius


def distance_to_segment(x, y, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0 if length == 0 else max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / length))
    return ((x - (ax + t * dx)) ** 2 + (y - (ay + t * dy)) ** 2) ** 0.5


def on_caret(x, y):
    return any(
        distance_to_segment(x, y, CARET[i], CARET[i + 1]) <= CARET_HALF_WIDTH for i in range(len(CARET) - 1)
    )


def coverage(px, py, size, samples=4):
    unit = 32 / size
    hits = 0
    for sy in range(samples):
        for sx in range(samples):
            x = (px + (sx + 0.5) / samples) * unit
            y = (py + (sy + 0.5) / samples) * unit
            if any(inside(x, y, rect) for rect in RECTS) or on_caret(x, y):
                hits += 1
    return hits / (samples * samples)


def main():
    target, size = sys.argv[1], int(sys.argv[2])
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            alpha = round(255 * coverage(x, y, size))
            row += bytes((0, 0, 0, alpha))
        rows.append(row)
    namespace["write_png"](target, size, size, rows)


main()
