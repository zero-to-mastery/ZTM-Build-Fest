# VDE Test Suite Documentation
<!-- @armor (Engine Test Suite) -->

Complete testing documentation for the Virtual Development Environment (VDE) system.

## Overview

The VDE test suite provides comprehensive coverage across three testing levels:

- **Feature Tests** (BDD-style) - High-level acceptance tests in Gherkin syntax
- **Unit Tests** - Low-level function tests for individual libraries
- **Integration Tests** - End-to-end workflow tests

## Test Structure

```
tests/
├── run-all-known-tests.sh              # Run ALL tests (unit + integration)
├── README.md                            # This file - test suite documentation
├── run-docker-free-tests.sh            # Docker-free tests only (fast, parser logic)
├── run-docker-required-tests.sh        # Docker-required tests (containers, SSH)
├── test-bdd-in-container.sh            # BDD tests in container (Docker-in-Docker, CI)
├── test-e2e-user-journey.sh            # End-to-end user journey test
├── generate-user-guide.sh              # Generate user guide from BDD results
├── bug-fix-validation.test.sh          # Bug fix validation tests
├── features/                            # BDD feature specifications
│   ├── README.md                        # Feature files overview
│   ├── steps/                           # BDD step definitions (Python)
│   │   ├── README.md                    # Step definitions directory guide
│   │   ├── config.py                    # Test configuration
│   │   ├── vm_common.py                 # Shared helper functions
│   │   ├── ssh_helpers.py               # SSH-specific helpers
│   │   ├── vm_creation_steps.py         # VM creation steps
│   │   ├── vm_status_steps.py           # VM status checks
│   │   ├── vm_operations_steps.py       # Basic VM operations
│   │   ├── vm_docker_build_steps.py     # Docker build operations
│   │   ├── vm_docker_network_steps.py   # Docker networking
│   │   ├── vm_docker_service_steps.py   # Docker service VMs
│   │   ├── installation_steps.py        # Installation setup
│   │   ├── post_install_verification_steps.py  # Post-install checks
│   │   ├── uninstallation_steps.py      # Uninstallation cleanup
│   │   ├── ssh_config_verification_steps.py    # SSH config checks
│   │   ├── vm_state_verification_steps.py      # VM state verification
│   │   ├── ssh_connection_steps.py      # SSH connection testing
│   │   ├── user_workflow_steps.py       # User environment workflows
│   │   ├── team_collaboration_steps.py  # Team onboarding
│   │   ├── port_management_steps.py     # Port allocation
│   │   ├── cache_steps.py               # Cache system
│   │   ├── parser_steps.py              # Command parser
│   │   ├── template_steps.py            # Template rendering
│   │   ├── config_steps.py              # VM configuration
│   │   ├── ssh_agent_steps.py           # SSH agent management
│   │   └── daily_workflow_steps.py      # Daily workflows
│   ├── vm-lifecycle.feature            # VM creation/start/stop workflows
│   ├── port-management.feature         # Port allocation and collision detection
│   ├── ssh-configuration.feature       # SSH agent and config management
│   ├── natural-language-parser.feature # AI command parser
│   ├── template-system.feature         # Template rendering engine
│   ├── shell-compatibility.feature     # Cross-shell compatibility
│   ├── cache-system.feature            # Cache invalidation and persistence
│   └── docker-operations.feature       # Docker Compose operations
├── run-docker-free-tests.sh            # Docker-free tests only (fast, parser logic)
├── run-docker-required-tests.sh        # Docker-required tests (containers, SSH)
├── test-bdd-in-container.sh            # BDD tests in container (Docker-in-Docker, CI)
├── test-e2e-user-journey.sh            # End-to-end user journey test
├── generate-user-guide.sh              # Generate user guide from BDD results
├── bug-fix-validation.test.sh          # Bug fix validation tests
├── features/                            # BDD feature specifications
│   ├── vm-lifecycle.feature            # VM creation/start/stop workflows
│   ├── port-management.feature         # Port allocation and collision detection
│   ├── ssh-configuration.feature       # SSH agent and config management
│   ├── natural-language-parser.feature # AI command parser
│   ├── template-system.feature         # Template rendering engine
│   ├── shell-compatibility.feature     # Cross-shell compatibility
│   ├── cache-system.feature            # Cache invalidation and persistence
│   └── docker-operations.feature       # Docker Compose operations
├── unit/                                # Unit tests per library
│   ├── vm-common.test.sh               # Core VM management functions
│   ├── .test.sh        # Shell compatibility layer
│   └── vde-parser.test.sh              # Natural language parser
└── integration/                         # Integration tests
    └── vm-lifecycle-integration.test.sh # End-to-end VM workflows
```

