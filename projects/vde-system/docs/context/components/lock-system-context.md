# Lock System Context
<!-- @forge (Context Documentation) -->

**Component**: Lock System (Concurrency Control & Determinism)  
**Project**: The Armor (@armor)  
**Last Updated**: 2026-04-30

---

## Purpose

The Lock System provides deterministic concurrency control for VDE operations. It implements a Lock-Queue Model with FIFO (First-In-First-Out) ticket-based sequencing to prevent race conditions, eliminate Thundering Herd problems, and ensure fair access to shared resources.

The system manages locks for global configuration, VM lifecycle operations, and port allocation. All critical sections are protected by locks to maintain deterministic behavior across high-concurrency scenarios.

---

## Key Files

### Core Lock Implementation
- `lib/vm-lock` - Lock-Queue implementation and functions
- `lib/vde-docker` - Port lock management and allocation

### Lock Directories
- `.locks/` - Root lock directory
- `.locks/global-config.lock` - Global configuration lock
- `.locks/vms/` - VM-specific locks
- `.locks/ports/` - Port allocation locks
- `.locks/global-config.lock.queue/` - Global config ticket queue
- `.locks/vms/<vm_name>.lock.queue/` - VM ticket queues
- `.locks/ports/port-<number>.lock/` - Port lock markers

### Lock-Related Commands
- `bin/vde-ps --locks` - Display active locks and queue state
- `bin/vde-health --check-locks` - Verify lock system health

---

## Dependencies

### System Dependencies
- **File System**: Uses mkdir atomicity for lock acquisition
- **Process Management**: Uses kill to check if lock owner is alive

### Internal Dependencies
- **Hub System**: Initiates lock acquisition for operations
- **Spoke System**: VM operations require VM locks
- **Port Allocation**: Port locks prevent double-allocation
- **Configuration System**: Global config lock protects vm-types.conf

### External Dependencies
- **None**: Pure file-system based implementation

---

## Integration Points

### APIs Exposed
- **claim_lock()** - Acquire lock with FIFO queue (primary function)
- **acquire_lock()** - Alias for claim_lock() (backward compatibility)
- **release_lock()** - Release held lock and remove ticket from queue

### Events Published
- **Lock Acquisition Events**: Logged with ticket info
- **Lock Release Events**: Logged when locks freed
- **Stale Lock Events**: Logged when stale locks detected

### Events Consumed
- **VM Creation**: Triggers VM lock acquisition
- **VM Removal**: Requires VM lock
- **Port Allocation**: Requires port lock
- **Config Changes**: Requires global config lock

### Database Interactions
- **None**: Lock state stored in file system

---

## Architecture Patterns

### Lock-Queue Pattern
```zsh
# claim_lock - Atomic locking with FIFO queue (actual API from lib/vm-lock)
# Args: <lock_file>
claim_lock() {
    local lock_file="$1"
    local queue_dir="${lock_file}.queue"
    local pid_file="${lock_file}/pid"

    mkdir -p "${queue_dir}"

    # Register ticket: EPOCHREALTIME timestamp + PID for uniqueness
    local ticket_id="${EPOCHREALTIME}-$$"
    touch "${queue_dir}/${ticket_id}"

    # Wait until this ticket is at the front of the FIFO queue
    while true; do
        # Sort numerically by filename (timestamp-pid); head = oldest = FIFO front
        local oldest=$(ls -1 "${queue_dir}" 2>/dev/null | sort -n | head -n 1)
        if [[ "${oldest}" == "${ticket_id}" ]]; then
            # Front of queue — attempt atomic lock acquisition
            if mkdir "${lock_file}" 2>/dev/null; then
                local pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')  # process group ID
                echo "$$:${pgid}:$(date +%s)" > "${pid_file}"
                return 0
            fi
        fi
        sleep 0.1
    done
}

# acquire_lock is an alias for backward compatibility
acquire_lock() { claim_lock "$@" }

# release_lock - Release atomic lock and remove this process's ticket
# Args: <lock_file>
release_lock() {
    local lock_file="$1"
    local queue_dir="${lock_file}.queue"

    # VDE_LOCK_TICKETS: global typeset -gA array populated by claim_lock; stores ticket_id per lock path
    rm -f "${queue_dir}/${VDE_LOCK_TICKETS[${lock_file}]}" 2>/dev/null
    rm -rf "${lock_file}" 2>/dev/null
}
```

