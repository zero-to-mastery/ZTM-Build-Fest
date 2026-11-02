#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vde-docker Library
# Tests image management and configuration logic
#
# NOTE: This test skips actual container runs to remain CI-compatible.

# Determine VDE root directory
if [[ -z "${VDE_ROOT_DIR}" ]]; then
    export VDE_ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi

# Source dependencies
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-naming"
source "${VDE_ROOT_DIR}/lib/vde-path-utils"
source "${VDE_ROOT_DIR}/lib/vm-common"
source "${VDE_ROOT_DIR}/lib/vde-docker"

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
# TESTS: Configuration Logic
# =============================================================================

test_get_compose_file() {
    test_start "get_compose_file"

    local result
    result=$(get_compose_file "python")

    result=$(get_compose_file "postgres")
    [[ "$result" == *"configs/docker/services/postgres/docker-compose.yml" ]] || { test_fail "get_compose_file" "expected postgres compose path, got $result"; return; }

    test_pass "get_compose_file"
        return
}

test_build_docker_opts() {
    test_start "build_docker_opts"

    # Build options check
    local result
    result=$(build_docker_opts "true" "false")

    result=$(build_docker_opts "false" "true")
    [[ "$result" == *"--no-cache"* ]] || { test_fail "build_docker_opts (nocache)" "expected --no-cache in '$result'"; return; }

    # If VDE_DOCKER_NETWORK is set (even if readonly), it should be in the output
    if [[ -n "${VDE_DOCKER_NETWORK}" ]]; then
        result=$(build_docker_opts "false" "false")
        [[ "$result" == *"--network ${VDE_DOCKER_NETWORK}"* ]] || { test_fail "build_docker_opts (network)" "expected --network ${VDE_DOCKER_NETWORK} in '$result'"; return; }
    fi

    test_pass "build_docker_opts"
        return
}

# =============================================================================
# TESTS: Port Registry Logic
# =============================================================================

test_port_allocation_logic() {
    test_start "port allocation logic"

    local test_registry="${VDE_ROOT_DIR}/.test-tmp/port-registry"
    rm -rf "${test_registry}"
    mkdir -p "${test_registry}"
    
    # Override VDE_PORT_REGISTRY for test
    VDE_PORT_REGISTRY="${test_registry}"
    
    allocate_ssh_port "testvm" 2299
    
    [[ $(cat "${test_registry}/testvm.port") == "2299" ]] || { test_fail "port allocation" "wrong port stored"; return; }
    [[ -d "${test_registry}/port-2299.lock" ]] || { test_fail "port allocation" "lock dir not created"; return; }

    vde_port_release "testvm"
    [[ ! -f "${test_registry}/testvm.port" ]] || { test_fail "port release" "registry file still exists"; return; }
    [[ ! -d "${test_registry}/port-2299.lock" ]] || { test_fail "port release" "lock dir still exists"; return; }

    test_pass "port allocation logic"
        return
}

# =============================================================================
# Run All Tests
# =============================================================================

echo "=============================================="
echo "VDE Docker Unit Tests"
echo "=============================================="

test_get_compose_file
test_build_docker_opts
test_port_allocation_logic

echo ""
echo "=============================================="
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
echo "=============================================="

exit $TESTS_FAILED
