# VDE CI Workflow Strengthening Plan
<!-- @shared-law (Sovereign Law) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the CI workflow with Forge Build Strategy Rule 5, ensure consistent step naming, and enforce the Sovereign Audit in the coverage job.

**Architecture:** Surgical replacement of YAML blocks to append cleanup commands to `apt-get` calls, rename steps, and insert the mandatory audit step.

**Tech Stack:** GitHub Actions (YAML), Zsh.

---

### Task 1: Update 'lint' job dependencies cleanup

**Files:**
- Modify: `.github/workflows/vde-ci.yml:42-45`

- [ ] **Step 1: Apply cleanup to 'lint' job**

### Task 2: Update 'unit-tests', 'integration-tests', and 'comprehensive-tests' cleanup

**Files:**
- Modify: `.github/workflows/vde-ci.yml:95`
- Modify: `.github/workflows/vde-ci.yml:158`
- Modify: `.github/workflows/vde-ci.yml:214`

- [ ] **Step 1: Apply cleanup to 'unit-tests' job**
- [ ] **Step 2: Apply cleanup to 'integration-tests' job**
- [ ] **Step 3: Apply cleanup to 'comprehensive-tests' job**

### Task 3: Update 'coverage' job: cleanup and Sovereign Audit

**Files:**
- Modify: `.github/workflows/vde-ci.yml:245-249`

- [ ] **Step 1: Apply cleanup and add Sovereign Audit**

### Task 4: Update 'docker-build' job cleanup

**Files:**
- Modify: `.github/workflows/vde-ci.yml:365-368`

- [ ] **Step 1: Apply cleanup to 'docker-build' job**

### Task 5: Update 'bdd-tests' job cleanup

**Files:**
- Modify: `.github/workflows/vde-ci.yml:580-581`

- [ ] **Step 1: Apply cleanup to 'bdd-tests' job**

### Task 6: Update 'summary' job: rename and cleanup

**Files:**
- Modify: `.github/workflows/vde-ci.yml:635-637`

- [ ] **Step 1: Rename 'Install zsh' to 'Install dependencies' and apply cleanup**

### Task 7: Verify Syntax

- [ ] **Step 1: Use `yamllint` to verify syntax**
