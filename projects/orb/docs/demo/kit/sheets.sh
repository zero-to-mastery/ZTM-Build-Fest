#!/bin/bash
# Tiles the screenshots 2x2 into contact sheets for review.
cd "$(dirname "$0")/shots"
rm -f sheet-*.png
files=($(ls [0-9]*.png))
for ((i = 0; i < ${#files[@]}; i += 4)); do
  set -- "${files[@]:i:4}"
  inputs=(); for f in "$@"; do inputs+=(-i "$f"); done
  while [ ${#inputs[@]} -lt 8 ]; do inputs+=(-i "$1"); done
  ffmpeg -loglevel error "${inputs[@]}" -filter_complex \
    "[0]scale=960:-1[a];[1]scale=960:-1[b];[2]scale=960:-1[c];[3]scale=960:-1[d];[a][b][c][d]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0" \
    -y "sheet-$(printf %02d $((i / 4 + 1))).png"
done
ls sheet-*
