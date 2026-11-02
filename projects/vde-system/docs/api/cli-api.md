# VDE API Reference
<!-- @shared-law (Sovereign Law) -->

**Version:** 1.5.6 (The Sovereign Baseline)
**Status:** AUTHORITATIVE

This document provides the complete API reference for the Virtual Development Environment (VDE) system.

---

## 1. Overview (The Rule Spine)

VDE is a **ZSH-ONLY** Docker-based container orchestration system. All libraries and scripts are designed for native ZSH execution.

### Architecture

```
VDE Root Directory
├── bin/                    # Unified CLI and binary rituals
│   ├── vde                 # Canonical command router (THE WAY)
│   ├── vde-enforce-uap.zsh # Rule Spine sentinel
│   └── ...                 # Lifecycle scripts
├── lib/                    # Standard Library (stdlib) ZSH modules
│   ├── vde-core            # Engine core, versioning, execution wrapper
│   ├── vde-constants       # Centralized constants and config
│   ├── vde-errors          # Contextual error handling
│   ├── vde-log             # Structured logging
│   ├── vde-docker          # Container lifecycle operations
│   ├── vde-docker-state    # Real-time state queries
│   ├── vde-ssh             # SSH key and config management
│   ├── vde-security        # Security policy enforcement
│   ├── vde-naming          # Naming conventions and validation
│   ├── vde-path-utils      # Cross-platform path handling
│   ├── vde-progress        # Progress indicators
│   ├── vde-parser          # Natural language command parsing
│   ├── vde-templates       # Template rendering
│   ├── vde-health          # Container health checks
│   ├── vde-metrics         # Performance metrics
│   ├── vde-audit           # Audit logging
│   ├── vde-cluster-utils   # Multi-VM cluster management
│   ├── vde-commands        # High-level command wrappers
│   ├── vde-shell-compat    # ZSH-native abstractions
│   ├── vde-root            # Project root detection
│   ├── vde-root-guard      # Path portability guard
│   ├── vde-pulse.zsh       # SSH agent bridge monitoring
│   ├── vde-function-trace  # Function execution tracing
│   ├── vde-trace-bootstrap # Trace system bootstrap
│   ├── vm-common           # High-level VM orchestration
│   └── vm-lock             # Atomic concurrency locking
├── data/                   # Beskar Registry (vm-types.json)
├── configs/                # Docker and service configurations
├── scripts/setup/          # Hydration rituals (USP)
├── env-files/              # Per-Spoke environment variables
├── projects/               # User workspace (source code mounts)
└── templates/              # Forge-mythos and VM templates
```

### Supported Environment

- **Shell:** zsh 5.0+ (Mandatory)
- **Platform:** macOS (Darwin), Linux, WSL2
- **Requirements:** Docker Desktop or Engine 20.10+

---

## 2. Unified CLI Reference

### `vde` - Unified Orchestrator

The main entry point for all VDE operations. Supervised by `vde-enforce-uap.zsh`.

**Usage:**
```zsh
vde <command> [options] [args]
```

#### Lifecycle Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `init` | — | Initialize infrastructure, SSH keys, networks, build vde-base |
| `create <vm>` | `rebuild` | Create a new VM Spoke from the Beskar Registry |
| `start <vm>` | — | Ignite a VM Spoke |
| `stop <vm>` | — | Quench (stop) a running VM |
| `restart <vm>` | — | Restart one or more active Spokes |
| `remove <vm>` | `delete`, `rm` | Dissolve a VM instance and its locks |
| `nuke` | — | **The Great Quench**: Remove all VDE artifacts |

#### Execution & Connectivity

| Command | Aliases | Description |
|---------|---------|-------------|
| `enter <vm>` | `ssh` | Enter a Spoke's login shell via the Transversal Bridge |
| `exec <vm> <cmd>` | — | Execute a command inside a Spoke |
| `port <vm>` | — | Retrieve the assigned SSH port for a Spoke |
| `logs <vm>` | — | Tail the logs of a specific Spoke |

#### Discovery & Status

| Command | Aliases | Description |
|---------|---------|-------------|
| `list` | — | List all available Spokes |
| `inspect <vm>` | — | Inspect container metadata and labels |
| `info <vm>` | — | Detailed system and environment diagnostics |
| `vision` | — | **The Archivist's Vision**: Real-time Markdown status grid |
| `stats` | — | View real-time resource usage of active Spokes |
| `images` | — | List all VDE-managed Docker images |
| `networks` | — | Audit and manage the `vde-net` Docker bridges |

#### Registry & Expansion

| Command | Aliases | Description |
|---------|---------|-------------|
| `add <name>` | — | Dynamic Expansion: Register a new Spoke type |
| `uninstall <vm>` | — | Permanent Removal: Remove a Spoke type from the Registry |
| `validate` | — | Verify Beskar Registry against JSON schemas |
| `rebuild-cache` | — | Force a re-smelt of the internal VM cache |
| `sync-version` | — | Synchronize versioning across Hub and Spokes |

#### Governance & Maintenance

