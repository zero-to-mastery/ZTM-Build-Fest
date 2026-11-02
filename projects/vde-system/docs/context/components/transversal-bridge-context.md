# Transversal Bridge Context
<!-- @forge (Context Documentation) -->

**Component**: Transversal Bridge (SSH Connectivity & Identity Management)  
**Project**: The Armor (@armor)  
**Last Updated**: 2026-04-30

---

## Purpose

The Transversal Bridge provides secure, production-like access from the Hub (host machine) to Spokes (containers) via SSH. It replaces docker exec with SSH to ensure production parity, proper terminal handling, file transfer capabilities, and identity isolation.

The bridge uses the vde_student SSH identity key for authentication, ensuring all access occurs as devuser inside Spokes. This maintains strict identity boundaries and prevents privileged access.

---

## Key Files

### SSH Identity Management
- `bin/ssh-setup` - SSH key generation and distribution
- `bin/ssh-sync` - SSH config synchronization for all Spokes
- `bin/ssh-vm` - Direct SSH access command
- `lib/vde-ssh` - SSH bridge library functions

### SSH Configuration
- `templates/ssh-config.tmpl` - SSH config template
- `~/.ssh/config` - User's SSH configuration (managed by VDE)
- `~/.ssh/vde/` - Isolated VDE SSH directory
- `~/.ssh/vde/vde_student` - Private SSH identity key
- `~/.ssh/vde/vde_student.pub` - Public SSH identity key
- `~/.ssh/vde/agent_env` - SSH agent environment file

### Container SSH Setup
- `scripts/vde-entrypoint.zsh` - Container entrypoint with SSH setup
- `public-ssh-keys/vde_student.pub` - Public key copied into containers
- `configs/ssh/sshd_config` - SSH daemon configuration

### SSH Agent Management
- `bin/ssh-agent-setup` - SSH agent initialization and management
- `~/.ssh/vde/agent_env` - Agent socket and PID exports

---

## Dependencies

### System Dependencies
- **SSH Client**: OpenSSH client on Hub for outbound connections
- **SSH Server**: OpenSSH server in Spokes for inbound connections
- **SSH Agent**: ssh-agent for key passphrase caching

### Internal Dependencies
- **Hub System**: Manages SSH bridge lifecycle
- **Spoke System**: Runs SSH server and accepts connections
- **Port Allocation**: Unique SSH port per container
- **Identity Management**: vde_student key generation and distribution

### External Dependencies
- **None**: SSH is part of the Unyielding Tetrad

---

## Integration Points

### APIs Exposed
- **SSH Service**: Each Spoke exposes SSH on assigned port
- **SFTP**: File transfer protocol over SSH
- **Port Forwarding**: SSH -L/-R for tunneling services

### Events Published
- **Connection Events**: Logged via SSH verbose mode
- **Authentication Events**: Logged in Spoke auth logs
- **Key Generation Events**: Logged by ssh-setup

### Events Consumed
- **Container Start**: Triggers SSH config sync
- **Container Stop**: Triggers SSH config cleanup
- **Port Changes**: Triggers SSH config update

### Database Interactions
- **None**: SSH config stored in ~/.ssh/config and ~/.ssh/vde/

---

## Architecture Patterns

### Identity Isolation Pattern
```zsh
# Identity location
VDE_SSH_DIR="${HOME}/.ssh/vde"
IDENTITY_KEY="${VDE_SSH_DIR}/vde_student"

# Key generation
ssh-keygen -t ed25519 -f "${IDENTITY_KEY}" -N "" -C "vde_student@vde"

# Public key distribution to containers
cp "${IDENTITY_KEY}.pub" public-ssh-keys/
```

### SSH Config Management Pattern
```zsh
# Template-based config generation
generate_ssh_config() {
    local alias="$1"
    local port="$2"
    
    cat >> ~/.ssh/config <<EOF
Host vde-${alias}
    HostName localhost
    Port ${port}
    User devuser
    IdentityFile ~/.ssh/vde/vde_student
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
EOF
}
```

### SSH Agent Pattern
```zsh
# Isolated agent for VDE keys
SSH_AUTH_SOCK="${HOME}/.ssh/vde/agent.sock"
SSH_AGENT_PID="${HOME}/.ssh/vde/agent.pid"

# Start agent
ssh-agent -a "${SSH_AUTH_SOCK}" > "${HOME}/.ssh/vde/agent_env"
source "${HOME}/.ssh/vde/agent_env"

# Add identity
ssh-add "${IDENTITY_KEY}"
```

### Port Forwarding Pattern
```zsh
# Forward local port to Spoke service
ssh -L 8080:localhost:3000 vde-python

# Forward Spoke service to local port
ssh -R 3000:localhost:8080 vde-python
```

---

## Key Architectural Decisions

### SSH Over Docker Exec
**Decision**: Use SSH bridge instead of docker exec  
**Rationale**: Production parity, terminal handling, port forwarding, file transfer

### Isolated SSH Directory
**Decision**: ~/.ssh/vde/ for VDE-specific SSH state  
**Rationale**: Prevents conflicts with user's existing SSH setup

### ed25519 Keys
**Decision**: Use ed25519 instead of RSA  
**Rationale**: Smaller keys, faster performance, modern security

### devuser Identity
**Decision**: All SSH access as devuser, never root  
**Rationale**: Security, consistent with production, prevents accidental damage

---

## Bridge Operations

