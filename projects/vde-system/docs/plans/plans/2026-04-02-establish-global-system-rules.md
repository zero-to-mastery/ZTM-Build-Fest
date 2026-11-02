# Establish Global System Rules Implementation Plan
<!-- @shared-law (Sovereign Law) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update all core mandate files to establish Rule A (Enforcer Supervision), Rule B (Phase-End Re-Audit Swarm), and Rule C (Explicit Commit Gate) as permanent, global system rules.

**Architecture:** Systematic update of core markdown and specification files to reflect new governance mandates.

**Tech Stack:** Markdown, ZSH (for verification).

---

### Task 1: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add Rule A, B, and C to Section 2 (STRICT Core Mandates)**

Update the list in section 2 with:
- **Rule A (Enforcer Supervision)**: Every single action (shell commands, sub-agent dispatches, verification steps, and cleanup) MUST be run under the supervision of the Enforcer (`bin/vde-enforce-uap.zsh`). No action is permitted without this spine.
- **Rule B (Phase-End Re-Audit Swarm)**: Every development phase MUST automatically conclude with a supervised re-audit swarm. This swarm MUST assume errors exist, search for regressions or weak spots, rerun all relevant Behave scenarios, and provide a summary of findings. Skipping or shortening this re-audit is a total mandate failure.
- **Rule C (Explicit Commit Gate)**: Following a successful re-audit, the agent MUST ask for explicit 'commit now' approval from the user. No commits are allowed without this manual gate.

---

### Task 2: Update MEMORY.md

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: Add Rule A, B, and C to "CRITICAL: PROTOCOL ENFORCEMENT"**

Append the three rules to the existing list of critical protocol enforcement rules.

---

### Task 3: Update GEMINI.md

**Files:**
- Modify: `GEMINI.md`

- [ ] **Step 1: Add Rule A, B, and C to "ABSOLUTE FAILURES TO AVOID"**

Integrate the three rules into the absolute failures section or as a new "Core Mandates" section.

---

### Task 5: Update docs/VDE-SPEC.md

**Files:**
- Modify: `docs/VDE-SPEC.md`

- [ ] **Step 1: Add Rule A, B, and C to Section 15 (Universal Agent Protocol)**

Update the section to include the three rules as mandatory requirements.

---

### Task 6: Final Verification

- [ ] **Step 1: Run bin/vde-enforce-uap.zsh**

Run: `bin/vde-enforce-uap.zsh`
Expected: PASS (or successful enforcement of baseline integrity).

- [ ] **Step 2: Verify Rule presence in all files**

Use `grep` to ensure the rules are present in all five files.
