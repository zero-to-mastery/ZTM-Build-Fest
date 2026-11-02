# Requirements
<!-- @shared-law (Sovereign Law) -->

This document outlines the system requirements for the **Sovereign Baseline (1.5.5)**.

[← Back to README](../../README.md)

---

## The Unyielding Tetrad (Mandatory)

The VDE depends on four core pillars. These MUST be installed and active on your host machine (the Hub) before you begin.

| Pillar | Requirement | Purpose | Minimum Version |
| :--- | :--- | :--- | :--- |
| **I. Zsh** | Version 5.0+ | The Voice of the Tribe. **ZSH ONLY.** | 5.0 |
| **II. Git** | Version 2.30+ | The Chronicler of your history. | 2.30 |
| **III. Docker** | Desktop / Engine | The World-Forge for your Spokes. | 20.10 |
| **IV. SSH** | OpenSSH Client | The Transversal Bridge to your Spokes. | (Any) |

---

## Platform-Specific Prerequisites

### 🪟 Windows Users: The WSL2 Mandate
Windows users MUST operate within **WSL2 (Windows Subsystem for Linux)**. This ensures Zsh-native purity and professional parity with Linux/macOS.
- **Requirement**: WSL2 active with a Linux distribution (e.g., Ubuntu).
- **Docker**: Docker Desktop for Windows configured to use the WSL2 based engine.

### 🍎 macOS Users
- **Docker**: Docker Desktop for Mac (Intel or Apple Silicon).
- **Zsh**: Native shell (pre-installed).

### 🐧 Linux Users
- **Docker**: Docker Engine and Docker Compose.
- **Privileges**: Your user must be in the `docker` group to run commands without `sudo`.

---

## Spoke Identity & Security

VDE uses a strictly isolated identity model:
- **User Account**: All Spokes run as the `devuser` account.
- **SSH Identity Key**: Access is secured via a unique `vde_student` identity key, confined to `~/.ssh/vde/`.
- **Workspace**: Your code lives at `$HOME/workspace/` inside the Spoke, synced to `projects/` on your Hub.

---

## Verifying Your Setup (The Spine Check)

Once your prerequisites are installed, you can verify your Hub's readiness by running:

```zsh
# Verify the Tetrad
zsh --version
git --version
docker version
ssh -V
```

### Initial Certification
If you have just cloned the repository, the fastest path is the bootstrap script:

```zsh
bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)
```

Or run the induction ritual manually:

```zsh
bin/vde path-of-the-foundling
```

### Continuous Verification
At any time, you can audit your Hub's compliance with the Rule Spine:
```zsh
vde health
```

---

## Environment Variables

VDE respects these environment variables (most are auto-detected):

| Variable | Purpose | Default |
|----------|---------|---------|
| `VDE_ROOT_DIR` | Root directory of the VDE repository | (Auto-detected) |
| `VDE_DOCKER_NETWORK` | The isolated bridge name | `vde-net` |
| `VDE_SSH_DIR` | The isolated key vault | `~/.ssh/vde` |

---

[← Back to README](../../README.md)
**This is the Way.**
