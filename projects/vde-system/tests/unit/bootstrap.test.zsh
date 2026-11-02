#!/usr/bin/env zsh
# @forge (Governance Sentinel)
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Unit Tests for scripts/bootstrap.sh
# Tests the front-door onboarding script in controlled environments.
# Bootstrap is a bash script that runs BEFORE VDE is installed, so these
# tests execute it directly in mocked environments rather than sourcing it.

typeset SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
typeset PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
typeset BOOTSTRAP="${PROJECT_ROOT}/scripts/bootstrap.sh"

# Test configuration
typeset VERBOSE=${VERBOSE:-false}
typeset TESTS_PASSED=0
typeset TESTS_FAILED=0

# Colors
if [[ -t 1 ]]; then
    typeset GREEN='\033[0;32m'
    typeset RED='\033[0;31m'
    typeset YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    RESET='\033[0m'
else
    typeset GREEN='' RED='' YELLOW='' CYAN='' RESET=''
fi

test_start() { echo -e "${YELLOW}[TEST]${RESET} $1" }
test_pass()  { echo -e "${GREEN}[PASS]${RESET} $1"; ((TESTS_PASSED++)) }
test_fail()  { echo -e "${RED}[FAIL]${RESET} $1: $2"; ((TESTS_FAILED++)) }

# =============================================================================
# Helpers: build a fake PATH to control what commands bootstrap can "see"
# =============================================================================

# Create a temporary bin directory with only the commands we want present
typeset MOCK_BIN=""
typeset ORIGINAL_PATH="${PATH}"

mock_bin_setup() {
    MOCK_BIN="$(mktemp -d)"
    # Symlink essential tools that bootstrap needs but are NOT under test
    for tool in bash uname grep head cat sed mkdir cp chmod rm find sleep tr; do
        local resolved
        resolved=$(command -v "${tool}" 2>/dev/null)
        [[ -n "${resolved}" ]] && ln -sf "${resolved}" "${MOCK_BIN}/${tool}"
    done
}

mock_bin_add() {
    local cmd="$1"
    local shift_arg="$2"
    # Remove any existing file or symlink before writing
    rm -f "${MOCK_BIN}/${cmd}"
    # Create a fake command that simulates version output
    cat > "${MOCK_BIN}/${cmd}" <<MOCK
#!/usr/bin/env bash
${shift_arg}
echo "mock-${cmd}-version"
MOCK
    chmod +x "${MOCK_BIN}/${cmd}"
}

mock_bin_add_docker() {
    # Docker needs special handling: bootstrap runs "docker version"
    # and also "docker info"
    rm -f "${MOCK_BIN}/docker"
    cat > "${MOCK_BIN}/docker" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "info" ]]; then
    echo "Mock Docker info"
    exit 0
fi
echo "Docker version mock-27.0.0"
MOCK
    chmod +x "${MOCK_BIN}/docker"
}

mock_bin_add_docker_dead() {
    # Docker installed but daemon not running
    rm -f "${MOCK_BIN}/docker"
    cat > "${MOCK_BIN}/docker" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "info" ]]; then
    echo "Cannot connect to the Docker daemon" >&2
    exit 1
fi
echo "Docker version mock-27.0.0"
MOCK
    chmod +x "${MOCK_BIN}/docker"
}

mock_bin_teardown() {
    if [[ -n "${MOCK_BIN}" && -d "${MOCK_BIN}" ]]; then
        rm -rf "${MOCK_BIN}"
    fi
    MOCK_BIN=""
}

# Run bootstrap with a controlled PATH (only our mock bin)
# We include /usr/bin only for env (needed for shebang) but strip
# everything else so real system tools don't leak through.
run_bootstrap() {
    PATH="${MOCK_BIN}" bash "${BOOTSTRAP}" 2>&1
}

# =============================================================================
# TEST 1: All 4 pillars present → proceeds to clone phase
# =============================================================================
test_all_pillars_present() {
    test_start "all 4 pillars present → proceeds to clone"

    mock_bin_setup
    mock_bin_add "zsh"    'shift 2>/dev/null'
    mock_bin_add "git"    'shift 2>/dev/null'
    mock_bin_add_docker
    mock_bin_add "ssh"    'shift 2>/dev/null'

    local output
    output=$(run_bootstrap)
    local rc=$?

    if [[ "${rc}" -ne 0 ]]; then
        # It probably tried to git clone and failed — that's expected.
        # We're verifying it got PAST the pillar checks.
        if echo "${output}" | grep -q "All pillars strong"; then
            test_pass "all 4 pillars present → proceeds to clone"
        else
            test_fail "all 4 pillars present" "Did not reach 'All pillars strong'. Output: ${output}"
        fi
    else
        if echo "${output}" | grep -q "All pillars strong"; then
            test_pass "all 4 pillars present → proceeds to clone"
        else
            test_fail "all 4 pillars present" "Passed but missing expected output"
        fi
    fi

    mock_bin_teardown
}

