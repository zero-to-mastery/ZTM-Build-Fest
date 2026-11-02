#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vde-parser Library
# Tests natural language parser functionality

# Don't use set -e as it interferes with test counting
# set -e

typeset SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
typeset PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source dependencies
source "$PROJECT_ROOT/lib/vde-shell-compat"
source "$PROJECT_ROOT/lib/vde-constants"
source "$PROJECT_ROOT/lib/vm-common"
source "$PROJECT_ROOT/lib/vde-commands"
source "$PROJECT_ROOT/lib/vde-parser"

# Test configuration
typeset VERBOSE=${VERBOSE:-false}
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

# Initialize VM types for parser tests
unset _VDE_CORE_LOADED
unset _VM_TYPES_LOADED
VDE_CORE_VM_TYPE=()
load_vm_types --no-cache >/dev/null 2>&1
invalidate_alias_map >/dev/null 2>&1
_build_alias_map >/dev/null 2>&1

# =============================================================================
# TESTS: Intent Detection
# =============================================================================

test_detect_list_intent() {
    test_start "detect list intent"

    local inputs=(
        "list all vms"
        "show all languages"
        "what vms can I create"
        "show services"
    )

    for input in "${inputs[@]}"; do
        local intent
        intent=$(detect_intent "$input")
        if [[ "$intent" != "list_vms" ]]; then
            test_fail "detect list intent" "input '$input' gave intent '$intent'"
        fi
    done

    test_pass "detect list intent"
        return
}

test_detect_create_intent() {
    test_start "detect create intent"

    local inputs=(
        "create a go vm"
        "create new vde-rust"
        "make a python"
        "set up js"
    )

    for input in "${inputs[@]}"; do
        local intent
        intent=$(detect_intent "$input")
        if [[ "$intent" != "create_vm" ]]; then
            test_fail "detect create intent" "input '$input' gave intent '$intent'"
        fi
    done

    test_pass "detect create intent"
        return
}

# =============================================================================
# TESTS: Entity Extraction
# =============================================================================

test_extract_vm_names() {
    test_start "extract vm names"

    local result
    result=$(extract_vm_names "start vde-python and vde-rust")

    if echo "$result" | grep -q "vde-python" && echo "$result" | grep -q "vde-rust"; then
        test_pass "extract vm names"
        return
    fi

    test_fail "extract vm names" "names not found in: $result"
}

test_extract_vm_aliases() {
    test_start "extract vm aliases"

    local result
    result=$(extract_vm_names "start python3")

    if echo "$result" | grep -q "vde-python"; then
        test_pass "extract vm aliases"
        return
    fi

    test_fail "extract vm aliases" "alias 'python3' not resolved to 'vde-python': $result"
}

# =============================================================================
# TESTS: Plan Generation
# =============================================================================

test_generate_plan_create() {
    test_start "generate plan (create)"

    local plan
    plan=$(generate_plan "create a vde-go vm")

    # Clean up plan for matching
    local clean_plan=$(echo "$plan" | grep -E "INTENT:|VM:|FLAGS:|FILTER:")

    if echo "$clean_plan" | grep -q "INTENT:create_vm"; then
        if echo "$clean_plan" | grep -q "VM:.*vde-go"; then
            test_pass "generate plan (create)"
        return
        fi
    fi

    test_fail "generate plan" "intent or VM not found in clean plan. Output was: $plan"
}

# =============================================================================
# TESTS: Alias Map
# =============================================================================

test_lookup_vm_by_alias() {
    test_start "lookup_vm_by_alias"

    _build_alias_map

    local result
    result=$(_lookup_vm_by_alias "python3")

    if [[ "$result" == "vde-python" ]]; then
        test_pass "lookup_vm_by_alias"
        return
    fi

    test_fail "lookup_vm_by_alias" "alias python3 not resolved to vde-python: $result"
}

# =============================================================================
# MAIN TEST RUNNER
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "Unit Tests: vde-parser (Consistent Naming)"
    echo "=========================================="
    echo ""

    test_detect_list_intent
    test_detect_create_intent
    test_extract_vm_names
    test_extract_vm_aliases
    test_generate_plan_create
    test_lookup_vm_by_alias

    # Print summary
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
