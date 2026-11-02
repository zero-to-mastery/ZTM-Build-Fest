#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# Zsh test config loader - reads schema-validated JSON configs
# Allows zsh unit tests to use pytest-config.json settings

# Find project root
if [[ -n "${VDE_ROOT_DIR}" ]]; then
    TEST_CONFIG_ROOT="${VDE_ROOT_DIR}"
elif [[ -n "${PROJECT_ROOT}" ]]; then
    TEST_CONFIG_ROOT="${PROJECT_ROOT}"
else
    TEST_CONFIG_ROOT="$(cd "$(dirname "${(%):-%x}")/../.." && pwd)"
fi

# Config file paths
typeset PYTEST_CONFIG_JSON="${TEST_CONFIG_ROOT}/tests/pytest-config.json"
typeset PYTEST_SCHEMA_JSON="${TEST_CONFIG_ROOT}/tests/pytest-config.schema.json"

# Default config values (used if JSON load fails)
typeset -g TEST_TIMEOUT_DEFAULT=60
typeset -g TEST_TIMEOUT_METHOD=30
typeset -g TEST_TIMEOUT_FUNCTION=10
typeset -g TEST_VERBOSE=0
typeset -g TEST_COVERAGE_ENABLED=0

# Load test configuration from pytest-config.json
load_test_config() {
    if [[ ! -f "${PYTEST_CONFIG_JSON}" ]]; then
        echo "[TEST CONFIG] Warning: pytest-config.json not found, using defaults" >&2
        return 1
    fi

    # Validate config if vde-core available
    if [[ -f "${TEST_CONFIG_ROOT}/lib/vde-core" ]]; then
        source "${TEST_CONFIG_ROOT}/lib/vde-core" 2>/dev/null

        if typeset -f vde_validate_json_schema >/dev/null 2>&1; then
            if ! vde_validate_json_schema "${PYTEST_CONFIG_JSON}" "${PYTEST_SCHEMA_JSON}" 2>/dev/null; then
                echo "[TEST CONFIG] Warning: Config validation failed, using defaults" >&2
                return 1
            fi
        fi
    fi

    # Parse JSON using Python (more reliable than jq)
    local config_data
    config_data=$(python3 -c "
import json, sys
try:
    with open('${PYTEST_CONFIG_JSON}') as f:
        config = json.load(f)

    # Extract timeout settings
    timeout = config.get('timeout', {})
    print(f\"TEST_TIMEOUT_DEFAULT={timeout.get('default', 60)}\")
    print(f\"TEST_TIMEOUT_METHOD={timeout.get('method', 30)}\")
    print(f\"TEST_TIMEOUT_FUNCTION={timeout.get('function', 10)}\")

    # Extract pytest settings
    pytest = config.get('pytest', {})
    addopts = pytest.get('addopts', [])
    verbose = 1 if '-v' in addopts or '--verbose' in addopts else 0
    print(f\"TEST_VERBOSE={verbose}\")

    # Extract coverage settings
    coverage = config.get('coverage', {})
    enabled = 1 if coverage.get('enabled', False) else 0
    print(f\"TEST_COVERAGE_ENABLED={enabled}\")

    sys.exit(0)
except Exception as e:
    print(f'Error loading config: {e}', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null)

    if [[ ${?} -eq 0 && -n "${config_data}" ]]; then
        # Set config variables from parsed JSON
        eval "${config_data}"
        return 0
    else
        echo "[TEST CONFIG] Warning: Failed to parse config, using defaults" >&2
        return 1
    fi
}

# Get test timeout for given test type
get_test_timeout() {
    local test_type="${1:-default}"

    case "${test_type}" in
        method)
            echo "${TEST_TIMEOUT_METHOD}"
            ;;
        function)
            echo "${TEST_TIMEOUT_FUNCTION}"
            ;;
        *)
            echo "${TEST_TIMEOUT_DEFAULT}"
            ;;
    esac
}

# Check if verbose mode is enabled
is_verbose_mode() {
    [[ ${TEST_VERBOSE} -eq 1 ]]
}

# Check if coverage is enabled
is_coverage_enabled() {
    [[ ${TEST_COVERAGE_ENABLED} -eq 1 ]]
}

# Load config on source (can be disabled by setting SKIP_TEST_CONFIG_LOAD=1)
if [[ -z "${SKIP_TEST_CONFIG_LOAD}" ]]; then
    load_test_config
fi
