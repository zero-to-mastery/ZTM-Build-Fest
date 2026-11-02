# GitHub CI Test Restrictions
<!-- @forge (Governance Sentinel) -->

**Status:** All `docker-required/` tests CANNOT run on GitHub CI due to Docker-in-Docker limitations.

---

## Overview

GitHub Actions CI cannot run tests that require actual Docker container operations (Docker-in-Docker is not supported). This document details what can and cannot be tested on GitHub CI versus locally.

---

## Test Architecture

### Docker-Free Tests (Run on GitHub CI ✅)

**Location:** `tests/features/docker-free/`
**Runner:** `./tests/run-docker-free-tests.sh`
**Status:** **158/158 scenarios passing (100%)** ✅

| Feature | Status | Description |
|--------|--------|-------------|
| cache-system | ✅ CI compatible | Cache system operations |
| documented-development-workflows | ✅ CI compatible | Documentation workflow tests |
| vm-information-and-discovery | ✅ CI compatible | VM information display |
| natural-language-parser | ✅ CI compatible | NL parser functionality |
| shell-compatibility | ✅ CI compatible | Shell compatibility layer |

**All docker-free tests run on GitHub CI with every push/PR.**

---

### Docker-Required Tests (Local Only ⚠️)

**Location:** `tests/features/docker-required/`
**Runner:** `./tests/run-local-bdd.sh`
**Status:** **397/397 scenarios passing (100%)** but CANNOT run on GitHub CI

**Reason:** Tests tagged with `@requires-docker-host` or `@requires-docker-ssh` require actual Docker operations that GitHub CI cannot perform.

---

## Docker-Required Features (GitHub Incompatible)

All 27 docker-required features are tagged with GitHub-incompatible tags:

| Feature | Tag | Reason |
|--------|-----|--------|
| ai-assistant-integration | `@requires-docker-host` | Requires actual container operations |
| ai-assistant-workflow | `@requires-docker-host` | Requires actual container creation/start |
| collaboration-workflow | `@requires-docker-host` | Requires VM operations |
| configuration-management | `@requires-docker-host` | Requires actual Docker config manipulation |
| daily-development-workflow | `@requires-docker-host` | Requires actual VM lifecycle operations |
| debugging-troubleshooting | `@requires-docker-host` | Requires actual Docker operations |
| docker-and-container-management | `@requires-docker-host` | Requires Docker container operations |
| docker-operations | `@requires-docker-host` | Requires actual Docker daemon access |
| error-handling-and-recovery | `@requires-docker-host` | Requires actual Docker operations |
| installation-setup | `@requires-docker-host` | Requires actual VM creation |
| multi-project-workflow | `@requires-docker-host` | Requires multiple VM operations |
| natural-language-commands | `@requires-docker-host` | Requires actual VM operations |
| port-management | `@requires-docker-host` | Requires port allocation |
| productivity-features | `@requires-docker-host` | Requires actual VM operations |
| ssh-agent-automatic-setup | `@requires-docker-host` | Requires SSH agent operations |
| ssh-agent-external-git-operations | `@requires-docker-host` | Requires actual SSH/git operations |
| ssh-agent-forwarding-vm-to-vm | `@requires-docker-host` | Requires VM-to-VM SSH |
| ssh-agent-vm-to-host-communication | `@requires-docker-host` | Requires VM operations |
| ssh-and-remote-access | `@requires-docker-host` | Requires actual SSH access |
| ssh-configuration | `@requires-docker-ssh` | Requires SSH config file modification |
| team-collaboration-and-maintenance | `@requires-duct-host` | Requires VM operations |
| template-system | `@requires-docker-host` | Requires template generation |
| vm-lifecycle-management | `@requires-docker-host` | Requires VM lifecycle operations |
| vm-lifecycle | `@requires-docker-host` | Requires actual VM creation/start/stop |
| vm-state-awareness | `@requires-docker-host` | Requires actual VM state tracking |

---

## Why Docker-in-Docker Doesn't Work on GitHub CI

**Technical Limitation:** GitHub Actions runners run in containers. Running Docker containers inside another container (Docker-in-Docker) requires special privileged mode that:

1. **Security risk** - Requires `--privileged` flag which is blocked by GitHub security policies
2. **Performance issues** - Nested containers have poor performance
3. **Path mapping conflicts** - Host paths like `~/dev` don't map inside CI containers
4. **Network isolation** - CI containers can't access host Docker daemon reliably

---

## How to Run Docker-Required Tests Locally

```zsh
# Run all docker-required tests locally
./tests/run-local-bdd.sh

# Run specific feature
./tests/run-local-bdd.sh vm-lifecycle

# Run with JSON output for User Guide generation
./tests/run-local-bdd.sh --json -o tests/behave-results.json
```

**Expected Results:**
- All 491 scenarios pass (100%)
- 31 features pass (all docker-free + docker-required)
- 0 failures, 0 errors

---

## CI/CD Status

| Metric | Value |
|--------|-------|
| **GitHub CI tests** | 158/158 scenarios (100% - docker-free only) |
| **Full test suite (local)** | 494/494 scenarios (100%) |
| **Test coverage** | 100% of all scenarios have step definitions |

---

## See Also

- `tests/TEST_SEPARATION.md` - Detailed test separation documentation
- `tests/run-docker-free-tests.sh` - Fast test runner for CI (docker-free only)
- `tests/run-docker-required-tests.sh` - Full test runner for local testing
- `.github/workflows/vde-ci.yml` - GitHub Actions workflow definition
