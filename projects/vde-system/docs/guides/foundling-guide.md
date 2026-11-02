# FOUNDLING GUIDE
<!-- @shared-law (Sovereign Law) -->
# Path of the Foundling: A Student's Guide to VDE (1.5.5)

Welcome, Foundling. You have entered the Forge. This guide explains the "Rituals" (commands) and "Creed" (rules) you will follow to learn the ways of engineering within the **Sovereign Baseline (1.5.5)**.

---

## 1. Why the Forge?
The VDE (Virtual Development Environment) provides you with "Spokes" (isolated containers). This means:
- Your computer stays clean. No installing Python, Node, or Postgres directly.
- Everything is disposable. If you break a Spoke, you just "Re-forge" (rebuild) it.
- You learn professional tools (Docker, Zsh, SSH) from day one.

## 2. The Onboarding Ritual (The First Strike)

**One command sets up everything:**

```zsh
bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)
```

This checks your system, clones VDE, and launches the onboarding. If anything's missing, it tells you exactly what to install.

**What this ritual does:**
- **Ignition**: Performs the `vde init` ritual automatically, setting up your `vde_student` SSH keys and creating the networks.
- **Spine Check**: Verifies that your Hub is ready (Zsh, Git, Docker, and SSH).
- **First Spoke**: Guides you through forging and entering your very first Python workspace.

## 3. Core Rituals (The Commands)

### Creating a Spoke (The Forge)
To create a workspace for a specific language or service:
```zsh
vde create <alias>
```

### Starting and Entering (The Handshake)
To start your Spoke and step inside as the `devuser`:
```zsh
vde start <alias>
vde enter <alias>
```
Once inside, you operate at `$HOME/workspace/`. This directory is **persistently synced** to `projects/<alias>` on your host computer, ensuring your work survives if you rebuild the Spoke image.

### Closing the Spoke (The Quench)
When your study session is done:
```zsh
vde stop <alias>
```

## 4. The Beskar Rules (Your Creed)
1. **Never use Bash**: We speak ZSH. All your scripts must start with `#!/usr/bin/env zsh`.
2. **Born Ready**: Your Spokes should have everything they need when they are created. 
3. **The Proof of Life**: We don't believe a system works; we prove it. The Forge is certified by the Heartbeat.

This is the Way.
