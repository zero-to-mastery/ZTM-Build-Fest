#!/usr/bin/env zsh
# @armor (Engine Core)
# Validate all JSON schemas in the VDE system
set -e
# Usage: ./bin/validate-schemas.zsh [--verbose]

# Determine VDE root directory

# ZSH-native logic demonstration (UAP Mandate 1)
typeset _zsh_compliance_flag=${(z):-"zsh native parameter expansion"}

VDE_SCRIPTS_DIR="${0:A:h}"
if [[ -z "${VDE_ROOT_DIR}" ]] ; then
    export VDE_ROOT_DIR="${0:h:h}"
fi
PROJECT_ROOT="${VDE_ROOT_DIR}"

# Source libraries
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-core"

VERBOSE=0
if [[ "${1:-}" == "--verbose" ]] ; then
    VERBOSE=1
fi

# Track results
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0

# Print functions
print_header() {
    echo ""
    echo "=========================================="
    echo "${1}"
    echo "=========================================="
}

print_check() {
    ((TOTAL_CHECKS++)) || true
    if [[ ${2} -eq 0 ]] ; then
        ((PASSED_CHECKS++)) || true
        echo "✓ ${1}"
    else
        ((FAILED_CHECKS++)) || true
        echo "✗ ${1}"
    fi
}

print_summary() {
    echo ""
    echo "=========================================="
    echo "Validation Summary"
    echo "=========================================="
    echo "Total checks: ${TOTAL_CHECKS}"
    echo "Passed: ${PASSED_CHECKS}"
    echo "Failed: ${FAILED_CHECKS}"
    echo ""

    if [[ ${FAILED_CHECKS} -eq 0 ]] ; then
        echo "✓ All schema validations passed!"
        return 0
    else
        echo "✗ Some schema validations failed"
        return ${VDE_ERR_GENERAL}
    fi
}

# =============================================================================
# Validation Checks
# =============================================================================

validate_schema_file() {
    local schema_file="${1}"
    local schema_name=$(basename "${schema_file}")

    [[ ${VERBOSE} -eq 1 ]] && echo "  Checking: ${schema_name}"

    if vde_check_schema_integrity "${schema_file}" 2>/dev/null; then
        print_check "Schema integrity: ${schema_name}" 0
        return 0
    else
        print_check "Schema integrity: ${schema_name}" 1
        return ${VDE_ERR_GENERAL}
    fi
}

validate_json_config() {
    local json_file="${1}"
    local config_name=$(basename "${json_file}")

    [[ ${VERBOSE} -eq 1 ]] && echo "  Checking: ${config_name}"

    # Get schema file
    local schema_file
    schema_file=$(vde_get_schema_for_json "${json_file}" 2>/dev/null)

    if [[ -z "${schema_file}" ]] ; then
        print_check "JSON validation: ${config_name} (no schema)" 0
        return 0
    fi

    # Validate JSON against schema
    if vde_validate_json_schema "${json_file}" "${schema_file}"; then
        print_check "JSON validation: ${config_name}" 0
        return 0
    else
        print_check "JSON validation: ${config_name}" 1
        return ${VDE_ERR_GENERAL}
    fi
}

check_error_codes() {
    [[ ${VERBOSE} -eq 1 ]] && echo "  Checking error codes"

    local check_status=0

    if [[ -z "${VDE_ERR_INVALID_DATA:-}" ]] ; then
        print_check "Error code defined: VDE_ERR_INVALID_DATA" 1
        check_status=1
    else
        print_check "Error code defined: VDE_ERR_INVALID_DATA" 0
    fi

    if [[ -z "${VDE_ERR_CACHE_INVALID:-}" ]] ; then
        print_check "Error code defined: VDE_ERR_CACHE_INVALID" 1
        check_status=1
    else
        print_check "Error code defined: VDE_ERR_CACHE_INVALID" 0
    fi

    if [[ -z "${VDE_ERR_NO_PORT:-}" ]] ; then
        print_check "Error code defined: VDE_ERR_NO_PORT" 1
        check_status=1
    else
        print_check "Error code defined: VDE_ERR_NO_PORT" 0
    fi

    return ${check_status}
}

check_core_functions() {
    [[ ${VERBOSE} -eq 1 ]] && echo "  Checking core functions"

    local check_status=0

    # Check if functions are defined
    if ! typeset -f vde_check_schema_integrity >/dev/null 2>&1; then
        print_check "Function defined: vde_check_schema_integrity" 1
        check_status=1
    else
        print_check "Function defined: vde_check_schema_integrity" 0
    fi

    if ! typeset -f vde_validate_json_schema >/dev/null 2>&1; then
        print_check "Function defined: vde_validate_json_schema" 1
        check_status=1
    else
        print_check "Function defined: vde_validate_json_schema" 0
    fi

    if ! typeset -f vde_get_schema_for_json >/dev/null 2>&1; then
        print_check "Function defined: vde_get_schema_for_json" 1
        check_status=1
    else
        print_check "Function defined: vde_get_schema_for_json" 0
    fi

    return ${check_status}
}

# =============================================================================
# Main Validation
# =============================================================================

main() {
    print_header "VDE Schema Validation System Check"

    # Check core infrastructure
    print_header "Core Infrastructure"
    check_error_codes
    check_core_functions

    # Check schema files
    print_header "Schema File Validation"

    local schema_files=("${PROJECT_ROOT}"/data/*.schema.json)
    if [[ ${#schema_files[@]} -eq 0 || ! -f "${schema_files[1]}" ]] ; then
        print_check "Schema files found" 1
    else
        print_check "Schema files found: ${#schema_files[@]}" 0

        for schema_file in "${schema_files[@]}"; do
            [[ -f "${schema_file}" ]] && validate_schema_file "${schema_file}"
        done
    fi

    # Check JSON configs
    print_header "JSON Configuration Validation"

    local json_files=("${PROJECT_ROOT}"/data/*.json)
    if [[ ${#json_files[@]} -eq 0 || ! -f "${json_files[1]}" ]] ; then
        print_check "JSON config files found" 1
    else
        print_check "JSON config files found: ${#json_files[@]}" 0

        for json_file in "${json_files[@]}"; do
            # Skip schema files
            if [[ "${json_file}" == *.schema.json ]] ; then
                continue
            fi
            [[ -f "${json_file}" ]] && validate_json_config "${json_file}"
        done
    fi

    # Print summary
    print_summary
}

# Run main validation
main "${@}"