### Initialization (vde ssh-setup init)
```zsh
# Generate vde_student key pair
vde ssh-setup init

# Output:
# ✓ Generated ed25519 key: ~/.ssh/vde/vde_student
# ✓ Started SSH agent: ~/.ssh/vde/agent.sock
# ✓ Added identity to agent
```

### Connection (vde enter)
```zsh
# Enter container via SSH
vde enter python

# Equivalent to:
# ssh vde-python
# (which expands to ssh devuser@localhost -p <port> -i ~/.ssh/vde/vde_student)
```

### Configuration Sync (vde ssh-sync)
```zsh
# Sync SSH config for all active containers
vde ssh-sync

# Updates ~/.ssh/config with entries for all running Spokes
```

### File Transfer (SCP/SFTP)
```zsh
# Copy file to Spoke
scp myfile.txt vde-python:~/workspace/

# Copy file from Spoke
scp vde-python:~/workspace/result.txt .

# Interactive SFTP
sftp vde-python
```

### Port Forwarding
```zsh
# Forward local 8080 to Spoke's 3000
ssh -L 8080:localhost:3000 vde-python

# Now http://localhost:8080 accesses Spoke's service
```

---

## SSH Configuration

### Hub SSH Client Config
```sshconfig
# ~/.ssh/config (managed by VDE)

Host vde-python
    HostName localhost
    Port 3022
    User devuser
    IdentityFile ~/.ssh/vde/vde_student
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null

Host vde-nodejs
    HostName localhost
    Port 3023
    User devuser
    IdentityFile ~/.ssh/vde/vde_student
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
```

### Spoke SSH Server Config
```sshconfig
# /etc/ssh/sshd_config (in container)

Port 22
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers devuser
X11Forwarding no
AllowTcpForwarding yes
GatewayPorts no
```

---

## Identity Management

### Key Generation
```zsh
# Generate ed25519 key pair
ssh-keygen -t ed25519 -f ~/.ssh/vde/vde_student -N "" -C "vde_student@vde"

# Result:
# ~/.ssh/vde/vde_student     (private key)
# ~/.ssh/vde/vde_student.pub (public key)
```

### Public Key Distribution
```zsh
# Copy to public-ssh-keys/ for container builds
cp ~/.ssh/vde/vde_student.pub public-ssh-keys/

# Dockerfile copies into container
COPY public-ssh-keys/vde_student.pub /home/devuser/.ssh/authorized_keys
```

### Key Usage
```zsh
# Add to agent (passphrase caching)
ssh-add ~/.ssh/vde/vde_student

# List keys in agent
ssh-add -l

# Remove all keys
ssh-add -D
```

---

## Common Operations

### Testing SSH Connection
```zsh
# Direct SSH test
ssh -i ~/.ssh/vde/vde_student -p 3022 devuser@localhost

# Or via VDE command
vde enter python
```

### Viewing SSH Configuration
```zsh
# View all VDE SSH configs
grep -A 5 "Host vde-" ~/.ssh/config

# View specific Spoke config
grep -A 10 "Host vde-python" ~/.ssh/config
```

### Restarting SSH Agent
```zsh
# Kill existing agent
kill $SSH_AGENT_PID

# Start new agent
ssh-agent-setup

# Add identity
ssh-add ~/.ssh/vde/vde_student
```

### Debugging SSH Issues
```zsh
# Verbose SSH connection
ssh -v vde-python

# Check SSH port
vde port python

# Check container SSH service
docker exec vde-python systemctl status ssh
```

---

## Operational Considerations

### Connection Security
- **No Password Auth**: Only public key authentication
- **No Root Login**: Only devuser can SSH in
- **Strict Host Key Checking**: Disabled for localhost (acceptable in dev)
- **Agent Forwarding**: Disabled by default (security)

### Performance
- **Connection Time**: ~100ms for first connection
- **Session Persistence**: Connections survive network interruptions
- **Agent Caching**: Passphrase cached in agent for session duration

### Reliability
- **Port Allocation**: Unique port per container prevents conflicts
- **Config Sync**: Automatic config updates on container start/stop
- **Key Management**: Automatic key generation if missing

---

## Troubleshooting

### SSH Connection Refused
1. Check container running: `vde ps`
2. Check SSH port: `vde port <alias>`
3. Check SSH service: `docker exec vde-<alias> systemctl status ssh`
4. View container logs: `vde logs <alias>`

### Permission Denied (publickey)
1. Verify key exists: `ls -la ~/.ssh/vde/vde_student*`
2. Check key in agent: `ssh-add -l`
3. Verify public key in container: `docker exec vde-<alias> cat ~/.ssh/authorized_keys`
4. Regenerate key: `vde ssh-setup init`

### SSH Config Missing
1. Manually sync: `vde ssh-sync`
2. Check config file: `grep "vde-<alias>" ~/.ssh/config`
3. Verify template: `cat templates/ssh-config.tmpl`

### Agent Not Running
1. Check agent: `echo $SSH_AGENT_PID`
2. Start agent: `ssh-agent-setup`
3. Add key: `ssh-add ~/.ssh/vde/vde_student`

---

## References

- `adr-002-ssh-bridge-architecture.md` - SSH bridge architectural decision
- `docs/ssh-configuration.md` - SSH setup and usage guide
- `lib/vde-ssh` - SSH bridge implementation
- `docs/vscode-remote-ssh.md` - VS Code Remote SSH integration

---

**This is the Way.**
