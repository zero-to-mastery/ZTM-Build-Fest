#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for VDE Schema Validation Functions
# Tests centralized JSON schema validation in vde-core

typeset SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
typeset PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source dependencies
source "$PROJECT_ROOT/lib/vde-shell-compat"
source "$PROJECT_ROOT/lib/vde-constants"
source "$PROJECT_ROOT/lib/vde-core"

# Test configuration
typeset VERBOSE=${VERBOSE:-false}
typeset TESTS_PASSED=0
typeset TESTS_FAILED=0
typeset TEST_TMP_DIR=""

# Test helpers
test_setup() {
    # Create temporary test directory
    TEST_TMP_DIR=$(mktemp -d)
    [[ "$VERBOSE" == "true" ]] && echo "Test temp dir: $TEST_TMP_DIR"

    # Create atomic copies of production data and schema for real-time check
    cp "$PROJECT_ROOT/data/vm-types.json" "$TEST_TMP_DIR/vm-types.json"
    cp "$PROJECT_ROOT/data/vm-types.schema.json" "$TEST_TMP_DIR/vm-types.schema.json"
}

test_teardown() {
    # Clean up temporary test directory
    if [[ -n "$TEST_TMP_DIR" && -d "$TEST_TMP_DIR" ]]; then
        rm -rf "$TEST_TMP_DIR"
    fi
}

test_assert() {
    local condition="$1"
    local message="${2:-Assertion failed}"

    if eval "$condition"; then
        ((TESTS_PASSED++))
        [[ "$VERBOSE" == "true" ]] && echo "  ✓ $message"
        return 0
    else
        ((TESTS_FAILED++))
        echo "  ✗ $message"
        return 1
    fi
}

run_test() {
    local test_name="$1"
    echo "  Running: $test_name"
    $test_name || true
}

# =============================================================================
# Schema Integrity Tests
# =============================================================================

test_check_schema_integrity_valid() {
    local schema_file="$TEST_TMP_DIR/vm-types.schema.json"

    vde_check_schema_integrity "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_SUCCESS ]]" "Valid schema passes integrity check"
}

test_check_schema_integrity_missing() {
    local schema_file="$TEST_TMP_DIR/missing.schema.json"

    vde_check_schema_integrity "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_ERR_NOT_FOUND ]]" "Missing schema returns NOT_FOUND"
}

test_check_schema_integrity_invalid_json() {
    local schema_file="$TEST_TMP_DIR/invalid.schema.json"
    echo "{ invalid json" > "$schema_file"

    vde_check_schema_integrity "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_ERR_INVALID_DATA ]]" "Invalid JSON returns INVALID_DATA"
}

test_check_schema_integrity_missing_fields() {
    local schema_file="$TEST_TMP_DIR/incomplete.schema.json"
    echo '{"title": "Test"}' > "$schema_file"

    vde_check_schema_integrity "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_ERR_INVALID_DATA ]]" "Schema without required fields returns INVALID_DATA"
}

# =============================================================================
# JSON Schema Validation Tests
# =============================================================================

test_validate_json_schema_valid() {
    local json_file="$TEST_TMP_DIR/vm-types.json"
    local schema_file="$TEST_TMP_DIR/vm-types.schema.json"

    vde_validate_json_schema "$json_file" "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_SUCCESS ]]" "Real vm-types.json passes schema validation"
}

test_validate_json_schema_missing_json() {
    local json_file="$TEST_TMP_DIR/missing.json"
    local schema_file="$PROJECT_ROOT/data/vm-types.schema.json"

    vde_validate_json_schema "$json_file" "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_ERR_NOT_FOUND ]]" "Missing JSON returns NOT_FOUND"
}

test_validate_json_schema_missing_schema() {
    local json_file="$PROJECT_ROOT/data/vm-types.json"
    local schema_file="$TEST_TMP_DIR/missing.schema.json"

    vde_validate_json_schema "$json_file" "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_ERR_NOT_FOUND ]]" "Missing schema returns NOT_FOUND"
}

test_validate_json_schema_invalid_data() {
    local json_file="$TEST_TMP_DIR/invalid-vm-types.json"
    local schema_file="$PROJECT_ROOT/data/vm-types.schema.json"

    # Create JSON missing required fields and with invalid name
    cat > "$json_file" <<'EOF'
{
  "version": "1.0",
  "vms": {
    "language": [
      {
        "name": "invalid-name"
      }
    ],
    "service": []
  }
}
EOF

    vde_validate_json_schema "$json_file" "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_ERR_INVALID_DATA ]]" "Invalid data returns INVALID_DATA"
}

