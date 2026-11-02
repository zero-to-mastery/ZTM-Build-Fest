# Integrate Silent Spine-Check into bin/vde Implementation Plan
<!-- @shared-law (Sovereign Law) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the `@system-spine` tetrad verification (`bin/vde-spine-check.zsh`) into the `bin/vde` CLI ignition flow.

**Architecture:** Add a call to `bin/vde-spine-check.zsh --quiet` immediately after the UAP enforcement in `bin/vde`. This ensures that the core technologies (Zsh, Git, Docker, SSH) are verified before any command is executed.

**Tech Stack:** Zsh, Docker, SSH, Git.

---

### Task 1: Verify Integration Missing (RED - Strike One)

**Files:**
- Read: `bin/vde`
- Test Script: `tests/repro-spine-check-integration.zsh`

- [ ] **Step 1: Write the failing test script**

```zsh
#!/usr/bin/env zsh
VDE_ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Verify bin/vde-spine-check.zsh is NOT currently in bin/vde
if grep -q "vde-spine-check.zsh" "${VDE_ROOT_DIR}/bin/vde"; then
    echo "FAIL: vde-spine-check.zsh already integrated"
    exit 1
fi

# Simulate a spine check failure and verify bin/vde still runs
# We'll use a wrapper to check if bin/vde returns success even if we 'break' the spine check expectation
# Since it's not integrated, bin/vde help should still pass
"${VDE_ROOT_DIR}/bin/vde" help > /dev/null
if [[ $? -eq 0 ]]; then
    echo "SUCCESS: bin/vde runs without spine check (Integration Missing)"
else
    echo "FAIL: bin/vde failed unexpectedly"
    exit 1
fi
```

- [ ] **Step 2: Run the test script to verify it fails (Correctly shows integration missing)**

Run: `zsh tests/repro-spine-check-integration.zsh`
Expected: "SUCCESS: bin/vde runs without spine check (Integration Missing)"

- [ ] **Step 3: Commit the test script**

```bash
git add tests/repro-spine-check-integration.zsh
git commit -m "test: add reproduction script for missing spine-check integration"
```

### Task 2: Integrate Spine-Check into bin/vde (GREEN - Strike Two)

**Files:**
- Modify: `bin/vde`

- [ ] **Step 1: Update bin/vde to include the check**

```zsh
# Enforce Universal Agent Protocol (The Rule Spine)
"${VDE_ROOT_DIR}/bin/vde-enforce-uap.zsh" --quiet || exit 1

# Enforce @system-spine tetrad (Section 16)
# This is the cognitive context and operational spine
"${VDE_ROOT_DIR}/bin/vde-spine-check.zsh" --quiet || exit 1
```

- [ ] **Step 2: Run bin/vde help to verify it passes in normal environment**

Run: `bin/vde help`
Expected: Help output and exit 0.

- [ ] **Step 3: Commit the change**

```bash
git add bin/vde
git commit -m "feat: integrate system-spine cognitive check into CLI ignition"
```

### Task 3: Verify Failure on Broken Spine (REFACTOR/VERIFY - Strike Three)

**Files:**
- Test Script: `tests/verify-spine-check-failure.zsh`

- [ ] **Step 1: Write the verification test script**

```zsh
#!/usr/bin/env zsh
VDE_ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Temporarily move vde-spine-check.zsh to simulate failure (or missing script)
mv "${VDE_ROOT_DIR}/bin/vde-spine-check.zsh" "${VDE_ROOT_DIR}/bin/vde-spine-check.zsh.bak"

# Run bin/vde help - it should now FAIL because of integration
"${VDE_ROOT_DIR}/bin/vde" help > /dev/null 2>&1
if [[ $? -ne 0 ]]; then
    echo "SUCCESS: bin/vde failed when spine check is missing/failing"
    RESULT=0
else
    echo "FAIL: bin/vde succeeded even when spine check is broken"
    RESULT=1
fi

# Restore the script
mv "${VDE_ROOT_DIR}/bin/vde-spine-check.zsh.bak" "${VDE_ROOT_DIR}/bin/vde-spine-check.zsh"

exit ${RESULT}
```

- [ ] **Step 2: Run the verification test script**

Run: `zsh tests/verify-spine-check-failure.zsh`
Expected: "SUCCESS: bin/vde failed when spine check is missing/failing"

- [ ] **Step 3: Clean up and final commit**

```bash
git add bin/vde tests/
git commit -m "test: verify bin/vde failure on broken spine check"
```
