# Patches for vde-system (base: ff77e79)

Nothing has been committed. Apply from the repo root with `git apply patches/<file>`.
Both apply cleanly to a pristine checkout and are independent of each other.

## 0001: make the bootstrap "fresh clone" test portable
`tests/unit/bootstrap.test.zsh` built its mock `git` with `sed -i ''` (BSD-only). On GNU sed the
substitution fails, the test fails, and a file named `MOCK_LOG_PLACEHOLDER` is left in the working
directory. The patch writes the mock with an unquoted heredoc instead, so no `sed` is needed.
Verified: 13/13 pass on Linux, no stray file, and removing `-b stable` from `scripts/bootstrap.sh`
makes the test fail (so it still tests what it claims). Not run on macOS; the new form uses only
heredoc variable expansion, so it should behave the same there.
Note: `bin/vde-release.zsh` and `bin/vde-heal-docs.zsh` use the same `sed -i ''` pattern. Not touched here.

## 0002: add unit tests for parser input validation and vm-lock
New files `tests/unit/vde-parser-validation.test.zsh` (55 checks) and `tests/unit/vm-lock.test.zsh`
(24 checks), in the repo's existing test style. Docker-free. The `execute_plan` cases all abort
validation (or run the help intent) before any `./bin/vde` call. Mutation-checked: 7/7 deliberate
breakages caught. Not covered: real multi-process lock contention and FIFO ordering.
Caveat: `generate_plan`/`execute_plan` currently have no caller outside tests, so the parser tests
guard code the CLI does not yet use.

## 0003 - extract bin/vde handlers into lib/vde-actions (Phase 1, no behavior change)

Moves the 8 multi-line inline arms of `bin/vde` (start, stop, restart, remove, exec, enter, port, help) into
`vde_action_*` functions in a new `lib/vde-actions`. `bin/vde` shrinks 542 -> ~266 lines. Also adds the 8 names to
`_VDE_TRACE_HIDE` in `lib/vde-function-trace`. Independent of 0001/0002 (applies to pristine ff77e79; verified).
Bodies are verbatim, so the 10 trailing-whitespace warnings from `git apply` come from the original code.

Verification (all executed, fake docker/uptime/df):
- characterize.py: 381/381 recorded cases match the golden baseline from ff77e79 (stdout, stderr, rc, docker argv).
- trace_compare.py: 30/30 handler cases give equivalent function-trace output.
- BDD function-trace.feature 20/20; all 11 tests/unit files pass.
- Mutation checks: 11 mutants of the extraction (docker stop->kill, rm -f->rm in remove AND in start --force, wrong port
  field, restart->stop dispatch, enter->exec dispatch, missing source line, dropped final exit, edited help text,
  dropped status hand-off in stop and in remove). All caught. Note: the hand-off mutants are caught only by
  trace_compare and the BDD feature (they change the EXIT-trap trace, not stdout/rc), not by the 381 goldens.

Documented cosmetic differences in function-trace output: nested calls are indented one level deeper, and the
"N infrastructure hidden" count is +1 (or the line newly appears where it was 0).

errexit hazard found and fixed: the original arms ended in `[[ -n "$x" ]] && cmd`. At top level a false list does not
trigger `set -e`; inside a function it makes the function return 1 and the caller exits at once, skipping the EXIT trap
(trace display). Fix: the handler stores `$?` in `_VDE_ACTION_RC`, returns 0, and bin/vde ends with `exit ${_VDE_ACTION_RC:-0}`.

Known quirks deliberately preserved (exit codes, dropped args for audit/check-tetrad/spine-check/heal, dns-check);
they are to be fixed only as separate, labelled patches.

