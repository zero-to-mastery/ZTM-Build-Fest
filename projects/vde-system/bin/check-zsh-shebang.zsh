#!/usr/bin/env zsh
# @armor (Engine Core)
# check-zsh-shebang - Verify all scripts use zsh shebang
# This script is used in CI to enforce zsh-only policy

set -e

VDE_SCRIPTS_DIR="$(cd "$(dirname "${0}")" && pwd)"
cd "${VDE_SCRIPTS_DIR}"

echo "Checking zsh shebang enforcement..."

failed=0

# Check all scripts in bin/ directory
# Use ZSH-native expansion (f) to split find results
for file in ${(f)"$(find . -type f -name "*.zsh" -o -name "*.sh" 2>/dev/null)"}; do
    # Skip directories
    [[ -f "${file}" ]] || continue
    
    # Skip backup files and cache
    [[ "${file}" == *".bak" ]] && continue
    [[ "${file}" == *".cache"* ]] && continue
    [[ "${file}" == *"backup/"* ]] && continue
    
    # Get the shebang
    shebang=$(head -1 "${file}" 2>/dev/null || true)
    
    # Check if it has a shebang
    if [[ "${shebang}" == \#\!* ]]; then
        # Check if it's zsh
        if [[ "${shebang}" == *(zsh|/bin/zsh)* ]]; then
            continue
        else
            echo "FAIL: ${file} uses non-zsh shebang: ${shebang}"
            failed=1
        fi
    else
        # No shebang - might be a library file, warn but don't fail
        echo "WARN: ${file} has no shebang"
    fi
done

# Check library files in lib/
for file in $(find lib -type f 2>/dev/null); do
    # Skip backup files explicitly
    [[ "${file}" == *".bak" ]] && continue

    shebang=$(head -1 "${file}" 2>/dev/null || true)
    
    if [[ "${shebang}" == \#\!* ]]; then
        if [[ "${shebang}" == *zsh* ]]; then
            continue
        else
            echo "FAIL: ${file} uses non-zsh shebang: ${shebang}"
            failed=1
        fi
    fi
done

if [[ ${failed} -eq 0 ]]; then
    echo "SUCCESS: All scripts use zsh shebang"
    exit ${VDE_SUCCESS}
else
    echo ""
    echo "ERROR: Some scripts do not use zsh shebang"
    echo "This project requires: #!/usr/bin/env zsh or #!/bin/zsh"
    exit ${VDE_ERR_GENERAL}
fi
