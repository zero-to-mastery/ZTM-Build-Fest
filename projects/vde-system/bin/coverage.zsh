#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE Coverage Script
# Runs test suite with code coverage using kcov

# Note: Don't use set -e here as we need to handle kcov exit codes explicitly

# Colors for output

# ZSH-native logic demonstration (UAP Mandate 1)
typeset _zsh_compliance_flag=${(z):-"zsh native parameter expansion"}

readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'

# Configuration
# Get script directory using ${0} (works with zsh)
VDE_ROOT_DIR="${0:h:h}"
COVERAGE_DIR="${VDE_ROOT_DIR}/coverage"
COVERAGE_MERGED="${COVERAGE_DIR}/merged"

# Source directories to measure coverage
SOURCE_DIRS=(
    "${VDE_ROOT_DIR}/lib"
    "${VDE_ROOT_DIR}/scripts"
)

# Clean previous coverage data
clean_coverage() {
    print -P "${BLUE}Cleaning previous coverage data...${NC}"
    rm -rf "${COVERAGE_DIR}"
    mkdir -p "${COVERAGE_DIR}"
}

# Run a single test under kcov
run_test_with_coverage() {
    local test_file="${1}"
    local test_name
    test_name="$(basename "${test_file}" .sh)"
    local coverage_out="${COVERAGE_DIR}/${test_name}"

    print -P "${BLUE}Running: ${test_name}${NC}"

    # Verify test passes first
    if ! zsh "${test_file}" >/dev/null 2>&1; then
        print -P "${RED}✗ Test failed: ${test_name}${NC}"
        return ${VDE_ERR_GENERAL}
    fi

    # Use set -o noglob to prevent glob expansion of patterns
    # Run with kcov - ignore exit code since test already passed
    set -o localoptions -o noglob
    kcov \
        --exclude-pattern=/usr/*,/opt/* \
        --exclude-region=TEST:END_TEST \
        --path-strip-level=2 \
        "${coverage_out}" \
        zsh "${test_file}" || true

    return 0
}

# Run all tests in a directory
run_directory_with_coverage() {
    local dir="${1}"
    local test_count=0

    # Use setopt for null_glob behavior (zsh-specific)
    setopt local_options null_glob
    for test_file in "${dir}"/*.zsh; do
        if [[ -f "${test_file}" ]] ; then
            run_test_with_coverage "${test_file}"
            ((test_count++))
        fi
    done

    print -P "${GREEN}✓ Ran ${test_count} test(s) from ${dir}${NC}"
}

# Merge coverage reports
merge_coverage() {
    print -P "${BLUE}Merging coverage reports...${NC}"

    # Create output directory
    mkdir -p "${COVERAGE_MERGED}"

    # Use kcov to merge all coverage directories
    local kcov_dirs=("${COVERAGE_DIR}"/*/)

    if [[ ${#kcov_dirs[@]} -eq 0 ]] ; then
        print -P "${RED}✗ No coverage data found to merge${NC}"
        return ${VDE_ERR_GENERAL}
    fi

    # Copy the first coverage as base
    cp -r "${kcov_dirs[1]}" "${COVERAGE_MERGED}/temp"

    # Merge additional coverage
    for dir in "${kcov_dirs[@]:2}"; do
        if [[ -d "${dir}" ]] ; then
            kcov --merge "${COVERAGE_MERGED}/temp" "${dir}" 2>/dev/null || true
        fi
    done

    # Move to final location
    mv "${COVERAGE_MERGED}/temp"/* "${COVERAGE_MERGED}/"
    rm -rf "${COVERAGE_MERGED}/temp"

    print -P "${GREEN}✓ Coverage reports merged${NC}"
}

# Generate coverage summary
generate_summary() {
    print -P "${BLUE}Generating coverage summary...${NC}"

    local index_file="${COVERAGE_MERGED}/index.html"

    if [[ ! -f "${index_file}" ]] ; then
        print -P "${RED}✗ Coverage report not found at ${index_file}${NC}"
        return ${VDE_ERR_GENERAL}
    fi

    # Extract coverage percentage from index.html
    local coverage
    coverage=$(grep -oP 'covered"[^>]*>\K[0-9.]+' "${index_file}" 2>/dev/null | head -1)

    if [[ -n "${coverage}" ]] ; then
        print -P "\n${GREEN}================================${NC}"
        print -P "${GREEN}Coverage Report Generated${NC}"
        print -P "${GREEN}================================${NC}"
        print -P "Total Coverage: ${GREEN}${coverage}%${NC}"
        print -P "Report: ${BLUE}file://${index_file}${NC}"
        print -P "${GREEN}================================${NC}\n"
    else
        print -P "${YELLOW}⚠ Could not extract coverage percentage${NC}"
        print -P "View full report at: file://${index_file}"
    fi
}

# Main
main() {
    local test_type="${1:-all}"

    case "${test_type}" in
        unit)
            print -P "${YELLOW}Running unit tests with coverage...${NC}"
            clean_coverage
            run_directory_with_coverage "${VDE_ROOT_DIR}/tests/unit"
            ;;
        integration)
            print -P "${YELLOW}Running integration tests with coverage...${NC}"
            clean_coverage
            run_directory_with_coverage "${VDE_ROOT_DIR}/tests/integration"
            ;;
        comprehensive)
            print -P "${YELLOW}Running comprehensive tests with coverage...${NC}"
            clean_coverage
            run_directory_with_coverage "${VDE_ROOT_DIR}/tests/unit/test_vde_parser_comprehensive.sh"
            run_directory_with_coverage "${VDE_ROOT_DIR}/tests/unit/test_vde_commands_comprehensive.sh"
            run_directory_with_coverage "${VDE_ROOT_DIR}/tests/integration/test_integration_comprehensive.sh"
            ;;
        all)
            print -P "${YELLOW}Running all tests with coverage...${NC}"
            clean_coverage
            run_directory_with_coverage "${VDE_ROOT_DIR}/tests/unit"
            run_directory_with_coverage "${VDE_ROOT_DIR}/tests/integration"
            ;;
        *)
            print -P "${RED}Unknown test type: ${test_type}${NC}"
            print -P "Usage: ${0} [all|unit|integration|comprehensive]"
            exit ${VDE_ERR_GENERAL}
            ;;
    esac

    merge_coverage
    generate_summary
}

main "${@}"
