# VDE Standard Library (stdlib) Documentation
<!-- @shared-law (Sovereign Law) -->


**Repository**: dderyldowney/vde-system  
**Version**: 1.5.6 (The Sovereign Baseline)  
**Language**: ZSH 5.0+  
**Last Updated**: 2026-09-29

---

## Table of Contents

1. [Overview](#overview)
2. [Core Libraries](#core-libraries)
3. [Support Libraries](#support-libraries)
4. [Specialized Libraries](#specialized-libraries)
5. [Utility Libraries](#utility-libraries)
6. [Return Codes](#return-codes)
7. [Quick Reference](#quick-reference)

---

## Overview

The VDE Standard Library is a modular, comprehensive collection of ZSH libraries designed for the Virtual Development Environment (VDE) system. These libraries provide:

- **Consistent Interfaces**: Standardized function signatures and return codes across all modules
- **Isolation**: Each library maintains clear responsibilities and minimal coupling
- **Portability**: Cross-platform support for Linux native, WSL2, and macOS
- **Security**: Built-in safeguards for SSH keys, file permissions, and Docker isolation
- **Performance**: Caching, atomic operations, and optimized data structures

All libraries enforce **ZSH-only** semantics (ZSH 5.0+) for optimal performance and feature set. POSIX compatibility is explicitly rejected to leverage ZSH native extensions.

---

## Core Libraries

### vde-core (@armor) (Engine Core Intelligence)
**Purpose**: Essential initialization, versioning, and core functions  
**Size**: 29.4 KB  
**Key Functions**:
- `vde_get_version()` - Extracts version from docs/governance/vde-spec.md
- `vde_run()` - Deterministic execution wrapper with error mapping
- Logging functions: `log_info()`, `log_error()`, `log_success()`, `log_warning()`
- `vde_query_json()` - Zero-host-dependency JQ wrapper

**Dependencies**: vde-shell-compat, vde-constants, vm-lock

**Usage**:
```bash
source "${VDE_ROOT_DIR}/lib/vde-core"
log_info "Operation started"
VERSION=$(vde_get_version)
```

---

### vde-constants (@armor) (Engine Constants)
**Purpose**: Centralized configuration and magic numbers  
**Size**: 13.7 KB  
**Key Constants**:

#### Return Codes
- `VDE_SUCCESS` (0) - Operation successful
- `VDE_ERR_GENERAL` (1) - Unspecified failure
- `VDE_ERR_INVALID_INPUT` (2) - Bad arguments
- `VDE_ERR_NOT_FOUND` (3) - Resource not found
- `VDE_ERR_PERMISSION` (4) - Insufficient permissions
- `VDE_ERR_TIMEOUT` (5) - Operation timeout
- `VDE_ERR_EXISTS` (6) - Resource already exists
- `VDE_ERR_DEPENDENCY` (7) - Missing dependency
- `VDE_ERR_DOCKER` (8) - Docker operation failure
- `VDE_ERR_LOCK` (9) - Lock acquisition failed
- `VDE_ERR_LOCK_CONTENTION` (12) - Lock busy
- `VDE_ERR_INVALID_DATA` (10) - Data validation failed
- `VDE_ERR_CACHE_INVALID` (11) - Cache stale/corrupt
- `VDE_ERR_SYNC_DRIFT` (13) - JSON/Cache mismatch

#### Health Check Codes
- `VDE_HEALTH_OK` (0)
- `VDE_HEALTH_MINOR` (30)
- `VDE_HEALTH_MAJOR` (31)
- `VDE_HEALTH_CRITICAL` (32)

#### Port Ranges
- Language VMs: 2200–2299
- Service VMs: 2400–2499
- Container Internal SSH: 22

#### Timeout Configuration
- Docker operations: 600s
- SSH connections: 60s
- Lock acquisition: 60s
- Health checks: 180s
- Container startup: 15s

#### Directory Structure
- `VDE_ROOT_DIR` - Project root
- `CONFIGS_DIR` - Docker configs (configs/docker)
- `VDE_SCRIPTS_DIR` - Binary scripts (bin)
- `TEMPLATES_DIR` - Templates directory
- `DATA_DIR` - Data files
- `VDE_CACHE_DIR` - Cache (.cache)
- `VDE_LOCKS_DIR` - Lock directory (.locks)
- `VDE_DOCKER_STATE_DIR` - Docker state (.docker-state)

---

### vde-shell-compat (@armor) (Shell Compatibility Layer)
**Purpose**: ZSH-native abstractions for shell features  
**Size**: 12.8 KB  
**Key Functions**:
- `_detect_shell()` - Detect current shell type
- `_shell_version()` - Get shell version
- `_is_zsh()` - Check if running in ZSH
- `_assoc_init()` - Initialize associative array
- `_assoc_set()` - Set associative array value
- `_assoc_get()` - Get associative array value
- `_assoc_keys()` - Get all keys from array
- `_assoc_has_key()` - Check key existence
- `_assoc_unset()` - Remove key from array
- `_enable_nullglob()` / `_disable_nullglob()` - Manage glob expansion

**Usage**:
```bash
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
_assoc_init "MY_MAP"
_assoc_set "MY_MAP" "key1" "value1"
value=$(_assoc_get "MY_MAP" "key1")
```

---

### vm-common (@armor) (VM Management Intelligence)
**Purpose**: High-level VM management and orchestration  
**Size**: 49.9 KB  
**Key Sections**:
- Directory constants setup
- Logging aliases (log_info, log_error, log_success)
- VM type loading and caching (Phase 31 Dual Resolution)
- Docker integration (lazy loading)
- SSH management (lazy loading)
- Template rendering (lazy loading)
- `resolve_vm_name()` - Resolve alias or short name to canonical vde- prefixed name
- `vde_get_hydration_script()` - Resolve the absolute path to a Spoke's hydration ritual

**Dependencies**: vde-core, vde-constants, vde-errors, vde-naming, vde-log, vde-shell-compat, vde-security, vde-path-utils, vde-progress, vm-lock

**Usage**:
```bash
source "${VDE_ROOT_DIR}/lib/vm-common"
# Now all functions from vde-core, vde-docker, vde-ssh, and vde-templates are available
```

---

## Support Libraries

### vde-log (@armor) (Logging Engine)
**Purpose**: Structured logging with rotation and multiple output formats  
**Size**: 14.4 KB  
**Features**:
- Log levels: DEBUG, INFO, WARN, ERROR
- Output formats: text, JSON, syslog
- Log rotation by size or age
- Configurable output (stdout, stderr, file)

**Key Functions**:
- `vde_log_init()` - Initialize logging system
- `vde_log_set_level()` - Set minimum log level
- `vde_log()` - Generic logging function
- `vde_log_info()`, `vde_log_error()`, `vde_log_warn()`, `vde_log_debug()` - Level-specific logging
- `vde_log_check_rotation()` - Check if rotation needed
- `vde_log_rotate()` - Rotate current log file

**Configuration**:
- `VDE_LOG_LEVEL` - Minimum log level (default: INFO)
- `VDE_LOG_FORMAT` - Output format (default: text)
- `VDE_LOG_OUTPUT` - Output destination (default: stderr)
- `VDE_LOG_FILE` - Log file path
- `VDE_LOG_MAX_SIZE` - Max file size before rotation (10MB)
- `VDE_LOG_MAX_DAYS` - Retention period (7 days)

---

### vde-errors (@armor) (Error Handling)
**Purpose**: Contextual error messages with remediation steps  
**Size**: 15.9 KB  
**Features**:
- Color-coded error output
- Remediation suggestions
- Documentation links
- Verbose mode support

**Key Functions**:
- `vde_error_show()` - Show full error with what/why/how
- `vde_error_simple()` - Show simple error message
- `vde_error_with_code()` - Show error with exit code
- `vde_error_set_verbose()` - Enable/disable verbose mode
- `vde_error_is_verbose()` - Check verbose mode status
- `vde_error_docker_not_running()` - Predefined Docker error
- `vde_error_insufficient_disk()` - Predefined disk space error
- `vde_error_port_in_use()` - Predefined port conflict error

**Configuration**:
- `VDE_ERRORS_VERBOSE` - Enable detailed output
- `VDE_ERRORS_DOC_URL` - Base documentation URL
- `VDE_ERRORS_SHOW_SOLUTION` - Enable solution display

---

### vde-audit (@armor) (Resource Auditing)
**Purpose**: Audit logging for security and compliance  
**Size**: 9.9 KB  
**Features**:
- CSV-based audit trail
- Operation logging with user/timestamp
- Query functions (by user, operation, date)
- Export to CSV/JSON

**Key Functions**:
- `vde_audit_init()` - Initialize audit system
- `vde_audit_log()` - Log audit entry
- `vde_audit_log_json()` - Log audit entry with JSON
- `vde_audit_query()` - Query audit log
- `vde_audit_by_user()` - Get entries by user
- `vde_audit_by_operation()` - Get entries by operation
- `vde_audit_recent()` - Get recent entries
- `vde_audit_export_csv()` - Export to CSV
- `vde_audit_export_json()` - Export to JSON
- `vde_audit_stats()` - Get audit statistics

**Logged Operations**:
- create_vm, start_vm, stop_vm, restart_vm, delete_vm, update_vm
- ssh_key_add, ssh_key_remove
- container_create, container_remove, container_start, container_stop

---

## Specialized Libraries

### vde-docker (@armor) (Docker Operations)
**Purpose**: Docker container lifecycle management  
**Size**: 16.8 KB  
**Key Functions**:
- `get_compose_file()` - Get docker-compose.yml path for VM
- `get_docker_project_name()` - Get Docker project name
- `image_exists()` - Check if Docker image exists
- `container_exists()` - Check if container exists
- `is_vm_running()` - Check if VM container is running
- `allocate_ssh_port()` - Reserve SSH port for VM
- `vde_port_release()` - Release SSH port
- `find_available_ssh_port()` - Find unused SSH port
- `vde_docker_ensure_network()` - Ensure VDE network exists

**Dependencies**: vde-constants, vde-errors, vde-shell-compat, vde-naming, vde-path-utils

---

### vde-docker-state (@armor) (Runtime State Management)
**Purpose**: Real-time Docker state queries  
**Size**: 5.8 KB  
**Key Functions**:
- `vm_container_exists()` - Check if container exists (any state)
- `vm_container_status()` - Get current container status
- `vm_is_container_running()` - Check if container is running
- `vm_is_container_stopped()` - Check if container is stopped
- `is_vde_managed()` - Check if container managed by VDE
- `list_running_containers()` - List all running VDE containers
- `list_all_containers()` - List all VDE containers
- `save_docker_state()` - Save VM state to JSON
- `load_docker_state()` - Load VM state from JSON

**Features**:
- Real-time Docker data queries (no reliance on config files)
- VDE label filtering
- Persistent state management

---

### vde-ssh (@armor) (SSH Operations)
**Purpose**: SSH key management and configuration  
**Size**: 24.9 KB  
**Key Functions**:
- `validate_public_key_file()` - Validate public key format
- `check_for_private_keys_in_public_dir()` - Security validation
- `detect_ssh_keys()` - Find available SSH keys
- `get_primary_ssh_key()` - Get main SSH key path
- `get_ssh_pubkey()` - Get public key for private key
- `sync_ssh_keys_to_vde()` - Sync keys to VDE build context
- `vde_ssh_add_identity()` - Add identity to SSH agent
- `vde_ssh_add_all_identities()` - Add all known keys to agent
- `vde_ssh_ensure_agent()` - Ensure SSH agent is running
- `vde_ssh_config_entry_add()` - Add entry to SSH config
- `vde_ssh_config_entry_remove()` - Remove entry from SSH config

**Security Features**:
- Private key detection in public directories
- SSH key isolation (VDE_SSH_DIR)
- Agent security enforcement
- File permission validation

---

### vde-health (@armor) (Health Checks)
**Purpose**: Container health checking  
**Size**: 13.3 KB  
**Key Functions**:
- `vde_check_container_running()` - Check container status
- `vde_check_ssh_port()` - Check SSH port accessibility
- `vde_check_ssh_login()` - Verify SSH login works
- `vde_check_language_tool()` - Verify language tool availability
- `vde_check_service_ports()` - Check service port accessibility
- `vde_health_check_all()` - Run all health checks for VM

**Health Levels**:
- CRITICAL (32) - Container not running
- MAJOR (31) - SSH not responding
- MINOR (30) - Language tool missing
- OK (0) - All checks pass

---

### vde-metrics (@armor) (Metrics Collection)
**Purpose**: Performance metrics collection and analysis  
**Size**: 11.0 KB  
**Key Functions**:
- `vde_metrics_init()` - Initialize metrics system
- `vde_metrics_record()` - Record metric value
- `vde_metrics_increment()` / `vde_metrics_decrement()` - Update counters
- `vde_metrics_timing_start()` / `vde_metrics_timing_end()` - Time operations
- `vde_metrics_time_command()` - Time command execution
- `vde_metrics_get()` - Retrieve metrics
- `vde_metrics_get_value()` - Get single metric value
- `vde_metrics_stats()` - Get metrics statistics
- `vde_metrics_export()` - Export to JSON
- `vde_metrics_reset()` - Clear all metrics

**Metrics Categories**:
- command.latency - Command execution time
- container.start_time - Container startup duration
- error.rate - Error frequency
- cache.hit_rate - Cache effectiveness

---

## Utility Libraries

### vde-naming (@armor) (Naming Conventions)
**Purpose**: VM naming conventions and validation  
**Size**: 3.6 KB  
**Key Functions**:
- `vde_validate_name()` - Validate VM name format
- `vde_normalize_name()` - Convert name to canonical form
- `vde_get_container_name()` - Get Docker container name
- `vde_get_ssh_host()` - Get SSH host alias
- `vde_get_hostname()` - Get internal hostname
- `vde_detect_vm_type_from_name()` - Infer VM type from name

**Naming Convention**:
- Directories: `<name>` (e.g., python, postgres)
- Containers/SSH: `vde-<name>` (e.g., vde-python, vde-postgres)
- Characters: lowercase alphanumeric + dashes
- Pattern: `^[a-z0-9-]+$`

---

### vde-path-utils (@armor) (Path Utilities)
**Purpose**: Cross-platform path handling  
**Size**: 5.8 KB  
**Key Functions**:
- `vde_path_to_home_rel()` - Convert absolute to HOME-relative
- `vde_path_from_home_rel()` - Convert HOME-relative to absolute
- `get_vm_conf_dir()` - Get VM config directory path
- `vde_path_normalize()` - Normalize path (remove .., /)
- `vde_get_project_name()` - Extract project name from VDE_ROOT_DIR
- `vde_is_home_path()` - Check if path is under HOME
- `vde_make_portable()` - Make path portable
- `vde_make_home_relative()` - Make path HOME-relative for display

**Features**:
- Cross-platform (Linux, WSL2, macOS)
- HOME directory detection
- Path normalization

---

### vde-progress (@armor) (Progress Indicators)
**Purpose**: Progress indicators for long operations  
**Size**: 15.7 KB  
**Features**:
- Spinner for indeterminate operations
- Progress bar for determinate operations
- Elapsed time display
- Quiet mode support

**Key Functions**:
- `vde_progress_spinner_start()` - Start spinner
- `vde_progress_spinner_update()` - Update spinner frame
- `vde_progress_spinner_stop()` - Stop spinner with message
- `vde_progress_bar_start()` - Start progress bar
- `vde_progress_bar_update()` - Update progress
- `vde_progress_bar_stop()` - Stop progress bar
- `_vde_progress_format_time()` - Format elapsed time

**Configuration**:
- `VDE_PROGRESS_QUIET` - Disable progress output
- `VDE_PROGRESS_BAR_WIDTH` - Bar width (default: 40)
- `VDE_PROGRESS_SPINNER_INTERVAL` - Animation speed (default: 0.1s)
- `VDE_PROGRESS_TIME_THRESHOLD` - Show time after (default: 2s)

---

### vde-parser (@armor) (Command Parsing)
**Purpose**: Natural language command parsing  
**Size**: 39.1 KB  
**Key Functions**:
- `detect_intent()` - Detect user intent from natural language
- `extract_vm_names()` - Extract VM references from text
- `extract_vm_names_to_display()` - Convert to display names
- `canonical_to_display()` - Convert canonical name to display name
- `_lookup_vm_by_alias()` - O(1) alias lookup

**Intent Detection**:
- INTENT_LIST_VMS - List VMs
- INTENT_CREATE_VM - Create new VM
- INTENT_START_VM - Start VM
- INTENT_STOP_VM - Stop VM
- INTENT_RESTART_VM - Restart VM
- INTENT_STATUS - Check status
- INTENT_CONNECT - Connect to VM
- INTENT_HELP - Show help

---

### vde-templates (@armor) (Hydration Blueprints)
**Purpose**: Template rendering for VM creation  
**Size**: 3.6 KB  
**Key Functions**:
- `render_template()` - Generic template renderer
- `render_language_template()` - Render language VM template
- `render_service_template()` - Render service VM template
- `render_ssh_entry()` - Render SSH config entry

**Template Variables**:
- NAME - VM name
- SSH_PORT - SSH port number
- INSTALL_CMD - Installation command
- SERVICE_PORTS - Service port mappings

---

### vde-security (@armor) (Security Guard)
**Purpose**: Security policy enforcement  
**Size**: 5.2 KB  
**Key Functions**:
- `vde_security_enforce_permissions()` - Set strict directory permissions
- `vde_security_ensure_network()` - Create isolated VDE network
- `vde_security_validate_naming()` - Audit naming conventions
- `vde_security_enforce_network_isolation()` - Ensure network segmentation
- `vde_security_init()` - Initialize security environment

**Security Goals**:
1. Isolation within VDE_ROOT_DIR
2. VDE_DOCKER_NETWORK isolation
3. VDE_SSH_DIR isolation
4. Strict permissions (700 for sensitive dirs)
5. Container network segmentation

---

### vde-cluster-utils (@armor) (Cluster Utilities)
**Purpose**: Multi-VM cluster management  
**Size**: 2.3 KB  
**Key Functions**:
- `vde_cluster_init()` - Initialize cluster state
- `vde_cluster_save()` - Save cluster definition
- `vde_cluster_list()` - List all clusters
- `vde_cluster_get_vms()` - Get VMs in cluster
- `vde_cluster_delete()` - Delete cluster
- `vde_cluster_exists()` - Check cluster existence

**Features**:
- JSON-based cluster storage
- Multi-VM grouping
- Cluster queries

---

### vde-commands (@armor) (Command Wrappers)
**Purpose**: High-level command wrappers  
**Size**: 15.7 KB  
**Key Functions**:
- `ensure_commands_log_dir()` - Ensure logging directory
- `log_command_action()` - Log command execution
- `vde_list_vms()` - List VMs with filtering
- `vde_vm_exists()` - Check VM existence
- `vde_get_vm_info()` - Get VM information
- `vde_get_running_vms()` - Get running VMs
- `vde_get_vm_status()` - Get VM status
- `vde_get_ssh_info()` - Get SSH connection info
- `vde_resolve_alias()` - Resolve alias to VM name
- `vde_resolve_vm_type()` - Validate VM type

---

### vde-pulse.zsh (@armor) (Engine Pulse)
**Purpose**: SSH agent bridge monitoring
**Size**: 2.3 KB
**Key Functions**:
- `vde_identity_pulse()` - Verify SSH agent bridge is active

**Purpose**: Ensures SSH agent inside container is accessible

---

### vde-function-trace (@armor) (Function Execution Tracing)
**Purpose**: Traces function execution paths and timing for debugging
**Size**: ~3 KB
**Key Functions**:
- `vde_trace_install` - Install trace hooks
- `vde_trace_display` - Display accumulated trace records
- `vde_trace_record` - Record a function dispatch event

**Features**:
- Records function name, timestamp, and targets
- Triggered via `VDE_TRACE_MODE=1`
- Auto-displays on EXIT trap

---

### vde-trace-bootstrap (@armor) (Trace System Bootstrap)
**Purpose**: Initializes the tracing subsystem early in the VDE lifecycle
**Size**: ~1 KB
**Key Functions**:
- Bootstraps trace mode before full library load
- Ensures trace hooks are in place for all subsequent operations

---

### vde-root & vde-root-guard (@armor) (Engine Pathing Core & Safeguard)
**Purpose**: Project root detection and validation  
**Sizes**: 1.1 KB, 1.4 KB  

**vde-root Functions**:
- Auto-detects VDE_ROOT_DIR by walking directory tree
- Looks for: bin/vde, lib/vde-core, or .git
- Fallback to PWD

**vde-root-guard Functions**:
- `vde_guard_absolute_paths()` - Scan for hardcoded paths
- `vde_check_absolute_paths()` - Validate portability

---

### vm-lock (@armor) (Concurrency Locking)
**Purpose**: Atomic file-based concurrency locking  
**Size**: 5.1 KB  
**Key Functions**:
- `claim_lock()` - Acquire atomic lock
- `acquire_lock()` - Alias for claim_lock
- `release_lock()` - Release atomic lock

**Lock Queue Model**:
- FIFO ticket system for high concurrency
- Atomic mkdir for gate operation
- PID tracking and PGID recording
- Recursive lock support
- Exponential backoff with jitter

---

## Return Codes

All VDE functions use standardized return codes for consistent error handling:

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | VDE_SUCCESS | Operation completed successfully |
| 1 | VDE_ERR_GENERAL | Unspecified failure |
| 2 | VDE_ERR_INVALID_INPUT | Bad arguments or validation failure |
| 3 | VDE_ERR_NOT_FOUND | Resource doesn't exist |
| 4 | VDE_ERR_PERMISSION | Insufficient permissions |
| 5 | VDE_ERR_TIMEOUT | Operation exceeded time limit |
| 6 | VDE_ERR_EXISTS | Resource already exists |
| 7 | VDE_ERR_DEPENDENCY | Required dependency missing |
| 8 | VDE_ERR_DOCKER | Docker-specific operation failure |
| 9 | VDE_ERR_LOCK | Failed to acquire lock |
| 10 | VDE_ERR_INVALID_DATA | Data validation failed |
| 11 | VDE_ERR_CACHE_INVALID | Cache is stale, corrupt, or missing |
| 12 | VDE_ERR_LOCK_CONTENTION | Lock is busy but still active (transient) |
| 13 | VDE_ERR_SYNC_DRIFT | JSON/Cache does not match authority |

---

## Quick Reference

### Essential Sourcing Order

```bash
# Minimal setup (core functions only)
source "${VDE_ROOT_DIR}/lib/vde-core"

# Full VM management
source "${VDE_ROOT_DIR}/lib/vm-common"

# SSH operations
source "${VDE_ROOT_DIR}/lib/vde-ssh"

# Docker operations
source "${VDE_ROOT_DIR}/lib/vde-docker"

# Error handling
source "${VDE_ROOT_DIR}/lib/vde-errors"

# Logging
source "${VDE_ROOT_DIR}/lib/vde-log"
```

### Common Operations

```bash
# Initialize logging
vde_log_init
vde_log_info "Starting operation"

# Load VM types
load_vm_types

# List running VMs
vde_get_running_vms

# Get VM status
vde_get_vm_status "python"

# Check SSH access
vde_check_ssh_port "python" 60

# Record metrics
vde_metrics_timing_start "my_operation"
# ... do work ...
vde_metrics_timing_end "my_operation"

# Acquire lock
claim_lock "${VDE_LOCKS_DIR}/vm-python.lock"
# ... critical section ...
release_lock "${VDE_LOCKS_DIR}/vm-python.lock"

# Handle errors
if ! vde_error_is_verbose; then
    vde_error_show "Operation failed" "Reason" "Fix it with: ..."
fi
```

### Directory Structure Reference

```
vde-system/
├── lib/
│   ├── vde-audit              # Resource Auditing
│   ├── vde-cluster-utils      # Cluster Utilities
│   ├── vde-commands           # Command Wrappers
│   ├── vde-constants          # Engine Constants
│   ├── vde-core               # Engine Core Intelligence
│   ├── vde-docker             # Docker Operations
│   ├── vde-docker-state       # Runtime State Management
│   ├── vde-errors             # Error Handling
│   ├── vde-function-trace     # Function Execution Tracing
│   ├── vde-health             # Health Checks
│   ├── vde-log                # Logging Engine
│   ├── vde-metrics            # Metrics Collection
│   ├── vde-naming             # Naming Conventions
│   ├── vde-parser             # Command Parsing
│   ├── vde-path-utils         # Path Utilities
│   ├── vde-progress           # Progress Indicators
│   ├── vde-pulse.zsh          # Engine Pulse
│   ├── vde-root               # Engine Pathing Core
│   ├── vde-root-guard         # Engine Pathing Safeguard
│   ├── vde-security           # Security Guard
│   ├── vde-shell-compat       # Shell Compatibility Layer
│   ├── vde-ssh                # SSH Operations
│   ├── vde-templates          # Hydration Blueprints
│   ├── vde-trace-bootstrap    # Trace System Bootstrap
│   ├── vm-common              # VM Management Intelligence
│   └── vm-lock                # Concurrency Locking
```

---

## Library Dependencies

```
vde-core
  ├─ vde-shell-compat
  ├─ vde-constants
  └─ vm-lock

vm-common (orchestrates all)
  ├─ vde-core
  ├─ vde-log
  ├─ vde-shell-compat
  ├─ vde-constants
  ├─ vde-errors
  ├─ vde-naming
  ├─ vde-security
  ├─ vde-path-utils
  ├─ vde-progress
  └─ (lazy loads: vde-ssh, vde-docker, vde-templates)

vde-docker
  ├─ vde-constants
  ├─ vde-errors
  ├─ vde-shell-compat
  ├─ vde-naming
  └─ vde-path-utils

vde-ssh
  ├─ vde-core
  ├─ vde-shell-compat
  ├─ vde-constants
  ├─ vde-errors
  ├─ vde-log
  ├─ vde-naming
  └─ vde-security

vde-health
  └─ vm-common

vde-templates
  ├─ vde-constants
  └─ vde-log
```

---

## Configuration Environment Variables

Key environment variables for library configuration:

```bash
# Logging
export VDE_LOG_LEVEL="INFO"          # DEBUG|INFO|WARN|ERROR
export VDE_LOG_FORMAT="text"         # text|json|syslog
export VDE_LOG_OUTPUT="stderr"       # stdout|stderr|file
export VDE_LOG_FILE="${VDE_ROOT_DIR}/logs/vde.log"

# Error Handling
export VDE_ERRORS_VERBOSE=0          # 0|1 for verbose output
export VDE_ERRORS_DOC_URL="https://github.com/dderyldowney/vde-system/blob/main/docs"

# Progress
export VDE_PROGRESS_QUIET=0           # 0|1 to suppress output
export VDE_PROGRESS_BAR_WIDTH=40      # Progress bar width

# Security
export VDE_SSH_DIR="${HOME}/.ssh/vde" # VDE SSH directory (isolated)
export VDE_DOCKER_NETWORK="vde-net"   # Isolated Docker network

# Metrics
export VDE_METRICS_FILE="${VDE_ROOT_DIR}/.cache/vde-metrics.json"

# Paths
export VDE_ROOT_DIR="/path/to/vde-system"
export CONFIGS_DIR="${VDE_ROOT_DIR}/configs/docker"
export TEMPLATES_DIR="${VDE_ROOT_DIR}/templates"
```

---

**End of VDE Standard Library Documentation**