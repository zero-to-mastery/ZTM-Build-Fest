#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vde-security Library
# Tests security policy enforcement functions
#
# These tests are Docker-free: they verify function existence, permission
# enforcement on local directories/files, and graceful handling of absent Docker.
# Docker-dependent tests (actual network creation, container inspection) belong
# in BDD feature files.

# Don't use set -e as it interferes with test counting
# set -e

typeset SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
typeset PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source dependencies in correct order
export VDE_ROOT_DIR="$PROJECT_ROOT"
source "$PROJECT_ROOT/lib/vde-constants"
source "$PROJECT_ROOT/lib/vde-log"
source "$PROJECT_ROOT/lib/vde-security"

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
# TESTS: Library Load
# =============================================================================

test_library_loads() {
    test_start "vde-security library loads without error"

    if [[ "${_VDE_SECURITY_LOADED:-}" == "1" ]]; then
        test_pass "vde-security library loads without error"
        return
    fi

    test_fail "vde-security library loads without error" "_VDE_SECURITY_LOADED is not set to 1"
}

# =============================================================================
# TESTS: Function Existence
# =============================================================================

test_functions_exist() {
    test_start "all vde_security_* functions are defined"

    local missing=()
    local required_functions=(
        vde_security_enforce_permissions
        vde_security_ensure_network
        vde_security_validate_naming
        vde_security_enforce_network_isolation
        vde_security_init
    )

    for fn in "${required_functions[@]}"; do
        if ! typeset -f "$fn" >/dev/null 2>&1; then
            missing+=("$fn")
        fi
    done

    if [[ ${#missing[@]} -eq 0 ]]; then
        test_pass "all vde_security_* functions are defined"
        return
    else
        test_fail "all vde_security_* functions are defined" "missing: ${missing[*]}"
    fi
}

# =============================================================================
# TESTS: Permission Enforcement
# Helper: run enforce_permissions in a subshell with a temp VDE_ROOT_DIR
# =============================================================================

_run_enforce_in_tmpdir() {
    # $1 = tmpdir path
    # Runs vde_security_enforce_permissions in a subshell with VDE_ROOT_DIR=$1
    local tmpdir="$1"
    (
        export VDE_ROOT_DIR="$tmpdir"
        # Re-source so constants pick up the new VDE_ROOT_DIR
        source "$PROJECT_ROOT/lib/vde-constants" 2>/dev/null
        source "$PROJECT_ROOT/lib/vde-log" 2>/dev/null
        source "$PROJECT_ROOT/lib/vde-security" 2>/dev/null
        vde_security_enforce_permissions >/dev/null 2>&1
    )
}

_get_perm() {
    local target="$1"
    # Try Linux/GNU format first (%a)
    local p=$(stat -c "%a" "$target" 2>/dev/null)
    if [[ -z "$p" ]]; then
        # Fallback to macOS/BSD format (%Lp)
        p=$(stat -f "%Lp" "$target" 2>/dev/null)
    fi
    echo "$p"
}

test_enforce_permissions_creates_strict_dirs() {
    test_start "vde_security_enforce_permissions sets 0700 on sensitive dirs"

    local tmpdir
    tmpdir=$(mktemp -d)

    mkdir -p "$tmpdir/.cache" "$tmpdir/.docker-state" "$tmpdir/.locks"
    chmod 755 "$tmpdir/.cache" "$tmpdir/.docker-state" "$tmpdir/.locks"

    _run_enforce_in_tmpdir "$tmpdir"

    local failed=0
    for dir in .cache .docker-state .locks; do
        local perm=$(_get_perm "$tmpdir/$dir")
        if [[ "$perm" != "700" ]]; then
            failed=1
            break
        fi
    done

    rm -rf "$tmpdir"

    if [[ $failed -eq 0 ]]; then
        test_pass "vde_security_enforce_permissions sets 0700 on sensitive dirs"
        return
    else
        test_fail "vde_security_enforce_permissions sets 0700 on sensitive dirs" "permission was not 700"
    fi
}

test_enforce_permissions_data_logs() {
    test_start "vde_security_enforce_permissions sets 0700 on data/ and logs/"

    local tmpdir
    tmpdir=$(mktemp -d)

    mkdir -p "$tmpdir/data" "$tmpdir/logs"
    chmod 755 "$tmpdir/data" "$tmpdir/logs"

    _run_enforce_in_tmpdir "$tmpdir"

    local failed=0
    for dir in data logs; do
        local perm=$(_get_perm "$tmpdir/$dir")
        if [[ "$perm" != "700" ]]; then
            failed=1
            break
        fi
    done

    rm -rf "$tmpdir"

    if [[ $failed -eq 0 ]]; then
        test_pass "vde_security_enforce_permissions sets 0700 on data/ and logs/"
        return
    else
        test_fail "vde_security_enforce_permissions sets 0700 on data/ and logs/" "permission was not 700"
    fi
}

test_enforce_permissions_env_files() {
    test_start "vde_security_enforce_permissions sets 0600 on *.env files"

    local tmpdir
    tmpdir=$(mktemp -d)

    mkdir -p "$tmpdir/env-files"
    echo "SECRET=value" > "$tmpdir/env-files/python.env"
    chmod 644 "$tmpdir/env-files/python.env"

    _run_enforce_in_tmpdir "$tmpdir"

    local perm=$(_get_perm "$tmpdir/env-files/python.env")

    rm -rf "$tmpdir"

    if [[ "$perm" == "600" ]]; then
        test_pass "vde_security_enforce_permissions sets 0600 on *.env files"
        return
    else
        test_fail "vde_security_enforce_permissions sets 0600 on *.env files" "permission was $perm, expected 600"
    fi
}

test_enforce_permissions_ssh_identity() {
    test_start "vde_security_enforce_permissions sets 0600 on SSH identity file"

    # VDE_SSH_IDENTITY is a readonly var pointing to ~/.ssh/vde/vde_student.
    # We test using the actual path: create a test key file there if absent,
    # set it to 644, run enforce_permissions, verify it becomes 600, then clean up.
    local created_test_file=0
    local test_identity="$VDE_SSH_IDENTITY"

    # Ensure the SSH dir exists
    mkdir -p "$VDE_SSH_DIR" 2>/dev/null || true

    if [[ ! -f "$test_identity" ]]; then
        echo "test-key-placeholder" > "$test_identity"
        created_test_file=1
    fi

    # Set to 644 to verify enforce_permissions corrects it
    chmod 644 "$test_identity" 2>/dev/null || true

    vde_security_enforce_permissions >/dev/null 2>&1

    local perm=$(_get_perm "$test_identity")

    # Clean up test file if we created it
    if [[ $created_test_file -eq 1 ]]; then
        rm -f "$test_identity"
    fi

    if [[ "$perm" == "600" ]]; then
        test_pass "vde_security_enforce_permissions sets 0600 on SSH identity file"
        return
    else
        test_fail "vde_security_enforce_permissions sets 0600 on SSH identity file" "permission was $perm, expected 600"
    fi
}

# =============================================================================
# TESTS: Network Functions (Docker-absent graceful handling)
# =============================================================================

test_ensure_network_no_docker() {
    test_start "vde_security_ensure_network handles absent Docker gracefully"

    # Create a fake docker that always fails
    local fake_bin
    fake_bin=$(mktemp -d)
    cat > "$fake_bin/docker" <<'EOF'
#!/usr/bin/env zsh
# @armor (Unit Test: Security Sentinel)
exit 1
EOF
    chmod +x "$fake_bin/docker"

    local orig_path="$PATH"
    export PATH="$fake_bin:$PATH"

    # Should not exit the shell even if docker fails
    vde_security_ensure_network "vde-test-net" >/dev/null 2>&1 || true

    export PATH="$orig_path"
    rm -rf "$fake_bin"

    # We only care that the function didn't crash the test runner
    test_pass "vde_security_ensure_network handles absent Docker gracefully"
        return
}

test_enforce_network_isolation_no_docker() {
    test_start "vde_security_enforce_network_isolation handles absent Docker gracefully"

    local fake_bin
    fake_bin=$(mktemp -d)
    cat > "$fake_bin/docker" <<'EOF'
#!/usr/bin/env zsh
if [[ "$1" == "ps" ]]; then
    exit 0
fi
exit 1
EOF
    chmod +x "$fake_bin/docker"

    local orig_path="$PATH"
    export PATH="$fake_bin:$PATH"

    vde_security_enforce_network_isolation "vde-test-net" >/dev/null 2>&1 || true

    export PATH="$orig_path"
    rm -rf "$fake_bin"

    test_pass "vde_security_enforce_network_isolation handles absent Docker gracefully"
        return
}

# =============================================================================
# TESTS: vde_security_validate_naming
# =============================================================================

test_vde_security_validate_naming() {
    test_start "vde_security_validate_naming returns VDE_SUCCESS"

    # Mock PATH and vde_query_json to simulate no violations
    local fake_bin=$(mktemp -d)
    echo "#!/bin/zsh\necho 'vde-python'" > "$fake_bin/vde_query_json"
    chmod +x "$fake_bin/vde_query_json"

    local orig_path="$PATH"
    export PATH="$fake_bin:$PATH"

    local rc=0
    vde_security_validate_naming >/dev/null 2>&1 || rc=$?

    export PATH="$orig_path"
    rm -rf "$fake_bin"

    if [[ $rc -eq $VDE_SUCCESS ]]; then
        test_pass "vde_security_validate_naming returns VDE_SUCCESS"
        return
    else
        test_fail "vde_security_validate_naming" "expected success, got $rc"
    fi
}

# =============================================================================
# TESTS: vde_security_init orchestration
# =============================================================================

test_security_init_calls_all_three() {
    test_start "vde_security_init invokes ensure_network, enforce_permissions, enforce_isolation"

    # Track which sub-functions were called by overriding them temporarily
    local called_network=0
    local called_perms=0
    local called_isolation=0

    # Override in current shell scope
    function vde_security_ensure_network { called_network=1; return 0; }
    function vde_security_enforce_permissions { called_perms=1; return 0; }
    function vde_security_enforce_network_isolation { called_isolation=1; return 0; }

    vde_security_init >/dev/null 2>&1

    # Restore originals by re-sourcing
    unfunction vde_security_ensure_network vde_security_enforce_permissions vde_security_enforce_network_isolation 2>/dev/null || true
    source "$PROJECT_ROOT/lib/vde-security" 2>/dev/null || true

    if [[ $called_network -eq 1 && $called_perms -eq 1 && $called_isolation -eq 1 ]]; then
        test_pass "vde_security_init invokes ensure_network, enforce_permissions, enforce_isolation"
        return
    else
        local missing=""
        [[ $called_network -eq 0 ]] && missing+=" ensure_network"
        [[ $called_perms -eq 0 ]] && missing+=" enforce_permissions"
        [[ $called_isolation -eq 0 ]] && missing+=" enforce_isolation"
        test_fail "vde_security_init invokes ensure_network, enforce_permissions, enforce_isolation" "not called:$missing"
    fi
}

# =============================================================================
# Run All Tests
# =============================================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  VDE Security Library Unit Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_library_loads
test_functions_exist
test_enforce_permissions_creates_strict_dirs
test_enforce_permissions_data_logs
test_enforce_permissions_env_files
test_enforce_permissions_ssh_identity
test_ensure_network_no_docker
test_enforce_network_isolation_no_docker
test_security_init_calls_all_three
test_vde_security_validate_naming

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results: ${TESTS_PASSED} passed, ${TESTS_FAILED} failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ $TESTS_FAILED -gt 0 ]]; then
    exit 1
fi
exit 0
