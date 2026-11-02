# ADR-002: SSH Bridge Architecture
<!-- @forge (Context Documentation) -->

**Status**: Accepted  
**Date**: 2026-04-30  
**Context**: Decision to use SSH bridge for container access instead of docker exec

---

## Context

VDE needs a reliable, production-like method for users to access the interior of containerized development environments (Spokes). The obvious default would be `docker exec`, which provides direct command execution inside containers. However, VDE's architecture requirements demand strict production parity, identity isolation, and long-running interactive sessions.

The development environment must behave identically to how production containers are accessed. In production cloud infrastructure, SSH is the standard access method, not docker exec. Additionally, VDE requires persistent identity management, proper terminal handling, and the ability to forward ports and files—capabilities that docker exec provides poorly or inconsistently.

---

## Decision

VDE SHALL use SSH as the primary transversal bridge between Hub (host) and Spokes (containers). All user access to container interiors occurs via SSH connection using the vde_student identity key.

### Technical Implementation

1. **SSH Identity**: Each Spoke has the vde_student SSH public key added to `~/.ssh/authorized_keys` during container build
2. **Port Forwarding**: Each Spoke exposes an SSH port (unique per container) mapped to the host
3. **SSH Config**: Hub maintains `~/.ssh/config` entries for each active Spoke with connection parameters
4. **Bridge Command**: `vde enter <alias>` wraps `ssh vde_student@localhost -p <port>` with proper terminal handling
5. **Agent Integration**: VDE manages an isolated SSH agent (`~/.ssh/vde/agent_env`) to avoid key passphrase prompts

### Why SSH Over Docker Exec

1. **Production Parity**: Production servers are accessed via SSH, not docker exec
2. **Terminal Handling**: SSH provides proper TTY allocation, terminal resizing, and signal forwarding
3. **Port Forwarding**: SSH supports `-L` and `-R` for tunneling services through the bridge
4. **File Transfer**: SCP and SFTP work natively without additional tools
5. **Identity Management**: SSH key-based auth provides strong identity isolation (devuser only)
6. **Session Persistence**: SSH sessions survive network interruptions and can be reattached
7. **Remote Development**: Enables VS Code Remote SSH integration for full IDE experience

---

## Alternatives Considered

### Alternative 1: Docker Exec
**Rejected**: 
- No production parity (production uses SSH)
- Poor TTY handling and signal forwarding
- No built-in file transfer or port forwarding
- Requires repeated execution for long-running commands
- Inconsistent behavior across Docker versions

### Alternative 2: nsenter
**Rejected**:
- Requires privileged container or host access
- Breaks container isolation model
- No portable across all platforms
- Complex setup and maintenance

### Alternative 3: kubectl exec (if using Kubernetes)
**Rejected**:
- Introduces Kubernetes dependency (violates Tetrad principle)
- Over-engineering for single-node development
- Same terminal handling issues as docker exec

### Alternative 4: Web-based Terminal (xterm.js)
**Rejected**:
- Requires web server infrastructure
- No production parity
- Network latency in local development
- Breaks offline development capability

---

## Consequences

### Positive Outcomes

1. **Production Parity**: Development access matches production infrastructure patterns
2. **Rich Feature Set**: Terminal handling, file transfer, port forwarding all work out of the box
3. **Identity Isolation**: Strict devuser-only access enforced via SSH key auth
4. **Tool Integration**: Works with VS Code Remote SSH, scp, sftp, and standard SSH tooling
5. **Session Management**: Can reattach to sessions, use tmux/screen for persistence
6. **Network Isolation**: Access occurs over Docker network, maintaining container boundaries

### Negative Outcomes

1. **Complexity**: SSH setup and key management adds operational complexity
2. **Port Allocation**: Must manage unique SSH ports for each container
3. **Key Distribution**: Must inject public keys during container build
4. **Debugging**: SSH issues add a layer of potential failure points
5. **Startup Time**: SSH service must be running before access is possible

### Mitigation Strategies

1. **Automated Setup**: `vde ssh-setup init` generates and distributes keys automatically
2. **Port Management**: Dynamic port allocation with conflict detection
3. **Health Checks**: `vde health` verifies SSH bridge is operational
4. **Inline Remediation**: `vde init` generates missing keys without requiring restart
5. **Comprehensive Logging**: SSH connection failures logged with actionable error messages

---

## Related Decisions

- **ADR-001**: ZSH-Only Requirement - Both enforce production parity
- **ADR-003**: Born Ready Containers - SSH service configured at build time
- **UAP Enforcement**: SSH commands run under UAP sentinel

---

## Implementation Details

### Key Files
- `lib/vde-ssh` - SSH bridge library functions
- `bin/ssh-vm` - Direct SSH access command
- `bin/ssh-setup` - SSH key generation and distribution
- `bin/ssh-sync` - SSH config synchronization
- `scripts/vde-entrypoint.zsh` - Container entrypoint with SSH setup
- `configs/ssh/` - SSH configuration templates

### Identity Management
```zsh
# Identity location
VDE_SSH_DIR="${HOME}/.ssh/vde"
IDENTITY_KEY="${VDE_SSH_DIR}/vde_student"
PUBLIC_KEY="${IDENTITY_KEY}.pub"

# Agent management
AGENT_ENV="${VDE_SSH_DIR}/agent_env"
```

### Port Allocation
```zsh
# Each VM type defines base SSH port in vm-types.conf
# Dynamic allocation for multiple instances
SSH_PORT_BASE=$(vde_get_ssh_port "$vm_type")
SSH_PORT_ACTUAL=$(find_available_port "$SSH_PORT_BASE")
```

---

## References

- `lib/vde-ssh` - SSH bridge implementation
- `docs/ssh-configuration.md` - SSH setup and usage guide
- `docs/architecture/data-flow.md` - Security & Sovereign Bridge section
- `docs/governance/vde-protocol.md` - Identity isolation requirements

---

**This is the Way.**