### Stale Lock Detection Pattern
```zsh
# Check if lock owner is still running
vde_is_lock_stale() {
    local lock_file="$1"
    local pid_file="${lock_file}/pid"
    
    if [[ -f "$pid_file" ]]; then
        local owner_pid=$(cut -d':' -f1 "$pid_file")
        if ! kill -0 "$owner_pid" 2>/dev/null; then
            # Owner process is dead - lock is stale
            return 0
        fi
    fi
    
    return 1
}
```

### Port Lock Pattern
```zsh
# Reserve a port
vde_acquire_port_lock() {
    local port="$1"
    local lock_dir="${VDE_ROOT_DIR}/.locks/ports"
    local port_lock="${lock_dir}/port-${port}.lock"
    
    # Attempt to create port lock
    if mkdir "$port_lock" 2>/dev/null; then
        echo "$$:${EPOCHREALTIME}" > "${port_lock}/pid"
        return 0
    fi
    
    return 1
}

# Release port
vde_release_port_lock() {
    local port="$1"
    local lock_dir="${VDE_ROOT_DIR}/.locks/ports"
    local port_lock="${lock_dir}/port-${port}.lock"
    
    rmdir "$port_lock" 2>/dev/null || true
}
```

---

## Key Architectural Decisions

### Lock-Queue Over Spinlocks
**Decision**: FIFO ticket-based queue instead of competitive spinlocks  
**Rationale**: Fairness, no CPU waste, prevents Thundering Herd

### File-System Based
**Decision**: Use file system operations instead of external lock managers  
**Rationale**: No external dependencies, atomic mkdir, simple debugging

### Stale Lock Detection
**Decision**: Auto-detect and clean up locks from dead processes  
**Rationale**: Prevents permanent blocking, improves reliability

### Ticket Timeouts
**Decision**: Maximum wait time with failure if exceeded  
**Rationale**: Prevents indefinite blocking, fails fast

---

## Lock Categories

### 1. Global Config Lock
**Purpose**: Protects vm-types.conf modifications  
**Location**: `.locks/global-config.lock`  
**Operations Protected**:
- Adding VM types
- Removing VM types
- Modifying VM type definitions
- Rebuilding cache

**Usage Example**:
```zsh
claim_lock "${VDE_ROOT_DIR}/.locks/global-config.lock" || {
    vde_error "Failed to acquire global config lock"
    exit 1
}

# Critical section
vde_add_vm_type "$new_type"

release_lock "${VDE_ROOT_DIR}/.locks/global-config.lock"
```

### 2. VM Locks
**Purpose**: Protects individual VM lifecycle operations  
**Location**: `.locks/vms/<vm_name>.lock`  
**Operations Protected**:
- Creating VM containers
- Starting VM containers
- Stopping VM containers
- Removing VM containers
- Rebuilding VM containers

**Usage Example**:
```zsh
claim_lock "${VDE_ROOT_DIR}/.locks/vms/${vm_name}.lock" || {
    vde_error "Failed to acquire VM lock for ${vm_name}"
    exit 1
}

# Critical section
docker create --name "vde-${vm_name}" ...

release_lock "${VDE_ROOT_DIR}/.locks/vms/${vm_name}.lock"
```

### 3. Port Locks
**Purpose**: Prevents double-allocation of same port  
**Location**: `.locks/ports/port-<number>.lock`  
**Operations Protected**:
- Port allocation during VM creation
- Port verification
- Port release

**Usage Example**:
```zsh
if vde_acquire_port_lock "$port"; then
    # Port reserved
    # ... use port ...
    vde_release_port_lock "$port"
else
    vde_error "Port ${port} is already allocated"
    exit 1
fi
```

---

## Common Operations

