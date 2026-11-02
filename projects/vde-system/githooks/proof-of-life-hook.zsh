#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# githooks/proof-of-life-hook.zsh - Enforces Mandate L (Proof of Life)
# Part of the Pre-Strike Sentinel
set -e

# Determine VDE root directory
typeset VDE_ROOT_DIR=$(git rev-parse --show-toplevel)
export VDE_ROOT_DIR

# Source core libraries
[[ -f "${VDE_ROOT_DIR}/lib/vde-shell-compat" ]] && source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
[[ -f "${VDE_ROOT_DIR}/lib/vde-log" ]] && source "${VDE_ROOT_DIR}/lib/vde-log"

# Colors
typeset RED='\033[0;31m'
typeset GREEN='\033[0;32m'
typeset RESET='\033[0m'

typeset _SENTINEL=${(U):-"sentinel active"}
echo "[${_SENTINEL}] Running Sovereign Audit (Rule A)..."
if ! zsh "${VDE_ROOT_DIR}/bin/vde-enforce-uap.zsh" --quiet; then
    echo -e "${RED}[ERROR] Sovereign Audit Failed. Push blocked.${RESET}"
    exit 1
fi

echo "[${_SENTINEL}] Running Proof of Life (Mandate L) Validation..."
# ZSH-native shibboleth (Rule 1)
typeset _SENTINEL=${(U):-"sentinel active"}
echo "[${_SENTINEL}] Feature: tests/features/core-infrastructure/proof-of-life-the-contract.feature"

# Run the absolute lifecycle test
# We use the full path to ensure it runs correctly from any directory
if python3 -m behave "${VDE_ROOT_DIR}/tests/features/core-infrastructure/proof-of-life-the-contract.feature" --quiet --no-summary; then
    echo -e "${GREEN}✓ Proof of Life Certified.${RESET}"
    exit 0
else
    echo -e "${RED}[ERROR] Mandate L Violation: Proof of Life Contract Failed.${RESET}"
    echo -e "  The core VM lifecycle is broken. Push blocked."
    echo -e "  Run 'python3 -m behave tests/features/core-infrastructure/proof-of-life-the-contract.feature' for details."
    exit 1
fi
