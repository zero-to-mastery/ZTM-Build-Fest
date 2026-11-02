#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vde-parser input validation
# Covers: contains_dangerous_chars, validate_plan_line, parse_flags, and the
# stdin path of execute_plan (every case aborts BEFORE any ./bin/vde call).
#
# NOTE: contains_dangerous_chars has an inverted return convention:
#   0 (VDE_SUCCESS)       => dangerous characters FOUND
#   3 (VDE_ERR_NOT_FOUND) => string is safe

# Determine VDE root directory
if [[ -z "${VDE_ROOT_DIR}" ]]; then
    export VDE_ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi

# Source dependencies (same set as vde-parser.test.zsh)
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vm-common"
source "${VDE_ROOT_DIR}/lib/vde-commands"
source "${VDE_ROOT_DIR}/lib/vde-parser"

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

# expect_rc <description> <expected_rc> <actual_rc>
expect_rc() {
    if [[ "${2}" == "${3}" ]]; then
        test_pass "${1}"
    else
        test_fail "${1}" "expected rc ${2}, got ${3}"
    fi
}

# =============================================================================
# TESTS: contains_dangerous_chars
# =============================================================================

test_dangerous_chars_each_metacharacter() {
    test_start "contains_dangerous_chars flags every listed metacharacter"
    local -a bad=( 'a;b' 'a|b' 'a&b' 'a$b' 'a`b' 'a(b' 'a)b' 'a{b' 'a}b'
                   'a[b' 'a]b' 'a<b' 'a>b' 'a!b' 'a#b' 'a*b' 'a?b' 'a\b' 'a"b' )
    local s
    for s in "${bad[@]}"; do
        contains_dangerous_chars "${s}"
        expect_rc "dangerous: [${s}]" 0 $?
    done
}

test_dangerous_chars_safe_values() {
    test_start "contains_dangerous_chars accepts ordinary values"
    local -a good=( 'python' 'vde-postgres' 'rebuild=true nocache=false' 'start_vm' 'a-b_c.d' )
    local s
    for s in "${good[@]}"; do
        contains_dangerous_chars "${s}"
        expect_rc "safe: [${s}]" 3 $?
    done
}

test_dangerous_chars_payloads() {
    test_start "contains_dangerous_chars flags realistic injection payloads"
    local -a payloads=( 'python; rm -rf /' '$(whoami)' '`id`' 'x && curl evil' 'x | nc host 1' )
    local s
    for s in "${payloads[@]}"; do
        contains_dangerous_chars "${s}"
        expect_rc "payload: [${s}]" 0 $?
    done
}

# =============================================================================
# TESTS: validate_plan_line
# =============================================================================

test_plan_line_allowed_keys() {
    test_start "validate_plan_line accepts each whitelisted key"
    local line
    for line in 'INTENT:start_vm' 'VM:python' 'FLAGS:rebuild=true' 'FILTER:running' \
                'CLUSTER_ACTION:start' 'CLUSTER_NAME:web'; do
        validate_plan_line "${line}" 2>/dev/null
        expect_rc "allowed: ${line}" 0 $?
    done
    validate_plan_line ''
    expect_rc "empty line is skipped" 0 $?
}

test_plan_line_rejections() {
    test_start "validate_plan_line rejects bad keys and injected values"
    validate_plan_line 'EVIL:python' 2>/dev/null
    expect_rc "unknown key" 2 $?
    validate_plan_line 'intent:start_vm' 2>/dev/null
    expect_rc "key match is case-sensitive" 2 $?
    validate_plan_line 'VM:python; rm -rf /' 2>/dev/null
    expect_rc "allowed key with injected value" 2 $?
    validate_plan_line 'VM:$(id)' 2>/dev/null
    expect_rc "command substitution in value" 2 $?
}

# =============================================================================
# TESTS: parse_flags
# =============================================================================

test_parse_flags_defaults_and_values() {
    test_start "parse_flags defaults, valid values, and state reset"
    parse_flags ""
    expect_rc "empty flags ok" 0 $?
    [[ "${rebuild}" == "false" && "${nocache}" == "false" ]] \
        && test_pass "empty flags leave both false" \
        || test_fail "empty flags leave both false" "rebuild=${rebuild} nocache=${nocache}"

    parse_flags "rebuild=true nocache=true"
    [[ "${rebuild}" == "true" && "${nocache}" == "true" ]] \
        && test_pass "both set to true" \
        || test_fail "both set to true" "rebuild=${rebuild} nocache=${nocache}"

    parse_flags "nocache=true"
    [[ "${rebuild}" == "false" ]] \
        && test_pass "rebuild reset on a new call (no state leakage)" \
        || test_fail "rebuild reset on a new call" "rebuild=${rebuild}"
}

test_parse_flags_rejections() {
    test_start "parse_flags rejects unknown, malformed, and dangerous input"
    parse_flags "rebuild=yes" 2>/dev/null;              expect_rc "non-boolean value" 2 $?
    parse_flags "rebuild=TRUE" 2>/dev/null;             expect_rc "boolean is case-sensitive" 2 $?
    parse_flags "force=true" 2>/dev/null;               expect_rc "unknown flag" 2 $?
    parse_flags "rebuild=true; id" 2>/dev/null;         expect_rc "metacharacters" 2 $?
    parse_flags "rebuild=true force=true" 2>/dev/null;  expect_rc "one bad flag among good ones" 2 $?
}

# =============================================================================
# TESTS: execute_plan (stdin path). Every plan below fails validation, or is
# the help intent, so no ./bin/vde command is ever run.
# =============================================================================

test_execute_plan_aborts_on_bad_plans() {
    test_start "execute_plan aborts before executing on invalid plans"
    printf 'INTENT:%s\nEVIL:x\n' "${INTENT_START_VM}" | execute_plan >/dev/null 2>&1
    expect_rc "second line with unknown key cannot be smuggled in" 2 $?

    printf 'INTENT:%s\nVM:python;id\n' "${INTENT_START_VM}" | execute_plan >/dev/null 2>&1
    expect_rc "injected VM value" 2 $?

    printf 'INTENT:%s\nFLAGS:force=true\n' "${INTENT_START_VM}" | execute_plan >/dev/null 2>&1
    expect_rc "unknown flag" 2 $?

    printf 'INTENT:%s\nFILTER:bogus\n' "${INTENT_LIST_VMS}" | execute_plan >/dev/null 2>&1
    expect_rc "invalid FILTER value" 2 $?

    printf 'INTENT\n' | execute_plan >/dev/null 2>&1
    expect_rc "colon-less line degrades to 'Unknown intent'" 2 $?
}

test_execute_plan_help_is_safe() {
    test_start "execute_plan runs the help intent"
    printf 'INTENT:%s\n' "${INTENT_HELP}" | execute_plan >/dev/null 2>&1
    expect_rc "help intent succeeds" 0 $?
}

# =============================================================================
# MAIN TEST RUNNER
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "Unit Tests: vde-parser input validation"
    echo "=========================================="
    echo ""

    test_dangerous_chars_each_metacharacter
    test_dangerous_chars_safe_values
    test_dangerous_chars_payloads
    test_plan_line_allowed_keys
    test_plan_line_rejections
    test_parse_flags_defaults_and_values
    test_parse_flags_rejections
    test_execute_plan_aborts_on_bad_plans
    test_execute_plan_help_is_safe

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
