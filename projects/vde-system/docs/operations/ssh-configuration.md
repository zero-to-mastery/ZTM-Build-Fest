# SSH Configuration & Agent Forwarding
<!-- @shared-law (Sovereign Law) -->

VDE provides **automatic SSH configuration** and **SSH agent forwarding** for seamless communication in the **Sovereign Baseline (1.5.5)**.

[← Back to README](../../README.md)

---

## Overview

VDE handles all SSH setup automatically through the `vm-common` library and related SSH functions:

- **Automatic SSH key detection**: Finds and uses all your SSH keys (ed25519, RSA, ECDSA, DSA, security keys)
- **Automatic SSH agent management**: Starts agent, loads keys, no manual configuration
- **Automatic SSH config generation**: Creates entries for all VMs in `~/.ssh/vde/config`
- **SSH agent forwarding**: VMs access your host's SSH keys securely (keys never leave the host)
- **Port-based authentication**: Each VM gets a unique SSH port for isolation

**No manual setup required** - VDE handles everything when you create or start VMs.

### SSH Key Types Supported

VDE automatically detects and uses any of these key types (in priority order):

- **vde_student** (preferred, most secure)
- **id_ecdsa_sk** (security key)
- **vde_student_sk** (security key)
- **id_ecdsa**
- **id_rsa**
- **id_dsa** (legacy)

Priority order: ed25519 > ecdsa-sk > ed25519-sk > ecdsa > rsa > dsa

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Host Machine                            │
│                                                                  │
│  ┌──────────────┐         ┌──────────────────────────────────┐ │
│  │ VDE SSH Keys │         │ SSH Agent                        │ │
│  │ ~/.ssh/vde/  │◄────────┤ • Holds private keys             │ │
│  │ vde_student  │         │ • Never exposes keys directly     │ │
│  │ ...         │         │ • Socket: $SSH_AUTH_SOCK         │ │
│  └──────────────┘         └──────────────▲───────────────────┘ │
│                                          │                     │
│                                          │ Socket Forwarding   │
│                                          ▼                     │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Docker Container (VM)                                     │ │
│  │                                                           │ │
│  │  • SSH_AUTH_SOCK=/ssh-agent/sock                          │ │
│  │  • Socket mounted read-only from host                     │ │
│  │  • Can use host's VDE SSH keys for authentication         │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Security Model

- **Private keys NEVER leave the host**: Only the authentication socket is forwarded
- **Read-only mount**: Containers cannot modify the SSH agent socket
- **Automatic key management**: All your keys are detected and loaded automatically
- **No manual configuration**: VDE handles agent startup and key loading

---

## Automatic SSH Setup

### What Happens Automatically

When you run `vde create` or `vde start`, VDE automatically:

1. **Starts SSH agent** if not running
2. **Detects all SSH keys** in `~/.ssh/vde/`
3. **Generates a key** if you don't have one (ed25519)
4. **Loads all keys** into the agent
5. **Generates SSH config** entries for VM-to-VM communication

### No Manual Steps Required

```zsh
# Just create and start VMs - SSH is handled automatically
vde create python
vde start python

# Connect using VDE commands (recommended)
vde enter python          # Enter the Spoke's login shell
vde enter py             # Uses Python's alias

# Or connect directly with SSH (requires -F flag)
ssh -F ~/.ssh/vde/config vde-python

# Or create a shell alias for convenience
alias vssh='ssh -F ~/.ssh/vde/config'
vssh vde-python
```

---

## VM-to-VM Communication

SSH from one VM to another using your host's SSH keys:

### Basic Examples

```zsh
# From your host
vde enter go              # Connect to Go VM

# From within Go VM (via SSH agent forwarding)
ssh vde-python            # SSH to Python VM
ssh vde-rust pwd          # Run command on Rust VM
scp vde-python:/data/file .  # Copy file from Python VM
```

### Full Stack Example

```zsh
# Create and start VMs
vde create python postgres redis
vde start python postgres redis

# From Python VM, connect to services via DNS discovery
vde enter python
psql -h vde-postgres -U devuser    # Connect to PostgreSQL
redis-cli -h vde-redis             # Connect to Redis
```

### SSH Config for VM-to-VM

VDE automatically generates these entries in `~/.ssh/vde/config`:

```ssh-config
# Python Dev VM
Host vde-python
    HostName localhost
    Port 2217
    User devuser
    IdentityFile ~/.ssh/vde/vde_student
    IdentitiesOnly yes

# Go Dev VM
Host vde-go
    HostName localhost
    Port 2208
    User devuser
    IdentityFile ~/.ssh/vde/vde_student
    IdentitiesOnly yes
```

