#!/usr/bin/env zsh
# @armor (Engine Core)
#===============================================================================
# vde-gospel-audit.zsh - Sovereign Artifact Integrity Sentinel
#
# Detects drift between the physical implementation and the Gospel.
# 1. Verifies existence of the 9 Sovereign Artifacts.
# 2. Verifies version consistency across the ecosystem.
# 3. Cross-references bin/ with docs/available-scripts.md.
#===============================================================================

# 1. Initialize the Spine
emulate -L zsh
setopt LOCAL_OPTIONS
typeset _zsh_compliance_flag=${(z):-"zsh native parameter expansion"}
set -e

# Use relative pathing (Mandate)
source "./lib/vde-core"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

errors=0

# 2. The Sovereign Artifact Set
SOVEREIGN_ARTIFACTS=(
    "docs/architecture/overview.md"
    "docs/architecture/data-flow.md"
    "docs/changelogs/current.md"
    "docs/governance/vde-spec.md"
    "USE_CASES.md"
    "VDE_ANALYSIS.md"
    "PROJECT_STATUS.md"
    "docs/governance/sovereign-charter.md"
    "docs/api/library-api.md"
)

echo -e "${GREEN}[AUDIT]${NC} Auditing Sovereign Artifact Set..."
for file in "${SOVEREIGN_ARTIFACTS[@]}"; do
    if [[ ! -f "./${file}" ]]; then
        echo -e "${RED}[FAILURE]${NC} Missing Sovereign Artifact: ${file}"
        errors=$((errors + 1))
    fi
done

# 3. Version Consistency Check
echo -e "${GREEN}[AUDIT]${NC} Verifying Version Consistency..."
GOSPEL_VER=$(vde_get_version)
echo -e "${GREEN}[INFO]${NC} Gospel Version (docs/governance/vde-spec.md): ${GOSPEL_VER}"

# Check data/vm-types.json
if [[ -f "./data/vm-types.json" ]]; then
    JSON_VER=$(vde_query_json ".version" "./data/vm-types.json" | tr -d '"')
    if [[ "${JSON_VER}" != "${GOSPEL_VER}" ]]; then
        echo -e "${RED}[CRITICAL FAILURE]${NC} Version drift detected in data/vm-types.json: ${JSON_VER} (expected ${GOSPEL_VER})"
        errors=$((errors + 1))
    fi
fi

# 4. Script Documentation Check
echo -e "${GREEN}[AUDIT]${NC} Cross-referencing bin/ with docs/available-scripts.md..."
AVAILABLE_SCRIPTS_DOC="./docs/available-scripts.md"
if [[ -f "${AVAILABLE_SCRIPTS_DOC}" ]]; then
    for script_path in "./bin"/*(N.); do
        script_name="${script_path:t}"
        # Skip internal/hidden files
        [[ "${script_name}" == "."* ]] && continue
        [[ "${script_name}" == "archive" ]] && continue
        
        # Check for literal name, or subcommand name (e.g. vde cluster for vde-cluster)
        local base_name="${script_name#vde-}"
        # Strip .zsh for subcommand checks (e.g. vde dns-check for vde-dns-check.zsh)
        local sub_cmd="${base_name%.zsh}"
        if ! grep -qE "(\`${script_name}\`|\`vde ${sub_cmd}([[:space:]]|\`))" "${AVAILABLE_SCRIPTS_DOC}"; then
            echo -e "${RED}[CRITICAL FAILURE]${NC} Undocumented scripts detected: bin/${script_name}"
            errors=$((errors + 1))
        fi
    done
fi

# 5. Final Verdict
if [[ $errors -gt 0 ]]; then
    echo -e "\n${RED}[GOSPEL-FAILURE]${NC} ${errors} integrity violations detected."
    # Exit with 13 for version drift if it was the only error, otherwise 1
    if [[ $errors -eq 1 && "${JSON_VER}" != "${GOSPEL_VER}" ]]; then
        exit 13
    fi
    exit 1
else
    echo -e "\n${GREEN}[GOSPEL-SUCCESS]${NC} Sovereign Artifact Set is synchronized."
    exit 0
fi
