# ADR-004: Lock-Queue Concurrency Model
<!-- @forge (Context Documentation) -->

**Status**: Accepted  
**Date**: 2026-04-30  
**Context**: Concurrency control for preventing race conditions

---

## Context

VDE operations often involve high-concurrency scenarios: parallel container builds, mass VM initialization, and simultaneous port allocations. Traditional locking mechanisms using competitive spinlocks or simple file locks introduce several problems:

1. **Thundering Herd**: Multiple processes simultaneously contending for the same resource cause performance degradation
2. **Starvation**: No guarantee of fairness—some processes may never acquire the lock
3. **Deadlocks**: Improper lock ordering can cause circular wait conditions
4. **Priority Inversion**: Low-priority processes holding locks block high-priority operations
5. **Nondeterminism**: Race conditions produce different results on different runs
6. **Resource Exhaustion**: Spinlocks consume CPU while waiting

VDE requires deterministic, fair, and efficient concurrency control for operations like:
- Global configuration modifications (vm-types.conf updates)
- Port allocation for multiple containers
- VM registry updates
- Docker state serialization

---

## Decision

VDE SHALL use a Lock-Queue Model with FIFO (First-In-First-Out) ticket-based sequencing for all critical sections. This ensures deterministic ordering, prevents Thundering Herd conditions, and guarantees fairness.

### Technical Implementation

#### Ticket-Based Queue System (Actual Implementation — `lib/vm-lock`)

```zsh
# claim_lock - Atomic locking with FIFO queue
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
        # Not first, or mkdir raced — yield and re-check
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

#### Lock Categories

1. **Global Config Lock** (`global-config.lock`):
   - Protects vm-types.conf modifications
   - Serialized all VM type additions/removals
   - Location: `${VDE_ROOT_DIR}/.locks/global-config.lock`

2. **VM Locks** (`vms/<vm_name>.lock`):
   - Protects individual VM lifecycle operations
   - Prevents concurrent create/remove on same VM
   - Location: `${VDE_ROOT_DIR}/.locks/vms/`

3. **Port Locks** (`ports/port-<number>.lock`):
   - Prevents double-allocation of same port
   - Used during container creation
   - Location: `${VDE_ROOT_DIR}/.locks/ports/`

#### Stale Lock Detection

```zsh
# Check if lock is stale (owner PID no longer running)
is_lock_stale() {
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

### Why This Model Works

1. **FIFO Ordering**: Tickets processed in timestamp order guarantees fairness
2. **No Spinlocks**: Processes sleep while waiting, not consuming CPU
3. **Atomic Operations**: Uses kernel-level `mkdir` atomicity for lock acquisition
4. **Ownership Tracking**: PID:PGID:TIMESTAMP records enable crash recovery
5. **Stale Lock Buster**: Automatically cleans up locks from dead processes
6. **Deterministic**: Same sequence of operations always produces same results

---

## Alternatives Considered

### Alternative 1: Competitive Spinlocks
**Rejected**:
- Thundering Herd problem
- CPU waste while spinning
- No fairness guarantee
- Starvation possible
- Nondeterministic ordering

### Alternative 2: Simple File Locks (flock)
**Rejected**:
- No queue ordering—first to claim wins regardless of arrival time
- Can't detect stale locks reliably
- Deadlock risk with nested locking
- No ownership tracking for debugging

### Alternative 3: Database-Based Locking
**Rejected**:
- Introduces external dependency (violates Tetrad)
- Overkill for single-node system
- Network dependency (violates Born Ready)
- Adds operational complexity

### Alternative 4: Semaphore-Based Approach
**Rejected**:
- Requires shared memory or external coordination
- Complex implementation in pure Zsh
- Harder to debug and monitor
- Not necessary for VDE's use case

---

## Consequences

### Positive Outcomes

1. **Deterministic Operations**: Same input always produces same output
2. **Fair Access**: FIFO queue guarantees no starvation
3. **Efficient**: No CPU waste—processes sleep while waiting
4. **Crash Recovery**: Stale lock detection prevents permanent blocking
5. **Observable**: Lock directories and tickets visible for debugging
6. **Scalable**: Handles high-concurrency operations without degradation

### Negative Outcomes

1. **Complexity**: More complex than simple file locks
2. **File System Overhead**: Creates many small files for tickets
3. **Sequential Bottleneck**: Some operations must serialize (by design)
4. **Cleanup Required**: Old tickets must be periodically cleaned up
5. **Debugging**: Understanding queue state requires reading directory contents

### Mitigation Strategies

1. **Lock Timeouts**: Maximum wait time with failure if exceeded
2. **Queue Cleanup**: Periodic cleanup of old ticket files
3. **Lock Monitoring**: `vde ps --locks` shows active locks and queue state
4. **Timeout Enforcement**: Stale lock auto-removal after threshold
5. **Logging**: Detailed lock acquisition/release logging for debugging

---

## Related Decisions

- **ADR-001**: ZSH-Only Requirement - Enables native associative arrays for lock tracking
- **ADR-003**: Born Ready Containers - Locks protect image build serialization
- **UAP Enforcement**: Lock operations run under sentinel

---

## Implementation Details

### Key Files
- `lib/vm-lock` - Lock-Queue implementation
- `bin/vde-create` - Uses locks for VM creation
- `bin/add-vm-type` - Uses global-config.lock
- `lib/vde-docker` - Port lock management

### Lock Usage Pattern
```zsh
# Acquire lock (claim_lock with FIFO queue)
claim_lock "${VDE_ROOT_DIR}/.locks/global-config.lock" || {
    vde_error "Failed to acquire global config lock"
    exit 1
}

# Critical section
vde_modify_vm_types

# Release lock
release_lock "${VDE_ROOT_DIR}/.locks/global-config.lock"
```

### Debugging Locks
```zsh
# Show all active locks
vde ps --locks

# Show specific lock queue
ls -la .locks/global-config.lock.queue/

# Check for stale locks
vde health --check-locks
```

---

## References

- `lib/vm-lock` - Lock-Queue implementation
- `docs/architecture/data-flow.md` - Concurrency & Atomic Stewardship section
- `tests/features/core-infrastructure/concurrency-queue.feature` - FIFO empirical proof (BDD — verified 200ms stagger prevents race condition)

---

**This is the Way.**
