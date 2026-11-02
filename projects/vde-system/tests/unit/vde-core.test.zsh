#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vde-core Library
# Tests core VDE functions and caching

# Don't use set -e as it interferes with test counting
# set -e

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

# =============================================================================
# TESTS: Directory Constants
# =============================================================================

test_directory_constants_exist() {
    test_start "directory constants exist"

    if [[ -n "$VDE_CORE_CONFIGS_DIR" ]] && \
       [[ -n "$VDE_CORE_BIN_DIR" ]] && \
       [[ -n "$VDE_CORE_DATA_DIR" ]] && \
       [[ -n "$VDE_CORE_CACHE_DIR" ]]; then
        test_pass "directory constants exist"
        return
    fi

    test_fail "directory constants exist" "some directory constants are missing"
}

test_directory_constants_values() {
    test_start "directory constants values"

    if [[ "$VDE_CORE_CONFIGS_DIR" == *"/configs/docker" ]] && \
       [[ "$VDE_CORE_BIN_DIR" == *"/bin" ]] && \
       [[ "$VDE_CORE_DATA_DIR" == *"/data" ]]; then
        test_pass "directory constants values"
        return
    fi

    test_fail "directory constants values" "directory constants have unexpected values"
}

test_vm_types_conf_exists() {
    test_start "vm types conf path"

    if [[ -n "$VDE_CORE_VM_TYPES_CONF" ]] && \
       [[ -f "$VDE_CORE_VM_TYPES_CONF" ]]; then
        test_pass "vm types conf path"
        return
    fi

    test_fail "vm types conf" "vm-types.conf not found at $VDE_CORE_VM_TYPES_CONF"
}

# =============================================================================
# TESTS: Logging Functions
# =============================================================================

test_log_info() {
    test_start "log_info"

    local result
    result=$(log_info "test message" 2>&1)
    if echo "$result" | grep -q "\[INFO\] test message"; then
        test_pass "log_info"
        return
    fi

    test_fail "log_info" "output missing [INFO] prefix: $result"
}

test_log_error() {
    test_start "log_error"

    local result
    result=$(log_error "test error" 2>&1)
    if echo "$result" | grep -q "\[ERROR\] test error"; then
        test_pass "log_error"
        return
    fi

    test_fail "log_error" "output missing [ERROR] prefix: $result"
}

test_log_success() {
    test_start "log_success"

    local result
    result=$(log_success "test success" 2>&1)
    if echo "$result" | grep -q "\[SUCCESS\] test success"; then
        test_pass "log_success"
        return
    fi

    test_fail "log_success" "output missing [SUCCESS] prefix: $result"
}

test_log_warning() {
    test_start "log_warning"

    local result
    result=$(log_warning "test warning" 2>&1)
    if echo "$result" | grep -q "\[WARNING\] test warning"; then
        test_pass "log_warning"
        return
        return
    fi

    test_fail "log_warning" "output missing [WARNING] prefix: $result"
}

# =============================================================================
# TESTS: Cache Functions
# =============================================================================

test_ensure_cache_dir() {
    test_start "ensure cache dir"

    # This should create the directory if missing
    _vde_core_ensure_cache_dir

    if [[ -d "$VDE_CORE_CACHE_DIR" ]]; then
        test_pass "ensure cache dir"
        return
    fi

    test_fail "ensure cache dir" "cache directory not created"
}

test_get_mtime_file_exists() {
    test_start "get mtime (file exists)"

    local mtime
    mtime=$(_vde_core_get_mtime "$VDE_CORE_VM_TYPES_CONF")

    if [[ "$mtime" -gt 0 ]]; then
        test_pass "get mtime (file exists)"
        return
    fi

    test_fail "get mtime" "expected positive mtime, got $mtime"
}

test_get_mtime_file_not_exists() {
    test_start "get mtime (file not exists)"

    local mtime
    mtime=$(_vde_core_get_mtime "/nonexistent/path/file")

    if [[ "$mtime" -eq 0 ]]; then
        test_pass "get mtime (file not exists)"
        return
    fi

    test_fail "get mtime" "expected 0 for non-existent file, got $mtime"
}

# =============================================================================
# TESTS: VM Type Loading
# =============================================================================

test_load_vm_types() {
    test_start "load vm types"

    # Force reload
    _VDE_CORE_LOADED=0
    vde_core_load_types

    # Check that some VMs are loaded
    if [[ -n "$_VDE_CORE_LOADED" ]] && [[ "${#VDE_CORE_VM_TYPE}" -gt 0 ]]; then
        test_pass "load vm types"
        return
    fi

    test_fail "load vm types" "VM types not loaded or array is empty"
}

test_get_all_vms() {
    test_start "get all vms"

    local result
    result=$(vde_core_get_all_vms)

    if echo "$result" | grep -q "vde-python"; then
        test_pass "get all vms"
        return
    fi

    test_fail "get all vms" "vde-python not in list of VMs"
}

