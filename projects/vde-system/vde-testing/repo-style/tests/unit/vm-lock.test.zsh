#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vm-lock Library
# Covers claim/release, re-entrancy depth, VDE_NO_LOCK bypass, stale-lock
# busting and its 10-second grace period. Docker-free.
# Not covered: real multi-process contention / FIFO ordering across processes.

# Determine VDE root directory
if [[ -z "${VDE_ROOT_DIR}" ]]; then
    export VDE_ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi

# Source dependencies
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vm-common"
source "${VDE_ROOT_DIR}/lib/vm-lock"

# Test configuration
typeset TESTS_PASSED=0
typeset TESTS_FAILED=0
typeset SANDBOX=""

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

# expect_eq <description> <expected> <actual>
expect_eq() {
    if [[ "${2}" == "${3}" ]]; then
        test_pass "${1}"
    else
        test_fail "${1}" "expected '${2}', got '${3}'"
    fi
}

setup() {
    unset VDE_NO_LOCK
    SANDBOX="$(mktemp -d)"
}

teardown() {
    [[ -n "${SANDBOX}" ]] && rm -rf "${SANDBOX}"
}

# =============================================================================
# TESTS
# =============================================================================

test_is_process_alive() {
    test_start "is_process_alive"
    is_process_alive $$;        expect_eq "own pid is alive" 0 $?
    is_process_alive 99999999;  expect_eq "absurd pid is dead" 1 $?
    is_process_alive "";        expect_eq "empty pid rejected" 1 $?
    is_process_alive "abc";     expect_eq "non-numeric pid rejected" 1 $?
    is_process_alive "12;id";   expect_eq "pid with metacharacters rejected" 1 $?
}

test_claim_release_cycle() {
    test_start "claim_lock / release_lock basic cycle"
    local lock="${SANDBOX}/basic.lock"

    claim_lock "${lock}" 2>/dev/null
    expect_eq "claim succeeds" 0 $?
    [[ -d "${lock}" ]]
    expect_eq "lock directory exists" 0 $?
    expect_eq "pid file records our pid" "$$" "$(cut -d: -f1 < "${lock}/pid")"
    expect_eq "pid file has PID:PGID:TS (3 fields)" 3 "$(awk -F: '{print NF}' < "${lock}/pid")"
    [[ -d "${lock}.queue" && -n "$(ls -A "${lock}.queue")" ]]
    expect_eq "ticket registered in queue" 0 $?

    release_lock "${lock}"
    expect_eq "release returns 0" 0 $?
    [[ ! -e "${lock}" ]]
    expect_eq "lock directory removed" 0 $?
    [[ ! -e "${lock}.queue" ]]
    expect_eq "empty queue directory removed" 0 $?
}

test_reentrancy() {
    test_start "claim_lock re-entrancy (depth counting)"
    local lock="${SANDBOX}/reentrant.lock"

    claim_lock "${lock}" 2>/dev/null
    claim_lock "${lock}" 2>/dev/null
    expect_eq "depth is 2 after two claims" 2 "${VDE_LOCK_DEPTH[${lock}]}"

    release_lock "${lock}"
    [[ -d "${lock}" ]]
    expect_eq "first release keeps the lock held" 0 $?
    expect_eq "depth back to 1" 1 "${VDE_LOCK_DEPTH[${lock}]}"

    release_lock "${lock}"
    [[ ! -e "${lock}" ]]
    expect_eq "second release frees the lock" 0 $?
    expect_eq "depth entry cleared" "" "${VDE_LOCK_DEPTH[${lock}]:-}"
}

test_no_lock_bypass() {
    test_start "VDE_NO_LOCK=1 bypass"
    local lock="${SANDBOX}/bypass.lock"

    VDE_NO_LOCK=1 claim_lock "${lock}"
    expect_eq "claim bypassed returns 0" 0 $?
    [[ ! -e "${lock}" ]]
    expect_eq "no lock directory created" 0 $?
}

test_release_unheld_lock() {
    test_start "release_lock on a lock that was never held"
    release_lock "${SANDBOX}/never.lock"
    expect_eq "harmless, returns 0" 0 $?
}

test_stale_lock_busting() {
    test_start "stale lock (dead owner, older than 10s) is busted"
    local lock="${SANDBOX}/stale.lock"
    mkdir -p "${lock}"
    echo "99999999:1:$(( $(date +%s) - 60 ))" > "${lock}/pid"

    claim_lock "${lock}" 2>/dev/null
    expect_eq "claim succeeds over stale lock" 0 $?
    expect_eq "ownership transferred to us" "$$" "$(cut -d: -f1 < "${lock}/pid")"
    release_lock "${lock}"
}

test_grace_period() {
    test_start "dead owner but lock younger than 10s is NOT busted"
    local lock="${SANDBOX}/grace.lock"
    mkdir -p "${lock}"
    echo "99999999:1:$(date +%s)" > "${lock}/pid"

    # claim_lock would keep retrying for ~30 cycles; cap it and inspect the lock.
    ( timeout 4 zsh -c "
        source '${VDE_ROOT_DIR}/lib/vde-shell-compat'
        source '${VDE_ROOT_DIR}/lib/vde-constants'
        source '${VDE_ROOT_DIR}/lib/vm-common'
        source '${VDE_ROOT_DIR}/lib/vm-lock'
        claim_lock '${lock}'" >/dev/null 2>&1 )
    expect_eq "fresh dead-owner lock still held by original pid" 99999999 "$(cut -d: -f1 < "${lock}/pid")"
}

# =============================================================================
# MAIN TEST RUNNER
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "Unit Tests: vm-lock"
    echo "=========================================="
    echo ""

    setup
    test_is_process_alive
    test_claim_release_cycle
    test_reentrancy
    test_no_lock_bypass
    test_release_unheld_lock
    test_stale_lock_busting
    test_grace_period
    teardown

    echo ""
    echo "=========================================="
    echo "Test Summary"
    echo "=========================================="
    echo -e "${GREEN}Passed:  $TESTS_PASSED${RESET}"
    echo -e "${RED}Failed:  $TESTS_FAILED${RESET}"
    echo ""

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "\n${GREEN}All tests passed!${RESET}\n"
        exit 0
    else
        echo -e "\n${RED}Some tests failed!${RESET}\n"
        exit 1
    fi
}

main "$@"
