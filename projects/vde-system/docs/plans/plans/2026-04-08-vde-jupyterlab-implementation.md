# vde-jupyterlab Implementation Plan
<!-- @shared-law (Sovereign Law) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `vde-jupyterlab` VM type with a full Data Science stack and persistent workspace mounting.

**Architecture:** Add `vde-jupyterlab` as a service in the registry, create a USP-compliant hydration script, and override the default service mount behavior in `lib/vm-common` to use a workspace mount at `projects/python/jupyterlabs`.

**Tech Stack:** ZSH, Docker, Python (JupyterLab, TensorFlow, etc.)

---

### Task 1: VM Registry Update

**Files:**
- Modify: `data/vm-types.json`

- [ ] **Step 1: Add vde-jupyterlab to service category**

```json
// Add to the "service" array in data/vm-types.json
{
  "name": "vde-jupyterlab",
  "aliases": ["jupyter", "lab", "notebook", "jupyterlab"],
  "display": "JupyterLab Data Science Suite",
  "pkgs": "python3-pip python3-venv",
  "custom_cmd": "zsh /vde/scripts/setup/jupyterlab-init.zsh",
  "service_ports": "8888",
  "ssh_port": 2407
}
```

- [ ] **Step 2: Verify registry with vde-enforce-uap.zsh**

Run: `./bin/vde-enforce-uap.zsh`
Expected: SUCCESS

- [ ] **Step 3: Commit registry update**

```zsh
git add data/vm-types.json
git commit -m "feat: Add vde-jupyterlab to VM registry"
```

---

### Task 2: Workspace Mount Override

**Files:**
- Modify: `lib/vm-common`

- [ ] **Step 1: Implement mount override in get_vm_mounts**

```zsh
# In lib/vm-common, update get_vm_mounts()
get_vm_mounts() {
    local vm_name="${1}"
    local category
    category=$(get_vm_category "${vm_name}")
    local raw_name
    raw_name=$(vde_normalize_name "${vm_name}")
    
    local src_path dst_path
    # Base mounts for all VMs
    local mounts=".:/vde:ro"
    
    # NEW: jupyterlab override
    if [[ "${raw_name}" == "jupyterlab" ]]; then
        src_path="projects/python/jupyterlabs"
        dst_path="/home/devuser/workspace"
    elif [[ "${category}" == "languages" ]]; then
        # ... existing logic ...
```

- [ ] **Step 2: Verify mount resolution**

Run: `source lib/vde-core && source lib/vm-common && get_vm_mounts vde-jupyterlab`
Expected: Outputs `.:/vde:ro|projects/python/jupyterlabs:/home/devuser/workspace|logs/jupyterlab:/logs`

- [ ] **Step 3: Commit mount override**

```zsh
git add lib/vm-common
git commit -m "feat: Implement workspace mount override for vde-jupyterlab"
```

---

### Task 3: Hydration Script Creation

**Files:**
- Create: `scripts/setup/jupyterlab-init.zsh`

- [ ] **Step 1: Write the hydration script**

```zsh
#!/usr/bin/env zsh
# VDE USP Hydration Script: jupyterlab
# Part of the Universal Script Parity (USP) mandate.
# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
local vde_jupyter_pkgs="python3-pip python3-venv"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_jupyter_pkgs}

# 3. Create a dedicated venv for Jupyter
local _venv_path="/home/devuser/.vde-venv"
sudo -u devuser python3 -m venv "${_venv_path}"

# 4. Install DS stack
sudo -u devuser "${_venv_path}/bin/pip" install --upgrade pip
sudo -u devuser "${_venv_path}/bin/pip" install \
    jupyterlab \
    matplotlib \
    scikit-learn \
    tensorflow \
    numpy \
    pandas

# 5. CONFIGURE JUPYTER
local _jupyter_config="/home/devuser/.jupyter/jupyter_lab_config.py"
sudo -u devuser mkdir -p /home/devuser/.jupyter
sudo -u devuser zsh -c "cat <<EOF > ${_jupyter_config}
c.ServerApp.ip = '0.0.0.0'
c.ServerApp.port = 8888
c.ServerApp.open_browser = False
c.ServerApp.token = ''
c.ServerApp.password = ''
c.ServerApp.root_dir = '/home/devuser/workspace'
EOF"

# 6. PERSISTENCE ANCHOR
local _zshenv="/home/devuser/.zshenv"
mkdir -p /home/devuser
touch "${_zshenv}"
grep -q "jupyter lab" "${_zshenv}" || {
    echo "nohup ${_venv_path}/bin/jupyter lab --config=${_jupyter_config} >/logs/jupyter.log 2>&1 &" >> "${_zshenv}"
}
chown devuser:devuser "${_zshenv}"

# 7. PURGING THE GHOSTS
apt-get clean
rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Set executable permissions**

Run: `chmod +x scripts/setup/jupyterlab-init.zsh`

- [ ] **Step 3: Commit hydration script**

```zsh
git add scripts/setup/jupyterlab-init.zsh
git commit -m "feat: Create jupyterlab-init.zsh hydration script"
```

---

### Task 4: Final Verification & Ignition

**Files:**
- Create: `projects/python/jupyterlabs/.keep`

- [ ] **Step 1: Create the host workspace directory**

Run: `mkdir -p projects/python/jupyterlabs && touch projects/python/jupyterlabs/.keep`

- [ ] **Step 2: Ignite the VM**

Run: `./bin/vde start jupyterlab`
Expected: Successful ignition and port 8888 exposed.

- [ ] **Step 3: Verify JupyterLab connectivity**

Run: `curl -I http://localhost:8888`
Expected: HTTP/1.1 200 OK (or similar)

- [ ] **Step 4: Commit workspace anchor**

```zsh
git add projects/python/jupyterlabs/.keep
git commit -m "chore: Initialize jupyterlab workspace directory"
```
