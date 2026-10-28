#!/usr/bin/env bash
# Render assets/icon.svg into the two files the app ships:
#   assets/icon.png    1024×1024, used for the Dock during development
#   assets/icon.icns   the macOS bundle icon used by pack:dir
#
# Only macOS tooling, so there is nothing to install: QuickLook renders the SVG,
# sips makes the sizes, iconutil packs them.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# QuickLook renders on white; the rounded corners have to become transparent,
# or the Dock draws a white plate behind the tile.
qlmanage -t -s 1024 -o "$tmp" assets/icon.svg >/dev/null 2>&1
# Apple grid: 824×824 tile inside 1024, radius 185 → inset 100.
python3 scripts/icon-alpha.py "$tmp/icon.svg.png" assets/icon.png 100 185

mkdir -p "$tmp/icon.iconset"
for spec in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" "128 128x128" \
            "256 128x128@2x" "256 256x256" "512 256x256@2x" "512 512x512" "1024 512x512@2x"; do
  set -- $spec
  sips -z "$1" "$1" assets/icon.png --out "$tmp/icon.iconset/icon_$2.png" >/dev/null
done

iconutil -c icns "$tmp/icon.iconset" -o assets/icon.icns
echo "icon.png + icon.icns rebuilt from assets/icon.svg"