## Running Tests

### Run All Tests

```zsh
./tests/run-all-known-tests.sh
```

### Run Specific Test Categories

```zsh
# Bug fix validation only
./tests/run-all-known-tests.sh bug-fix

# Unit tests only
./tests/run-all-known-tests.sh unit

# Integration tests only
./tests/run-all-known-tests.sh integration

# Specific test file
./tests/run-all-known-tests.sh unit/vm-common
```

### Run Individual Test Files

```zsh
# Bug fix validation
./tests/bug-fix-validation.test.sh

# Unit tests
./tests/unit/vm-common.test.sh
./tests/unit/.test.sh
./tests/unit/vde-parser.test.sh

# Integration tests
./tests/integration/vm-lifecycle-integration.test.sh
```

### Options

```zsh
# Verbose output
./tests/run-all-known-tests.sh -v
./tests/run-all-known-tests.sh --verbose

# List available tests
./tests/run-all-known-tests.sh --list

# Show help
./tests/run-all-known-tests.sh --help
```

## Test Coverage

### Feature Tests (BDD)

#### vm-lifecycle.feature
- Creating new language and service VMs
- Starting and stopping VMs (single and multiple)
- Restarting VMs with rebuild options
- Listing VMs with filters
- Removing VMs
- Adding new VM types
- Error handling for duplicate/non-existent VMs

#### port-management.feature
- Port allocation for language and service VMs
- Sequential port allocation
- Port registry persistence
- Host port collision detection
- Docker port collision detection
- Atomic port reservation (race condition prevention)
- Port range validation
- Lock cleanup and stale lock removal

#### ssh-configuration.feature
- Automatic SSH agent starting
- SSH key generation
- Public key synchronization
- SSH config entry creation (with merge tests)
- VM-to-VM SSH communication
- SSH key type detection
- **SSH Config Merge Tests** (Critical):
  - Merging new entries with existing config
  - Preserving user's custom SSH settings
  - Atomic merge to prevent corruption
  - Temporary file then atomic rename
  - Creating SSH config if it doesn't exist
  - Preserving blank lines and formatting
  - Concurrent update handling
  - Backup creation before modification

#### natural-language-parser.feature
- Intent detection for all operations
- Entity extraction (VM names, aliases)
- Filter extraction (lang/svc/all)
- Flag parsing (rebuild, no-cache)
- VM alias resolution
- Security validation (dangerous characters)
- Plan generation and validation

#### template-system.feature
- Language VM template rendering
- Service VM template rendering
- Variable substitution
- Special character escaping
- SSH agent forwarding configuration
- Network configuration
- Volume mount configuration

#### shell-compatibility.feature
- Shell detection (zsh, bash 3.x, bash 4+)
- Native vs file-based associative arrays
- Cross-shell associative array operations
- Special character handling (hex encoding)
- Key collision prevention
- Script path detection
- Cleanup on exit

#### cache-system.feature
- VM types caching
- Cache validation (mtime comparison)
- Cache invalidation
- Port registry caching
- Cache bypass with --no-cache
- Lazy loading