# =============================================================================
# TEST 2: Missing Zsh → reports missing, exits 1
# =============================================================================
test_missing_zsh() {
    test_start "missing zsh → reports and exits 1"

    mock_bin_setup
    # Deliberately NOT adding zsh — only docker and ssh
    mock_bin_add_docker
    mock_bin_add "ssh"    'shift 2>/dev/null'
    # git is needed for the uname check in detect_platform
    mock_bin_add "git"    'shift 2>/dev/null'

    local output
    output=$(run_bootstrap)
    local rc=$?

    if [[ "${rc}" -eq 1 ]] && echo "${output}" | grep -q "Zsh"; then
        test_pass "missing zsh → reports and exits 1"
    else
        test_fail "missing zsh" "Expected exit 1 with 'Zsh' in output. rc=${rc}, output: ${output}"
    fi

    mock_bin_teardown
}

# =============================================================================
# TEST 3: Missing Git → reports missing, exits 1
# =============================================================================
test_missing_git() {
    test_start "missing git → reports and exits 1"

    mock_bin_setup
    mock_bin_add "zsh"    'shift 2>/dev/null'
    # Deliberately NOT adding git
    mock_bin_add_docker
    mock_bin_add "ssh"    'shift 2>/dev/null'
    # uname is needed for platform detection

    local output
    output=$(run_bootstrap)
    local rc=$?

    if [[ "${rc}" -eq 1 ]] && echo "${output}" | grep -q "Git"; then
        test_pass "missing git → reports and exits 1"
    else
        test_fail "missing git" "Expected exit 1 with 'Git' in output. rc=${rc}, output: ${output}"
    fi

    mock_bin_teardown
}

# =============================================================================
# TEST 4: Missing Docker → reports missing, exits 1
# =============================================================================
test_missing_docker() {
    test_start "missing docker → reports and exits 1"

    mock_bin_setup
    mock_bin_add "zsh"    'shift 2>/dev/null'
    mock_bin_add "git"    'shift 2>/dev/null'
    # Deliberately NOT adding docker
    mock_bin_add "ssh"    'shift 2>/dev/null'

    local output
    output=$(run_bootstrap)
    local rc=$?

    if [[ "${rc}" -eq 1 ]] && echo "${output}" | grep -q "Docker"; then
        test_pass "missing docker → reports and exits 1"
    else
        test_fail "missing docker" "Expected exit 1 with 'Docker' in output. rc=${rc}, output: ${output}"
    fi

    mock_bin_teardown
}

# =============================================================================
# TEST 5: Missing SSH → reports missing, exits 1
# =============================================================================
test_missing_ssh() {
    test_start "missing ssh → reports and exits 1"

    mock_bin_setup
    mock_bin_add "zsh"    'shift 2>/dev/null'
    mock_bin_add "git"    'shift 2>/dev/null'
    mock_bin_add_docker
    # Deliberately NOT adding ssh
    # uname needed for platform detection

    local output
    output=$(run_bootstrap)
    local rc=$?

    if [[ "${rc}" -eq 1 ]] && echo "${output}" | grep -q "SSH"; then
        test_pass "missing ssh → reports and exits 1"
    else
        test_fail "missing ssh" "Expected exit 1 with 'SSH' in output. rc=${rc}, output: ${output}"
    fi

    mock_bin_teardown
}

# =============================================================================
# TEST 6: Docker installed but daemon not running → warns and exits 1
# =============================================================================
test_docker_daemon_not_running() {
    test_start "docker daemon not running → warns and exits 1"

    mock_bin_setup
    mock_bin_add "zsh"    'shift 2>/dev/null'
    mock_bin_add "git"    'shift 2>/dev/null'
    mock_bin_add_docker_dead
    mock_bin_add "ssh"    'shift 2>/dev/null'

    local output
    output=$(run_bootstrap)
    local rc=$?

    if [[ "${rc}" -eq 1 ]] && echo "${output}" | grep -q "not running"; then
        test_pass "docker daemon not running → warns and exits 1"
    else
        test_fail "docker daemon not running" "Expected exit 1 with 'not running'. rc=${rc}, output: ${output}"
    fi

    mock_bin_teardown
}

