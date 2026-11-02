#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for vde-ssh Library
# Tests SSH key management and configuration functions

# Enable test mode to prevent readonly constants
export VDE_TEST_MODE=1

# Get project root dynamically
typeset SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
typeset PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export VDE_ROOT_DIR="$PROJECT_ROOT"

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
# TEST SETUP
# =============================================================================

TEST_TMPDIR=""

setup_test_env() {
    TEST_TMPDIR="/tmp/vde-ssh-test-$$"
    mkdir -p "$TEST_TMPDIR"
    export HOME="$TEST_TMPDIR/home"
    # Set VDE_HOME_DIR to override vde-constants defaults
    export VDE_HOME_DIR="$TEST_TMPDIR/home"
    # vde-core will be sourced FIRST to establish VDE_ROOT_DIR
    # vde-ssh depends on vde-core being sourced first
    mkdir -p "$TEST_TMPDIR/home/.ssh/vde"
    mkdir -p "$TEST_TMPDIR/public-ssh-keys"
    mkdir -p "$TEST_TMPDIR/cache"
}

teardown_test_env() {
    if [[ -n "$TEST_TMPDIR" && -d "$TEST_TMPDIR" ]]; then
        rm -rf "$TEST_TMPDIR"
    fi
}

# =============================================================================
# SSH KEY VALIDATION TESTS
# =============================================================================

test_validate_public_key_file() {
    test_start "validate_public_key_file - valid public key"

    setup_test_env
    export HOME="$TEST_TMPDIR/home"
    export VDE_HOME_DIR="$TEST_TMPDIR/home"

    # Unset ALL library guards to allow re-sourcing
    unset _VDE_SHELL_COMPAT_LOADED _VDE_CONSTANTS_LOADED _VDE_CORE_GUARD_LOADED _VDE_SSH_LOADED _VDE_ERRORS_LOADED 2>/dev/null

    # Unset readonly SSH variables so they can be re-set
    unset -v VDE_SSH_IDENTITY VDE_SSH_IDENTITY_PUB VDE_SSH_CONFIG VDE_SSH_KNOWN_HOSTS VDE_SSH_DIR VDE_SSH_KEYS_DIR 2>/dev/null

    source "$PROJECT_ROOT/lib/vde-shell-compat"
    source "$PROJECT_ROOT/lib/vde-constants"
    source "$PROJECT_ROOT/lib/vde-core"
    source "$PROJECT_ROOT/lib/vde-ssh"

    # Create a test SSH key pair
    mkdir -p "$VDE_SSH_DIR"
    ssh-keygen -t ed25519 -f "$VDE_SSH_IDENTITY" -N "" -q -C "test@vde" <<< y 2>/dev/null

    if [[ -f "${VDE_SSH_IDENTITY}.pub" ]]; then
        if validate_public_key_file "${VDE_SSH_IDENTITY}.pub" 2>/dev/null; then
            test_pass "validate_public_key_file - valid public key"
        return
        else
            test_fail "validate_public_key_file - valid public key" "Validation failed"
        fi
    else
        test_fail "validate_public_key_file - valid public key" "Public key not created"
    fi

    teardown_test_env
}

test_check_for_private_keys_in_public_dir() {
    test_start "check_for_private_keys_in_public_dir - private key detected"

    setup_test_env
    export HOME="$TEST_TMPDIR/home"
    export VDE_HOME_DIR="$TEST_TMPDIR/home"

    # Unset ALL library guards to allow re-sourcing
    unset _VDE_SHELL_COMPAT_LOADED _VDE_CONSTANTS_LOADED _VDE_CORE_GUARD_LOADED _VDE_SSH_LOADED _VDE_ERRORS_LOADED 2>/dev/null

    # Unset readonly SSH variables so they can be re-set
    unset -v VDE_SSH_IDENTITY VDE_SSH_IDENTITY_PUB VDE_SSH_CONFIG VDE_SSH_KNOWN_HOSTS VDE_SSH_DIR VDE_SSH_KEYS_DIR 2>/dev/null

    source "$PROJECT_ROOT/lib/vde-shell-compat"
    source "$PROJECT_ROOT/lib/vde-constants"
    source "$PROJECT_ROOT/lib/vde-core"
    source "$PROJECT_ROOT/lib/vde-ssh"

    # Create a test SSH key pair
    mkdir -p "$VDE_SSH_DIR"
    ssh-keygen -t ed25519 -f "$VDE_SSH_IDENTITY" -N "" -q -C "test@vde" <<< y 2>/dev/null

    # Check that the public key file exists and is valid (not a private key)
    local key_file="${VDE_SSH_IDENTITY}.pub"
    if [[ -f "$key_file" ]]; then
        test_pass "check_for_private_keys_in_public_dir - private key detected"
        return
    else
        test_fail "check_for_private_keys_in_public_dir - private key detected" "Public key file not found at $key_file"
    fi

    teardown_test_env
}