#### docker-operations.feature
- Docker Compose build/start/stop
- Rebuild with/without cache
- Error handling (port conflicts, network, disk space)
- Transient failure retry
- Container status detection
- Project naming conventions
- Volume mounts

### Unit Tests

#### vm-common.test.sh
**Tests core VM management functions:**

- VM Type Loading
  - `load_vm_types` - Load and parse vm-types.conf
  - `cache_vm_types` - Create cache file
  - `load_from_cache` - Load from cached data

- VM Info Queries
  - `get_vm_info type` - Get VM type (lang/svc)
  - `get_vm_info display` - Get display name
  - `get_vm_info install` - Get install command

- VM Discovery
  - `get_all_vms` - Get all VM names
  - `get_lang_vms` - Get language VMs only
  - `get_service_vms` - Get service VMs only
  - `is_known_vm` - Check if VM is defined
  - `resolve_vm_name` - Resolve alias to canonical name

- Port Management
  - `get_allocated_ports` - Get allocated ports
  - Port range constants validation
  - `acquire_lock` / `release_lock` - File locking
  - `lock_timeout` - Timeout behavior

- Docker Compose Functions
  - `get_compose_file` - Get docker-compose.yml path
  - `build_docker_opts` - Build docker-compose options

- Template Rendering
  - `render_template` - Basic variable substitution
  - Special character escaping

- VM Existence
  - `vm_exists` - Check if VM is created
  - Negative case handling

- Validation Functions
  - `validate_vm_name` - Name format validation
  - Empty/invalid character handling

- Logging Functions
  - `log_info` / `log_error` - Logging output

- Return Codes
  - All VDE_ERR_* constants

- Directory Constants
  - All directory path constants

#### .test.sh
**Tests shell compatibility layer:**

- Shell Detection
  - `_detect_shell` - zsh/bash detection
  - `_is_zsh` / `_is_bash` - Type checks
  - `_shell_version` - Version detection
  - `_bash_version_major` - Major version extraction

- Associative Array Operations
  - `_assoc_init` - Initialize array
  - `_assoc_set` / `_assoc_get` - Set/get values
  - `_assoc_keys` - Get all keys
  - `_assoc_has_key` - Check key existence
  - `_assoc_unset` - Remove key
  - `_assoc_clear` - Clear all entries

- Special Character Handling
  - **Hex encoding for key collision prevention**
  - Complex key handling (slashes, dashes, dots)
  - Key enumeration preserves original keys
  - Empty key handling

- Multiple Independent Arrays
  - Array isolation test

- Script Path Detection
  - `_get_script_path` - Get current script path
  - `_get_script_dir` - Get script directory

- Native Support Detection
  - `_shell_supports_native_assoc` - Check for native arrays

#### vde-parser.test.sh
**Tests natural language parser:**

- Intent Detection
  - List intent (8 variations)
  - Create intent (4 variations)
  - Start intent (3 variations)
  - Stop intent (3 variations)
  - Restart intent (3 variations)
  - Status intent (3 variations)
  - Connect intent (3 variations)
  - Help intent (3 variations)

- Entity Extraction
  - `extract_vm_names` - Extract VM names from input
  - "all" handling
  - Alias resolution
  - `extract_filter` - lang/svc/all filter
  - `extract_flags` - rebuild/nocache flags

- Plan Generation
  - `generate_plan` - Create execution plan
  - Intent + VMs + FLAGS output

- Security Validation
  - `validate_plan_line` - Whitelist validation
  - Invalid key rejection
  - Dangerous character detection
  - `contains_dangerous_chars` - Metacharacter check
  - `parse_flags` - Safe flag parsing

- Alias Map
  - `_build_alias_map` - Build O(1) lookup map
  - `_lookup_vm_by_alias` - Fast alias lookup
  - `invalidate_alias_map` - Force rebuild

- Source Guard
  - `_VDE_PARSER_LOADED` flag check

### Integration Tests

