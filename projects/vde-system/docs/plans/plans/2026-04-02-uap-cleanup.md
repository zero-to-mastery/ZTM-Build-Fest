# UAP Cleanup Implementation Plan
<!-- @shared-law (Sovereign Law) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `AGENTS.md`, `MEMORY.md`, and condense documentation/handover files.

**Architecture:** Systematic updates to link syntax in `AGENTS.md` and extreme condensation of secondary documentation files to improve context token efficiency while maintaining technical authority.

**Tech Stack:** ZSH, Gemini CLI.

---

### Task 1: Update AGENTS.md Link Syntax

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Replace link patterns**
  Perform surgical replacements of the "Read `FILENAME`" pattern with "Read @FILENAME".

### Task 2: Update MEMORY.md Compliance Status

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: Update with exact compliance text**
  Update the file with the resolution of the ZSH mandate and orchestrator role.

### Task 3: Condense Handover and Documentation Files

**Files:**
- Modify: `session_handover.md`
- Modify: `plans/session_handover_remediation.md`
- Modify: `docs/VDE-SPEC.md`
- Modify: `PROJECT_STATUS.md`

- [ ] **Step 1: Condense session_handover.md**
  Keep only phase status, blockers, and next steps.

- [ ] **Step 2: Condense plans/session_handover_remediation.md**
  Keep only high-priority debt and remediation goals.

- [ ] **Step 3: Condense docs/VDE-SPEC.md**
  Create a condensed authoritative spec.

- [ ] **Step 4: Condense PROJECT_STATUS.md**
  Keep only Technical Health Dashboard and key stats.

### Task 4: Final Validation

- [ ] **Step 1: Run Enforcer and Shebang Checker**
  Run `bin/vde-enforce-uap.zsh` and `bin/check-zsh-shebang.zsh`.