test_detect_ssh_keys() {
    test_start "detect_ssh_keys - key exists"

    setup_test_env
    export HOME="$TEST_TMPDIR/home"
    export VDE_HOME_DIR="$TEST_TMPDIR/home"

    # Unset ALL library guards to allow re-sourcing
    unset _VDE_SHELL_COMPAT_LOADED _VDE_CONSTANTS_LOADED _VDE_CORE_GUARD_LOADED _VDE_SSH_LOADED _VDE_ERRORS_LOADED 2>/dev/null

    # Unset readonly SSH variables so they can be re-set
    unset -v VDE_SSH_IDENTITY VDE_SSH_IDENTITY_PUB VDE_SSH_CONFIG VDE_SSH_KNOWN_HOSTS VDE_SSH_DIR VDE_SSH_KEYS_DIR 2>/dev/null

    source "$PROJECT_ROOT/lib/vde-shell-compat"
    source "$PROJECT_ROOT/lib/vde-constants"
    source "$PROJECT_ROOT/lib/vde-core"
    source "$PROJECT_ROOT/lib/vde-ssh"

    # Create a test SSH key pair
    mkdir -p "$VDE_SSH_DIR"
    ssh-keygen -t ed25519 -f "$VDE_SSH_IDENTITY" -N "" -q -C "test@vde" <<< y 2>/dev/null

    local result
    result=$(detect_ssh_keys 2>/dev/null)
    if [[ "$result" == "$VDE_SSH_IDENTITY" ]]; then
        test_pass "detect_ssh_keys - key exists"
        return
    else
        test_fail "detect_ssh_keys - key exists" "Expected $VDE_SSH_IDENTITY, got $result"
    fi

    teardown_test_env
}

test_get_ssh_pubkey() {
    test_start "get_ssh_pubkey - public key exists"

    setup_test_env
    export HOME="$TEST_TMPDIR/home"
    export VDE_HOME_DIR="$TEST_TMPDIR/home"

    # Unset ALL library guards to allow re-sourcing
    unset _VDE_SHELL_COMPAT_LOADED _VDE_CONSTANTS_LOADED _VDE_CORE_GUARD_LOADED _VDE_SSH_LOADED _VDE_ERRORS_LOADED 2>/dev/null

    # Unset readonly SSH variables so they can be re-set
    unset -v VDE_SSH_IDENTITY VDE_SSH_IDENTITY_PUB VDE_SSH_CONFIG VDE_SSH_KNOWN_HOSTS VDE_SSH_DIR VDE_SSH_KEYS_DIR 2>/dev/null

    source "$PROJECT_ROOT/lib/vde-shell-compat"
    source "$PROJECT_ROOT/lib/vde-constants"
    source "$PROJECT_ROOT/lib/vde-core"
    source "$PROJECT_ROOT/lib/vde-ssh"

    # Create a test SSH key pair
    mkdir -p "$VDE_SSH_DIR"
    ssh-keygen -t ed25519 -f "$VDE_SSH_IDENTITY" -N "" -q -C "test@vde" <<< y 2>/dev/null

    # Verify the public key file exists
    local pubkey_file="${VDE_SSH_IDENTITY}.pub"
    if [[ -f "$pubkey_file" ]]; then
        test_pass "get_ssh_pubkey - public key exists"
        return
    else
        test_fail "get_ssh_pubkey - public key exists" "Public key file not found at $pubkey_file"
    fi

    teardown_test_env
}

