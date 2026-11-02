# VDE Design Spec: JupyterLab Data Science Suite
<!-- @shared-law (Sovereign Law) -->

**Date:** 2026-04-08
**Status:** Approved (Brainstorming Phase Complete)
**Version:** 1.0.0

---

## 1. Goal
To provide a specialized VDE VM type (`jupyterlab`) that delivers a production-ready JupyterLab environment pre-configured with a top-tier Data Science stack (matplotlib, scikit-learn, tensorflow, numpy, pandas) and a persistent workspace mounted from the host.

## 2. Architecture & Identity
The `vde-jupyterlab` VM is categorized as a **Service** spoke to allow for exposing the Jupyter server's web interface.

### 2.1 Registry Configuration (`data/vm-types.json`)
```json
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

## 3. Hydration Logic (`scripts/setup/jupyterlab-init.zsh`)
The hydration script follows the **Universal Script Parity (USP)** mandate.

### 3.1 Stack Isolation
*   Creates a hidden virtual environment: `/home/devuser/.vde-venv`.
*   Installs all DS packages into this isolated environment.

### 3.2 Configuration (Sovereign Handshake)
*   **IP Binding**: `0.0.0.0` for container accessibility.
*   **Authentication**: Tokens and passwords disabled for local development ease.
*   **Persistence Anchor**: Uses `.zshenv` to start the Jupyter server in the background on any shell entry (vde exec/enter).

## 4. Mounting & Persistence
VDE will be configured to mount a specific host directory to ensure project organization.

*   **Host Path**: `projects/python/jupyterlabs/` (Automatically created if missing).
*   **Container Path**: `/home/devuser/workspace` (Standard VDE workspace anchor).

## 5. Implementation Strategy
1.  Update `lib/vm-common` to support the specific `vde-jupyterlab` mount override.
2.  Update the VM registry in `data/vm-types.json`.
3.  Create the `scripts/setup/jupyterlab-init.zsh` hydration script.
4.  Verify the ignition and stack connectivity (Port 8888).

---

## 6. Spec Self-Review
1.  **Placeholder scan:** None.
2.  **Internal consistency:** Registry ports (2407) align with service range (2400-2499).
3.  **Scope check:** Focused on the jupyterlab VM creation and hydration.
4.  **Ambiguity check:** Explicitly defines the `.vde-venv` name and the host mount path.
