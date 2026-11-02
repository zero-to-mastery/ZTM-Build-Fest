#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# Integration Tests for VM Lifecycle (v2.1.0 Hardened)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Tests end-to-end VM creation, startup, and management workflows

# Don't use set -e as it interferes with test counting
# set -e

typeset SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
typeset PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source core libraries
export VDE_ROOT_DIR="$PROJECT_ROOT"
source "$PROJECT_ROOT/lib/vde-constants"
source "$PROJECT_ROOT/lib/vm-common"
source "$PROJECT_ROOT/lib/vm-lock"

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
    echo -e "${GREEN}PASS${RESET} ($1)"
    ((TESTS_PASSED++))
}

test_fail() {
    echo -e "${RED}FAIL${RESET} ($1: $2)"
    ((TESTS_FAILED++))
}

_get_mtime() {
    local file=$1
    if [[ "$OSTYPE" == "darwin"* ]]; then
        stat -f %m "$file" 2>/dev/null || echo 0
    else
        stat -c %Y "$file" 2>/dev/null || echo 0
    fi
}

# =============================================================================
# TESTS: VM Types Loading
# =============================================================================

test_vm_types_load() {
    test_start "VM types can be loaded"

    # Reset cache to force reload
    rm -f "$VDE_CACHE_DIR/vm-types.cache"
    unset _VM_TYPES_LOADED
    load_vm_types

    local count=${#VM_TYPE[@]}
    if [[ $count -gt 0 ]]; then
        test_pass "VM types can be loaded ($count types)"
        return
    fi

    test_fail "VM types load" "no VM types loaded"
}

test_vm_types_have_required_fields() {
    test_start "VM types have required fields"

    local vm="vde-python"
    local type display pkgs custom_cmd

    type=$(get_vm_info type "$vm")
    display=$(get_vm_info display "$vm")
    pkgs=$(get_vm_info pkgs "$vm")
    custom_cmd=$(get_vm_info custom_cmd "$vm")

    if [[ -n "$type" ]] && [[ -n "$display" ]] && { [[ -n "$pkgs" ]] || [[ -n "$custom_cmd" ]]; }; then
        test_pass "VM types have required fields"
        return
    fi

    test_fail "VM types fields" "missing fields - type:$type display:$display pkgs:$pkgs custom_cmd:$custom_cmd"
}

# =============================================================================
# TESTS: Port Allocation
# =============================================================================

test_port_allocation_basic() {
    test_start "Port allocation (basic)"

    # Clear port registry safely for test
    mkdir -p "$VDE_CACHE_DIR/port-registry"
    rm -rf "$VDE_CACHE_DIR/port-registry"/*(N)

    local port=$(find_available_port 2240 2250)
    if [[ -n "$port" ]]; then
        test_pass "Port allocation (basic - allocated $port)"
        return
    fi

    test_fail "Port allocation" "no port allocated"
}

# =============================================================================
# TESTS: Template System
# =============================================================================

test_template_rendering_lang() {
    test_start "Template rendering (language VM)"

    local test_dir="/tmp/vde-test-render-$$"
    mkdir -p "$test_dir"

    # Mock variables for rendering
    local NAME="test-lang"
    local SSH_PORT="2299"
    local PKGS="vim"
    local CUSTOM_CMD="echo test"

    local template="$PROJECT_ROOT/templates/compose-language.yml"
    local output="$test_dir/docker-compose.yml"

    if [[ ! -f "$template" ]]; then
        test_fail "Template rendering" "template missing at $template"
        rm -rf "$test_dir"
        return
    fi

    # Manual rendering for test
    sed "s@{{NAME}}@$NAME@g; s@{{SSH_PORT}}@$SSH_PORT@g; s@{{PKGS}}@$PKGS@g; s@{{CUSTOM_CMD}}@$CUSTOM_CMD@g" "$template" > "$output"

    if grep -q "vde-test-lang" "$output" && grep -q "2299:2299" "$output"; then
        test_pass "Template rendering (language VM)"
    else
        test_fail "Template rendering" "incorrect content in output"
    fi

    rm -rf "$test_dir"
}

# =============================================================================
# TESTS: Locking System
# =============================================================================

test_file_locking_basic() {
    test_start "File locking (acquire/release)"

    local lock_file="/tmp/vde-test-lock-$$"
    rm -rf "$lock_file"

    if claim_lock "$lock_file"; then
        if [[ -d "$lock_file" ]]; then
            release_lock "$lock_file"
            if [[ ! -d "$lock_file" ]]; then
                test_pass "File locking (acquire/release)"
                return
            fi
        fi
    fi

    test_fail "File locking" "failed acquire/release cycle"
}

test_file_locking_exclusion() {
    test_start "File locking (mutual exclusion)"

    local lock_file="/tmp/vde-test-lock-excl-$$"
    rm -rf "$lock_file"

    # Acquire in subshell
    ( claim_lock "$lock_file" && zmodload zsh/zselect && zselect -t 100 && release_lock "$lock_file" ) &
    local pid=$!
    
    # Give subshell a head start
    zmodload zsh/zselect && zselect -t 20

    # Verify lock exists
    if [[ -d "$lock_file" ]]; then
        test_pass "File locking (mutual exclusion - lock active)"
    else
        test_fail "File locking" "lock was not held by background process"
    fi

    wait $pid
    rm -rf "$lock_file"
}

# =============================================================================
# TESTS: Cache System
# =============================================================================

test_cache_vm_types() {
    test_start "Cache VM types"

    # Ensure cache is rebuilt
    unset _VM_TYPES_LOADED
    load_vm_types --no-cache

    if [[ -f "$VDE_CACHE_DIR/vm-types.cache" ]]; then
        test_pass "Cache VM types"
        return
    fi

    test_fail "Cache VM types" "cache file not created"
}

test_cache_invalidation() {
    test_start "Cache invalidation"

    local cache_file="$VDE_CACHE_DIR/vm-types.cache"
    unset _VM_TYPES_LOADED
    load_vm_types
    
    local old_mtime=$(_get_mtime "$cache_file")
    
    # Touch source file to invalidate cache
    zmodload zsh/zselect && zselect -t 110
    touch "$PROJECT_ROOT/data/vm-types.json"
    
    unset _VM_TYPES_LOADED
    load_vm_types
    local new_mtime=$(_get_mtime "$cache_file")

    if [[ "$new_mtime" -gt "$old_mtime" ]]; then
        test_pass "Cache invalidation (cache updated)"
        return
    fi

    test_fail "Cache invalidation" "cache not updated (old: $old_mtime, new: $new_mtime)"
}

# =============================================================================
# TESTS: Utilities
# =============================================================================

test_get_compose_file_path() {
    test_start "Get compose file path"

    local vm="vde-python"
    local actual=$(get_compose_file "$vm")
    
    if [[ "$actual" == *"configs/docker/languages/python/docker-compose.yml" ]]; then
        test_pass "Get compose file path ($actual)"
        return
    fi

    test_fail "Get compose file path" "incorrect path: $actual"
}

# =============================================================================
# MAIN
# =============================================================================

main() {
    echo -e "\n=========================================="
    echo "Integration Tests: VM Lifecycle"
    echo -e "==========================================\n"

    test_vm_types_load
    test_vm_types_have_required_fields
    test_port_allocation_basic
    test_template_rendering_lang
    test_file_locking_basic
    test_file_locking_exclusion
    test_cache_vm_types
    test_cache_invalidation
    test_get_compose_file_path

    echo -e "\n=========================================="
    echo "Test Summary"
    echo "=========================================="
    echo -e "Passed:  ${GREEN}${TESTS_PASSED}${RESET}"
    echo -e "Failed:  ${RED}${TESTS_FAILED}${RESET}"
    echo -e "\nTotal:   $((TESTS_PASSED + TESTS_FAILED))"

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "\n${GREEN}All tests passed!${RESET}\n"
        exit 0
    else
        echo -e "\n${RED}Some tests failed!${RESET}\n"
        exit 1
    fi
}

main "$@"