# =============================================================================
# TEST 7: Fix hints include actionable install commands
# =============================================================================
test_fix_hints_are_actionable() {
    test_start "missing pillars show install hints"

    mock_bin_setup
    # Only zsh present — git, docker, ssh all missing
    mock_bin_add "zsh" 'shift 2>/dev/null'
    # uname needed for platform detection

    local output
    output=$(run_bootstrap)
    local rc=$?

    # Each missing pillar should be reported by name
    local all_hints=true
    for pillar in "Git" "Docker" "SSH"; do
        if ! echo "${output}" | grep -q "${pillar}"; then
            test_fail "fix hints actionable" "Missing pillar '${pillar}' not reported"
            all_hints=false
            break
        fi
    done

    if [[ "${all_hints}" == true ]]; then
        # Verify at least one hint contains actionable text
        if [[ "${rc}" -eq 1 ]] && echo "${output}" | grep -qi "install\|https://\|Run:"; then
            test_pass "missing pillars show install hints"
        else
            test_fail "fix hints actionable" "Hints missing actionable commands. rc=${rc}"
        fi
    fi

    mock_bin_teardown
}

# =============================================================================
# TEST 8: Platform detection — WSL2 identified via /proc/version
# =============================================================================
test_detect_wsl2() {
    test_start "WSL2 platform detected"

    mock_bin_setup
    mock_bin_add "zsh"    'shift 2>/dev/null'
    mock_bin_add "git"    'shift 2>/dev/null'
    mock_bin_add_docker
    mock_bin_add "ssh"    'shift 2>/dev/null'

    # Create a fake /proc/version that looks like WSL2
    local fake_proc
    fake_proc="$(mktemp)"
    echo "Linux version 5.15.0-microsoft-standard-WSL2" > "${fake_proc}"

    # Patch the bootstrap to use our fake /proc/version
    local patched
    patched="$(mktemp)"
    # Escape the fake_proc path for sed (slashes in tmp paths)
    local escaped_proc
    escaped_proc=$(echo "${fake_proc}" | sed 's/\//\\\//g')
    sed 's|/proc/version|'"${fake_proc}"'|g' "${BOOTSTRAP}" > "${patched}"
    chmod +x "${patched}"

    # Override uname to report Linux (WSL2 runs on Linux)
    # Remove the symlink first, then write our mock
    rm -f "${MOCK_BIN}/uname"
    cat > "${MOCK_BIN}/uname" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "-s" ]]; then
    echo "Linux"
else
    echo "Linux"
fi
MOCK
    chmod +x "${MOCK_BIN}/uname"

    local output
    output=$(PATH="${MOCK_BIN}" bash "${patched}" 2>&1)

    if echo "${output}" | grep -q "WSL"; then
        test_pass "WSL2 platform detected"
    else
        test_fail "detect WSL2" "Output did not contain 'WSL'. Output: ${output}"
    fi

    rm -f "${fake_proc}" "${patched}"
    mock_bin_teardown
}

# =============================================================================
# TEST 9: Re-running bootstrap prints re-run command on missing pillars
# =============================================================================
test_rerun_guidance() {
    test_start "missing pillars → shows re-run command"

    mock_bin_setup
    # Only zsh present
    mock_bin_add "zsh" 'shift 2>/dev/null'
    # uname needed for platform detection

    local output
    output=$(run_bootstrap)
    local rc=$?

    if [[ "${rc}" -eq 1 ]] && echo "${output}" | grep -q "bootstrap.sh"; then
        test_pass "missing pillars → shows re-run command"
    else
        # Strip ANSI codes for diagnostic
        local clean_output
        clean_output=$(echo "${output}" | sed 's/\x1b\[[0-9;]*m//g')
        test_fail "rerun guidance" "Expected exit 1 with 'bootstrap.sh' in output. rc=${rc}, last lines: ${clean_output[-200,-1]}"
    fi

    mock_bin_teardown
}

# =============================================================================
# TEST 10: Bootstrap script is valid bash syntax
# =============================================================================
test_syntax_valid() {
    test_start "bootstrap.sh has valid bash syntax"

    if bash -n "${BOOTSTRAP}" 2>/dev/null; then
        test_pass "bootstrap.sh has valid bash syntax"
    else
        test_fail "bash syntax" "bash -n returned errors"
    fi
}

# =============================================================================
# TEST 11: Bootstrap uses #!/usr/bin/env bash (not zsh)
# =============================================================================
test_shebang_is_bash() {
    test_start "bootstrap.sh shebang is bash (not zsh)"

    local shebang
    shebang=$(head -1 "${BOOTSTRAP}")

    if [[ "${shebang}" == "#!/usr/bin/env bash" ]]; then
        test_pass "bootstrap.sh shebang is bash (not zsh)"
    else
        test_fail "shebang" "Expected '#!/usr/bin/env bash', got '${shebang}'"
    fi
}

