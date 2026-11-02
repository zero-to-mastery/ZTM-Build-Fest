# Phase 32: Forge Intelligence (The Self-Augmenting Sentinel)
<!-- @shared-law (Forge Component) -->

**Status**: DRAFT (Pending Clan Leader Approval)
**Branch**: `feat/phase32-forge-intelligence`

## Background & Motivation
The Forge currently enforces static governance via `bin/vde-enforce-uap.zsh`, but it lacks the cognitive ability to detect drift between its physical implementation (CLI utilities, library signatures) and the Gospel of the Forge (`docs/governance/vde-spec.md`, `docs/api/library-api.md`, `docs/api/cli-api.md`). Furthermore, recent mandates (e.g., Sourcery-AI remediation) must be formalized into the automated lifecycle gates.

## Scope & Impact
To preserve the blazing-fast execution of the daily UAP Sentinel, we will implement a **Distributed Sentinel** architecture. This avoids bloating `bin/vde-enforce-uap.zsh` and delegates heavy analysis and auto-healing to specialized scripts triggered during critical lifecycle events (e.g., `pre-push` or explicit `vde audit` commands).

## Proposed Solution

1.  **The Gospel Auditor (`bin/vde-gospel-audit.zsh`)**:
    *   **Function**: A dedicated Sentinel script that verifies the structural integrity of the Sovereign Artifact Set.
    *   **Checks**:
        *   Confirms the existence of all 9 Sovereign Artifacts.
        *   Verifies that the `VERSION` and `SEMVER` constants match across `docs/governance/vde-spec.md`, `data/vm-types.json`, and core engine files.
        *   Cross-references `bin/` contents with `docs/available-scripts.md` to ensure no undocumented commands exist.
2.  **The Self-Healer (`bin/vde-heal-docs.zsh` & `bin/vde-sync-version`)**:
    *   **Function**: An autonomous regeneration and synchronization tool for the Alor.
    *   **Execution**: Parses the core engine files (`data/vm-types.json`, `bin/vde-*`, `lib/vde-*`) for the absolute ground truth regarding versioning, available scripts, and library signatures. `bin/vde-sync-version` will be updated to align with and utilize this new architecture.
    *   **Output**: Automatically synchronizes and updates the **ENTIRE 9-file Sovereign Artifact Set** (`docs/architecture/overview.md`, `docs/architecture/data-flow.md`, `docs/changelogs/current.md`, `docs/governance/vde-spec.md`, `USE_CASES.md`, `VDE_ANALYSIS.md`, `PROJECT_STATUS.md`, `docs/governance/sovereign-charter.md`, `docs/api/library-api.md`), as well as `docs/api/cli-api.md` and `docs/reference/scripts.md`. It ensures 100% agreement between the code and the Gospel, updating versions, dates, and dynamically generated documentation tables across all artifacts.
3.  **Hardened Lifecycle Rituals (`githooks/pre-push` & `.github/workflows`)**:
    *   Integrate `vde-gospel-audit.zsh` into the local `pre-push` hook, ensuring no code leaves the Anvil if the Gospel has drifted.
    *   Formalize the Sourcery-AI remediation check as a mandatory pre-merge gate.

## Alternatives Considered
*   **The Monolithic Sentinel**: Integrating all intelligence into `vde-enforce-uap.zsh`. Rejected due to the unacceptable performance penalty it would impose on every single execution of `vde`.

## Phased Implementation Plan
1.  **Phase 32.1 (The Auditor)**: Create `bin/vde-gospel-audit.zsh` with pure ZSH parsing logic to detect version mismatches and undocumented scripts.
2.  **Phase 32.2 (The Healer)**: Create `bin/vde-heal-docs.zsh` to parse standard library function signatures and regenerate Markdown tables.
3.  **Phase 32.3 (The Gates)**: Update the `githooks/pre-push` script to mandate a successful Gospel Audit before pushing.

## Verification & Testing
*   **Drift Detection**: Intentionally mismatch the version in `docs/governance/vde-spec.md` and `data/vm-types.json`, run `vde-gospel-audit.zsh`, and verify it emits a `[CRITICAL FAILURE]`.
*   **Auto-Healing**: Add a dummy function to `lib/vde-core`, run `vde-heal-docs.zsh`, and verify the function appears accurately in `docs/api/library-api.md`.
*   **Pre-Push Enforcement**: Attempt to push to the remote repository while Gospel drift is present; verify the push is blocked.
*   **Artifact Purge (Cleanup)**: Explicitly purge all test artifacts generated during verification, including temporary dummy functions, file segment backups, orphaned containers, and local temp files, restoring the system to a clean state.

## Migration & Rollback
*   In the event of instability or false positive drift detections, the agent MUST explicitly debug and fix the implementation in the `bin/vde-gospel-audit.zsh` or `githooks/pre-push` scripts. Bypassing, removing, or reverting these governance gates is strictly prohibited. We fix forward.