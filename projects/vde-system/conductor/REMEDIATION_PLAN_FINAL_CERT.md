# FINAL CERTIFICATION STRIKE PLAN (CORRECTED)
<!-- @shared-law (Forge Component) -->

## 1. Relative-Paths-Only Mandate Refinement
`VDE_ROOT_DIR` must always be the directory that `bin/vde` is **under**. We must use Zsh-native relative path derivation to ensure the system remains portable and AI-blind to absolute host paths.
- **Action for `bin/` scripts**: Replace absolute path logic with `VDE_ROOT_DIR="${0:h:h}"`.
- **Action for `lib/` scripts**: Replace absolute path logic with `VDE_ROOT_DIR="${(%):-%x:h:h}"`.
- **Action for `bin/vde`**: Ensure it exports this relative `VDE_ROOT_DIR` so all child processes inherit the relative context.

## 2. Phase 31 Test Bank: DNS & Sovereign Bridge
- **File**: `tests/features/advanced-orchestration/phase31-dns-discovery.feature`
- **Empirical Proofs**:
  1. Spoke-to-Spoke discovery via `ping` and `nc` (both canonical and short aliases).
  2. Hub-to-Spoke discovery via the `vde-host` bridge alias.
  3. Verification that DNS aliases are generated using only relative logic.

## 3. Phase 32 Test Bank: Forge Intelligence (Auto-Remediation)
- **File**: `tests/features/governance/phase32-auto-remediation.feature`
- **Empirical Proofs**:
  1. **Registry Healing**: Verify `bin/vde heal` restores `vm-types.json` from `vm-types.conf`.
  2. **Gospel Synchronization**: Prove `vde-gospel-audit.zsh` detects drift and `vde heal` remediates.
  3. **Path Leak Detection**: Prove the system blocks and reports absolute path injections.

## 4. Anti-Recursion Test Bank: Locking Mechanism
- **File**: `tests/features/core-infrastructure/locking-recursion-fix.feature`
- **Empirical Proofs**:
  1. **Stale Lock Buster**: Prove that a dead PID's lock is purged after 10s.
  2. **Process explosion Guard**: Verify `vde-poll` no longer sources `vm-common` recursively, preventing CPU-exhaustion.

## 5. Final Certification Execution
- Re-run all test suites to certify the 100% Green Armor.
