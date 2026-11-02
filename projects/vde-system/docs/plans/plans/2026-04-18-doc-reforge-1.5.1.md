# VDE 1.5.1 Documentation Re-Forge Implementation Plan
<!-- @shared-law (Forge Implementation Plan) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize the documentation re-forge for VDE 1.5.1 Sovereign Baseline, ensuring accuracy of facts, unified CLI usage, and removal of hardcoded home paths.

**Architecture:** Surgical updates to 10 key documentation files to align with the certified 1.5.1 state. Updates include replacing outdated commands, fixing hardcoded paths, and ensuring Mandate 24 compliance.

**Tech Stack:** Markdown, Zsh, VDE Unified CLI.

---

### Task 1: Update docs/API.md

**Files:**
- Modify: `docs/API.md`

- [ ] **Step 1: Add `rebuild` command and update `restart` description**
- [ ] **Step 2: Verify tagging and version**

### Task 2: Update docs/rebuild-guidelines.md

**Files:**
- Modify: `docs/rebuild-guidelines.md`

- [ ] **Step 1: Replace `vde start <vm> --rebuild` with `vde rebuild <vm>` throughout**
- [ ] **Step 2: Replace `vde start <vm> --rebuild --no-cache` with `vde rebuild <vm> --no-cache`**

### Task 3: Update docs/best-practices.md

**Files:**
- Modify: `docs/best-practices.md`

- [ ] **Step 1: Update rebuild examples to use `vde rebuild`**
- [ ] **Step 2: Ensure path consistency (use $HOME/workspace)**

### Task 4: Update docs/troubleshooting.md

**Files:**
- Modify: `docs/troubleshooting.md`

- [ ] **Step 1: Update rebuild examples to use `vde rebuild`**
- [ ] **Step 2: Replace hardcoded port examples with `vde port <vm>` references where appropriate**
- [ ] **Step 3: Ensure no hardcoded `/home/devuser`**

### Task 5: Update docs/DEVELOPMENT_GUIDE.md

**Files:**
- Modify: `docs/DEVELOPMENT_GUIDE.md`

- [ ] **Step 1: Update examples to use unified `vde` commands (`vde create`, `vde start`, `vde rebuild`, `vde enter`)**
- [ ] **Step 2: Update parser intents list to reflect 1.5.1 reality if possible, or clarify it's for the parser**

### Task 6: Update docs/extending-vde.md

**Files:**
- Modify: `docs/extending-vde.md`

- [ ] **Step 1: Update Step 1 example to use `vde add` if it matches the current bin/add-vm-type behavior**
- [ ] **Step 2: Ensure consistency with unified CLI**

### Task 7: Update docs/TESTING.md

**Files:**
- Modify: `docs/TESTING.md`

- [ ] **Step 1: Verify and solidify the "17 Scenarios, 137 Steps" metrics**
- [ ] **Step 2: Ensure tagging compliance**

### Task 8: Update docs/beskar-map.md, CONTRIBUTING.md, and README.md

**Files:**
- Modify: `docs/beskar-map.md`
- Modify: `CONTRIBUTING.md`
- Modify: `README.md`

- [ ] **Step 1: Surgical check for any remaining 1.5.0-era facts or hardcoded paths**
- [ ] **Step 2: Final integrity mirror check for 1.5.1 Baseline**

### Task 9: Final Compliance Audit

**Files:**
- All target files

- [ ] **Step 1: Run `bin/vde-enforce-uap.zsh` to ensure no new fractures**
- [ ] **Step 2: Verify Mandate 24 (Tagging) on Line 2 or 3 of all 10 files**
