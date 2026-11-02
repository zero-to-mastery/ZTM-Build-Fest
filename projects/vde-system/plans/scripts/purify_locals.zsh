#!/usr/bin/env zsh
# @armor (Engine Core)
# Purges illegal top-level 'local' declarations by converting them to 'typeset'.

files_purified=0

# Scan bin and scripts
for file in $(find bin scripts -type f); do
    # Only target ZSH scripts (check shebang or extension)
    if [[ "$file" == *.zsh ]] || head -n 1 "$file" | grep -q "zsh"; then
        if grep -q "^local " "$file"; then
            echo "[PURIFY] $file"
            # Replace 'local ' at start of line with 'typeset '
            sed -i '' 's/^local /typeset /g' "$file" 2>/dev/null || sed -i 's/^local /typeset /g' "$file"
            ((files_purified++))
        fi
    fi
done

echo "[SUCCESS] Purified $files_purified files."
