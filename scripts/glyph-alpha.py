"""Turn a black-on-white render into a black-on-transparent one.

QuickLook renders SVG on white, but a menu-bar template image needs the glyph
alone: macOS then draws it black or white depending on the bar. Alpha follows
1 - luminance, which keeps the antialiased edges.

usage: python3 scripts/glyph-alpha.py <in.png> <out.png>
"""

import sys

sys.argv = sys.argv[:1] + sys.argv[1:]
namespace = {"__name__": "icon"}
exec(open("scripts/icon-alpha.py").read().replace("main()\n", ""), namespace)


def main():
    source, target = sys.argv[1], sys.argv[2]
    width, height, rows = namespace["read_png"](source)
    for row in rows:
        for x in range(width):
            r, g, b = row[x * 4 : x * 4 + 3]
            luminance = round(0.2126 * r + 0.7152 * g + 0.0722 * b)
            row[x * 4 : x * 4 + 3] = b"\x00\x00\x00"
            row[x * 4 + 3] = min(row[x * 4 + 3], 255 - luminance)
    namespace["write_png"](target, width, height, rows)


main()
