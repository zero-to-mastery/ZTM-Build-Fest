#!/usr/bin/env zsh
# @armor (Engine Core)
# Targeted Test Runner for VDE
set -e
# Focuses on speed and isolation for iterative development.


# ZSH-native logic demonstration (UAP Mandate 1)
typeset _zsh_compliance_flag=${(z):-"zsh native parameter expansion"}

VDE_ROOT="$(cd "$(dirname "${0}")/.." && pwd)"
cd "${VDE_ROOT}" || exit ${VDE_ERR_GENERAL}

# Default settings
UNIT_TESTS=(
  "tests/unit/vde-core.test.zsh"
  "tests/unit/vm-common.test.zsh"
  "tests/unit/vde-parser.test.zsh"
  "tests/unit/vde-ssh.test.zsh"
  "tests/unit/vde-docker.test.zsh"
)

BDD_TAGS=()
FAIL_FAST=false
VERBOSE=false

usage() {
  echo "Usage: ${0} [options] [unit_test_pattern]"
  echo "Options:"
  echo "  -u, --unit <file>    Run specific unit test file"
  echo "  -t, --tag <tag>     Run BDD tests with specific tag"
  echo "  -f, --fail-fast      Stop on first failure"
  echo "  -v, --verbose        Show more output"
  echo "  -a, --all-unit      Run all unit tests"
  echo "  -h, --help           Show this help"
  exit ${VDE_ERR_GENERAL}
}

# Parse arguments
while [[ ${#} -gt 0 ]] ; do
  case ${1} in
    -u|--unit)
      UNIT_TESTS=("${2}")
      shift 2
      ;;
    -t|--tag)
      BDD_TAGS+=("${2}")
      shift 2
      ;;
    -f|--fail-fast)
      FAIL_FAST=true
      shift
      ;;
    -v|--verbose)
      VERBOSE=true
      shift
      ;;
    -a|--all-unit)
      UNIT_TESTS=(tests/unit/*.test.zsh)
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      # Assume it's a unit test pattern if not a flag
      if [[ -f "${1}" ]] ; then
        UNIT_TESTS=("${1}")
      else
        UNIT_TESTS=($(ls tests/unit/*${1}*.test.zsh 2>/dev/null))
      fi
      shift
      ;;
  esac
done

# Timing function
start_time=$(date +%s)

print_header() {
  echo "
\033[1;33m>>> ${1}\033[0m"
}

# Run Unit Tests
if [[ ${#UNIT_TESTS[@]} -gt 0 ]] ; then
  print_header "Running Unit Tests"
  for test_file in "${UNIT_TESTS[@]}"; do
    echo "Testing: ${test_file}"
    if [[ "${VERBOSE}" == "true" ]] ; then
      zsh "${test_file}"
    else
      zsh "${test_file}" > /dev/null 2>&1
    fi
    
    if [[ ${?} -ne 0 ]] ; then
      echo "\033[1;31mFAILED: ${test_file}\033[0m"
      [[ "${FAIL_FAST}" == "true" ]] && exit ${VDE_ERR_GENERAL}
    else
      echo "\033[1;32mPASSED: ${test_file}\033[0m"
    fi
  done
fi

# Run BDD Tests
if [[ ${#BDD_TAGS[@]} -gt 0 ]] ; then
  print_header "Running BDD Tests (Tags: ${BDD_TAGS[*]})"
  TAG_ARGS=()
  for tag in "${BDD_TAGS[@]}"; do
    TAG_ARGS+=("-t" "${tag}")
  done
  
  if [[ "${VERBOSE}" == "true" ]] ; then
    python3 -m behave "${TAG_ARGS[@]}" tests/features
  else
    python3 -m behave "${TAG_ARGS[@]}" tests/features --quiet --no-skipped
  fi
  
  if [[ ${?} -ne 0 ]] ; then
    echo "\033[1;31mBDD Tests FAILED\033[0m"
    [[ "${FAIL_FAST}" == "true" ]] && exit ${VDE_ERR_GENERAL}
  else
    echo "\033[1;32mBDD Tests PASSED\033[0m"
  fi
fi

end_time=$(date +%s)
duration=$((end_time - start_time))

echo "
\033[1;34mTotal Execution Time: ${duration}s\033[0m"