### Correction to the 0003 entry above
The first export of 0003 was missing the new file `lib/vde-actions` (new files were not staged when it was built), so
it did not produce a working tree. It was caught by building the tree from the patch files alone. 0003 has been
re-exported and now contains the file (mode 100755). Re-verified from patch files on a clean clone of ff77e79:
characterize.py 381/381, trace_compare.py 30/30, BDD function-trace 20/20, all 13 unit files pass.
The verification harness also had a flaw (results depended on leftover `.cache`/`.docker-state` in the tree being
tested); `characterize.py` and `trace_compare.py` now ignore that state and run each case in a throwaway copy.

## 0004 - fix `vde dns-check` (separate, behavior-changing)
Before: `vde dns-check ...` always died with `shift: shift count must be <= $#` (exit 1), because the flag loop
had already consumed "$@". Now `bin/vde` passes the typed words (`input_targets`) to `bin/vde-dns-check.zsh`.
Executed against a fake docker: `dns-check python postgres` -> PASS (rc 0); no arguments -> usage, rc 2;
failing ping -> "ICMP Handshake (Alias) FAILED", rc 1. Base gave the shift error in all cases.
Golden cases that change: `route.dns-check.noargs` and `route.dns-check.pair` (2 of 381).

## 0005 - forward typed arguments to audit / check-tetrad / spine-check / heal (latent)
Before: these four delegates always received no arguments. After: they receive the typed words.
None of vde-gospel-audit.zsh, vde-check-tetrad.zsh or vde-heal-docs.zsh reads arguments today, so there is no
visible behavior change; it only matters once something passes them (e.g. the parser). Golden cases that change:
9 each for audit, check-tetrad, spine-check, heal (36 of 381), and only in the recorded delegate argv.

## Applying
Canonical order 0001 -> 0005 (0001/0002 are plain diffs: `git apply`; 0003-0005 are mailbox patches: `git am`).
0003, 0004 and 0005 also apply alone to pristine ff77e79, and 0003+0004+0005 apply in other orders tried
(0004,0005,0003 and 0005,0003,0004). (After 0006/0007 the full-stack numbers are below.) 
## 0006 - bare `vde` prints usage (behavior change)  [requires 0003]
Before: `vde` with no arguments died with `shift: shift count must be <= $#` (exit 1), showing nothing.
Now: prints the same usage text as `vde help` and exits 2 (VDE_ERR_INVALID_INPUT, same code dns-check uses for
usage errors). `vde function-trace` with no subcommand had the same `shift` bug and now behaves the same way.
Note: `vde_action_help` ends in its own `exit 0`, so it runs in a subshell to keep the exit status
(my first version exited 0; caught by the golden check, then fixed). Needs 0003 because it calls `vde_action_help`.
Choice to revisit: exit 2 vs 0 for a bare `vde`.

## 0007 - unknown command exits non-zero (behavior change)
Before: `vde frobnicate` printed "Unknown command. Run 'vde help' for usage." on stdout and exited 0.
Now: "Unknown command 'frobnicate'. ..." on stderr, exit 2. Side effect, expected: `vde -q start` (a flag before
the command, never supported) was also an "unknown command" with exit 0 and now exits 2 (golden `start.quiet`).
Anything scripted as `vde <typo> && next` will now stop, which is the point of the fix.

## Final state of the stack 0001 -> 0007 (Executed, built from the patch files on a clean ff77e79 clone)
- characterize.py: 340/381 match. The 41 differences are exactly: 38 from 0004/0005 (dns-check 2; audit, check-tetrad,
  spine-check, heal 9 each), plus router.noargs, router.unknown, start.quiet from 0006/0007. No other case changed.
- trace_compare.py 30/30, BDD function-trace 20/20, all 13 unit files pass.
- Mutants of 0006/0007 (drop the subshell; drop the exit in the unknown arm) are each caught by the golden check.
- 0006/0007 apply in either order after 0003. 0006 also *applies* to pristine ff77e79 but would call an undefined
  function there, so always apply after 0003.
- To move the baseline forward, re-record the 41 cases deliberately; do not edit goldens by hand.