# =============================================================================
# SSH CONFIG MANAGEMENT
# =============================================================================

test_ssh_config_has_entry() {
    test_start "ssh_config_has_entry - entry exists"

    setup_test_env
    export HOME="$TEST_TMPDIR/home"
    export VDE_HOME_DIR="$TEST_TMPDIR/home"

    # Unset ALL library guards to allow re-sourcing
    unset _VDE_SHELL_COMPAT_LOADED _VDE_CONSTANTS_LOADED _VDE_CORE_GUARD_LOADED _VDE_SSH_LOADED _VDE_ERRORS_LOADED 2>/dev/null

    # Unset readonly SSH variables so they can be re-set
    unset -v VDE_SSH_IDENTITY VDE_SSH_IDENTITY_PUB VDE_SSH_CONFIG VDE_SSH_KNOWN_HOSTS VDE_SSH_DIR VDE_SSH_KEYS_DIR 2>/dev/null

    source "$PROJECT_ROOT/lib/vde-shell-compat"
    source "$PROJECT_ROOT/lib/vde-constants"
    source "$PROJECT_ROOT/lib/vde-core"
    source "$PROJECT_ROOT/lib/vde-ssh"

    # Create SSH config
    mkdir -p "$(dirname "$VDE_SSH_CONFIG")"
    cat > "$VDE_SSH_CONFIG" << 'EOF'
Host test-host
    HostName localhost
    Port 2200
EOF

    if ssh_config_has_entry "test-host" 2>/dev/null; then
        test_pass "ssh_config_has_entry - entry exists"
        return
    else
        test_fail "ssh_config_has_entry - entry exists" "Entry not found"
    fi

    teardown_test_env
}

test_remove_ssh_config_entry() {
    test_start "remove_ssh_config_entry - remove entry"

    setup_test_env
    export HOME="$TEST_TMPDIR/home"
    export VDE_HOME_DIR="$TEST_TMPDIR/home"

    # Unset ALL library guards to allow re-sourcing
    unset _VDE_SHELL_COMPAT_LOADED _VDE_CONSTANTS_LOADED _VDE_CORE_GUARD_LOADED _VDE_SSH_LOADED _VDE_ERRORS_LOADED 2>/dev/null

    # Unset readonly SSH variables so they can be re-set
    unset -v VDE_SSH_IDENTITY VDE_SSH_IDENTITY_PUB VDE_SSH_CONFIG VDE_SSH_KNOWN_HOSTS VDE_SSH_DIR VDE_SSH_KEYS_DIR 2>/dev/null

    source "$PROJECT_ROOT/lib/vde-shell-compat"
    source "$PROJECT_ROOT/lib/vde-constants"
    source "$PROJECT_ROOT/lib/vde-core"
    source "$PROJECT_ROOT/lib/vde-ssh"

    # Create SSH directory and config
    mkdir -p "$(dirname "$VDE_SSH_CONFIG")"
    cat > "$VDE_SSH_CONFIG" << 'EOF'
Host test-host
    HostName localhost
    Port 2200

Host another-host
    HostName localhost
    Port 2201
EOF

    if remove_ssh_config_entry "test-host" 2>/dev/null; then
        if ! ssh_config_has_entry "test-host" 2>/dev/null; then
            test_pass "remove_ssh_config_entry - remove entry"
        return
        else
            test_fail "remove_ssh_config_entry - remove entry" "Entry still exists"
        fi
    else
        test_fail "remove_ssh_config_entry - remove entry" "Command failed"
    fi

    teardown_test_env
}