#### vm-lifecycle-integration.test.sh
**End-to-end VM workflow tests:**

- VM Type Discovery
  - Types can be loaded
  - Required fields present

- Port Allocation
  - Basic allocation
  - Sequential allocation
  - Registry tracking

- Template Rendering
  - Language VM template
  - Service VM template

- Directory Structure
  - All required directories exist

- File Operations
  - Lock acquire/release
  - Mutual exclusion

- SSH Configuration
  - SSH key detection
  - Config template exists

- Cache System
  - Cache directory exists
  - VM types caching
  - Cache invalidation

- VM Validation
  - Valid name acceptance
  - Invalid name rejection

- VM Resolution
  - Direct name resolution
  - Alias resolution
  - Unknown handling

- Compose File Path
  - Path construction

- Constants
  - All constants defined

### Bug Fix Validation Tests

#### bug-fix-validation.test.sh
**Validates that all bugs from bug hunts are fixed:**

1. **SSH Keys Handling (.pub files only)**
   - Only .pub files copied, not .keep or other files

2. **Port Collision Detection**
   - lsof, netstat, docker port checking

3. **Key Collision Prevention (hex encoding)**
   - "a/b" and "a_b" don't collide

4. **apt-key Deprecation Fix**
   - Modern GPG keyring with signed-by

5. **Architecture Detection**
   - No hardcoded architecture

6. **Host Access Script Removal**
   - Broken host-sh script removed

7. **Dockerfile SSH Keys Build**
   - Handles empty keys directory

8. **Container Name Regex Allows Numbers** (NEW)
   - [a-z0-9] allows names like "python3"

9. **Parser Removes # Character** (NEW)
   - Unsafe comment character removed

10. **start-virtual Checks VM Existence** (NEW)
    - Validates VM is created before starting

11. **add-vm-type Uses Portable Syntax** (NEW)
    - Uses is_known_vm vs zsh-specific syntax

12. **vde-commands Properly Quotes Aliases** (NEW)
    - Aliases properly quoted

## Test Development Guidelines

### Writing New Tests

1. **Unit Tests**: Add to `tests/unit/<library>.test.sh`
2. **Integration Tests**: Add to `tests/integration/<feature>-integration.test.sh`
3. **Feature Tests**: Add to `tests/features/<feature>.feature`

### Test File Template

```zsh
#!/usr/bin/env zsh
# Unit Tests for <library>
# Tests <description>

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source dependencies
source "$PROJECT_ROOT/lib/"
source "$PROJECT_ROOT/lib/vde-constants"
source "$PROJECT_ROOT/lib/<library>"

# Test configuration
TESTS_PASSED=0
TESTS_FAILED=0

# Colors
if [[ -t 1 ]]; then
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[0;33m'
    RESET='\033[0m'
else
    GREEN=''
    RED=''
    YELLOW=''
    RESET=''
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

# Test functions here
test_<feature>() {
    test_start "<description>"

    # Test logic
    if <condition>; then
        test_pass "<description>"
        return
    fi

    test_fail "<description>" "reason"
}

main() {
    echo ""
    echo "=========================================="
    echo "Unit Tests: <library>"
    echo "=========================================="
    echo ""

    # Run tests
    test_<feature>
    # ... more tests

    # Print summary
    echo ""
    echo "=========================================="
    echo "Test Summary"
    echo "=========================================="
    echo -e "${GREEN}Passed:  $TESTS_PASSED${RESET}"
    echo -e "${RED}Failed:  $TESTS_FAILED${RESET}"
    echo ""

    local total=$((TESTS_PASSED + TESTS_FAILED))
    echo "Total:   $total"

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "\n${GREEN}All tests passed!${RESET}\n"
        exit 0
    else
        echo -e "\n${RED}Some tests failed!${RESET}\n"
        exit 1
    fi
}

main "$@"
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run Tests
        run: ./tests/run-all-known-tests.sh
```

### Pre-commit Hook

