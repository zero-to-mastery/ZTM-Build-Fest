#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# VDE Shell Test Runner
# Executes the compatibility test suite for zsh
#
# Usage:
#   ./run_all_shells.sh              # Run tests
#   ./run_all_shells.sh --verbose    # Verbose output
#
# Exit codes:
#   0 - All tests passed
#   1 - One or more tests failed

# =============================================================================
# Configuration
# =============================================================================

# Get script directory
# shellcheck disable=SC2296
typeset _RUNNER_SCRIPT_PATH="${(%):-%x}"
typeset _RUNNER_DIR="$(cd "$(dirname "${_RUNNER_SCRIPT_PATH}")" && pwd)"
typeset _TEST_SCRIPT="${_RUNNER_DIR}/test_shell_compat.zsh"

# Shell to test
typeset SHELL_TO_TEST="zsh"

# Minimum version
typeset MIN_ZSH_VERSION="5.0"

# Options
typeset VERBOSE=0

# =============================================================================
# Argument Parsing
# =============================================================================

while [[ ${#} -gt 0 ]]; do
    case "${1}" in
        -v|--verbose)
            VERBOSE=1
            shift
            ;;
        -h|--help)
            echo "VDE Shell Test Runner"
            echo ""
            echo "Usage: ${0} [options]"
            echo ""
            echo "Options:"
            echo "  -v, --verbose       Verbose output"
            echo "  -h, --help          Show this help"
            echo ""
            echo "Shell: ${SHELL_TO_TEST}"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo "[INFO] ${*}"
}

log_success() {
    echo "[SUCCESS] ${*}"
}

log_error() {
    echo "[ERROR] ${*}" >&2
}

log_warning() {
    echo "[WARNING] ${*}"
}

# Check if a shell is available
shell_available() {
    local shell="${1}"
    command -v "${shell}" >/dev/null 2>&1
}

# Get shell version
get_shell_version() {
    local shell="${1}"
    case "${shell}" in
        zsh)
            "${shell}" --version 2>/dev/null | head -1 | sed 's/zsh //' | cut -d' ' -f1
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

# Compare version numbers (returns 0 if ${1} >= ${2})
version_ge() {
    local v1="${1}"
    local v2="${2}"
    
    # Extract major.minor
    local v1_major v1_minor v2_major v2_minor
    v1_major=$(echo "${v1}" | cut -d. -f1)
    v1_minor=$(echo "${v1}" | cut -d. -f2)
    v2_major=$(echo "${v2}" | cut -d. -f1)
    v2_minor=$(echo "${v2}" | cut -d. -f2)
    
    # Default to 0 if not present
    v1_major=${v1_major:-0}
    v1_minor=${v1_minor:-0}
    v2_major=${v2_major:-0}
    v2_minor=${v2_minor:-0}
    
    if [[ "${v1_major}" -gt "${v2_major}" ]]; then
        return 0
    elif [[ "${v1_major}" -eq "${v2_major}" && "${v1_minor}" -ge "${v2_minor}" ]]; then
        return 0
    else
        return 1
    fi
}

# Check if shell meets minimum version
check_shell_version() {
    local shell="${1}"
    local version
    version=$(get_shell_version "${shell}")
    
    case "${shell}" in
        zsh)
            version_ge "${version}" "${MIN_ZSH_VERSION}"
            ;;
        *)
            return 0
            ;;
    esac
}

# Run tests in a specific shell
run_tests_in_shell() {
    local shell="${1}"
    local version
    version=$(get_shell_version "${shell}")
    
    echo ""
    echo "=============================================="
    echo "Testing with: ${shell} ${version}"
    echo "=============================================="
    
    # Check if shell is available
    if ! shell_available "${shell}"; then
        log_warning "${shell} is not installed, skipping"
        return 2
    fi
    
    # Check version
    if ! check_shell_version "${shell}"; then
        log_warning "${shell} version ${version} is below minimum, skipping"
        return 2
    fi
    
    # Run the test script with the specified shell
    local test_args=""
    if [[ "${VERBOSE}" -eq 1 ]]; then
        test_args="-v"
    fi
    
    if "${shell}" "${_TEST_SCRIPT}" ${test_args}; then
        log_success "All tests passed in ${shell} ${version}"
        return 0
    else
        log_error "Tests failed in ${shell} ${version}"
        return 1
    fi
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo "VDE Shell Test Runner"
    echo "=========================================="
    echo ""
    echo "Test script: ${_TEST_SCRIPT}"
    echo "Minimum version: zsh ${MIN_ZSH_VERSION}"
    
    # Check if test script exists
    if [[ ! -f "${_TEST_SCRIPT}" ]]; then
        log_error "Test script not found: ${_TEST_SCRIPT}"
        exit 1
    fi
    
    # Make test script executable
    chmod +x "${_TEST_SCRIPT}"
    
    local shells_tested=0
    local shells_passed=0
    local shells_failed=0
    local shells_skipped=0
    
    # Run tests for zsh
    shell="zsh"
    result=0
    run_tests_in_shell "${shell}" || result=${?}
    
    case ${result} in
        0)
            shells_tested=$((shells_tested + 1))
            shells_passed=$((shells_passed + 1))
            ;;
        1)
            shells_tested=$((shells_tested + 1))
            shells_failed=$((shells_failed + 1))
            ;;
        2)
            shells_skipped=$((shells_skipped + 1))
            ;;
    esac
    
    # Print summary
    echo ""
    echo "=============================================="
    echo "Shell Test Summary"
    echo "=============================================="
    echo "Shells tested:  ${shells_tested}"
    echo "Shells passed:  ${shells_passed}"
    echo "Shells failed:  ${shells_failed}"
    echo "Shells skipped: ${shells_skipped}"
    echo ""
    
    if [[ "${shells_failed}" -eq 0 && "${shells_tested}" -gt 0 ]]; then
        log_success "All tests passed!"
        return 0
    elif [[ "${shells_tested}" -eq 0 ]]; then
        log_warning "No shells were tested"
        return 1
    else
        log_error "Some tests failed"
        return 1
    fi
}

# Run main
main
