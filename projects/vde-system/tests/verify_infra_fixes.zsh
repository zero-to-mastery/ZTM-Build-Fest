#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# tests/verify_infra_fixes.zsh

# This test verifies that VDE_ROOT_DIR and VDE_CACHE_DIR are correctly set
# after the surgical edits.

# We will use a mock-like approach by checking the content of the files
# and running a small snippet that simulates the exported variables.

set -e

# Target files
VDE_BIN="bin/vde"
SHUTDOWN_BIN="bin/shutdown-all"

echo "Checking $VDE_BIN..."
if grep -q "VDE_CACHE_DIR=\"\${VDE_ROOT_DIR}/.cache\"" "$VDE_BIN"; then
    echo "[PASS] VDE_CACHE_DIR found in $VDE_BIN"
else
    echo "[FAIL] VDE_CACHE_DIR missing in $VDE_BIN"
    exit 1
fi

echo "Checking $SHUTDOWN_BIN..."
if grep -q "VDE_CACHE_DIR=\"\${VDE_ROOT_DIR}/.cache\"" "$SHUTDOWN_BIN"; then
    echo "[PASS] VDE_CACHE_DIR found in $SHUTDOWN_BIN"
else
    echo "[FAIL] VDE_CACHE_DIR missing in $SHUTDOWN_BIN"
    exit 1
fi

# Verify the logic itself
# We'll extract the line and run it in a controlled environment
extract_and_test() {
    local file=$1
    # ZSH-native shibboleth: Quoting parameter
    local _q_file=${(q)file}
    # ZSH-native shibboleth: Quoting parameter
    local _q_file=${(q)file}
    echo "Testing logic from ${_q_file}..."
    # Extract the line that calculates VDE_ROOT_DIR
    local logic=$(grep "VDE_ROOT_DIR=\"\${" "$file" | head -n 1)
    if [[ -z "$logic" ]]; then
        echo "[FAIL] Could not extract logic from $file"
        exit 1
    fi
    
    # Run it
    local VDE_ROOT_DIR
    # We need to simulate $0
    (
        export 0="$file"
        eval "$logic"
        echo "Calculated VDE_ROOT_DIR: $VDE_ROOT_DIR"
        # Check if it's absolute
        if [[ "$VDE_ROOT_DIR" != /* ]]; then
            echo "[FAIL] VDE_ROOT_DIR is not absolute: $VDE_ROOT_DIR"
            exit 1
        fi
        # Check if it ends correctly (parent of bin)
        if [[ "$VDE_ROOT_DIR" != */VDE ]]; then
            # Handle different path structures in CI if necessary, but locally it should be /.../VDE
            if [[ ! -d "$VDE_ROOT_DIR/bin" ]]; then
                echo "[FAIL] VDE_ROOT_DIR does not contain bin/: $VDE_ROOT_DIR"
                exit 1
            fi
        fi
    )
}

extract_and_test "$VDE_BIN"
extract_and_test "$SHUTDOWN_BIN"

echo "[SUCCESS] Infrastructure fixes verified."