| Command | Aliases | Description |
|---------|---------|-------------|
| `health` | — | Run the System Spine health check |
| `audit` | — | Verify structural integrity of the Sovereign Artifact Set |
| `heal` | — | Self-healing: Restore registry, correct version drift, detect path leaks |
| `prune` | — | **The Pruning Ritual**: Archive old plans/scripts, purge aged logs |
| `check-tetrad` | `spine-check` | Verify the Unyielding Tetrad (Zsh, Git, Docker, SSH) |
| `matrix-audit` | — | Exhaustive verification of every registered VM type |
| `matrix-rebuild` | — | Comprehensive non-cached re-forging of the Spoke matrix |

#### Orchestration & DNS

| Command | Aliases | Description |
|---------|---------|-------------|
| `cluster <cmd>` | — | Orchestrate multi-VM tech stacks (save, list, start, stop, remove) |
| `dns-check <src> <tgt>` | — | **The Handshake Ritual**: Verify cross-Spoke DNS resolution |

#### SSH Management

| Command | Aliases | Description |
|---------|---------|-------------|
| `ssh-setup` | — | Manage VDE SSH environment (keys, agent, config) |
| `ssh-sync` | — | Sync VDE SSH public keys to the build context |
| `ssh-agent-setup` | — | Initialize the SSH agent for the Forge |

#### Onboarding

| Command | Aliases | Description |
|---------|---------|-------------|
| `path-of-the-foundling` | `foundling` | Interactive induction ritual for new students |

#### Bootstrap (Pre-Install)

```zsh
bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)
```

Checks the 4 pillars, clones VDE, and launches `path-of-the-foundling`. Works in any shell (bash or zsh).

---

## 3. Library API

### vde-constants

Standardized constants for VDE operations.

**Return Codes (Exit Codes):**

| Constant | Value | Description |
|----------|-------|-------------|
| `VDE_SUCCESS` | 0 | Operation complete |
| `VDE_ERR_GENERAL` | 1 | General failure |
| `VDE_ERR_INVALID_INPUT` | 2 | Validation failure |
| `VDE_ERR_NOT_FOUND` | 3 | Resource missing |
| `VDE_ERR_PERMISSION` | 4 | Insufficient permissions |
| `VDE_ERR_TIMEOUT` | 5 | Operation timeout |
| `VDE_ERR_EXISTS` | 6 | Resource conflict |
| `VDE_ERR_DEPENDENCY` | 7 | Missing dependency |
| `VDE_ERR_DOCKER` | 8 | Docker daemon error |
| `VDE_ERR_LOCK` | 9 | Spinlock failure |
| `VDE_ERR_INVALID_DATA` | 10 | Data validation failed |
| `VDE_ERR_CACHE_INVALID` | 11 | Cache stale/corrupt |
| `VDE_ERR_LOCK_CONTENTION` | 12 | Lock busy (transient) |
| `VDE_ERR_SYNC_DRIFT` | 13 | JSON/Cache mismatch |

**Health Check Codes:**

| Constant | Value | Description |
|----------|-------|-------------|
| `VDE_HEALTH_OK` | 0 | All checks pass |
| `VDE_HEALTH_MINOR` | 30 | Minor issue detected |
| `VDE_HEALTH_MAJOR` | 31 | Major issue detected |
| `VDE_HEALTH_CRITICAL` | 32 | Critical failure |

**Port Ranges:**

| Range | Usage |
|-------|-------|
| 2200–2299 | Language VM SSH |
| 2400–2499 | Service VM SSH |
| 22 | Container internal SSH |

---

### vde-naming

**Core Functions:**

| Function | Description |
|----------|-------------|
| `vde_normalize_name <name>` | Strips prefix and non-alphanumeric chars (Path Traversal Protection) |
| `vde_validate_name <name>` | Enforces `^[a-z0-9-]+$` pattern |
| `vde_get_container_name <name>` | Returns `vde-<name>` |
| `vde_get_ssh_host <name>` | Returns SSH host alias |

---

### vde-log

**Logging Functions:**

```zsh
vde_log_init                          # Initialize logging system
vde_log_set_level <LEVEL>             # DEBUG, INFO, WARN, ERROR
vde_log_info "Message" "component"
vde_log_error "Failure" "component"
vde_log_warn "Warning" "component"
vde_log_debug "Debug" "component"
vde_log_check_rotation                # Check if rotation needed
vde_log_rotate                        # Rotate current log file
```

---

### vm-lock

**Concurrency Functions:**

| Function | Description |
|----------|-------------|
| `claim_lock <path>` | Acquire atomic lock (FIFO ticket-based) |
| `acquire_lock <path>` | Alias for claim_lock |
| `release_lock <path>` | Release atomic lock |

**Lock Queue Model:**
- FIFO ticket system using `${EPOCHREALTIME}-$$` naming
- Atomic `mkdir` for gate operation
- PID tracking and PGID recording
- Recursive lock support

---

## 4. Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `VDE_ROOT_DIR` | Repository root authority | (Auto-detected) |
| `VDE_DOCKER_NETWORK` | Isolated bridge name | `vde-net` |
| `VDE_SSH_DIR` | Isolated key vault | `~/.ssh/vde` |
| `VDE_DOCKER_STATE_DIR` | Docker state directory | `${VDE_ROOT_DIR}/.docker-state` |
| `VDE_LOG_LEVEL` | Minimum log level | `INFO` |
| `VDE_PROGRESS_QUIET` | Disable progress output | `0` |
| `VDE_DEBUG_TIMING` | Enable millisecond tracing | (unset) |

---

[← Back to README](../../README.md)
