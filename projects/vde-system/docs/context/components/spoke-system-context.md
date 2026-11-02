# Spoke System Context
<!-- @forge (Context Documentation) -->

**Component**: Spoke System (Container Lifecycle & USP)  
**Project**: The Armor (@armor)  
**Last Updated**: 2026-04-30

---

## Purpose

Spokes are isolated containers (jails) where development occurs. Each Spoke provides a complete, reproducible development environment for a specific technology stack (Python, Node.js, Go, etc.). Spokes are managed by the Hub via the Transversal Bridge (SSH) and follow the Universal Script Parity (USP) pattern for consistent initialization.

Spokes are AI-blind, depend only on the Unyielding Tetrad, and operate independently once created. Students (Foundlings) work as `devuser` inside Spokes with full isolation from the Hub.

---

## Key Files

### Spoke Definition
- `data/vm-types.conf` - Source of truth for all Spoke configurations
- `data/vm-types.json` - Machine-readable Spoke definitions
- `templates/compose-service.yml` - Docker Compose service template
- `templates/compose-language.yml` - Language-specific Dockerfile template

### Initialization Scripts (USP)
- `scripts/vde-entrypoint.zsh` - Universal container entrypoint
- `scripts/vde-motd.zsh` - Message of the Day display
- `scripts/setup/<alias>-init.zsh` - Spoke-specific initialization (one per VM type)

### Spoke State
- `projects/<alias>/` - Workspace directories synced to Hub
- `logs/<alias>/` - Spoke-specific logs
- `data/<alias>/` - Spoke data persistence

### Configuration Files
- `env-files/<alias>.env` - Spoke environment variables
- `configs/docker/` - Docker configuration templates
- `configs/nginx/` - Nginx configuration (if needed)
- `configs/postgres/` - PostgreSQL configuration (if needed)

---

## Dependencies

### Container Base Images
- **Ubuntu 22.04**: Default base for most Spokes
- **Alpine**: Lightweight variants for minimal Spokes
- **Language-Specific**: Official images for some stacks (e.g., python:3.11)

### Runtime Dependencies (Installed at Build Time)
- **Zsh**: Shell environment (required by Mandate C)
- **OpenSSH Server**: For Transversal Bridge access
- **Git**: Version control
- **Language Runtimes**: Python, Node.js, Go, etc. (per VM type)
- **Development Tools**: Editors, debuggers, linters (per VM type)

### Internal Dependencies
- **Hub System**: Hub manages Spoke lifecycle
- **Transversal Bridge**: SSH connectivity from Hub
- **Lock System**: Coordinates creation/deletion
- **UAP Enforcement**: Validates Spoke compliance

### External Dependencies
- **None**: Spokes are Born Ready and operate without network calls

---

## Integration Points

### APIs Exposed
- **SSH Service**: Port-mapped SSH access (via Transversal Bridge)
- **Language Services**: Language-specific servers (e.g., Python HTTP, Node.js)
- **Development Tools**: LSP servers, debuggers, test runners
- **Data Services**: Database servers (if configured)

### Events Published
- **Startup Events**: Logged to Hub via Docker daemon
- **Health Status**: Reported via `docker ps` and `vde health`
- **Log Events**: Streamed to Hub via docker logs
- **Exit Events**: Trigger Hub cleanup on container termination

### Events Consumed
- **SSH Connections**: Accepts inbound SSH connections from Hub
- **File Sync Events**: Syncs workspace/ directory to Hub
- **Configuration Changes**: Rebuilds when VM type definition changes
- **Lifecycle Commands**: Responds to start/stop/remove from Hub

### Database Interactions
- **Internal Databases**: May run database services (PostgreSQL, MongoDB, etc.)
- **No External Databases**: Spokes are self-contained
- **Data Persistence**: Volume mounts for data/ directory

---

## Architecture Patterns

### Universal Script Parity (USP)
Every VM type has a corresponding initialization script:
```zsh
# File location
scripts/setup/<alias>-init.zsh

# Entry point reference (in vm-types.conf)
custom_cmd: /vde/setup/<alias>-init.zsh
```

The script:
- Uses absolute `/vde/` paths for reliability
- Runs on first container start via entrypoint
- Creates .vde-initialized flag to prevent re-running
- Performs all runtime configuration without network calls

### Born Ready (BTO) Pattern
All dependencies installed at build time:
```dockerfile
# Install packages
RUN apt-get update && \
    apt-get install -y python3 nodejs zsh git openssh-server && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy setup scripts
COPY scripts/setup/<alias>-init.zsh /vde/setup/

# Configure user
RUN useradd -m -s /usr/bin/zsh devuser
```

### Workspace Persistence
```yaml
# Docker Compose volume mount
volumes:
  - ${VDE_ROOT_DIR}/projects/<alias>:/home/devuser/workspace
```

Students save code in `$HOME/workspace/` inside Spoke, which syncs to Hub's `projects/<alias>/` directory.

