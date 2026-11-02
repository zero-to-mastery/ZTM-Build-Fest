# Setup Script Logging Sourcing Fix Implementation Plan
# @forge (Hardening Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure setup scripts in `scripts/setup/` correctly source `lib/vde-log` to provide `vde_log_info`.

**Architecture:** Setup scripts are executed during VM initialization. They must reliably locate and source core libraries using `VDE_ROOT_DIR`. Since `vde_log_info` was moved to `lib/vde-log`, scripts using it must source that library explicitly if it's not included in `lib/vde-core`.

**Tech Stack:** Zsh

---

### Task 1: Fix scripts/setup/lua-init.zsh

**Files:**
- Modify: `scripts/setup/lua-init.zsh`

- [ ] **Step 1: Apply the fix to scripts/setup/lua-init.zsh**

Replace fragile relative sourcing and redundant checks with robust absolute sourcing.

```zsh
#!/usr/bin/env zsh
# @armor (Engine Core)
# Forged in Beskar: vde-lua
set -e
export DEBIAN_FRONTEND=noninteractive
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
[[ -f "${VDE_ROOT_DIR}/lib/vde-core" ]] && source "${VDE_ROOT_DIR}/lib/vde-core"
[[ -f "${VDE_ROOT_DIR}/lib/vde-log" ]] && source "${VDE_ROOT_DIR}/lib/vde-log"

vde_log_info "Igniting Lua environment..."
sudo apt-get update && sudo apt-get install -y lua5.4 luarocks
vde_purge_ghosts
```

- [ ] **Step 2: Verify syntax**

Run: `zsh -n scripts/setup/lua-init.zsh`
Expected: 0 exit code

- [ ] **Step 3: Commit**

```bash
git add scripts/setup/lua-init.zsh
git commit -m "fix(armor): ensure lib/vde-log is sourced in lua-init.zsh"
```

---

### Task 2: Fix scripts/setup/lamp-init.zsh

**Files:**
- Modify: `scripts/setup/lamp-init.zsh`

- [ ] **Step 1: Apply the fix to scripts/setup/lamp-init.zsh**

```zsh
#!/usr/bin/env zsh
# @armor (Engine Core)
# Forged in Beskar: vde-lamp
set -e
export DEBIAN_FRONTEND=noninteractive
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
[[ -f "${VDE_ROOT_DIR}/lib/vde-core" ]] && source "${VDE_ROOT_DIR}/lib/vde-core"
[[ -f "${VDE_ROOT_DIR}/lib/vde-log" ]] && source "${VDE_ROOT_DIR}/lib/vde-log"

vde_log_info "Igniting LAMP Stack environment..."
sudo apt-get update && sudo apt-get install -y php-cli mysql-client
vde_purge_ghosts
```

- [ ] **Step 2: Verify syntax**

Run: `zsh -n scripts/setup/lamp-init.zsh`
Expected: 0 exit code

- [ ] **Step 3: Commit**

```bash
git add scripts/setup/lamp-init.zsh
git commit -m "fix(armor): ensure lib/vde-log is sourced in lamp-init.zsh"
```

---

### Task 3: Fix scripts/setup/mean-init.zsh

**Files:**
- Modify: `scripts/setup/mean-init.zsh`

- [ ] **Step 1: Apply the fix to scripts/setup/mean-init.zsh**

```zsh
#!/usr/bin/env zsh
# @armor (Engine Core)
# Forged in Beskar: vde-mean
set -e
export DEBIAN_FRONTEND=noninteractive
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
[[ -f "${VDE_ROOT_DIR}/lib/vde-core" ]] && source "${VDE_ROOT_DIR}/lib/vde-core"
[[ -f "${VDE_ROOT_DIR}/lib/vde-log" ]] && source "${VDE_ROOT_DIR}/lib/vde-log"

vde_log_info "Igniting MEAN Stack environment..."
sudo apt-get update && sudo apt-get install -y mongodb-clients
vde_purge_ghosts
```

- [ ] **Step 2: Verify syntax**

Run: `zsh -n scripts/setup/mean-init.zsh`
Expected: 0 exit code

- [ ] **Step 3: Commit**

```bash
git add scripts/setup/mean-init.zsh
git commit -m "fix(armor): ensure lib/vde-log is sourced in mean-init.zsh"
```

---

### Task 4: Fix scripts/setup/certified-ghost-init.zsh

**Files:**
- Modify: `scripts/setup/certified-ghost-init.zsh`

- [ ] **Step 1: Apply the fix to scripts/setup/certified-ghost-init.zsh**

```zsh
#!/usr/bin/env zsh
# @armor (Engine Core)
# Forged in Beskar: vde-certified-ghost
set -e
export DEBIAN_FRONTEND=noninteractive
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
[[ -f "${VDE_ROOT_DIR}/lib/vde-core" ]] && source "${VDE_ROOT_DIR}/lib/vde-core"
[[ -f "${VDE_ROOT_DIR}/lib/vde-log" ]] && source "${VDE_ROOT_DIR}/lib/vde-log"

vde_log_info "Igniting Certified Ghost environment..."
# PURGING THE GHOSTS (Rule 12.5)
vde_purge_ghosts
```

- [ ] **Step 2: Verify syntax**

Run: `zsh -n scripts/setup/certified-ghost-init.zsh`
Expected: 0 exit code

- [ ] **Step 3: Commit**

```bash
git add scripts/setup/certified-ghost-init.zsh
git commit -m "fix(armor): ensure lib/vde-log is sourced in certified-ghost-init.zsh"
```