```zsh
#!/usr/bin/env zsh
# .git/hooks/pre-commit

./tests/run-all-known-tests.sh unit || exit 1
```

## Test Coverage Matrix

| Component | Feature Tests | Unit Tests | Integration Tests |
|-----------|--------------|------------|-------------------|
| VM Lifecycle | ✓ | ✓ | ✓ |
| Port Management | ✓ | ✓ | ✓ |
| SSH Configuration | ✓ | ✓ | ✓ |
| Natural Language Parser | ✓ | ✓ | - |
| Template System | ✓ | ✓ | ✓ |
| Shell Compatibility | ✓ | ✓ | - |
| Cache System | ✓ | ✓ | ✓ |
| Docker Operations | ✓ | - | ✓ |
| Bug Fixes | ✓ | - | - |

## CRITICAL POLICIES

### ⚠️ Production Config Protection Policy

**NEVER delete or modify production VM configurations in tests.**

#### Protected Files (NEVER delete):

1. **`configs/docker/<language>/docker-compose.yml`** - VM configuration files
   - Examples: `configs/docker/python/docker-compose.yml`, `configs/docker/rust/docker-compose.yml`
   - These are developer infrastructure that must persist

2. **`env-files/<service>.env`** - Service environment files
   - Examples: `env-files/postgres.env`, `env-files/redis.env`
   - These define service configuration and must not be removed

#### Test VM Naming Rules

Integration tests MUST use **test-only VM names** that will never match production VM types:

```zsh
# ✅ CORRECT - Test-only names
TEST_LANG_VM="vde-test-lang"    # Not in vm-types.conf
TEST_SVC_VM="vde-test-svc"      # Not in vm-types.conf
TEST_LANG_VM2="vde-test-lang2"  # Not in vm-types.conf

# ❌ WRONG - Production VM names (DELETES PRODUCTION CONFIGS!)
TEST_LANG_VM="python"    # Matches real VM type
TEST_SVC_VM="postgres"  # Matches real service
```

#### Safe Naming Conventions

| Convention | Example | Safe? |
|------------|---------|-------|
| `vde-test-*` | `vde-test-lang`, `vde-test-svc` | ✅ Yes |
| `e2e-test-*` | `e2e-test-go`, `e2e-test-minio` | ✅ Yes |
| `test-*` | `test-python`, `test-postgres` | ⚠️ Borderline |
| Production names | `python`, `postgres`, `rust` | ❌ NO |

#### Historical Context

This policy was established after a critical bug where integration tests used production VM names (`python`, `postgres`), causing test cleanup to delete actual developer configurations. See commit `dfd2303` for the fix.

### Fake Test Prohibition Policy

**NEVER use fake test patterns in BDD step implementations.**

Forbidden patterns (see `/GEMINI.md`):
1. `assert True` - Always-passing assertions
2. `context.xxx = True` - Setting flags without real verification
3. `pass` statements in `@then` steps - Silent bypass of verification

All tests must use **real verification**:
- `subprocess.run()` for actual command execution
- `Path.exists()` for real file checks
- `docker ps`, `docker inspect` for container state

## Known Limitations

1. **Docker-dependent tests**: Integration tests may require Docker to be running
2. **Port conflicts**: Tests using real ports may fail if ports are in use
3. **File system tests**: Some tests create temporary files in /tmp

## Contributing

When adding new features:
1. Write feature tests first (BDD scenarios)
2. Write unit tests for new functions
3. Update integration tests if needed
4. Run full test suite before committing
5. Update this documentation if adding new test files

## Troubleshooting

### Tests fail with "command not found"
- Ensure zsh is installed: `which zsh`
- Some tests require Docker: `docker --version`

### Port allocation tests fail
- Check if test ports (2900-2999) are available
- Run: `lsof -i :2900-2999`

### Cache-related tests fail
- Clear cache: `rm -rf .cache/`
- Reload: `load_vm_types --no-cache`
