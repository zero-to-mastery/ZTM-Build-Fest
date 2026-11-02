# Phase 23 Sleep Remediation Implementation Plan
<!-- @shared-law (Sovereign Law) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate non-compliant 'sleep' calls to improve deterministic readiness and reduce flakiness in the VDE workspace.

**Architecture:** This plan follows a surgical replacement approach for static `sleep` calls and a refactoring approach for the `wait_for_container_healthy` function in `lib/vde-docker`.

**Tech Stack:** Python (BDD steps), ZSH (Core libraries).

---

### Task 1: Initialization & Workspace Integrity

**Files:**
- Run: `bin/vde-enforce-uap.zsh`

- [ ] **Step 1: Run the UAP enforcer**

Run: `zsh bin/vde-enforce-uap.zsh`
Expected: PASS (No output if successful)

---

### Task 2: Python Helper Remediation

**Files:**
- Modify: `tests/features/steps/vm_common.py:290, 319, 368`

- [ ] **Step 1: Update wait_for_container**

Modify `tests/features/steps/vm_common.py`:
Replace `time.sleep(1)` with `time.sleep(0.2)` in `wait_for_container` (around line 290).

- [ ] **Step 2: Update vde_wait_for_container_healthy**

Modify `tests/features/steps/vm_common.py`:
Replace `time.sleep(1)` with `time.sleep(0.2)` in `vde_wait_for_container_healthy` (around lines 319 and 368).

---

### Task 3: Health Library Remediation

**Files:**
- Modify: `lib/vde-health:107, 158, 239`

- [ ] **Step 1: Update SSH port polling**

Modify `lib/vde-health`:
Replace `sleep 2` with `sleep 0.2` in `vde_check_ssh_port` (around line 107).

- [ ] **Step 2: Update SSH login polling**

Modify `lib/vde-health`:
Replace `sleep 2` with `sleep 0.2` in `vde_check_ssh_login` (around line 158).

- [ ] **Step 3: Update language tool polling**

Modify `lib/vde-health`:
Replace `sleep 2` with `sleep 0.2` in `vde_check_language_tool` (around line 239).

---

### Task 4: Docker Library Refactoring

**Files:**
- Modify: `lib/vde-docker:527-528`

- [ ] **Step 1: Refactor wait_for_container_healthy**

Modify `lib/vde-docker`:
Replace the static `sleep 5` loop in `wait_for_container_healthy` with a deterministic polling loop using `sleep 0.2`.

```zsh
wait_for_container_healthy() {
    local vm_name="${1}"
    local timeout="${2:-60}"
    
    typeset -F elapsed=0
    typeset -F check_interval=0.2

    while (( elapsed < timeout )); do
        local container_id
        container_id=$(get_container_id "${vm_name}")

        if [ -z "${container_id}" ]; then
            _error "Container not found: ${vm_name}"
            return ${VDE_ERR_NOT_FOUND}
        fi

        local status
        status=$(docker inspect -f '{{.State.Health.Status}}' "${container_id}" 2>/dev/null)

        if [ "${status}" = "healthy" ]; then
            return ${VDE_SUCCESS}
        fi

        sleep ${check_interval}
        (( elapsed += check_interval ))
    done

    _error "Container '${vm_name}' did not become healthy within ${timeout}s"
    return ${VDE_ERR_TIMEOUT}
}
```

---

### Task 5: SSH Library Remediation

**Files:**
- Modify: `lib/vde-ssh:312`

- [ ] **Step 1: Update lock acquisition polling**

Modify `lib/vde-ssh`:
Replace `sleep 1` with `sleep 0.2` in `acquire_lock` (around line 312).

---

### Task 6: Finalization & Verification

**Files:**
- Run: `bin/vde-enforce-uap.zsh`
- Run: `bin/check-zsh-shebang.zsh`
- Test: `tests/features/docker-required/service-volume-hardening.feature`

- [ ] **Step 1: Run UAP enforcer**

Run: `zsh bin/vde-enforce-uap.zsh`
Expected: PASS

- [ ] **Step 2: Run shebang check**

Run: `zsh bin/check-zsh-shebang.zsh`
Expected: PASS

- [ ] **Step 3: Verify with BDD tests**

Run: `python3 -m behave tests/features/docker-required/service-volume-hardening.feature`
Expected: All scenarios PASS
