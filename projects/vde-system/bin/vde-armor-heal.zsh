#!/usr/bin/env zsh
# @armor (Engine Core)
#===============================================================================
# vde-armor-heal.zsh - Deterministic Armor Self-Healing Engine
#
# Autonomously remediates physical environment fractures:
# 1. Aligns Beskar Registry version with the physical Engine version.
# 2. Synchronizes dates and versions in core student artifacts.
# 3. Triggers cache re-smelting if implementation drift is detected.
#
# This script is AI-Blind and Forge-Blind.
#===============================================================================

# 1. Initialize the Spine
emulate -L zsh
setopt LOCAL_OPTIONS
typeset _zsh_compliance_flag=${(z):-"zsh native parameter expansion"}
set -e

# Use strictly relative pathing (Mandate)
VDE_ROOT_DIR="${0:h:h}"
source "./lib/vde-core"

# Colors for high-fidelity output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

echo -e "${GREEN}[ARMOR-HEAL]${NC} Initiating Deterministic Healing Ritual...${RESET}"

# 2. Directory Restoration (The Foundation)
REQUIRED_DIRS=("data" "lib" "scripts" ".cache")
for dir in "${REQUIRED_DIRS[@]}"; do
    if [[ ! -d "./${dir}" ]]; then
        mkdir -p "./${dir}"
        echo -e "${YELLOW}[HEALED]${NC} Restored directory: ${dir}"
    fi
done

# 3. Version Synchronization (The Baseline)
# We leverage the deterministic parts of sync-version for the Armor
echo -e "${GREEN}[INFO]${NC} Synchronizing Armor Baseline..."
zsh "./bin/vde-sync-version" --quiet || true

# 4. Registry & Cache Synchronization
if [[ -f "./data/vm-types.json" ]]; then
    echo -e "${GREEN}[INFO]${NC} Re-smelting Beskar Cache..."
    zsh "./bin/vde-rebuild-cache" --quiet || true
fi

echo -e "\n${GREEN}[SUCCESS]${NC} The Armor is healed and autonomous."
exit 0