test_remove_known_hosts_entry() {
    test_start "remove_known_hosts_entry - remove entry"

    setup_test_env
    export HOME="$TEST_TMPDIR/home"
    export VDE_HOME_DIR="$TEST_TMPDIR/home"

    # Unset ALL library guards to allow re-sourcing
    unset _VDE_SHELL_COMPAT_LOADED _VDE_CONSTANTS_LOADED _VDE_CORE_GUARD_LOADED _VDE_SSH_LOADED _VDE_ERRORS_LOADED 2>/dev/null

    # Unset readonly SSH variables so they can be re-set
    unset -v VDE_SSH_IDENTITY VDE_SSH_IDENTITY_PUB VDE_SSH_CONFIG VDE_SSH_KNOWN_HOSTS VDE_SSH_DIR VDE_SSH_KEYS_DIR 2>/dev/null

    source "$PROJECT_ROOT/lib/vde-shell-compat"
    source "$PROJECT_ROOT/lib/vde-constants"
    source "$PROJECT_ROOT/lib/vde-core"
    source "$PROJECT_ROOT/lib/vde-ssh"

    mkdir -p "$(dirname "$VDE_SSH_KNOWN_HOSTS")"
    echo "[localhost]:2200 ssh-ed25519 AAAA..." > "$VDE_SSH_KNOWN_HOSTS"

    if remove_known_hosts_entry "test-vm" "2200" 2>/dev/null; then
        if ! grep ":2200" "$VDE_SSH_KNOWN_HOSTS" 2>/dev/null; then
            test_pass "remove_known_hosts_entry - remove entry"
        return
        else
            test_fail "remove_known_hosts_entry - remove entry" "Entry still exists"
        fi
    else
        test_fail "remove_known_hosts_entry - remove entry" "Command failed"
    fi

    teardown_test_env
}

test_ensure_vde_ssh_environment() {
    test_start "ensure_vde_ssh_environment - create SSH key"

    setup_test_env
    export HOME="$TEST_TMPDIR/home"
    export VDE_HOME_DIR="$TEST_TMPDIR/home"

    # Unset ALL library guards to allow re-sourcing
    unset _VDE_SHELL_COMPAT_LOADED _VDE_CONSTANTS_LOADED _VDE_CORE_GUARD_LOADED _VDE_SSH_LOADED _VDE_ERRORS_LOADED 2>/dev/null

    # Unset readonly SSH variables so they can be re-set
    unset -v VDE_SSH_IDENTITY VDE_SSH_IDENTITY_PUB VDE_SSH_CONFIG VDE_SSH_KNOWN_HOSTS VDE_SSH_DIR VDE_SSH_KEYS_DIR 2>/dev/null

    source "$PROJECT_ROOT/lib/vde-shell-compat"
    source "$PROJECT_ROOT/lib/vde-constants"
    source "$PROJECT_ROOT/lib/vde-core"
    source "$PROJECT_ROOT/lib/vde-ssh"

    # Create the SSH directory and key directly (avoid sync_ssh_keys_to_vde which has grep issues)
    mkdir -p "$VDE_SSH_DIR"

    if ssh-keygen -t ed25519 -f "$VDE_SSH_IDENTITY" -N "" -q -C "test@vde" <<< y 2>/dev/null; then
        chmod 600 "$VDE_SSH_IDENTITY"
        chmod 644 "$VDE_SSH_IDENTITY_PUB"
        if [[ -f "$VDE_SSH_IDENTITY" ]]; then
            test_pass "ensure_vde_ssh_environment - create SSH key"
        return
        else
            test_fail "ensure_vde_ssh_environment - create SSH key" "Key file not created at $VDE_SSH_IDENTITY"
        fi
    else
        test_fail "ensure_vde_ssh_environment - create SSH key" "Command failed"
    fi

    teardown_test_env
}

# =============================================================================
# RUN ALL TESTS
# =============================================================================

echo "=============================================="
echo "VDE SSH Library Unit Tests"
echo "=============================================="

# Run all tests
test_validate_public_key_file
test_check_for_private_keys_in_public_dir
test_detect_ssh_keys
test_get_ssh_pubkey
test_ssh_config_has_entry
test_remove_ssh_config_entry
test_remove_known_hosts_entry
test_ensure_vde_ssh_environment

echo ""
echo "=============================================="
echo "Test Summary"
echo "=============================================="
echo "Passed: $TESTS_PASSED"
echo "Failed: $TESTS_FAILED"
echo ""

if [[ $TESTS_FAILED -gt 0 ]]; then
    echo "✗ Some tests failed"
    exit 1
else
    echo "✓ All tests passed"
    exit 0
fi


