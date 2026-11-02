# Spec: Phase 23 Sleep Call Remediation
<!-- @shared-law (Sovereign Law) -->

**Date:** 2026-04-01
**Topic:** Remediating non-compliant 'sleep' calls to improve deterministic readiness.

## 1. Purpose
The current VDE codebase contains several `sleep` calls (ranging from 1s to 5s) that contribute to flakiness and slow down execution. To align with Phase 23 (Deterministic Readiness) goals, these must be replaced with sub-second polling logic (0.2s - 0.5s).

## 2. Constraints
- **ZSH Only**: All shell script changes must remain ZSH-native.
- **Sub-second Precision**: Use `0.2s` as the default polling interval.
- **Deterministic Polling**: Ensure loops still respect timeouts and don't busy-wait.

## 3. Design Sections

### 3.1 Python Helper Remediation
In `tests/features/steps/vm_common.py`, the `wait_for_container` and `vde_wait_for_container_healthy` functions currently use `time.sleep(1)`. This will be updated to `time.sleep(0.2)`.

### 3.2 ZSH Health Check Library Remediation
In `lib/vde-health`, the polling loops for SSH port, SSH login, and language tool availability use `sleep 2`. These will be updated to `sleep 0.2`. The `vde_wait_for_container_healthy` function already has sub-second logic but will be verified.

### 3.3 ZSH Docker Library Refactoring
In `lib/vde-docker`, the `wait_for_container_healthy` function uses a static `sleep 5`. This will be refactored to use a polling loop with `sleep 0.2` and proper timeout tracking.

### 3.4 SSH Lock Acquisition Remediation
In `lib/vde-ssh`, the `acquire_lock` function uses `sleep 1`. This will be updated to `sleep 0.2`.

## 4. Testing & Verification
- **UAP Enforcement**: Run `bin/vde-enforce-uap.zsh` to verify integrity.
- **Shebang Check**: Run `bin/check-zsh-shebang.zsh`.
- **BDD Verification**: Run `python3 -m behave tests/features/docker-required/service-volume-hardening.feature` to confirm health checks still pass.

## 5. Self-Review
- [x] No placeholders like TBD/TODO.
- [x] Internal consistency: All sleep calls reduced to sub-second.
- [x] Focused scope: No unrelated refactoring.
- [x] Unambiguous requirements.
