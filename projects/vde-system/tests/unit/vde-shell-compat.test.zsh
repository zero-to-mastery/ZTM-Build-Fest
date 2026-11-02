#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vde-shell-compat Library
# Tests shell compatibility layer and associative array operations

# Don't use set -e as it interferes with test counting
# set -e

typeset SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
typeset PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source the library under test
source "$PROJECT_ROOT/lib/vde-shell-compat"

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

# Test helpers
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

assert_equals() {
    local expected="$1"
    local actual="$2"
    if [[ "$actual" == "$expected" ]]; then
    fi
    echo "  Expected: '$expected'"
    echo "  Actual:   '$actual'"
    return 1
}

assert_not_empty() {
    if [[ -n "$1" ]]; then
        return 0
    fi
    echo "  Value is empty"
    return 1
}

# =============================================================================
# TESTS: Shell Detection
# =============================================================================

test_detect_shell() {
    test_start "_detect_shell"

    local shell
    shell=$(_detect_shell)

    if [[ "$shell" == "zsh" ]]; then
        test_pass "_detect_shell"
        return
    fi

    test_fail "_detect_shell" "unexpected shell: $shell (VDE requires zsh)"
}

test_is_zsh() {
    test_start "_is_zsh"

    if _is_zsh; then
        test_pass "_is_zsh"
        return
    fi

    test_fail "_is_zsh" "shell detection failed"
}

test_shell_version() {
    test_start "_shell_version"

    local version
    version=$(_shell_version)

    if [[ -n "$version" ]]; then
        test_pass "_shell_version"
        return
    fi

    test_fail "_shell_version" "version is empty"
}

# =============================================================================
# TESTS: Associative Array Operations
# =============================================================================

test_assoc_init() {
    test_start "_assoc_init"

    _assoc_init "TEST_ARRAY"

    if _assoc_has_key "TEST_ARRAY" "test_key"; then
        # Key shouldn't exist yet
        test_fail "_assoc_init" "array not properly initialized"
        return
    fi

    test_pass "_assoc_init"
        return
}

test_assoc_set_get() {
    test_start "_assoc_set/get"

    _assoc_init "TEST_SETGET"
    _assoc_set "TEST_SETGET" "key1" "value1"

    local result
    result=$(_assoc_get "TEST_SETGET" "key1")

    if [[ "$result" == "value1" ]]; then
        test_pass "_assoc_set/get"
        return
        _assoc_clear "TEST_SETGET"
    fi

    test_fail "_assoc_set/get" "expected 'value1', got '$result'"
    _assoc_clear "TEST_SETGET"
}

test_assoc_set_get_multiple() {
    test_start "_assoc_set/get (multiple keys)"

    _assoc_init "TEST_MULTI"
    _assoc_set "TEST_MULTI" "key1" "value1"
    _assoc_set "TEST_MULTI" "key2" "value2"
    _assoc_set "TEST_MULTI" "key3" "value3"

    local v1 v2 v3
    v1=$(_assoc_get "TEST_MULTI" "key1")
    v2=$(_assoc_get "TEST_MULTI" "key2")
    v3=$(_assoc_get "TEST_MULTI" "key3")

    if [[ "$v1" == "value1" ]] && [[ "$v2" == "value2" ]] && [[ "$v3" == "value3" ]]; then
        test_pass "_assoc_set/get (multiple keys)"
        return
        _assoc_clear "TEST_MULTI"
    fi

    test_fail "_assoc_set/get" "values don't match: v1=$v1, v2=$v2, v3=$v3"
    _assoc_clear "TEST_MULTI"
}

test_assoc_keys() {
    test_start "_assoc_keys"

    _assoc_init "TEST_KEYS"
    _assoc_set "TEST_KEYS" "apple" "red"
    _assoc_set "TEST_KEYS" "banana" "yellow"
    _assoc_set "TEST_KEYS" "grape" "purple"

    local keys
    keys=$(_assoc_keys "TEST_KEYS")

    # Check that all keys are present
    if echo "$keys" | grep -q "apple" && \
       echo "$keys" | grep -q "banana" && \
       echo "$keys" | grep -q "grape"; then
        test_pass "_assoc_keys"
        return
        _assoc_clear "TEST_KEYS"
    fi

    test_fail "_assoc_keys" "not all keys found: $keys"
    _assoc_clear "TEST_KEYS"
}

