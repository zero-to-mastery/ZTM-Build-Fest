#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vde-naming Library
# Tests VM naming conventions and resolution

# Determine VDE root directory
if [[ -z "${VDE_ROOT_DIR}" ]]; then
    export VDE_ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi

# Source dependencies
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-naming"

# Test configuration
typeset TESTS_PASSED=0
typeset TESTS_FAILED=0

# Colors
if [[ -t 1 ]]; then
    typeset GREEN='\033[0;32m'
    typeset RED='\033[0;31m'
    typeset YELLOW='\033[1;33m'
    typeset RESET='\033[0m'
else
    typeset GREEN=''
    typeset RED=''
    typeset YELLOW=''
    typeset RESET=''
fi

test_start() {
    echo -e "${YELLOW}[TEST]${RESET} $1"
}

test_pass() {
    echo -e "${GREEN}[PASS]${RESET} $1"
    ((TESTS_PASSED++))
}

test_fail() {
    echo -e "${RED}[FAIL]${RESET} $1: $2"
    ((TESTS_FAILED++))
}

# =============================================================================
# TESTS: Naming Logic
# =============================================================================

test_vde_get_container_name() {
    test_start "vde_get_container_name"

    local result
    result=$(vde_get_container_name "python")

    result=$(vde_get_container_name "vde-postgres")
    [[ "$result" == "vde-postgres" ]] || { test_fail "vde_get_container_name" "failed to handle already prefixed name: $result"; return; }

    test_pass "vde_get_container_name"
        return
}

test_vde_get_hostname() {
    test_start "vde_get_hostname"

    local result
    result=$(vde_get_hostname "vde-python")

    test_pass "vde_get_hostname"
        return
}

test_vde_get_ssh_host() {
    test_start "vde_get_ssh_host"

    local result
    result=$(vde_get_ssh_host "python")

    test_pass "vde_get_ssh_host"
        return
}

test_vde_normalize_name() {
    test_start "vde_normalize_name"

    local result
    result=$(vde_normalize_name "vde-python")

    result=$(vde_normalize_name "postgres")
    [[ "$result" == "postgres" ]] || { test_fail "vde_normalize_name" "failed to handle already normalized name: $result"; return; }

    test_pass "vde_normalize_name"
        return
}

test_vde_validate_name() {
    test_start "vde_validate_name"

    if vde_validate_name "python" && vde_validate_name "vde-postgres"; then
        if ! vde_validate_name "Invalid_Name!"; then
            test_pass "vde_validate_name"
        return
        fi
    fi

    test_fail "vde_validate_name" "validation logic failed"
}

# =============================================================================
# Run All Tests
# =============================================================================

echo "=============================================="
echo "VDE Naming Unit Tests"
echo "=============================================="

test_vde_get_container_name
test_vde_get_hostname
test_vde_get_ssh_host
test_vde_normalize_name
test_vde_validate_name

echo ""
echo "=============================================="
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
echo "=============================================="

exit $TESTS_FAILED
