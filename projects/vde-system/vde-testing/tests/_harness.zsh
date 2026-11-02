#!/usr/bin/env zsh
# Tiny shared harness for the standalone VDE gap-filling tests.
# Usage: VDE_ROOT_DIR=/path/to/vde-system zsh <test-file>
typeset -g TESTS_PASSED=0 TESTS_FAILED=0

assert_eq() {   # assert_eq <name> <expected> <actual>
    if [[ "$2" == "$3" ]]; then
        echo "[PASS] $1"; (( TESTS_PASSED++ ))
    else
        echo "[FAIL] $1: expected '$2', got '$3'"; (( TESTS_FAILED++ ))
    fi
}

assert_rc() {   # assert_rc <name> <expected_rc> <actual_rc>
    assert_eq "$1 (return code)" "$2" "$3"
}

finish() {
    echo "----------------------------------------"
    echo "Passed: ${TESTS_PASSED}  Failed: ${TESTS_FAILED}"
    (( TESTS_FAILED == 0 ))
}
