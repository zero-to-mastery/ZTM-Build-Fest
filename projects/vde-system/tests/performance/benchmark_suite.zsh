#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# Performance Benchmark Suite for VDE
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}


typeset TEST_DIR="$(cd "$(dirname "${0}")" && pwd)"
typeset VDE_ROOT_DIR="$(cd "${TEST_DIR}/../.." && pwd)"

typeset -g TESTS_PASSED=0
typeset -g TESTS_FAILED=0
typeset GREEN='\033[0;32m'
typeset RED='\033[0;31m'
typeset YELLOW='\033[0;33m'
typeset RESET='\033[0m'
test_start() { echo -e "${YELLOW}Benchmarking: ${1}${RESET}" }
test_pass() { echo -e "  ${GREEN}✓ PASS: ${1}${RESET}"; ((TESTS_PASSED++)) }
test_fail() { echo -e "  ${RED}✗ FAIL: ${1} - ${2}${RESET}"; ((TESTS_FAILED++)) }

# Timing helper - returns milliseconds
time_ms() {
    local start end
    if command -v gdate &>/dev/null; then
        start=$(gdate +%s%N)
        "${@}" > /dev/null 2>&1
        end=$(gdate +%s%N)
        echo $(( (end - start) / 1000000 ))
    elif command -v python3 &>/dev/null; then
        start=$(python3 -c 'import time; print(int(time.time()*1000))')
        "${@}" > /dev/null 2>&1
        end=$(python3 -c 'import time; print(int(time.time()*1000))')
        echo $(( end - start ))
    else
        # Fallback: second-level granularity
        start=$(date +%s)
        "${@}" > /dev/null 2>&1
        end=$(date +%s)
        echo $(( (end - start) * 1000 ))
    fi
}

# Benchmark 1: VDE help response time (target: < 3000ms)
bench_vde_help() {
    test_start "VDE help command response time (target: < 3000ms)"
    local ms=$(time_ms "${VDE_ROOT_DIR}/bin/vde" help)
    if [[ ${ms} -lt 3000 ]]; then
        test_pass "VDE help: ${ms}ms"
    else
        test_fail "VDE help" "took ${ms}ms (target: < 3000ms)"
    fi
}

# Benchmark 2: VM type loading (target: < 2000ms)
bench_vm_type_loading() {
    test_start "VM type loading time (target: < 2000ms)"
    local ms=$(time_ms zsh -c "source '${VDE_ROOT_DIR}/lib/vm-common' && get_all_vms")
    if [[ ${ms} -lt 2000 ]]; then
        test_pass "VM type loading: ${ms}ms"
    else
        test_fail "VM type loading" "took ${ms}ms (target: < 2000ms)"
    fi
}

# Benchmark 3: Parser simple input (target: < 2000ms)
bench_parser_simple() {
    test_start "Parser simple input time (target: < 2000ms)"
    local ms=$(time_ms zsh -c "source '${VDE_ROOT_DIR}/lib/vde-parser' && parse_intent 'start python'")
    if [[ ${ms} -lt 2000 ]]; then
        test_pass "Parser simple: ${ms}ms"
    else
        test_fail "Parser simple" "took ${ms}ms (target: < 2000ms)"
    fi
}

# Benchmark 4: Library sourcing time (target: < 1000ms)
bench_library_sourcing() {
    test_start "Library sourcing time (target: < 1000ms)"
    local ms=$(time_ms zsh -c "source '${VDE_ROOT_DIR}/lib/vm-common'")
    if [[ ${ms} -lt 1000 ]]; then
        test_pass "Library sourcing: ${ms}ms"
    else
        test_fail "Library sourcing" "took ${ms}ms (target: < 1000ms)"
    fi
}

# Benchmark 5: VDE list command (target: < 3000ms)
bench_vde_list() {
    test_start "VDE list command time (target: < 3000ms)"
    local ms=$(time_ms "${VDE_ROOT_DIR}/bin/vde" list)
    if [[ ${ms} -lt 3000 ]]; then
        test_pass "VDE list: ${ms}ms"
    else
        test_fail "VDE list" "took ${ms}ms (target: < 3000ms)"
    fi
}

main() {
    echo ""
    echo "=========================================="
    echo "Performance Benchmarks: VDE"
    echo "=========================================="
    echo ""

    bench_vde_help
    bench_vm_type_loading
    bench_parser_simple
    bench_library_sourcing
    bench_vde_list

    echo ""
    echo "=========================================="
    echo "Benchmark Summary"
    echo "=========================================="
    echo -e "${GREEN}Passed:  ${TESTS_PASSED}${RESET}"
    echo -e "${RED}Failed:  ${TESTS_FAILED}${RESET}"
    echo ""

    [[ ${TESTS_FAILED} -eq 0 ]] && exit 0 || exit 1
}
main "${@}"