test_get_vm_type() {
    test_start "get vm type"

    local result
    result=$(vde_core_get_vm_type "vde-python")

    if [[ "$result" == "lang" ]]; then
        test_pass "get vm type"
        return
    fi

    test_fail "get vm type" "expected 'lang', got '$result'"
}

test_is_known_vm_true() {
    test_start "is known vm (true)"

    if vde_core_is_known_vm "vde-python"; then
        test_pass "is known vm (true)"
        return
    fi

    test_fail "is known vm true" "vde-python should be known"
}

test_is_known_vm_false() {
    test_start "is known vm (false)"

    if ! vde_core_is_known_vm "nonexistentvm123"; then
        test_pass "is known vm (false)"
        return
    fi

    test_fail "is known vm false" "nonexistentvm123 should not be known"
}

# =============================================================================
# TESTS: Cache Operations
# =============================================================================

test_cache_operations() {
    test_start "cache save and load"

    # Force a reload to ensure cache is created
    invalidate_vm_types_cache
    vde_core_load_types

    # Check cache file exists
    if [[ -f "$VDE_CORE_VM_TYPES_CACHE" ]]; then
        test_pass "cache save and load"
        return
    fi

    test_fail "cache operations" "cache file not created"
}

test_invalidate_cache() {
    test_start "invalidate cache"

    # Create a marker in cache file
    echo "MARKER=test" >> "$VDE_CORE_VM_TYPES_CACHE" 2>/dev/null

    # Invalidate
    invalidate_vm_types_cache

    # Check marker is gone
    if [[ ! -f "$VDE_CORE_VM_TYPES_CACHE" ]] || \
       ! grep -q "MARKER=test" "$VDE_CORE_VM_TYPES_CACHE" 2>/dev/null; then
        test_pass "invalidate cache"
        return
    fi

    test_fail "invalidate cache" "cache was not properly invalidated"
}

# =============================================================================
# TESTS: Lazy Loading Support
# =============================================================================

test_lazy_loading_variables() {
    test_start "lazy loading variables"

    if [[ -n "$_VDE_SSH_LOADED" ]] && \
       [[ -n "$_VDE_DOCKER_LOADED" ]] && \
       [[ -n "$_VDE_TEMPLATE_LOADED" ]]; then
        test_pass "lazy loading variables"
        return
    fi

    test_fail "lazy loading variables" "lazy loading variables not initialized"
}

test_require_ssh() {
    test_start "require ssh"

    # This should succeed (may source additional files)
    vde_require_ssh
    if [[ $? -eq 0 ]]; then
        test_pass "require ssh"
        return
    fi

    test_fail "require ssh" "require_ssh returned error"
}

test_require_docker() {
    test_start "require docker"

    vde_require_docker
    if [[ $? -eq 0 ]]; then
        test_pass "require docker"
        return
    fi

    test_fail "require docker" "require_docker returned error"
}

test_require_template() {
    test_start "require template"

    vde_require_template
    if [[ $? -eq 0 ]]; then
        test_pass "require template"
        return
    fi

    test_fail "require template" "require_template returned error"
}

# =============================================================================
# TESTS: Performance Timing
# =============================================================================

test_timing_variables() {
    test_start "timing functions"

    VDE_DEBUG_TIMING=1
    vde_time_start "test_operation"
    vde_time_end "test_operation" 2>/dev/null

    VDE_DEBUG_TIMING=0
    test_pass "timing functions"
        return
}

# =============================================================================
# TESTS: Source Guard
# =============================================================================

test_source_guard() {
    test_start "source guard"

    # Source again
    source "$PROJECT_ROOT/lib/vde-core" 2>/dev/null

    # Check guard is working (constants should be readonly still)
    if [[ "$VDE_SUCCESS" -eq 0 ]]; then
        test_pass "source guard"
        return
    fi

    test_fail "source guard" "guard not working correctly"
}

# =============================================================================
# Run All Tests
# =============================================================================

echo "=============================================="
echo "VDE Core Unit Tests"
echo "=============================================="

# Invalidate cache to ensure fresh load
invalidate_vm_types_cache

# Directory constants tests
test_directory_constants_exist
test_directory_constants_values
test_vm_types_conf_exists

# Logging function tests
test_log_info
test_log_error
test_log_success
test_log_warning

# Cache function tests
test_ensure_cache_dir
test_get_mtime_file_exists
test_get_mtime_file_not_exists

# VM type loading tests
test_load_vm_types
test_get_all_vms
test_get_vm_type
test_is_known_vm_true
test_is_known_vm_false

# Cache operations tests
test_cache_operations
test_invalidate_cache

# Lazy loading tests
test_lazy_loading_variables
test_require_ssh
test_require_docker
test_require_template

# Performance timing tests
test_timing_variables

# Source guard test
test_source_guard

echo ""
echo "=============================================="
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
echo "=============================================="

exit $TESTS_FAILED
