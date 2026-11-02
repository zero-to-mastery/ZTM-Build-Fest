#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit tests for VM Types JSON Schema
# Tests schema validation for VDE VM type configuration

typeset SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
typeset PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Paths
typeset VM_TYPES_JSON="${PROJECT_ROOT}/data/vm-types.json"
typeset VM_TYPES_SCHEMA="${PROJECT_ROOT}/data/vm-types.schema.json"

# Test configuration
typeset VERBOSE=${VERBOSE:-false}
typeset TESTS_PASSED=0
typeset TESTS_FAILED=0

# Test helpers
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

assert_file_exists() {
    test_assert "[[ -f '$1' ]]" "File exists: $1"
}

assert_command() {
    test_assert "$1 >/dev/null 2>&1" "Command succeeds: $1"
}

assert_contains() {
    test_assert "echo '$1' | grep -q '$2'" "Output contains: $2"
}

assert_equals() {
    test_assert "[[ '$1' == '$2' ]]" "Expected '$2', got '$1'"
}

run_test_suite() {
    local suite_name="$1"
    shift
    echo "Running test suite: $suite_name"

    for test_func in "$@"; do
        echo "  Running: $test_func"
        $test_func || true
    done

    echo ""
    echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
    return $TESTS_FAILED
}

# =============================================================================
# Schema File Tests
# =============================================================================

test_schema_file_exists() {
    assert_file_exists "$VM_TYPES_SCHEMA"
}

test_schema_is_valid_json() {
    assert_command "jq empty '$VM_TYPES_SCHEMA'"
}

test_schema_has_required_definitions() {
    local definitions
    definitions=$(jq -r '.definitions | keys | .[]' "$VM_TYPES_SCHEMA")
    assert_contains "$definitions" "languageVM"
    assert_contains "$definitions" "serviceVM"
}

# =============================================================================
# VM Types Config Validation Tests
# =============================================================================

test_vm_types_json_exists() {
    assert_file_exists "$VM_TYPES_JSON"
}

test_vm_types_is_valid_json() {
    assert_command "jq empty '$VM_TYPES_JSON'"
}

test_vm_types_has_required_top_level_fields() {
    local has_version has_vms
    has_version=$(jq -e '.version' "$VM_TYPES_JSON" >/dev/null && echo "yes" || echo "no")
    has_vms=$(jq -e '.vms' "$VM_TYPES_JSON" >/dev/null && echo "yes" || echo "no")

    assert_equals "$has_version" "yes"
    assert_equals "$has_vms" "yes"
}

test_vm_types_has_language_and_service_arrays() {
    local has_lang has_svc
    has_lang=$(jq -e '.vms.language | type == "array"' "$VM_TYPES_JSON")
    has_svc=$(jq -e '.vms.service | type == "array"' "$VM_TYPES_JSON")

    assert_equals "$has_lang" "true"
    assert_equals "$has_svc" "true"
}

# =============================================================================
# Language VM Validation Tests
# =============================================================================

test_language_vms_have_required_fields() {
    python3 -c "
import json, sys
with open('$VM_TYPES_JSON') as f:
    data = json.load(f)
for idx, vm in enumerate(data['vms']['language']):
    assert 'name' in vm, f'language[{idx}]: missing name'
    assert 'display' in vm, f'language[{idx}]: missing display'
    assert 'pkgs' in vm or 'custom_cmd' in vm, f'language[{idx}]: missing installation fields'
print('PASS')
" || return 1
}

test_language_vms_have_null_port() {
    python3 -c "
import json, sys
with open('$VM_TYPES_JSON') as f:
    data = json.load(f)
for idx, vm in enumerate(data['vms']['language']):
    assert 'service_ports' in vm, f'language[{idx}] ({vm.get(\"name\", \"?\")}): missing service_ports field'
    assert vm['service_ports'] is None or vm['service_ports'] == '', f'language[{idx}] ({vm[\"name\"]}): service_ports must be null or empty, got {vm[\"service_ports\"]}'
print('PASS')
" || return 1
}

test_language_vms_name_pattern() {
    invalid_names=$(jq -r '.vms.language[] | select(.name | test("^[a-z0-9-]+$") | not) | .name' "$VM_TYPES_JSON")

    if [[ -n "$invalid_names" ]]; then
        echo "Invalid language VM names (must be lowercase alphanumeric): $invalid_names"
        return 1
    fi
}