test_validate_json_schema_language_vm_with_port() {
    local json_file="$TEST_TMP_DIR/lang-with-port.json"
    local schema_file="$PROJECT_ROOT/data/vm-types.schema.json"

    # Create language VM with invalid ssh_port (out of range)
    cat > "$json_file" <<'EOF'
{
  "version": "1.0",
  "vms": {
    "language": [
      {
        "name": "vde-test-lang",
        "display": "Test Language",
        "ssh_port": 9999
      }
    ],
    "service": []
  }
}
EOF

    vde_validate_json_schema "$json_file" "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_ERR_INVALID_DATA ]]" "Language VM with invalid port returns INVALID_DATA"
}

test_validate_json_schema_service_vm_without_port() {
    local json_file="$TEST_TMP_DIR/service-without-port.json"
    local schema_file="$PROJECT_ROOT/data/vm-types.schema.json"

    # Create service VM without ssh_port (invalid)
    cat > "$json_file" <<'EOF'
{
  "version": "1.0",
  "vms": {
    "language": [],
    "service": [
      {
        "name": "vde-test-service",
        "display": "Test Service"
      }
    ]
  }
}
EOF

    vde_validate_json_schema "$json_file" "$schema_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_ERR_INVALID_DATA ]]" "Service VM without port returns INVALID_DATA"
}

# =============================================================================
# Schema Discovery Tests
# =============================================================================

test_get_schema_for_json_found() {
    local json_file="$PROJECT_ROOT/data/vm-types.json"
    local schema_file

    schema_file=$(vde_get_schema_for_json "$json_file" 2>/dev/null)
    test_assert "[[ -f '$schema_file' ]]" "Schema file found for vm-types.json"
}

test_get_schema_for_json_not_found() {
    local json_file="$TEST_TMP_DIR/no-schema.json"
    echo '{}' > "$json_file"

    vde_get_schema_for_json "$json_file" >/dev/null 2>&1
    test_assert "[[ $? -eq $VDE_ERR_NOT_FOUND ]]" "Missing schema returns NOT_FOUND"
}

# =============================================================================
# Error Code Tests
# =============================================================================

test_error_codes_defined() {
    test_assert "[[ -n '$VDE_ERR_INVALID_DATA' ]]" "VDE_ERR_INVALID_DATA is defined"
    test_assert "[[ -n '$VDE_ERR_CACHE_INVALID' ]]" "VDE_ERR_CACHE_INVALID is defined"
    test_assert "[[ '$VDE_ERR_INVALID_DATA' -eq 10 ]]" "VDE_ERR_INVALID_DATA equals 10"
    test_assert "[[ '$VDE_ERR_CACHE_INVALID' -eq 11 ]]" "VDE_ERR_CACHE_INVALID equals 11"
}

# =============================================================================
# Integration Tests
# =============================================================================

test_vm_common_uses_validation() {
    # Test that vm-common has validation functions available
    source "$PROJECT_ROOT/lib/vm-common" >/dev/null 2>&1

    # Check that validate_vm_types_config function exists
    if typeset -f validate_vm_types_config >/dev/null 2>&1; then
        test_assert "[[ 0 -eq 0 ]]" "vm-common validation functions available"
        return 0
    else
        test_assert "[[ 1 -eq 0 ]]" "vm-common validation functions available"
        return 1
    fi
}

# =============================================================================
# Run Test Suite
# =============================================================================

run_test_suite() {
    echo "========================================"
    echo "VDE Schema Validation Test Suite"
    echo "========================================"
    echo ""

    test_setup

    echo "Schema Integrity Tests:"
    run_test test_check_schema_integrity_valid
    run_test test_check_schema_integrity_missing
    run_test test_check_schema_integrity_invalid_json
    run_test test_check_schema_integrity_missing_fields

    echo ""
    echo "JSON Schema Validation Tests:"
    run_test test_validate_json_schema_valid
    run_test test_validate_json_schema_missing_json
    run_test test_validate_json_schema_missing_schema
    run_test test_validate_json_schema_invalid_data
    run_test test_validate_json_schema_language_vm_with_port
    run_test test_validate_json_schema_service_vm_without_port

    echo ""
    echo "Schema Discovery Tests:"
    run_test test_get_schema_for_json_found
    run_test test_get_schema_for_json_not_found

    echo ""
    echo "Error Code Tests:"
    run_test test_error_codes_defined

    echo ""
    echo "Integration Tests:"
    run_test test_vm_common_uses_validation

    test_teardown

    echo ""
    echo "========================================"
    echo "Test Results"
    echo "========================================"
    echo "Passed: $TESTS_PASSED"
    echo "Failed: $TESTS_FAILED"

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo ""
        echo "✓ All tests passed!"
        return 0
    else
        echo ""
        echo "✗ Some tests failed"
        return 1
    fi
}

# Run the test suite
run_test_suite
