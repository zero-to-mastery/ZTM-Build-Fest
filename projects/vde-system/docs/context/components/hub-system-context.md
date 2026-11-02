# Hub System Context
<!-- @forge (Context Documentation) -->

**Component**: Hub System (Host Machine Orchestration)  
**Project**: The Armor (@armor)  
**Last Updated**: 2026-04-30

---

## Purpose

The Hub is the host machine that governs all VDE orchestration, security, and global configuration. It serves as the central command post for managing Spoke containers, enforcing the Universal Agent Protocol (UAP), and maintaining the sovereign state of the development environment.

The Hub is AI-blind and operates using only the Unyielding Tetrad (Zsh, Git, Docker, SSH). It provides the physical runtime environment for students (Foundlings) without any Forge components active.

---

## Key Files

### Core Orchestration
- `bin/vde` - Unified command router and main CLI entry point
- `lib/vde-core` - Core orchestration logic and command routing
- `lib/vde-commands` - Command definitions and validation
- `lib/vde-parser` - Argument parsing and command validation

### Configuration Management
- `data/vm-types.conf` - Human-readable VM type registry (source of truth)
- `data/vm-types.json` - Machine-readable VM type registry (generated)
- `data/vm-types.schema.json` - Schema validation for VM types
- `.env` - Environment configuration (not version controlled)
- `.env.template` - Environment configuration template

### State Management
- `.docker-state/` - Docker state cache and runtime data
- `.docker-state/clusters/` - Cluster state information
- `.cache/` - Build and runtime caches
- `.cache/vm-types.cache` - ZSH associative array cache for O(1) lookup
- `.cache/port-registry/` - Port allocation registry
- `logs/` - Hub-level logs for all operations
- `.locks/` - Lock directories for concurrency control

### Security
- `lib/vde-security` - Security enforcement functions
- `lib/vde-root-guard` - Root privilege protection
- `public-ssh-keys/` - Public SSH keys for Spoke authentication

---

## Dependencies

### System Dependencies (Unyielding Tetrad)
- **Zsh 5.0+**: Shell environment and scripting language
- **Git 2.30+**: Version control and Conventional Commits enforcement
- **Docker 20.10+**: Container orchestration and Spoke lifecycle
- **SSH**: Transversal bridge to Spokes

### Internal Dependencies
- **All Libraries**: Depends on lib/ directory for core functionality
- **Configuration**: Reads from data/ and .env for configuration
- **State**: Uses .docker-state/, .cache/, .locks/ for runtime state
- **Templates**: Uses templates/ for Dockerfile and config generation

### External Dependencies
- **None**: The Hub is strictly AI-blind and depends only on the Tetrad

---

## Integration Points

### APIs Exposed
- **CLI Interface**: `bin/vde` provides unified command surface
- **Command Router**: Routes to subcommands (init, create, start, stop, etc.)
- **Health Endpoint**: `vde health` for system status checks
- **Info Endpoint**: `vde info <alias>` for Spoke state queries

### Events Published
- **State Change Events**: Logged to logs/ directory
- **Error Events**: Logged via vde_error with detailed context
- **Audit Events**: vde-enforce-uap.zsh logs all compliance checks

### Events Consumed
- **Container Events**: Monitors Docker daemon for container state changes
- **Port Allocation Events**: Responds to port availability checks
- **Lock Events**: Participates in lock-queue for synchronized access

### Database Interactions
- **No Databases**: Uses file-based state (JSON, conf files, cache files)
- **VM Registry**: data/vm-types.json acts as authoritative database
- **Port Registry**: .cache/port-registry/ for port allocation tracking

---

## Architecture Patterns

### Command Router Pattern
The `bin/vde` script implements a unified command router:
```zsh
# Load libraries
source lib/vde-shell-compat
source lib/vde-constants
source lib/vde-core

# Route commands
case "$ACTION" in
    init)    vde_init "$@" ;;
    create)  vde_create "$@" ;;
    start)   vde_start "$@" ;;
    # ... more commands
esac
```

