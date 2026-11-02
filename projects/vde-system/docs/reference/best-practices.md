# Best Practices
<!-- @shared-law (Sovereign Law) -->

Recommended practices for working with VDE effectively in the **Sovereign Baseline (1.5.5)**.

[← Back to README](../../README.md)

---

## Development Workflow

### 1. Work in Projects Directory

All code is in `projects/<lang>/` which persists on your host (the Hub).

```zsh
# Good: Work in projects directory on your host
cd ~/vde/projects/python/my-api
# Edit files, they appear in container at $HOME/workspace/

# Access via SSH - files are mounted from host
vde enter python
cd ~/workspace  # Persistently synced to ~/vde/projects/python/
# Files persist here even after image rebuilds
```

### 2. Use VSCode Remote-SSH

Edit code locally with full IDE support while executing in the Spoke.

```
1. Connect VSCode to VM via Remote-SSH (e.g., vde-python)
2. Open the folder: $HOME/workspace/
3. Edit files with full language support
4. Use integrated terminal for vde commands
```

### 3. Commit Often

Your code is safe on the host; containers are ephemeral.

```zsh
# Git repo on host (The Hub)
cd ~/vde/projects/python/my-api
git commit -am "Work in progress"

# Spoke can be rebuilt anytime
vde rebuild python
# Your code is still there in $HOME/workspace/
```

### 4. Use Service VMs

Databases and caches run in separate containers for isolation and parity.

```zsh
# Good: Use separate service containers
vde start postgres redis

# Connect from language container
vde enter python
psql -h vde-postgres -U devuser  # Works via DNS discovery!
```

### 5. Multi-Spoke Interaction

All VMs share the `vde-net` bridge and have SSH agent forwarding enabled.

```zsh
# From vde-python, connect to postgres using Hub's SSH keys
ssh vde-postgres
```

**Inter-Spoke Best Practices:**
- Use canonical names (`vde-postgres`) for communication.
- Leverage SSH agent forwarding for Git operations inside Spokes.
- No need to copy keys into Spokes; the `vde_student` key remains on the Hub.

---

## Container Management

### Start Only What You Need

```zsh
# Good: Start only what you're using
vde start python postgres

# Avoid: Starting everything unless needed
vde start all  # Consumes Hub resources
```

### Stop When Done

```zsh
# Stop VMs to free memory/CPU
vde stop python postgres

# Or stop all
vde stop all
```

### Check Status Regularly

```zsh
vde list
```

---

## Configuration

### Keep SSH Config Updated

VDE automatically manages `~/.ssh/vde/config` during the `init` and `create` rituals.

```zsh
# Check SSH entries
cat ~/.ssh/vde/config | grep -A 5 "Host "
```

### Backup Important Data

```zsh
# Service data persists on host in the data/ directory
ls ~/vde/data/postgres/

# Back it up regularly
tar -czf postgres-backup.tar.gz ~/vde/data/postgres/
```

---

## Security

### SSH Agent Forwarding

VDE uses SSH agent forwarding to keep your environment secure.

**Security Model:**
- Private keys **NEVER leave the Hub** machine.
- Only the authentication socket is forwarded to Spokes (read-only).
- Spokes authenticate using the `vde_student` key via the bridge.

**Best Practices:**
- Let `vde path-of-the-foundling` handle SSH setup automatically.
- Ensure the `vde_student` key is loaded in your host agent (`ssh-add -l`).
- Use `vde health` to verify the Transversal Bridge integrity.

### Use Sudo Judiciously

You have passwordless `sudo` as the `devuser` inside Spokes, but use it carefully:

```zsh
# In Spoke
sudo apt-get update  # Needed for system packages
# But prefer build-time hydration (vde rebuild) for permanent changes.
```

---

## Documentation

### Keep READMEs Updated

Each project in `projects/` should have its own README:

```zsh
# projects/python/my-api/README.md
# Document how to run, test, and deploy your specific app
```

---

[← Back to README](../../README.md)
**This is the Way.**
