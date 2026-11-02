# VDE Testing Strategy

Scope: `dderyldowney/vde-system` (ZSH-native Docker "Spoke" environment), checked out at `ff77e79` (PR #476 merge).
Nothing here was committed to the repo. The test files are standalone and take `VDE_ROOT_DIR` as an input.

## How each claim below was verified

| Label | Meaning |
|---|---|
| **Executed** | Ran in a Linux sandbox with zsh 5.9, OpenSSH, and no Docker daemon. |
| **Read** | Established by reading source or file listings only. Not run. |

---

## 1. Where the suite stands today

**Inventory (Read):** 11 zsh unit files in `tests/unit/`, 3 zsh integration scripts, 28 BDD `.feature` files holding 107 scenarios, and a pytest config whose `testpaths` points only at `tests/unit` (which has no Python tests).

**Baseline run of `tests/unit/*.test.zsh` (Executed):**

| Result | Files |
|---|---|
| All pass | `vde-docker`, `vde-naming`, `vde-parser`, `vde-path-utils`, `vde-security`, `vde-shell-compat`, `vm-types-schema` |
| Failed until OpenSSH was installed, then 8/8 | `vde-ssh`. The environment was missing `ssh-keygen`, so this is not a bug. |
| Still failing | `vde-core` ("require docker": no Docker daemon here, so environmental). `bootstrap` ("fresh clone": a real portability bug, see finding F1). |
| Passes | `vde-schema-validation`: 17/17. It prints "Running: ..." lines and a summary instead of per-test PASS lines, which is why my first grep showed 0. |

## 2. Test plan by component

Pyramid target for this repo: many fast zsh unit tests on pure-logic libraries, a moderate number of Docker-free BDD scenarios, and few Docker-dependent integration scripts run locally or in a Docker-capable CI job.

| Area | What to test | Type | Coverage target | Existing state |
|---|---|---|---|---|
| **Parser input validation** (`lib/vde-parser`: `contains_dangerous_chars`, `validate_plan_line`, `parse_flags`, `validate_vm_name_security`) | Every metacharacter is rejected, whitelist of plan keys, flag values are strict booleans, state resets between calls | Unit, Docker-free | 100% of branches. This is the injection boundary for natural-language input. | Zero tests reference these functions (only a README mention). **Gap filled here.** |
| **Locking** (`lib/vm-lock`: `claim_lock`, `release_lock`, stale-lock buster, re-entrancy, FIFO tickets) | Claim/release cycle, depth counting, stale lock with dead owner, 10s grace period, `VDE_NO_LOCK` bypass | Unit, Docker-free | All branches except real multi-process contention | Only covered by a Docker-requiring integration script and BDD features. **Unit gap filled here.** |
| **Naming and sanitization** (`lib/vde-naming`) | Path-traversal inputs, prefix handling, validator rules | Unit | 100% of branches | Partly covered: 5 unit tests plus a BDD step for `vde_normalize_name`. **Lowest-value addition.** |
| **Shell-out boundary** (`lib/vde-docker`, `bin/vde`, `bin/vde-rebuild`) | Generated `docker compose` argument vectors, without a daemon, by putting a recording stub `docker` on `PATH` | Unit with test double | Every lifecycle command emits the expected argv | Only 3 tests in `vde-docker.test.zsh`. **Recommended next.** |
| **Rust rewrite parity** | Golden-file / characterization tests: feed identical inputs to the ZSH parser and the Rust port, diff outputs | Contract | 100% of `detect_intent` and `generate_plan` cases in a table | Not present. Highest-leverage item during the rewrite. |
| **SSH key flow** (`lib/vde-ssh`) | Key sync, `VDE_AUTHORIZED_KEY` injection, isolated-agent socket | Unit, needs `ssh-keygen` | Existing 8 tests pass | Adequate once OpenSSH exists. |
| **Spoke lifecycle end to end** | create, start, enter, stop, rebuild | Integration, Docker | Smoke path only | Exists (BDD plus `vm-lifecycle-integration.test.zsh`). Cannot run in this sandbox. |
| **Libraries with no test reference by name** | `vde-audit`, `vde-errors`, `vde-health`, `vde-metrics`, `vde-progress`, `vde-templates`, `vde-docker-state`, `vde-cluster-utils` | Unit | Start with `vde-errors`, `vde-docker-state`, `vde-templates` (pure logic) | Name-match grep only, so they may be covered indirectly through BDD. Treat as candidates, not confirmed gaps. |

**Skip:** the themed governance scripts (`*-tetrad`, `*-gospel-*`) beyond their own exit codes, and trivial constant definitions in `vde-constants`.

## 3. Example cases (these exist as runnable tests)

- `contains_dangerous_chars 'python; rm -rf /'` returns 0 (0 means "dangerous found", so the return value is inverted relative to the name).
- `validate_plan_line 'EVIL:python'` returns 2 and `validate_plan_line 'VM:$(id)'` returns 2.
- `parse_flags "rebuild=true force=true"` returns 2, and a later `parse_flags "nocache=true"` resets `rebuild` to `false`.
- `claim_lock` over a dead-owner lock older than 60s succeeds and takes ownership. The same lock aged under 10s is left alone.
- Two nested `claim_lock` calls give depth 2, and the first `release_lock` leaves the lock held.
- `vde_normalize_name '../../etc/passwd'` yields `etcpasswd`.

## 4. Results of the new tests

All **Executed** in this sandbox against the unmodified checkout.

| File | Checks | Result |
|---|---|---|
| `tests/parser-security.test.zsh` | 53 | 53 pass |
| `tests/vm-lock.test.zsh` | 24 | 24 pass |
| `tests/naming-traversal.test.zsh` | 31 | 31 pass |

- Three consecutive runs gave identical results (no flakiness observed).
- `zsh -n` syntax check is clean on all files.
- **Mutation check (Executed):** I deliberately broke the library in 9 ways (for example dropped `|` from the dangerous-character list, added `EVIL` to the key whitelist, removed the 10s grace period, broke the re-entrancy counter, stopped stripping unsafe characters in `vde_normalize_name`). The tests caught 8 of 9 on the first pass. The survivor exposed a hole in my own naming tests (no name with an inner dash), which I fixed and then re-ran: the mutant is now caught (2 failures), and the real code still passes 31/31.

**Not covered:** real multi-process lock contention and FIFO ordering across processes (would need concurrent subprocess tests with timing), and anything needing a Docker daemon.

## 5. Findings

| ID | Finding | Evidence | Severity |
|---|---|---|---|
| **F1** | `tests/unit/bootstrap.test.zsh` "fresh clone" uses `sed -i ''`, which is BSD/macOS syntax. On GNU sed it fails, so the placeholders are never substituted. The mock git then writes its log to a literal file named `MOCK_LOG_PLACEHOLDER` in the current directory. The test is macOS-only and pollutes the working tree on Linux. **Fixed in patch 0001** (verified: 13/13 pass, no stray file, and a mutation that removes `-b stable` from the clone is now caught). **The same `sed -i ''` pattern also appears in production scripts** `bin/vde-release.zsh` (7 places) and `bin/vde-heal-docs.zsh` (1 place), so those likely fail on Linux too. I did not change or run them. | Executed: test fails; `MOCK_LOG_PLACEHOLDER` appeared in the repo root; `sed -i '' s/a/b/ file` errors on GNU sed. Scripts: found by grep (Read only). | Medium for Linux/WSL2/CI users |
| **F2** | `validate_plan_line 'INTENT'` (no colon) is accepted. **Traced: harmless.** `execute_plan` then sees intent `INTENT`, reports "Unknown intent" and returns 2 (now asserted by a test). | Executed plus Read | Informational |
| **F3** | `contains_dangerous_chars` does not flag single quote, tilde, or newline. **Traced: not reachable as an injection.** The parser has no `eval`; `execute_plan` reads stdin line by line so a newline cannot smuggle a second key (asserted by a test); generated plans only carry VM names mapped through the alias table. **Residual, low:** in a hand-fed plan, unknown VM names only log a warning and are passed unquoted to `./bin/vde start/stop`. That is argument injection into VDE's own CLI, not shell injection, and `bin/vde stop` resolves each target and rejects unknowns. | Executed plus Read | Low |
| **F7** | `generate_plan` and `execute_plan` have **no caller** in `bin/`, `lib/` or `scripts/`; only the parser itself, its unit test, and `tests/README.md` mention them, and nothing sources `lib/vde-parser` except tests. At this commit the parser's validation layer is not wired into the `vde` CLI. | Read (grep across the repo) | Informational; lowers upstream value of the parser tests |
| **F8** | `bin/targeted-test.zsh` lists `tests/unit/vm-common.test.zsh`, which does not exist. | Executed `ls` | Low (tooling drift) |
| **F4** | `tests/README.md` lists 7 runner scripts (`run-all-known-tests.sh`, `run-docker-free-tests.sh`, `run-docker-required-tests.sh`, `test-bdd-in-container.sh`, `test-e2e-user-journey.sh`, `generate-user-guide.sh`, `bug-fix-validation.test.sh`) that do not exist in the checkout. | Executed `ls` check: all 7 missing | Low (doc drift) |
| **F5** | `pytest.ini` points `testpaths` at `tests/unit`, which contains only zsh tests. Plain `pytest` collects nothing. | Read | Low |
| **F6** | The test suite depends on the host having `ssh-keygen` and Docker. The unit tests do not skip cleanly when they are absent; they report failures. | Executed | Low |

## 6. What I'd actually upstream

Two patches are in `patches/` (they apply cleanly to a pristine checkout of `ff77e79`):

- **0001, bootstrap test portability.** Strongest case: fixes a real Linux failure and a stray-file side effect. Small and self-contained.
- **0002, parser validation and vm-lock unit tests.** Moderate case. `vm-lock` is concurrency-sensitive code with no unit test. The parser tests cover a security layer that, per F7, is not currently wired into the CLI, so their main value is as a regression net and as a behavior reference for the Rust rewrite.

`naming-traversal` is dropped: it mostly duplicates existing coverage.

## 7. Notes on repo conventions

The repo's `CLAUDE.md` and `.gemini/instructions.md` define a mandatory workflow (issue, feature branch, PR, user approval) and a startup ritual. I did not run the startup ritual or commit anything, since the work stayed outside the repo. If these tests are promoted, they would need to follow that Strike protocol.

## 8. Running

Preferred (repo-style, after applying the patches): `zsh tests/unit/vde-parser-validation.test.zsh`, `zsh tests/unit/vm-lock.test.zsh`, `zsh tests/unit/bootstrap.test.zsh`.

The first-round standalone versions (`tests/*.test.zsh` in this bundle) are superseded by the repo-style files in `repo-style/` and the patches, and are kept only for reference:

```zsh
VDE_ROOT_DIR=/path/to/vde-system zsh tests/parser-security.test.zsh
```

Requires zsh 5.x. No Docker needed.

## 9. Final verification of the patched tree (Executed)

Full `tests/unit/*.test.zsh` run with both patches applied: every file passes except `vde-core`, whose single failure is "require docker" (no Docker daemon in the sandbox). Results: `bootstrap` 13/13, `vde-parser-validation` 55/55, `vm-lock` 24/24, `vde-parser` 6/6, `vde-schema-validation` 17/17, `vde-shell-compat` 18/18, `vde-ssh` 8/8. Mutation checks on the reshaped tests: 7 of 7 caught (including the bootstrap "clone without stable" mutant).
