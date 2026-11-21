#!/usr/bin/env bash
# Regenerate the self-hosted Fira Sans WOFF2 subsets in web/public/fonts from the
# OFL-licensed TTF sources in web/fonts-src. Requires fonttools with Brotli:
#   python3 -m pip install fonttools brotli
# The ranges follow the Google Fonts latin / latin-ext split, plus U+2192 (the UI's
# "→"). web/src/styles.css declares the same unicode-range values, so browsers
# download the latin-ext file only for text that uses those characters.
set -euo pipefail
cd "$(dirname "$0")/.."

LATIN='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191-2193,U+2212,U+2215,U+FEFF,U+FFFD'
LATIN_EXT='U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

for source in web/fonts-src/fira-sans-*.ttf; do
  name=$(basename "$source" .ttf)
  pyftsubset "$source" --unicodes="$LATIN" --layout-features='*' --flavor=woff2 \
    --output-file="web/public/fonts/$name-latin.woff2"
  pyftsubset "$source" --unicodes="$LATIN_EXT" --layout-features='*' --flavor=woff2 \
    --output-file="web/public/fonts/$name-latin-ext.woff2"
done