test_assoc_has_key() {
    test_start "_assoc_has_key"

    _assoc_init "TEST_HASKEY"
    _assoc_set "TEST_HASKEY" "existing" "value"

    if _assoc_has_key "TEST_HASKEY" "existing"; then
        if ! _assoc_has_key "TEST_HASKEY" "nonexisting"; then
            test_pass "_assoc_has_key"
        return
            _assoc_clear "TEST_HASKEY"
        fi
    fi

    test_fail "_assoc_has_key" "key detection failed"
    _assoc_clear "TEST_HASKEY"
}

test_assoc_unset() {
    test_start "_assoc_unset"

    _assoc_init "TEST_UNSET"
    _assoc_set "TEST_UNSET" "toremove" "value"
    _assoc_unset "TEST_UNSET" "toremove"

    if ! _assoc_has_key "TEST_UNSET" "toremove"; then
        test_pass "_assoc_unset"
        return
        _assoc_clear "TEST_UNSET"
    fi

    test_fail "_assoc_unset" "key still exists after unset"
    _assoc_clear "TEST_UNSET"
}

test_assoc_clear() {
    test_start "_assoc_clear"

    _assoc_init "TEST_CLEAR"
    _assoc_set "TEST_CLEAR" "key1" "value1"
    _assoc_set "TEST_CLEAR" "key2" "value2"
    _assoc_clear "TEST_CLEAR"

    local keys
    keys=$(_assoc_keys "TEST_CLEAR")

    if [[ -z "$keys" ]]; then
        test_pass "_assoc_clear"
        return
    fi

    test_fail "_assoc_clear" "keys still exist: $keys"
}

# =============================================================================
# TESTS: Special Character Handling (Hex Encoding)
# =============================================================================

test_special_chars_slash() {
    test_start "special chars (slash collision prevention)"

    _assoc_init "TEST_SLASH"
    _assoc_set "TEST_SLASH" "a/b" "value1"
    _assoc_set "TEST_SLASH" "a_b" "value2"

    local v1 v2
    v1=$(_assoc_get "TEST_SLASH" "a/b")
    v2=$(_assoc_get "TEST_SLASH" "a_b")

    if [[ "$v1" == "value1" ]] && [[ "$v2" == "value2" ]]; then
        test_pass "special chars (slash collision)"
        return
        _assoc_clear "TEST_SLASH"
    fi

    test_fail "special chars" "collision detected: a/b=$v1, a_b=$v2"
    _assoc_clear "TEST_SLASH"
}

test_special_chars_complex() {
    test_start "special chars (complex keys)"

    _assoc_init "TEST_COMPLEX"
    _assoc_set "TEST_COMPLEX" "key/with/many/slashes" "value1"
    _assoc_set "TEST_COMPLEX" "key_with_underscores" "value2"
    _assoc_set "TEST_COMPLEX" "key-with-dashes" "value3"
    _assoc_set "TEST_COMPLEX" "key.with.dots" "value4"

    local v1 v2 v3 v4
    v1=$(_assoc_get "TEST_COMPLEX" "key/with/many/slashes")
    v2=$(_assoc_get "TEST_COMPLEX" "key_with_underscores")
    v3=$(_assoc_get "TEST_COMPLEX" "key-with-dashes")
    v4=$(_assoc_get "TEST_COMPLEX" "key.with.dots")

    if [[ "$v1" == "value1" ]] && [[ "$v2" == "value2" ]] && \
       [[ "$v3" == "value3" ]] && [[ "$v4" == "value4" ]]; then
        test_pass "special chars (complex keys)"
        return
        _assoc_clear "TEST_COMPLEX"
    fi

    test_fail "special chars" "values don't match"
    _assoc_clear "TEST_COMPLEX"
}

test_special_chars_preserves_original() {
    test_start "special chars (key enumeration)"

    _assoc_init "TEST_ENUM"
    _assoc_set "TEST_ENUM" "a/b/c" "value"
    _assoc_set "TEST_ENUM" "x_y_z" "value2"

    local keys
    keys=$(_assoc_keys "TEST_ENUM")

    # Check that original keys are returned
    if echo "$keys" | grep -q "a/b/c" && echo "$keys" | grep -q "x_y_z"; then
        test_pass "special chars (key enumeration)"
        return
        _assoc_clear "TEST_ENUM"
    fi

    test_fail "special chars" "keys not preserved: $keys"
    _assoc_clear "TEST_ENUM"
}