### Configuration Sync Pipeline
Three-tier reactive synchronization:
1. **Source** (`vm-types.conf`) → Human-editable flat file
2. **Registry** (`vm-types.json`) → Generated via vde_translate_conf_to_json
3. **Cache** (`vm-types.cache`) → ZSH associative arrays for O(1) lookup

### State Isolation
Each runtime concern has isolated state directory:
- `.docker-state/` - Docker-specific state
- `.cache/` - Build and runtime caches
- `.locks/` - Concurrency control
- `logs/` - Operational logs

### Permission Enforcement
```zsh
# Sensitive directories get 700 (owner only)
chmod 700 data/ logs/ .cache/ .locks/

# Identity and config files get 600 (owner read/write)
chmod 600 ~/.ssh/vde/vde_student
chmod 600 .env
```

---

## Key Architectural Decisions

### Unified Command Router
**Decision**: Single `bin/vde` entry point routes all operations  
**Rationale**: Consistent UX, centralized UAP enforcement, easier auditing

### File-Based State
**Decision**: No databases, use JSON/conf files for state  
**Rationale**: Version control, simplicity, no external dependencies, Born Ready

### Configuration Sync Pipeline
**Decision**: Three-tier synchronization (conf → json → cache)  
**Rationale**: Human-editable source, machine-readable runtime, fast lookup cache

### Permission Isolation
**Decision**: Strict 700/600 permissions on sensitive directories  
**Rationale**: Security, prevent accidental modification, multi-user safety

---

## Operational Considerations

### Startup Sequence
1. Load environment variables from .env
2. Source all library files from lib/
3. Initialize logging system
4. Run security checks (vde_security_init)
5. Register signal handlers for graceful shutdown
6. Route command to appropriate handler

### Shutdown Sequence
1. Signal handler triggers cleanup
2. Release any held locks
3. Flush logs
4. Save state if needed
5. Exit with appropriate code

### Error Handling
- **Deterministic Error Engine**: vde_error_map translates exit codes
- **Context Preservation**: Errors include full context for debugging
- **Graceful Degradation**: Non-critical failures don't stop operations
- **Signal Handling**: SIGINT/SIGTERM trigger cleanup before exit

### Performance Considerations
- **Cache Invalidation**: Automatic re-sync when source files change
- **Lazy Loading**: Libraries loaded on-demand
- **Lock Timeouts**: Prevent indefinite blocking
- **Parallel Operations**: Lock-Queue enables safe parallelism

---

## Common Operations

### Adding a New VM Type
```zsh
# Edit source configuration
vim data/vm-types.conf

# Rebuild cache and JSON
vde rebuild-cache

# Verify new type is available
vde ps --types
```

### Checking Hub Health
```zsh
# Full health check
vde health

# Check specific pillars
vde spine-check

# View active locks
vde ps --locks
```

### Viewing System State
```zsh
# List all VMs
vde ps

# View VM info
vde info python

# View logs
vde logs python

# View port usage
vde port --list
```

---

## Troubleshooting

### Hub Won't Start
1. Check Four Pillars: `vde health`
2. Verify Zsh version: `zsh --version`
3. Check Docker: `docker ps`
4. Review logs: `logs/chaos-*.log`

### Configuration Not Syncing
1. Check cache timestamp vs source files
2. Manually rebuild: `vde rebuild-cache`
3. Verify syntax: `bin/validate-schemas.zsh`

### Locks Not Releasing
1. Check for stale locks: `vde ps --locks`
2. Verify owner PID is still running
3. Manually remove stale lock if needed

---

## References

- `docs/architecture/overview.md` - System architecture overview
- `docs/architecture/data-flow.md` - Advanced orchestration details
- `docs/governance/vde-spec.md` - Hub specifications and requirements
- `lib/vde-core` - Core implementation

---

**This is the Way.**