### Viewing Active Locks
```zsh
# Show all locks
vde ps --locks

# Output example:
# Active Locks:
#   global-config.lock: held by PID 12345 (since 12:34:56)
#   vms/python.lock: held by PID 12346 (since 12:35:01)
#   ports/3022.lock: held by PID 12347 (since 12:35:02)
```

### Checking Lock Queue
```zsh
# View queue for a lock
ls -la .locks/global-config.lock.queue/

# Output example:
# total 8
# drwxr-xr-x  2 user group 4096 Apr 30 21:45 .
# drwxr-xr-x 10 user group 4096 Apr 30 21:44 ..
# -rw-r--r--  1 user group    0 Apr 30 21:45 1714491950-12345
# -rw-r--r--  1 user group    0 Apr 30 21:45 1714491951-12346
```

### Checking for Stale Locks
```zsh
# Verify lock system health
vde health --check-locks

# Automatically cleans up stale locks
```

### Manually Releasing Stale Lock
```zsh
# If auto-cleanup fails, manually remove
rm -rf .locks/global-config.lock
rm -rf .locks/vms/python.lock
rm -rf .locks/ports/3022.lock
```

---

## Operational Considerations

### Lock Acquisition Flow
1. Process creates ticket in queue directory
2. Process waits until ticket is oldest in queue
3. Process attempts to create lock directory (atomic mkdir)
4. If successful, write ownership info and proceed
5. If failed, another process won - clean up ticket and retry

### Lock Release Flow
1. Process removes ticket from queue
2. Process removes lock directory
3. Next process in queue can now claim lock

### Timeout Handling
- **Default Timeout**: 30 seconds
- **Timeout Action**: Remove ticket, return failure
- **Retry Strategy**: Caller decides whether to retry

### Concurrency Behavior
- **FIFO Ordering**: First to request gets first access
- **No Starvation**: Every request eventually gets access
- **Fair Access**: No priority, all processes equal
- **Deterministic**: Same sequence produces same results

---

## Performance Characteristics

### Lock Acquisition Time
- **No Contention**: ~1ms (directory creation)
- **With Contention**: Depends on queue position
- **Average Wait**: <100ms for typical operations

### Resource Usage
- **Disk I/O**: Minimal (small directory operations)
- **CPU**: Low (processes sleep while waiting)
- **Memory**: Negligible (file system metadata only)

### Scalability
- **Max Concurrent Processes**: Limited by file descriptor limits
- **Queue Depth**: No practical limit
- **Lock Count**: One per resource being protected

---

## Troubleshooting

### Lock Timeout
1. Check queue state: `ls -la .locks/global-config.lock.queue/`
2. Check if lock is stale: `cat .locks/global-config.lock/pid`
3. Verify owner PID: `ps -p <pid>`
4. If stale, manually remove: `rm -rf .locks/global-config.lock`

### Lock Not Releasing
1. Check if process still running: `ps -p <pid>`
2. If process dead, lock is stale - will auto-cleanup
3. Manual cleanup: `rm -rf .locks/<lock_name>.lock`
4. Check for zombie processes: `ps aux | grep defunct`

### Queue Growing
1. Check if processes are stuck: `ps aux | grep vde`
2. View queue: `ls -la .locks/global-config.lock.queue/`
3. Kill stuck processes: `kill <pid>`
4. Clear queue: `rm -rf .locks/global-config.lock.queue/*`

### Port Conflicts Despite Lock
1. Check port lock: `ls -la .locks/ports/`
2. Verify port not in use: `netstat -an | grep <port>`
3. Check Docker: `docker ps | grep <port>`
4. Manual port reservation if needed

---

## References

- `adr-004-lock-queue-concurrency-model.md` - Lock-Queue architectural decision
- `lib/vm-lock` - Lock-Queue implementation
- `docs/architecture/data-flow.md` - Concurrency & Atomic Stewardship section
- `tests/features/core-infrastructure/concurrency-queue.feature` - FIFO empirical proof (BDD — verified 200ms stagger prevents race condition)

---

**This is the Way.**