# =============================================================================
# TEST 12: VDE already cloned → updates instead of failing
# =============================================================================
test_existing_vde_updates() {
    test_start "existing ~/VDE directory → updates instead of failing"

    mock_bin_setup
    mock_bin_add "zsh"    'shift 2>/dev/null'
    mock_bin_add "git"    'shift 2>/dev/null'
    mock_bin_add_docker
    mock_bin_add "ssh"    'shift 2>/dev/null'

    # Create a fake existing VDE directory with a .git dir
    local fake_home
    fake_home="$(mktemp -d)"
    mkdir -p "${fake_home}/VDE/.git"
    # Stub git to succeed
    rm -f "${MOCK_BIN}/git"
    cat > "${MOCK_BIN}/git" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "clone" ]]; then
    echo "mock clone should NOT be called for existing dir"
    exit 1
fi
if [[ "$1" == "fetch" ]]; then
    echo "Fetching origin stable"
    exit 0
fi
if [[ "$1" == "reset" ]]; then
    echo "Resetting to origin/stable"
    exit 0
fi
echo "git $@"
exit 0
MOCK
    chmod +x "${MOCK_BIN}/git"

    # uname needed for platform detection

    # Run bootstrap with HOME overridden to our temp dir
    local output
    output=$(PATH="${MOCK_BIN}" HOME="${fake_home}" bash "${BOOTSTRAP}" 2>&1 || true)

    if echo "${output}" | grep -qi "Updating\|already exists\|fetch"; then
        test_pass "existing ~/VDE directory → updates instead of failing"
    else
        test_fail "existing VDE" "Expected update behavior. Output: ${output}"
    fi

    rm -rf "${fake_home}"
    mock_bin_teardown
}

# =============================================================================
# TEST 13: Fresh install → clones from stable
# =============================================================================
test_fresh_install_clones_stable() {
    test_start "fresh install → clones from stable branch"

    mock_bin_setup
    mock_bin_add "zsh"    'shift 2>/dev/null'
    mock_bin_add_docker
    mock_bin_add "ssh"    'shift 2>/dev/null'

    # Use a fake git that logs what it was told
    local fake_home
    fake_home="$(mktemp -d)"

    local git_log
    git_log="$(mktemp)"

    rm -f "${MOCK_BIN}/git"
    cat > "${MOCK_BIN}/git" <<'MOCK'
#!/usr/bin/env bash
echo "git $@" >> "MOCK_LOG_PLACEHOLDER"
if [[ "$1" == "clone" ]]; then
    mkdir -p "MOCK_HOME_PLACEHOLDER/VDE/.git"
    echo "Cloned"
    exit 0
fi
exit 0
MOCK
    # Replace placeholders (can't use them inside a quoted heredoc)
    sed -i '' "s|MOCK_LOG_PLACEHOLDER|${git_log}|g" "${MOCK_BIN}/git"
    sed -i '' "s|MOCK_HOME_PLACEHOLDER|${fake_home}|g" "${MOCK_BIN}/git"
    chmod +x "${MOCK_BIN}/git"

    # uname needed for platform detection

    # Run bootstrap
    PATH="${MOCK_BIN}" HOME="${fake_home}" bash "${BOOTSTRAP}" 2>&1 || true

    if [[ -f "${git_log}" ]] && grep -q "clone.*stable" "${git_log}"; then
        test_pass "fresh install → clones from stable branch"
    else
        local log_content
        log_content=$(cat "${git_log}" 2>/dev/null || echo "(empty)")
        test_fail "fresh clone" "Expected 'clone' and 'stable' in git log. Got: ${log_content}"
    fi

    rm -f "${git_log}"
    rm -rf "${fake_home}"
    mock_bin_teardown
}

# =============================================================================
# Main
# =============================================================================
main() {
    echo ""
    echo "Unit Tests: bootstrap.sh (The Front Door)"
    echo "==========================================="
    echo ""

    test_syntax_valid
    test_shebang_is_bash
    test_all_pillars_present
    test_missing_zsh
    test_missing_git
    test_missing_docker
    test_missing_ssh
    test_docker_daemon_not_running
    test_fix_hints_are_actionable
    test_detect_wsl2
    test_rerun_guidance
    test_existing_vde_updates
    test_fresh_install_clones_stable

    # Print summary
    echo ""
    echo "==========================================="
    echo "Test Summary"
    echo "==========================================="
    echo -e "${GREEN}Passed:  $TESTS_PASSED${RESET}"
    echo -e "${RED}Failed:  $TESTS_FAILED${RESET}"
    echo ""

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "\n${GREEN}All tests passed!${RESET}\n"
        exit 0
    else
        echo -e "\n${RED}Some tests failed!${RESET}\n"
        exit 1
    fi
}

main "$@"