This allows VMs to SSH to each other via `localhost:<port>`.

---

## VM-to-Host Communication

Execute commands on your host from within any VM:

### Direct Docker Commands

```zsh
# From within any VM
docker exec vde-python ls           # Execute in Python VM
docker exec vde-postgres psql       # Execute in PostgreSQL
```

---

## VM-to-External Communication

Use your host's SSH keys for external services from within any VM:

### Git Operations

```zsh
# From within any VM - uses your GitHub/GitLab keys
git clone github.com:user/repo
git push origin main
```

### External SSH

```zsh
# From within any VM - uses your host keys
ssh user@external-server.com
scp user@external-server.com:/path/file .
```

---

## Checking SSH Status

### View SSH Status

```zsh
# Interactive status display
vde health  # Includes SSH status check
```

This shows:
- SSH agent run status
- Available SSH keys
- Keys loaded in agent
- Running VMs
- Usage examples

### Manual Commands

```zsh
# Check if SSH agent is running
ps aux | grep ssh-agent

# View loaded keys
ssh-add -l

# View SSH config
cat ~/.ssh/vde/config

# Test SSH connection
ssh -v vde-python
```

---

## Manual SSH Operations (Optional)

While VDE handles everything automatically, you can perform manual operations if needed:

### Add a New Key to Agent

```zsh
ssh-add ~/.ssh/vde/new_key
```

### Start SSH Agent Manually

```zsh
eval "$(ssh-agent -s)"
ssh-add
```

### Stop Agent

```zsh
ssh-agent -k
```

### Restart Agent

```zsh
eval "$(ssh-agent -s)" && ssh-add
```

---

## Troubleshooting

### SSH Agent Not Running

**Symptom**: `SSH_AUTH_SOCK` not set or agent not found

**Solution**: VDE starts agent automatically, but you can manually start:

```zsh
eval "$(ssh-agent -s)"
ssh-add
```

### Keys Not Loaded in Agent

**Symptom**: `ssh-add -l` shows "no identities"

**Solution**: Add your keys:

```zsh
ssh-add ~/.ssh/vde/vde_student
# Or add all keys
for key in ~/.ssh/vde/id_*; do [ -f "$key" ] && ssh-add "$key"; done
```

### VM-to-VM SSH Not Working

**Symptom**: Can't SSH from one VM to another

**Solution**: Check that both VMs are running:

```zsh
docker ps | grep -E "python|go"
```

Regenerate VM SSH config:

```zsh
vde health
```

### Permission Denied (publickey)

**Symptom**: `Permission denied (publickey)`

**Solutions**:

1. Check key permissions:
```zsh
chmod 600 ~/.ssh/vde/vde_student
chmod 644 ~/.ssh/vde/vde_student.pub
```

2. Verify key is in agent:
```zsh
ssh-add -l
```

3. Check SSH config:
```zsh
cat ~/.ssh/vde/config
```

4. Rebuild VM with updated keys:
```zsh
vde stop python
vde start python
```

### Connection Refused

**Symptom**: `ssh: connect to host localhost port 2217: Connection refused`

**Solutions**:

1. Check if container is running:
```zsh
docker ps | grep python
```

2. Check container logs:
```zsh
docker logs vde-python
```

3. Restart container:
```zsh
vde stop python
vde start python
```

### Verbose Debugging

```zsh
# Enable verbose SSH output
ssh -v vde-python

# More verbose
ssh -vv vde-python

# Maximum verbosity
ssh -vvv vde-python
```

---

## Best Practices

1. **Let VDE handle SSH setup**: Don't manually configure SSH agent or keys
2. **Use VM aliases**: Use `vde-python` instead of `localhost -p 2217`
3. **Use the vde CLI**: Prefer `vde create/start/stop` over direct script calls
4. **Check status with vde health**: Run `vde health` for comprehensive system status including SSH agent status
5. **Multiple keys are supported**: All your keys are automatically detected and loaded
6. **Security keys work too**: YubiKey and other security keys are automatically detected
7. **Keys never leave the host**: Agent forwarding is secure by design
8. **VM-to-VM communication**: Use SSH for service-to-service communication

---

## Related Documentation

- [Quick Start](../guides/getting-started.md) - Getting started with VDE
- [Advanced Usage](../guides/advanced-usage.md) - VM-to-VM communication patterns
- [Architecture](../architecture/overview.md) - Technical architecture details
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions

---

[← Back to README](../../README.md)
