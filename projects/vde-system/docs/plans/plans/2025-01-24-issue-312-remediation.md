# Issue #312: Remediate 1.5.1 Initialization and Postgres Environment Loading Implementation Plan
<!-- @forge (Development Plan) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the VDE system correctly loads environment variables from `.env` during Spoke ignition and build, and provide integrated SSH management commands.

**Architecture:** 
1.  Update `bin/vde` ignition logic to include `--env-file` when `.env` exists.
2.  Expand `bin/vde` command router to handle SSH stack operations.
3.  Update `bin/vde-rebuild` to use Zsh arrays for build command construction, including `.env` injection.

**Tech Stack:** Zsh, Docker Compose, SSH.

---

### Task 1: Inject `.env` into Spoke Ignition in `bin/vde`

**Files:**
- Modify: `bin/vde`

- [ ] **Step 1: Locate the `start)` case and update the ignition handshake.**

Replace the current `docker compose` call with a Zsh array-based command that conditionally includes the `.env` file.

### Task 2: Route SSH Stack in `bin/vde`

**Files:**
- Modify: `bin/vde`

- [ ] **Step 1: Add SSH-related actions to the main `case ${ACTION}` block.**

### Task 3: Inject `.env` into Spoke Build in `bin/vde-rebuild`

**Files:**
- Modify: `bin/vde-rebuild`

- [ ] **Step 1: Refactor `build_vm_image` function to use Zsh array for build command.**

### Task 4: Verification

**Files:**
- Run: `bin/vde-enforce-uap.zsh`
- Run: `python3 -m behave tests/features/core-infrastructure/proof-of-life-the-contract.feature`

- [ ] **Step 1: Run Sovereign Audit.**
- [ ] **Step 2: Run Proof of Life test to ensure Heartbeat is restored.**
