# Bashism Purge Stage 2: Final Strike Implementation Plan
<!-- @shared-law (Sovereign Law) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Final purification of the VDE codebase by replacing all remaining Bash-style regex matches (`=~`), `export -f` calls, and `tr` usages with Zsh-native equivalents.

**Architecture:** A targeted replacement strategy using Zsh's powerful parameter expansion and globbing patterns in `[[ ... ]]` blocks. This ensures full compliance with Mandate C (ZSH ONLY) while maintaining existing logic.

**Tech Stack:** Zsh 5.0+, Git.

---

### Task 1: Regex Match (`=~`) Replacement in Core Scripts

**Files:**
- Modify: `bin/vde-enforce-uap.zsh`
- Modify: `bin/vde-spine-check.zsh`
- Modify: `bin/vde-path-of-the-foundling`
- Modify: `bin/validate-schemas.zsh`

- [ ] **Step 1: Replace Bash-style regex in `bin/vde-enforce-uap.zsh`**
- [ ] **Step 2: Replace Bash-style regex in `bin/vde-spine-check.zsh`**
- [ ] **Step 3: Replace Bash-style regex in `bin/vde-path-of-the-foundling`**
- [ ] **Step 4: Replace Bash-style regex in `bin/validate-schemas.zsh`**
- [ ] **Step 5: Verify changes with a dry-run check**

---

### Task 2: Advanced Regex and Filter Replacement

**Files:**
- Modify: `bin/vde-ps`
- Modify: `bin/check-zsh-shebang.zsh`
- Modify: `bin/list-vms`
- Modify: `lib/vde-naming`

- [ ] **Step 1: Replace regex matching in `bin/vde-ps` with parameter expansion**
- [ ] **Step 2: Replace regex matching in `bin/check-zsh-shebang.zsh`**
- [ ] **Step 3: Replace filter matching in `bin/list-vms`**
- [ ] **Step 4: Replace name validation in `lib/vde-naming`**
- [ ] **Step 5: Verify changes**

---

### Task 3: Purge `export -f` and Convert `tr` to Zsh Expansion

**Files:**
- Modify: `lib/vde-audit`
- Modify: `lib/vde-metrics`
- Modify: `lib/vde-health`
- Modify: `lib/vde-naming`
- Modify: `lib/vde-log`

- [ ] **Step 1: Remove `export -f` from `lib/vde-audit`, `lib/vde-metrics`, `lib/vde-health`**
- [ ] **Step 2: Convert `tr` to Zsh native expansion in `lib/vde-naming`**
- [ ] **Step 3: Convert `tr` to Zsh native expansion in `lib/vde-log`**
- [ ] **Step 4: Final verification and reporting**