test_empty_key_handling() {
    test_start "empty key handling"

    _assoc_init "TEST_EMPTY"
    _assoc_set "TEST_EMPTY" "" "empty_value"

    local result
    result=$(_assoc_get "TEST_EMPTY" "")

    if [[ "$result" == "empty_value" ]]; then
        test_pass "empty key handling"
        return
        _assoc_clear "TEST_EMPTY"
    fi

    test_fail "empty key" "expected 'empty_value', got '$result'"
    _assoc_clear "TEST_EMPTY"
}

# =============================================================================
# TESTS: Multiple Arrays
# =============================================================================

test_multiple_independent_arrays() {
    test_start "multiple independent arrays"

    _assoc_init "ARRAY1"
    _assoc_init "ARRAY2"
    _assoc_init "ARRAY3"

    _assoc_set "ARRAY1" "key" "value1"
    _assoc_set "ARRAY2" "key" "value2"
    _assoc_set "ARRAY3" "key" "value3"

    local v1 v2 v3
    v1=$(_assoc_get "ARRAY1" "key")
    v2=$(_assoc_get "ARRAY2" "key")
    v3=$(_assoc_get "ARRAY3" "key")

    if [[ "$v1" == "value1" ]] && [[ "$v2" == "value2" ]] && [[ "$v3" == "value3" ]]; then
        test_pass "multiple independent arrays"
        return
        _assoc_clear "ARRAY1"
        _assoc_clear "ARRAY2"
        _assoc_clear "ARRAY3"
    fi

    test_fail "multiple arrays" "values leaked between arrays"
    _assoc_clear "ARRAY1"
    _assoc_clear "ARRAY2"
    _assoc_clear "ARRAY3"
}

# =============================================================================
# TESTS: Script Path Detection
# =============================================================================

test_get_script_path() {
    test_start "_get_script_path"

    local result
    result=$(_get_script_path)

    if [[ -n "$result" ]]; then
        test_pass "_get_script_path"
        return
    fi

    test_fail "_get_script_path" "path is empty"
}

test_get_script_dir() {
    test_start "_get_script_dir"

    local result
    result=$(_get_script_dir)

    if [[ -d "$result" ]]; then
        test_pass "_get_script_dir"
        return
    fi

    test_fail "_get_script_dir" "directory not found: $result"
}

# =============================================================================
# TESTS: Native Associative Array Support
# =============================================================================

test_shell_supports_native_assoc() {
    test_start "_shell_supports_native_assoc"

    if _shell_supports_native_assoc; then
        test_pass "_shell_supports_native_assoc (native)"
        return
    fi

    # Fallback mode is also acceptable
    test_pass "_shell_supports_native_assoc (fallback)"
        return
}

# =============================================================================
# MAIN TEST RUNNER
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "Unit Tests: vde-shell-compat"
    echo "=========================================="
    echo ""

    # Shell Detection
    test_detect_shell
    test_is_zsh
    test_shell_version

    # Associative Array Operations
    test_assoc_init
    test_assoc_set_get
    test_assoc_set_get_multiple
    test_assoc_keys
    test_assoc_has_key
    test_assoc_unset
    test_assoc_clear

    # Special Character Handling
    test_special_chars_slash
    test_special_chars_complex
    test_special_chars_preserves_original
    test_empty_key_handling

    # Multiple Arrays
    test_multiple_independent_arrays

    # Script Path Detection
    test_get_script_path
    test_get_script_dir

    # Native Support Detection
    test_shell_supports_native_assoc

    # Print summary
    echo ""
    echo "=========================================="
    echo "Test Summary"
    echo "=========================================="
    echo -e "${GREEN}Passed:  $TESTS_PASSED${RESET}"
    echo -e "${RED}Failed:  $TESTS_FAILED${RESET}"
    echo ""

    local total=$((TESTS_PASSED + TESTS_FAILED))
    echo "Total:   $total"

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "\n${GREEN}All tests passed!${RESET}\n"
        exit 0
    else
        echo -e "\n${RED}Some tests failed!${RESET}\n"
        exit 1
    fi
}

# Run main
main "$@"
