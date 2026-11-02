# TROUBLESHOOTING
<!-- @shared-law (Sovereign Law) -->
# Troubleshooting (1.5.5)

Common issues and solutions for VDE in the **Sovereign Baseline (1.5.5)**.

[← Back to README](../../README.md)

---

## SSH Authentication Fails: "Permission denied (publickey)"

**Problem:** You try to connect but get "Permission denied (publickey)".

### Solution 1: Use the `vde` command (Recommended)

```zsh
# The canonical way to enter a Spoke:
vde enter go
```

### Solution 2: Verify the Identity Key is Loaded

VDE uses the `vde_student` key. Ensure it is in your host's SSH agent:

```zsh
ssh-add -l | grep vde_student
```
If not found, run:
```zsh
vde init
```

### Why this happens

Your Hub has a username (like `alex`). VDE Spokes use `devuser` as the internal account. When you run `ssh localhost`, SSH tries to log in as **your** Hub username. The `vde enter` command automatically handles the `devuser@` mapping and port resolution.

---

## Port Conflicts

**Problem:** A port is already in use, preventing Spoke ignition.

```zsh
# See what is using the port (e.g., 2203)
lsof -i :2203

# Stop the conflicting Spoke
vde stop python

# Or use the Tactical Sweep to clear all locks
vde-tactical-sweep.zsh
```

---

## SSH Agent Forwarding Issues

**Problem:** You cannot use Git or SSH between Spokes.

```zsh
# 1. Check if the agent is running on the Hub
echo $SSH_AUTH_SOCK

# 2. Verify the vde_student key is loaded
ssh-add -l

# 3. Run the Handshake Ritual to verify the bridge
vde dns-check python postgres
```

---

## Spoke Won't Start

**Problem:** A Spoke fails to ignite or crashes immediately.

```zsh
# 1. Check the logs
vde logs python

# 2. Re-smelt the image to factory baseline
vde rebuild python

# 3. Verify the Tetrad health
vde health
```

---

## VSCode Remote-SSH Connection Failures

**Problem:** VSCode cannot connect to a Spoke.

```zsh
# 1. Verify you can connect from the terminal
vde enter go

# 2. Ensure your Hub's SSH config includes the VDE vault:
# Your ~/.ssh/config should contain: Include ~/.ssh/vde/config

# 3. Open the correct folder in VSCode:
$HOME/workspace/
```

---

## Data Persistence

**Problem:** Your code disappeared after a rebuild.

**Solution:** Ensure you are saving work in `$HOME/workspace/`. Files saved outside this directory (e.g., in `/tmp` or `/etc`) are ephemeral and will be purged during a `vde rebuild`.

---

## Complete Reset (The Great Quench)

If the Forge is hopelessly fractured and you need a clean start:

```zsh
# 1. Backup your projects/ and data/ directories.
# 2. Execute the Great Quench
vde nuke
```
This removes all VDE containers, images, and networks, allowing you to run `vde path-of-the-foundling` from a blank slate.

---

[← Back to README](../../README.md)
**This is the Way.**
