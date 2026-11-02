#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# Integration Test for vde-jupyterlab (The Sovereign DS Spoke)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Part of the VDE Certification Suite

typeset SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
typeset PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source core libraries
export VDE_ROOT_DIR="$PROJECT_ROOT"
source "$PROJECT_ROOT/lib/vde-constants"
source "$PROJECT_ROOT/lib/vm-common"

# Colors for output
typeset RED='\033[0;31m'
typeset GREEN='\033[0;32m'
typeset YELLOW='\033[1;33m'
typeset RESET='\033[0m'

# Test counters
typeset TESTS_PASSED=0
typeset TESTS_FAILED=0

# Helper functions
test_start() {
    echo -n "[TEST] $1... "
}

test_pass() {
    echo -e "${GREEN}PASS${RESET}"
    ((TESTS_PASSED++))
}

test_fail() {
    echo -e "${RED}FAIL${RESET} ($1)"
    ((TESTS_FAILED++))
}

# =============================================================================
# 1. REGISTRY AUDIT
# =============================================================================
test_registry_presence() {
    test_start "jupyterlab is registered as a service"
    load_vm_types >/dev/null 2>&1
    
    local type=$(get_vm_type "vde-jupyterlab")
    if [[ "$type" == "service" ]]; then
        test_pass
    else
        test_fail "Expected service, got $type"
    fi
}

test_identity_assignment() {
    test_start "jupyterlab has correct port assignments"
    local ssh_port=$(get_vm_info ssh_port "vde-jupyterlab")
    local svc_ports=$(get_vm_info svc_ports "vde-jupyterlab")
    
    if [[ "$ssh_port" == "2401" && "$svc_ports" == "8888" ]]; then
        test_pass
    else
        test_fail "Ports incorrect: SSH=$ssh_port (expected 2401), SVC=$svc_ports (expected 8888)"
    fi
}

# =============================================================================
# 2. USP AUDIT (Universal Script Parity)
# =============================================================================
test_hydration_script_compliance() {
    test_start "jupyterlab-init.zsh follows USP standards"
    local script="$PROJECT_ROOT/scripts/setup/jupyterlab-init.zsh"
    
    if [[ ! -f "$script" ]]; then
        test_fail "Script missing"
        return
    fi
    
    local errors=0
    grep -q "set -e" "$script" || ((errors++))
    grep -q "apt-get clean" "$script" || ((errors++))
    grep -q "DEBIAN_FRONTEND=noninteractive" "$script" || ((errors++))
    grep -q "Forged in Beskar" "$script" || ((errors++))
    grep -q "tini" "$script" || ((errors++))
    grep -q "jupyter_server_config.py" "$script" || ((errors++))
    
    if [[ $errors -eq 0 ]]; then
        test_pass
    else
        test_fail "USP standards violation in $script"
    fi
}

# =============================================================================
# 3. MOUNT AUDIT
# =============================================================================
test_workspace_mount_override() {
    test_start "jupyterlab uses custom workspace mount"
    local mounts=$(get_vm_mounts "vde-jupyterlab")
    
    if [[ "$mounts" == *"projects/python/jupyterlabs:/home/devuser/workspace"* ]]; then
        test_pass
    else
        test_fail "Mount override missing in $mounts"
    fi
}

# =============================================================================
# 4. RUNTIME VERIFICATION (Empirical Proof)
# =============================================================================
test_runtime_connectivity() {
    test_start "jupyterlab container is responsive on port 8888"
    
    # Mandate: Force fresh ignition to ensure empirical proof of the current Beskar
    "$PROJECT_ROOT/bin/vde" stop jupyterlab >/dev/null 2>&1 || true
    "$PROJECT_ROOT/bin/vde" rm jupyterlab >/dev/null 2>&1 || true
    
    echo -n "(igniting...) "
    if ! "$PROJECT_ROOT/bin/vde" start jupyterlab >/dev/null 2>&1; then
        test_fail "Failed to ignite vde-jupyterlab"
        return 1
    fi
    
    # Use vde-poll to monitor hydration (Rule 23)
    # Mandate: JupyterLab has a ~12 minute hydration window. We wait 15m (900s).
    echo -n "(polling process...) "
    if "${PROJECT_ROOT}/bin/vde-poll" --exec "pgrep -f jupyter-lab" --timeout 900 jupyterlab; then
        echo -n "(polling HTTP port...) "
        local max_retries=900
        local retry=0
        
        while [[ $retry -lt $max_retries ]]; do
            # We use localhost here because the port is mapped to the Hub
            if curl -s -I http://localhost:8888 | grep -q "HTTP/1.1"; then
                test_pass
                return 0
            fi
            # MANDATE: vde-poll is the SOLE permitted wait primitive
            "${PROJECT_ROOT}/bin/vde-poll" --wait 1 all >/dev/null 2>&1
            (( retry++ ))
            [[ $(( retry % 10 )) -eq 0 ]] && echo -n "."
        done
        test_fail "JupyterLab UI not responding on port 8888 after 900s"
    else
        test_fail "JupyterLab process not found after 900s"
    fi
}

# =============================================================================
# MAIN
# =============================================================================
echo "=============================================="
echo "VDE JupyterLab Spoke Integration Tests"
echo "=============================================="

test_registry_presence
test_identity_assignment
test_hydration_script_compliance
test_workspace_mount_override
test_runtime_connectivity

echo "=============================================="
echo "Test Summary"
echo "=============================================="
echo "Passed: $TESTS_PASSED"
echo "Failed: $TESTS_FAILED"

if [[ $TESTS_FAILED -eq 0 ]]; then
    echo -e "\n${GREEN}✓ All JupyterLab certification tests passed${RESET}"
    exit 0
else
    echo -e "\n${RED}✗ JupyterLab certification failed${RESET}"
    exit 1
fi
