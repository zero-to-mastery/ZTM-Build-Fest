# Finalize Anti-Entropy Registry Sweep Implementation Plan
<!-- @shared-law (Sovereign Law) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `vde-lang` Docker build failure by copying the `scripts/` directory into the image and verify the `csharp` VM setup.

**Architecture:** Update `configs/docker/vde-lang.Dockerfile` to `COPY scripts/ /vde/scripts/` at build time, ensuring scripts are available for the `CUSTOM_BUILD_CMD`.

**Tech Stack:** Docker, ZSH, VDE CLI.

---

### Task 1: Reproduce Failure

**Files:**
- Create: `tests/reproduce_csharp_build_failure.zsh`

- [ ] **Step 1: Write the reproduction script**

```zsh
#!/usr/bin/env zsh
# tests/reproduce_csharp_build_failure.zsh

set -e

echo "[TEST] Attempting to rebuild csharp VM..."
# Rebuild csharp VM
bin/vde rebuild csharp
echo "[TEST] Rebuild successful."

# Start csharp VM
bin/vde start csharp
echo "[TEST] Start successful."

# Verify dotnet
echo "[TEST] Verifying dotnet installation..."
bin/vde enter csharp dotnet --version
```

- [ ] **Step 2: Run the reproduction script to verify failure**

Run: `chmod +x tests/reproduce_csharp_build_failure.zsh && tests/reproduce_csharp_build_failure.zsh`
Expected: FAIL during `bin/vde rebuild csharp` because `zsh /vde/scripts/setup/csharp-init.zsh` will fail (file not found).

---

### Task 2: Fix Dockerfile

**Files:**
- Modify: `configs/docker/vde-lang.Dockerfile`

- [ ] **Step 1: Add COPY instruction to Dockerfile**

```dockerfile
# configs/docker/vde-lang.Dockerfile

# ... after Step 1 and before Step 2 ...
COPY scripts/ /vde/scripts/
RUN chmod +x /vde/scripts/setup/*.zsh
# ...
```

- [ ] **Step 2: Commit changes**

Run: `git add configs/docker/vde-lang.Dockerfile && git commit -m "fix(docker): copy scripts to image at build time"`

---

### Task 3: Verify Fix

**Files:**
- Use: `tests/reproduce_csharp_build_failure.zsh`

- [ ] **Step 1: Run the reproduction script to verify success**

Run: `tests/reproduce_csharp_build_failure.zsh`
Expected: PASS. Rebuild should succeed, and `dotnet --version` should return a value.

- [ ] **Step 2: Commit verification results**

Run: `git commit --allow-empty -m "test: verify csharp build and dotnet installation"`

---

### Task 4: Cleanup

- [ ] **Step 1: Stop and remove csharp VM**

Run: `bin/vde stop csharp`
Expected: Container stopped and removed.

- [ ] **Step 2: Remove reproduction test script**

Run: `rm tests/reproduce_csharp_build_failure.zsh`
Expected: File removed.

- [ ] **Step 3: Commit cleanup**

Run: `git add tests/reproduce_csharp_build_failure.zsh && git commit -m "test: cleanup reproduction script"`
