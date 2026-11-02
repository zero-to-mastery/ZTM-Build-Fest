# Remediation Plan: VDE-CASCADE-01 (SSH Infinite Smelt & Orchestrator Drop)

## Background & Motivation
The VDE orchestration interface (`bin/vde`) acts as the supreme router for the Forge. Recently, an infinite recursive loop was introduced when `vde ssh-sync` became responsible for enforcing a base image rebuild whenever SSH keys are refreshed (Mandate 1.5.1). This created a deadlock because `vde-rebuild` also calls `ssh-sync` to ensure keys exist in the build context. Additionally, sub-scripts erroneously trigger deprecation warnings because the main orchestrator does not correctly set and export the `VDE_ORCHESTRATED` flag.

## Scope & Impact
This remediation targets the core orchestrator (`bin/vde`), the rebuild logic (`bin/vde-rebuild`), and the SSH library (`lib/vde-ssh`). The changes are strictly localized to the VDE CLI and its core dependencies, restoring functionality to the `ssh-*` commands and allowing VM creation and initialization to proceed.

## Proposed Solution
We will resolve this by implementing an environment variable-based guard system. This adheres to the Unix tradition and the zero-host-dependency doctrine of the Forge.

1.  **The Orchestrator Drop**: Inject `export VDE_ORCHESTRATED=1` into `bin/vde` before routing commands. This silences the false standalone deprecation warnings in all sub-scripts.
2.  **The Build Context Guard**: Inject `export VDE_IN_REBUILD=1` into the beginning of `bin/vde-rebuild`.
3.  **The Smelt Guard**: Modify the `sync_ssh_keys_to_vde()` function within `lib/vde-ssh`. It will now check if `VDE_IN_REBUILD` is set. If the flag is set (indicating we are already inside a rebuild cycle), it will skip the call to `"vde" rebuild base`, thereby breaking the recursive loop.

## Alternatives Considered
An alternative is to pass explicit flags (e.g., `--skip-rebuild`) down the call stack. However, since the call chain involves multiple scripts (`vde` -> `vde-rebuild` -> `vde-ssh`), environment variables are a more idiomatic and less invasive way to manage state across the entire process tree without altering every intermediate command signature.

## Implementation Plan
1.  Modify `bin/vde` to export `VDE_ORCHESTRATED=1`.
2.  Modify `bin/vde-rebuild` to export `VDE_IN_REBUILD=1` immediately upon execution.
3.  Modify `lib/vde-ssh` in the `sync_ssh_keys_to_vde()` function to conditionally execute the base image rebuild only if `VDE_IN_REBUILD` is empty or 0.

## Verification
1.  Run `bin/vde ssh-setup status` and verify that the deprecation warning ("Standalone execution of ssh-setup is deprecated") no longer appears.
2.  Run `bin/vde ssh-sync` and verify that it successfully syncs the keys and triggers a base image rebuild without entering an infinite loop.
3.  Run `bin/vde rebuild base` and verify that it completes successfully without getting stuck in a recursive `ssh-sync` loop.

## Migration & Rollback
If the changes introduce new failures, the rollback strategy is a simple `git revert` of the commit containing these surgical modifications. No state mutation or data schema changes are involved, ensuring a clean and immediate rollback path.