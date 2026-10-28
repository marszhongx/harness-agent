"""Give the icon an alpha channel.

QuickLook renders the SVG on white, so the PNG it produces has opaque corners.
macOS draws Dock icons as-is, so that white would show as a square plate behind
the rounded tile. The shape is a plain rounded rectangle, so its coverage can be
computed exactly instead of pulled from another renderer.

usage: python3 scripts/icon-alpha.py <in.png> <out.png> [inset] [exponent]

The body is a superellipse (`|x/a|^n + |y/a|^n <= 1`), which is what Apple's
"continuous" corners are; circular corner arcs look slightly flat next to system
icons. n=5 is visually indistinguishable at icon sizes.
"""

import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    pos, idat = 8, b""
    width = height = None
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        kind = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color_type = struct.unpack(">IIBB", chunk[:10])
            if (depth, color_type) != (8, 6):
                raise SystemExit("expected 8-bit RGBA input")
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
        pos += 12 + length
    return width, height, unfilter(zlib.decompress(idat), width, height)


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def unfilter(raw, width, height):
    bpp, stride = 4, width * 4
    rows = []
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        kind = raw[pos]
        line = bytearray(raw[pos + 1 : pos + 1 + stride])
        pos += 1 + stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if kind == 1:
                line[i] = (line[i] + a) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + b) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif kind == 4:
                line[i] = (line[i] + paeth(a, b, c)) & 0xFF
        rows.append(line)
        prev = line
    return rows


def coverage(x, y, size, inset, exponent, samples=4):
    """Fraction of this pixel inside the squircle, by supersampling."""
    half = (size - 2 * inset) / 2
    centre = size / 2
    hits = 0
    for sy in range(samples):
        for sx in range(samples):
            px = x + (sx + 0.5) / samples
            py = y + (sy + 0.5) / samples
            inside = (abs(px - centre) / half) ** exponent + (abs(py - centre) / half) ** exponent
            if inside <= 1:
                hits += 1
    return hits / (samples * samples)


def write_png(path, width, height, rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(kind, payload):
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def main():
    source, target = sys.argv[1], sys.argv[2]
    # Apple's grid: 824×824 body in a 1024 canvas, continuous corners.
    inset = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    exponent = float(sys.argv[4]) if len(sys.argv) > 4 else 5.0
    width, height, rows = read_png(source)
    if width != height:
        raise SystemExit("expected a square icon")
    for y, row in enumerate(rows):
        for x in range(width):
            alpha = round(255 * coverage(x, y, width, inset, exponent))
            row[x * 4 + 3] = min(row[x * 4 + 3], alpha)
    write_png(target, width, height, rows)


main()
