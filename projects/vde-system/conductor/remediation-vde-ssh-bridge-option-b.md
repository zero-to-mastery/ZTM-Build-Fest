# Remediation Plan: VDE-SSH-BRIDGE-OPTION-B

## Background & Motivation
The Clan Leader has selected **Option B (Environment Variable Injection)** to harden the Transversal Bridge and make it resilient to clean-slate bootups (`rm -rf ~/.ssh/vde`).

Currently, the `docker-compose.yml` templates attempt to mount the host's `vde_student.pub` directly into the container as `authorized_keys`. However, Docker on macOS preserves the host's UID (e.g., 501), which causes the container's `sshd` to reject the file because it is not owned by `devuser` (UID 1000) or `root`. This mismatch leads to the persistent `Permission denied (publickey)` errors in the tests.

## Scope & Impact
This remediation affects the SSH syncing logic (`lib/vde-ssh`), the container entrypoint (`scripts/vde-entrypoint.zsh`), and the docker-compose templates (`templates/compose-language.yml`, `templates/compose-service.yml`). By passing the public key as an environment variable and having the entrypoint write the file natively, we guarantee perfect file ownership (`devuser:devuser`) and bypass Docker's host-volume permission quirks entirely.

## Proposed Solution
1. **Dynamic Key Injection**: Modify `sync_ssh_keys_to_vde()` in `lib/vde-ssh` to write the public key into the global `${VDE_ROOT_DIR}/.env` file as `VDE_AUTHORIZED_KEY="..."`.
2. **Template Cleanup**: Remove the direct file mounts for `authorized_keys` and `vde_student` from both `compose-language.yml` and `compose-service.yml`.
3. **Entrypoint Execution**: Update `scripts/vde-entrypoint.zsh` so that when the container starts, it reads `VDE_AUTHORIZED_KEY`, creates `~/.ssh/vde/authorized_keys`, and assigns strict `devuser:devuser` ownership and `644` permissions.

## Implementation Plan
1. Edit `lib/vde-ssh` to inject `VDE_AUTHORIZED_KEY` into `.env`.
2. Edit `scripts/vde-entrypoint.zsh` to write the key to disk.
3. Edit `templates/compose-language.yml` and `templates/compose-service.yml` to remove the `vde_student.pub` and `vde_student` volume mounts.

## Verification
1. Run the `vde rebuild base` command to ensure no regressions.
2. Run `python3 -m behave tests/features/core-infrastructure/proof-of-life-the-contract.feature` and verify that Scenario 3 (Spoke Interaction) passes, proving `sshd` now accepts the dynamically injected key.