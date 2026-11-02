# Fix Tilde Expansion Bug in rust-init.zsh Implementation Plan
<!-- @shared-law (Sovereign Law) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unquote `local dev_home=~devuser` in `scripts/setup/rust-init.zsh` to allow Zsh tilde expansion.

**Architecture:** Use a surgical edit to remove quotes from the variable assignment, ensuring tilde expansion works as expected in Zsh.

**Tech Stack:** Zsh

---

### Task 1: Initialize Strike and Branch

**Files:**
- Create: `gh issue create`
- Modify: `git checkout -b fix/rust-init-tilde-expansion`

- [ ] **Step 1: Open Signet of Intent**

Run: `gh issue create --title "Fix: Tilde expansion bug in rust-init.zsh" --body "The local variable dev_home is quoted, preventing tilde expansion in Zsh. This causes setup failures when used in paths."`
Expected: Issue number returned (e.g., #181)

- [ ] **Step 2: Forge Feature Branch**

Run: `git checkout -b fix/rust-init-tilde-expansion`
Expected: Switched to a new branch 'fix/rust-init-tilde-expansion'

### Task 2: Apply the Reforging

**Files:**
- Modify: `scripts/setup/rust-init.zsh:37`

- [ ] **Step 1: Apply surgical edit to unquote dev_home**

```zsh
# OLD: local dev_home="~devuser"
# NEW: local dev_home=~devuser
```

Run: `replace` tool on `scripts/setup/rust-init.zsh`
```javascript
{
  "file_path": "$HOME/VDE/scripts/setup/rust-init.zsh",
  "old_string": "local dev_home=\"~devuser\"",
  "new_string": "local dev_home=~devuser",
  "instruction": "Unquote dev_home assignment to allow Zsh tilde expansion per MANDATE."
}
```

- [ ] **Step 2: Verify the edit**

Run: `grep "local dev_home=~devuser" scripts/setup/rust-init.zsh`
Expected: Line 37 matches exactly (no quotes).

### Task 3: Empirical Verification

**Files:**
- Run: `plans/scripts/repro_tilde_bug.zsh`

- [ ] **Step 1: Run reproduction script to confirm fix logic**

Run: `zsh $HOME/VDE/plans/scripts/repro_tilde_bug.zsh`
Expected: Output confirms unquoted tilde expands to a path (e.g., `/var/root`).

- [ ] **Step 2: Verify no regressions in rust-init.zsh**

Run: `zsh -n $HOME/VDE/scripts/setup/rust-init.zsh`
Expected: No syntax errors.

### Task 4: Submit Chronicle and Cleanup

**Files:**
- Modify: `gh pr create`

- [ ] **Step 1: Commit the Reforging**

Run: `git add scripts/setup/rust-init.zsh`
Run: `git commit -m "fix(setup): unquote dev_home for tilde expansion in rust-init.zsh"`
Expected: Commit successful.

- [ ] **Step 2: Present Chronicle for Clan Leader Review**

Action: Report PR body and Issue linkage.
PR Body:
(1) Fracture Analysis: `local dev_home="~devuser"` prevented tilde expansion.
(2) The Reforging: Removed quotes to allow expansion.
(3) The Beskar Set: `scripts/setup/rust-init.zsh`

- [ ] **Step 3: Create Chronicle (Wait for Approval)**

Run: `gh pr create --title "fix: unquote dev_home in rust-init.zsh" --body "Fracture Analysis: local dev_home='~devuser' prevented tilde expansion.\nThe Reforging: Removed quotes to allow expansion.\nThe Beskar Set: scripts/setup/rust-init.zsh\n\nCloses #<ISSUE_NUMBER>"`

- [ ] **Step 4: Cleanup Staging**

Run: `rm $HOME/VDE/plans/scripts/repro_tilde_bug.zsh`
Expected: Artifact removed.
