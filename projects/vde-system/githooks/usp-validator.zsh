#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# githooks/usp-validator.zsh - Codifies USP Mandates from usp-validation.feature
# Part of the Pre-Strike Sentinel
set -e

# Determine VDE root directory
VDE_ROOT_DIR="${0:a:h:h}"
export VDE_ROOT_DIR

# Source core libraries for VM registry lookup
# We set VDE_SKIP_AUTO_LOAD to prevent it from loading VM types on source
export VDE_SKIP_AUTO_LOAD=1
[[ -f "${VDE_ROOT_DIR}/lib/vde-shell-compat" ]] && source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
[[ -f "${VDE_ROOT_DIR}/lib/vde-constants" ]] && source "${VDE_ROOT_DIR}/lib/vde-constants"
[[ -f "${VDE_ROOT_DIR}/lib/vde-log" ]] && source "${VDE_ROOT_DIR}/lib/vde-log"
[[ -f "${VDE_ROOT_DIR}/lib/vm-common" ]] && source "${VDE_ROOT_DIR}/lib/vm-common"

# Colors
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

EXIT_CODE=0

echo "Running Universal Script Parity (USP) Validation..."

# Load VM types manually
load_vm_types

# 1. Registration & Presence Check
# ZSH-native shibboleth (Rule 1): Expand keys from associative array
typeset registered_vms=(${(k)VM_DISPLAY})
typeset setup_dir="${VDE_ROOT_DIR}/scripts/setup"

# Check if every registered VM has a setup script
for vm in "${registered_vms[@]}"; do
    # Remove vde- prefix for script matching
    typeset vm_alias="${vm#vde-}"
    typeset script="${setup_dir}/${vm_alias}-init.zsh"
    if [[ ! -f "${script}" ]]; then
        echo -e "${RED}[ERROR] USP Violation: Registered VM '${vm}' is missing hydration script: scripts/setup/${vm_alias}-init.zsh${RESET}"
        EXIT_CODE=1
    fi
done

# 2. Ghost Script Check
# Check if every script in scripts/setup/ is registered
for script in "${setup_dir}"/*-init.zsh(N); do
    typeset script_base=$(basename "${script}")
    typeset vm_alias="${script_base%-init.zsh}"
    typeset found=0
    for reg_vm in "${registered_vms[@]}"; do
        typeset reg_alias="${reg_vm#vde-}"
        if [[ "${reg_alias}" == "${vm_alias}" ]]; then
            found=1
            break
        fi
    done
    if [[ ${found} -eq 0 ]]; then
        echo -e "${RED}[ERROR] USP Violation: Script 'scripts/setup/${script_base}' exists but '${vm_alias}' is not in the Beskar Registry.${RESET}"
        EXIT_CODE=1
    fi
done

# 3. Compliance Ritual Check (Rule F)
# Scans staged scripts for mandatory patterns
# Fix: use --diff-filter instead of --filter
for file in $(git diff --cached --name-only --diff-filter=ACM | grep 'scripts/setup/.*-init\.zsh$'); do
    typeset content=$(cat "${file}")
    
    # Check for 'set -e'
    if ! grep -q "set -e" <<< "${content}"; then
        echo -e "${RED}[ERROR] USP Violation: '${file}' missing 'set -e' for deterministic error handling.${RESET}"
        EXIT_CODE=1
    fi

    # Check for BTO ghost purge (Rule 12.5)
    # Canonical form: vde_purge_ghosts; legacy inline also accepted during migration
    if ! grep -q "vde_purge_ghosts" <<< "${content}"; then
        if ! grep -q "apt-get clean" <<< "${content}"; then
            echo -e "${RED}[ERROR] USP Violation: '${file}' missing 'apt-get clean' mandate.${RESET}"
            EXIT_CODE=1
        fi
        if ! grep -q "rm -rf /var/lib/apt/lists/\*" <<< "${content}"; then
            echo -e "${RED}[ERROR] USP Violation: '${file}' missing ghost purging mandate (rm -rf /var/lib/apt/lists/*).${RESET}"
            EXIT_CODE=1
        fi
    fi

    # Check for 'DEBIAN_FRONTEND=noninteractive'
    if ! grep -q "DEBIAN_FRONTEND=noninteractive" <<< "${content}"; then
        echo -e "${RED}[ERROR] USP Violation: '${file}' missing 'DEBIAN_FRONTEND=noninteractive' mandate.${RESET}"
        EXIT_CODE=1
    fi

    # Check for 'Forged in Beskar' header
    if ! grep -q "Forged in Beskar" <<< "${content}"; then
        echo -e "${RED}[ERROR] USP Violation: '${file}' missing 'Forged in Beskar' header ritual.${RESET}"
        EXIT_CODE=1
    fi
done

if [[ ${EXIT_CODE} -ne 0 ]]; then
    echo -e "${RED}USP Validation Failed. Commit blocked.${RESET}"
fi

exit ${EXIT_CODE}
