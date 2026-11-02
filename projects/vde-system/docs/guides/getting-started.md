# GETTING STARTED
<!-- @armor (Student Documentation) -->
<p align="center"><img src="../imgs/vde-system-logo.png" alt="Virtualized Development Environment System Logo"></p>

# VDE Getting Started: The Path of the Foundling

Welcome to the **Virtualized Development Environment (VDE)**. This guide is your map to forging a sovereign development ecosystem.

---

## 1. Onboarding: The Path of the Foundling

**One command gets you everything:**

```zsh
bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)
```

This checks your system, clones VDE, and launches the onboarding ritual. If anything's missing, it tells you exactly what to install.

The onboarding ritual (`path-of-the-foundling`) then walks you through the lifecycle:
1.  **`vde init`**: The Initialization Ritual. Hydrates your Hub and generates your `vde_student` SSH identity key.
2.  **`vde create <alias>`**: The Smelting Ritual. Creates an immutable Docker image for a Spoke.
3.  **`vde start <alias>`**: The Ignition Ritual. Brings the Spoke to life as a running container.
4.  **`vde enter <alias>`**: The Sovereign Handshake. Securely enters the Spoke as the `devuser` via the SSH bridge.
5.  **`vde stop <alias>`**: The Quenching Ritual. Safely stops the Spoke.
6.  **`vde rm <alias>`**: The Dissolution Ritual. Removes the Spoke instance.

---

## 2. Daily Development Workflows

### Your Workspace
Inside any Spoke, you operate as the `devuser`. Your code lives at `$HOME/workspace/`. This directory is **persistently synced** to `projects/<alias>` on your host machine. Save your work here to ensure it survives Spoke rebuilds.

### Clusters and Discovery
VDE supports multi-Spoke tech stacks:
```vde start python postgres redis```
Spokes discover each other automatically by name. Python can reach Postgres at `vde-postgres` and Redis at `vde-redis`.

### The Sovereign Bridge (`vde-host`)
To access services on your host computer (the Hub) or the internet bridge, use `vde-host`.

---

## 3. The Beskar Vault (Directory Structure)

| Directory | Project | Purpose |
| :--- | :--- | :--- |
| `projects/` | `@armor` | **YOUR CODE LIVES HERE.** Persistent and synced. |
| `data/` | `@armor` | Database persistence (Postgres/Redis volumes). |
| `bin/` | `@shared-law` | The `vde` command suite. |
| `env-files/` | `@shared-law` | Configuration for your Spokes. |

---

## 4. Essential Rituals Reference

| Command | Action |
| :--- | :--- |
| `vde list` | Audit all registered and active Spokes. |
| `vde info <alias>` | Inspect the configuration of a specific Spoke. |
| `vde rebuild <alias>` | Re-smelt a Spoke image (updates packages). |
| `vde health` | Run System Spine health checks (Spine Check). |
| `vde dns-check` | Verify cross-Spoke DNS resolution. |
| `vde nuke` | **The Great Quench**: Safe removal of all VDE artifacts. |

**This is the Way.**