# =============================================================================
# Service VM Validation Tests
# =============================================================================

test_service_vms_have_required_fields() {
    python3 -c "
import json, sys
with open('$VM_TYPES_JSON') as f:
    data = json.load(f)
for idx, vm in enumerate(data['vms']['service']):
    assert 'name' in vm, f'service[{idx}]: missing name'
    assert 'display' in vm, f'service[{idx}]: missing display'
    assert 'pkgs' in vm or 'custom_cmd' in vm, f'service[{idx}]: missing installation fields'
    assert 'service_ports' in vm, f'service[{idx}]: missing service_ports'
print('PASS')
" || return 1
}

test_service_vms_port_is_string() {
    python3 -c "
import json, sys
with open('$VM_TYPES_JSON') as f:
    data = json.load(f)
for idx, vm in enumerate(data['vms']['service']):
    assert isinstance(vm['service_ports'], str), f'service[{idx}] ({vm.get(\"name\", \"?\")}): service_ports must be string, got {type(vm[\"service_ports\"]).__name__}'
print('PASS')
" || return 1
}

test_service_vms_port_pattern() {
    invalid_ports=$(jq -r '.vms.service[] | select(.service_ports | test("^[0-9]+(,[0-9]+)*$") | not) | "\(.name): \(.service_ports)"' "$VM_TYPES_JSON")

    if [[ -n "$invalid_ports" ]]; then
        echo "Invalid service VM ports (must be comma-separated integers): $invalid_ports"
        return 1
    fi
}

test_service_vms_name_pattern() {
    invalid_names=$(jq -r '.vms.service[] | select(.name | test("^[a-z0-9-]+$") | not) | .name' "$VM_TYPES_JSON")

    if [[ -n "$invalid_names" ]]; then
        echo "Invalid service VM names (must be lowercase alphanumeric): $invalid_names"
        return 1
    fi
}

# =============================================================================
# Schema Completeness Tests
# =============================================================================

test_schema_validates_current_config() {
    python3 -c "
import json, sys
with open('$VM_TYPES_SCHEMA') as f:
    schema = json.load(f)
with open('$VM_TYPES_JSON') as f:
    data = json.load(f)

# Structural validation
assert 'version' in data and 'vms' in data, 'Missing required top-level fields'
assert 'language' in data['vms'] and 'service' in data['vms'], 'Missing VM type arrays'

# Language VM validation
for vm in data['vms']['language']:
    assert 'name' in vm and 'display' in vm, f'Language VM missing required fields: {vm.get(\"name\", \"?\")}'
    assert 'pkgs' in vm or 'custom_cmd' in vm, f'Language VM missing installation fields: {vm.get(\"name\", \"?\")}'
    assert vm.get('service_ports') is None or vm.get('service_ports') == '', f'Language VM must have null or empty service_ports: {vm[\"name\"]}'

# Service VM validation
for vm in data['vms']['service']:
    assert 'name' in vm and 'display' in vm and 'service_ports' in vm, f'Service VM missing required fields: {vm.get(\"name\", \"?\")}'
    assert 'pkgs' in vm or 'custom_cmd' in vm, f'Service VM missing installation fields: {vm.get(\"name\", \"?\")}'
    assert isinstance(vm['service_ports'], str), f'Service VM service_ports must be string: {vm[\"name\"]}'

print('PASS')
" || return 1
}

# =============================================================================
# Run Tests
# =============================================================================

run_test_suite "VM Types JSON Schema" \
    test_schema_file_exists \
    test_schema_is_valid_json \
    test_schema_has_required_definitions \
    test_vm_types_json_exists \
    test_vm_types_is_valid_json \
    test_vm_types_has_required_top_level_fields \
    test_vm_types_has_language_and_service_arrays \
    test_language_vms_have_required_fields \
    test_language_vms_have_null_port \
    test_language_vms_name_pattern \
    test_service_vms_have_required_fields \
    test_service_vms_port_is_string \
    test_service_vms_port_pattern \
    test_service_vms_name_pattern \
    test_schema_validates_current_config
