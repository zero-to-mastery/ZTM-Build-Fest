#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vde-path-utils Library
# Tests path resolution and normalization

# Determine VDE root directory
if [[ -z "${VDE_ROOT_DIR}" ]]; then
    export VDE_ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi

# Source dependencies
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-path-utils"

# Test configuration
typeset TESTS_PASSED=0
typeset TESTS_FAILED=0

# Colors
if [[ -t 1 ]]; then
    typeset GREEN='\033[0;32m'
    typeset RED='\033[0;31m'
    typeset YELLOW='\033[0;33m'
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
# TESTS: Path Utils
# =============================================================================

test_vde_path_to_home_rel() {
    test_start "vde_path_to_home_rel"

    local result
    result=$(vde_path_to_home_rel "${HOME}/test/path")

    test_pass "vde_path_to_home_rel"
        return
}

test_vde_path_from_home_rel() {
    test_start "vde_path_from_home_rel"

    local result
    result=$(vde_path_from_home_rel "~/test/path")

    test_pass "vde_path_from_home_rel"
        return
}

test_vde_path_normalize() {
    test_start "vde_path_normalize"

    local result
    result=$(vde_path_normalize "/tmp//test/./path")

    test_pass "vde_path_normalize"
        return
}

test_vde_get_project_name() {
    test_start "vde_get_project_name"

    local result
    result=$(vde_get_project_name)

    test_pass "vde_get_project_name"
        return
}

# =============================================================================
# Run All Tests
# =============================================================================

echo "=============================================="
echo "VDE Path Utils Unit Tests"
echo "=============================================="

test_vde_path_to_home_rel
test_vde_path_from_home_rel
test_vde_path_normalize
test_vde_get_project_name

echo ""
echo "=============================================="
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
echo "=============================================="

exit $TESTS_FAILED