### Service Spoke Pattern
Service Spokes (databases, web servers) run background services:
```zsh
# Asynchronous ignition hook
/usr/local/bin/vde-spoke-ignition.zsh

# Detaches service availability from SSH gate
# Service starts even if SSH isn't immediately ready
```

---

## Key Architectural Decisions

### devuser Isolation
**Decision**: All development occurs as devuser, never as root  
**Rationale**: Security, prevents accidental system damage, consistent with production

### Absolute Pathing
**Decision**: USP scripts use /vde/ absolute paths  
**Rationale**: Reliability across different mount points, no path resolution ambiguity

### Born Ready Containers
**Decision**: All configuration at build time, no runtime apt calls  
**Rationale**: Immutability, offline capability, deterministic behavior

### Workspace Sync
**Decision**: Volume mount workspace/ to Hub for persistence  
**Rationale**: Code survives container recreation, accessible from Hub for backups

---

## Spoke Lifecycle

### 1. Definition (Hub)
```zsh
# Add to vm-types.conf
python|Python 3.11|py|Python 3.11 with pip|python3,nodejs||3022
```

### 2. Build (Hub)
```zsh
# Generate Dockerfile from template
vde rebuild python

# Built image tagged: vde-python:<timestamp>
```

### 3. Create (Hub)
```zsh
# Create container from image
vde create python

# Allocates port, sets up SSH, creates workspace
```

### 4. Start (Hub)
```zsh
# Start container
vde start python

# SSH service starts, entrypoint runs USP script
```

### 5. Enter (Hub → Spoke)
```zsh
# SSH into container
vde enter python

# Connected as devuser, ready to work
```

### 6. Stop (Hub)
```zsh
# Stop container
vde stop python

# Container paused, state preserved
```

### 7. Remove (Hub)
```zsh
# Remove container
vde remove python

# Container deleted, image preserved for recreation
```

---

## Common Operations

### Creating a New Spoke
```zsh
# Define VM type
vim data/vm-types.conf

# Build image
vde rebuild <alias>

# Create container
vde create <alias>

# Start and enter
vde start <alias>
vde enter <alias>
```

### Rebuilding a Spoke
```zsh
# Stop container
vde stop <alias>

# Rebuild image (incorporates changes)
vde rebuild <alias>

# Recreate container
vde remove <alias>
vde create <alias>
vde start <alias>
```

### Accessing Spoke Files
```zsh
# From Hub: view workspace
ls -la projects/<alias>/

# From Spoke: files are in workspace/
cd ~/workspace
```

### Viewing Spoke Logs
```zsh
# From Hub
vde logs <alias>

# Or directly via Docker
docker logs -f vde-<alias>
```

---

## Operational Considerations

### Startup Sequence
1. Docker starts container from image
2. Entrypoint script (`vde-entrypoint.zsh`) executes
3. SSH service starts and listens on assigned port
4. USP script runs (if not already initialized)
5. Message of the Day displays
6. Container ready for SSH connections

### SSH Access
```zsh
# From Hub
ssh vde_student@localhost -p <port>

# Or via VDE command
vde enter <alias>
```

### Data Persistence
- **Workspace**: Synced via volume mount
- **Data**: Persisted in `data/<alias>/` volume
- **Logs**: Collected in Hub's `logs/<alias>/`

### Resource Limits
- **CPU**: Default (no limits, uses host share)
- **Memory**: Default (no limits, uses host available)
- **Disk**: Limited by available disk space
- **Network**: Bridge network `vde-net` with `vde.managed=true` label

---

## Troubleshooting

### Spoke Won't Start
1. Check image exists: `docker images | grep vde`
2. Check port availability: `vde port <alias>`
3. View logs: `vde logs <alias>`
4. Verify build: `vde rebuild <alias>`

### Can't SSH Into Spoke
1. Check SSH port: `vde port <alias>`
2. Verify container running: `vde ps`
3. Check SSH config: `cat ~/.ssh/config | grep <alias>`
4. Verify key: `ls -la ~/.ssh/vde/vde_student`

### USP Script Not Running
1. Check if initialized: `docker exec vde-<alias> ls -la ~/.vde-initialized`
2. View entrypoint logs: `vde logs <alias>`
3. Manually run: `docker exec vde-<alias> /vde/setup/<alias>-init.zsh`

### Workspace Not Syncing
1. Check volume mount: `docker inspect vde-<alias> | grep Mounts`
2. Verify permissions: `ls -la projects/<alias>/`
3. Restart container: `vde restart <alias>`

---

## References

- `docs/architecture/overview.md` - Hub-and-Spoke model
- `docs/Lifecycle_Of_A_Spoke.md` - Detailed lifecycle documentation
- `docs/architecture/data-flow.md` - Universal Script Parity section
- `scripts/vde-entrypoint.zsh` - Universal entrypoint implementation

---

**This is the Way.**
