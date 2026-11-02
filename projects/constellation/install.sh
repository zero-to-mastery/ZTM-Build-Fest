#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-.}"

copy_one() {
  local rel="$1"
  local src="$SOURCE_DIR/$rel"
  local dst="$DEST/$rel"

  if [[ -e "$dst" ]]; then
    echo "SKIP existing: $rel"
    return
  fi

  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "ADD: $rel"
}

while IFS= read -r rel; do
  [[ "$rel" == "MANIFEST.json" ]] && continue
  [[ "$rel" == "install.sh" ]] && continue
  copy_one "$rel"
done < <(
  cd "$SOURCE_DIR"
  find . -type f -not -path './install.sh' -not -path './MANIFEST.json' |
    sed 's#^./##' |
    sort
)

echo
echo "Installed without overwriting existing files."
echo "Review AGENTS.md and docs/PROJECT-PRINCIPLES.md before committing."
