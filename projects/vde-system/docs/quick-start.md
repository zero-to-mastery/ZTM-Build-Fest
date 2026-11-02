# QUICK-START
<!-- @shared-law (Sovereign Law) -->
# Quick Start (Sovereign Baseline 1.5.5)

Get up and running with VDE in minutes.

[← Back to README](../README.md)

---

## First-Time Setup

**One command:**

```zsh
bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)
```

This checks your system, clones VDE, and walks you through setup. If anything's missing (Zsh, Git, Docker, SSH), it tells you exactly what to install and how.

- *Windows Users*: Open PowerShell as Administrator, run `wsl --install`, restart, then run the command above from your Ubuntu terminal.

**Prefer manual setup?**

```zsh
git clone -b stable https://github.com/dderyldowney/vde-system.git ~/VDE
cd ~/VDE
bin/vde path-of-the-foundling
```

---

## What Just Happened?

When you ran `bin/vde path-of-the-foundling`:
1. **Interactive Induction**: A step-by-step ritual guided you through initial configuration.
2. **Infrastructure Smelting**: `vde init` was executed automatically, creating networks and enforcing permissions.
3. **Identity Forgery**: Your unique `vde_student` SSH identity key was generated and primed.
4. **Foundation Building**: The foundational `vde-base` image was built and baked with your identity.
5. **Certification**: Your first Spoke was created and ignited to certify the Transversal Bridge.

## Daily Workflow

1. **Ignite & Enter**: 
   ```zsh
   vde start python && vde enter python
   ```
2. **Code**: You are now the `devuser`. Work in `$HOME/workspace/`. This directory is **persistently synced** to `projects/python` on your Hub (host machine).
3. **Persist**: Anything saved in `$HOME/workspace/` survives even if you `vde rebuild` the Spoke.
4. **Quench**: 
   ```zsh
   vde stop python
   ```

---

## Next Steps

- **User Guide**: Read the full [User Guide](./guides/getting-started.md) for advanced rituals.
- **Foundling Guide**: Read [Foundling Guide](./guides/foundling-guide.md) for a simplified manual.
- **Reference**: See [Command Reference](./reference/commands.md) for all rituals.

---

[← Back to README](../README.md)

*[Home](../README.md) | [Quick Start](./quick-start.md) | [Documentation](./)*
