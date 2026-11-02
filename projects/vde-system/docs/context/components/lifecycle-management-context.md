# Lifecycle Management Context
<!-- @forge (Context Documentation) -->

**Component**: Lifecycle Management (VM Operations)  
**Project**: The Armor (@armor)  
**Last Updated**: 2026-04-30

---

## Purpose

Lifecycle Management provides the complete operational lifecycle for Spoke containers (VMs). It implements the "Heartbeat" of VDE (Mandate L), ensuring that all Spokes can reliably execute: `init`, `create`, `rebuild`, `start`, `enter`, `stop`, `remove`, `add`, and `uninstall`. Failure of any state is a Protocol Blockade.

The lifecycle is the core value proposition of VDE—transforming raw container images into battle-ready development environments.

---

## Key Files

### Lifecycle Commands
- `bin/vde` - Unified command router for all lifecycle operations
- `bin/vde-init` - System initialization ritual
- `bin/vde-bootstrap` - New Foundling onboarding
- `bin/vde-create` - Create container (via vde router)
- `bin/vde-rebuild` - Rebuild container image
- `bin/vde-start` - Start container
- `bin/vde-enter` - Enter container via SSH
- `bin/vde-stop` - Stop container
- `bin/vde-remove` - Remove container
- `bin/add-vm-type` - Add new VM type
- `bin/uninstall-vm-type` - Remove VM type

### Lifecycle Libraries
- `lib/vde-core` - Core lifecycle orchestration
- `lib/vde-docker` - Docker lifecycle operations
- `lib/vde-docker-state` - State management
- `lib/vde-naming` - VM name resolution
- `lib/vde-commands` - Command definitions

### Configuration
- `data/vm-types.conf` - VM type definitions
- `env-files/<alias>.env` - Per-VM environment variables
- `templates/compose-service.yml` - Docker Compose template

---

## Dependencies

### System Dependencies
- **Docker**: Container lifecycle management
- **SSH**: Transversal bridge for enter operation
- **File System**: State and configuration persistence

### Internal Dependencies
- **Hub System**: Orchestrates lifecycle operations
- **Spoke System**: Container runtime environment
- **Transversal Bridge**: SSH connectivity for enter
- **Lock System**: Serializes critical operations
- **UAP Enforcement**: Validates all operations

### External Dependencies
- **None**: Pure Docker and SSH operations

---

## Integration Points

### APIs Exposed
- **CLI Commands**: All lifecycle operations via `vde` command
- **State Query**: `vde ps`, `vde info <alias>` for state inspection
- **Health Check**: `vde health` for system verification

### Events Published
- **Lifecycle Events**: Logged to logs/ directory
- **State Changes**: Updated in .docker-state/
- **Port Allocations**: Recorded in .cache/port-registry/

### Events Consumed
- **User Commands**: Trigger lifecycle state transitions
- **Docker Events**: Monitored for container state changes
- **Configuration Changes**: Trigger rebuild operations

### Database Interactions
- **VM Registry**: data/vm-types.json (authoritative VM database)
- **State Cache**: .docker-state/ (runtime state)
- **Port Registry**: .cache/port-registry/ (port allocations)

---

## Architecture Patterns

### Unified Command Router Pattern
```zsh
# bin/vde routes all lifecycle operations
#!/usr/bin/env zsh

# Load lifecycle libraries
source lib/vde-core
source lib/vde-docker
source lib/vde-naming

# Route command
case "$ACTION" in
    init)    vde_init "$@" ;;
    create)  vde_create "$@" ;;
    rebuild) vde_rebuild "$@" ;;
    start)   vde_start "$@" ;;
    enter)   vde_enter "$@" ;;
    stop)    vde_stop "$@" ;;
    remove)  vde_remove "$@" ;;
    *)       vde_error "Unknown command: $ACTION" ;;
esac
```

### State Transition Pattern
```zsh
# Each lifecycle operation manages state transitions
vde_create() {
    local alias="$1"
    
    # Validate state (must not exist)
    if vde_vm_exists "$alias"; then
        vde_error "VM $alias already exists"
        return 1
    fi
    
    # Acquire lock
    vde_acquire_lock ".locks/vms/${alias}.lock" || return 1
    
    # Allocate port
    local port=$(vde_allocate_port "$alias")
    
    # Create container
    docker create --name "vde-${alias}" ...
    
    # Update state
    vde_set_vm_state "$alias" "created"
    
    # Release lock
    vde_release_lock ".locks/vms/${alias}.lock"
}
```

### Proof of Life Pattern
```zsh
# Verify complete lifecycle works
vde_proof_of_life() {
    local alias="$1"
    
    # Test each state
    vde_create "$alias" || return 1
    vde_start "$alias" || return 1
    vde_enter "$alias" --test || return 1
    vde_stop "$alias" || return 1
    vde_remove "$alias" || return 1
    
    echo "✅ Proof of Life: $alias PASSED"
}
```

---

## Lifecycle States

### 1. Init (System Initialization)
**Purpose**: Initialize Hub for VDE operations  
**Command**: `vde init`  
**Operations**:
- Generate vde_student SSH key
- Initialize SSH agent
- Create VDE directories
- Setup Docker network (vde-net)
- Validate Four Pillars

**State Transition**: Uninitialized → Initialized

### 2. Create (Container Creation)
**Purpose**: Create container from image  
**Command**: `vde create <alias>`  
**Operations**:
- Validate VM type exists
- Allocate SSH port
- Create Docker Compose config
- Create container from image
- Setup volume mounts
- Register in state

**State Transition**: None → Created

### 3. Rebuild (Image Rebuild)
**Purpose**: Rebuild container image with changes  
**Command**: `vde rebuild <alias>`  
**Operations**:
- Stop container if running
- Remove container
- Rebuild Docker image
- Recreate container
- Start container

**State Transition**: Running/Stopped → Rebuilt → Running

### 4. Start (Container Start)
**Purpose**: Start container and services  
**Command**: `vde start <alias>`  
**Operations**:
- Validate container exists
- Start Docker container
- Wait for SSH service
- Sync SSH config
- Verify health

**State Transition**: Created/Stopped → Running

### 5. Enter (Container Access)
**Purpose**: Access container interior via SSH  
**Command**: `vde enter <alias>`  
**Operations**:
- Validate container running
- Resolve SSH port
- Establish SSH connection
- Launch shell as devuser

**State Transition**: Running → Connected (transient)

### 6. Stop (Container Stop)
**Purpose**: Stop container while preserving state  
**Command**: `vde stop <alias>`  
**Operations**:
- Validate container running
- Stop Docker container
- Preserve volumes and state
- Update state to stopped

**State Transition**: Running → Stopped

### 7. Remove (Container Removal)
**Purpose**: Remove container (image preserved)  
**Command**: `vde remove <alias>`  
**Operations**:
- Stop container if running
- Remove Docker container
- Release port allocation
- Update state
- Preserve image for recreation

**State Transition**: Running/Stopped → None

### 8. Add (VM Type Addition)
**Purpose**: Add new VM type to registry  
**Command**: `vde add`  
**Operations**:
- Acquire global config lock
- Add to vm-types.conf
- Rebuild vm-types.json
- Rebuild cache
- Release lock

**State Transition**: Registry Updated

### 9. Uninstall (VM Type Removal)
**Purpose**: Remove VM type from registry  
**Command**: `vde uninstall <alias>`  
**Operations**:
- Acquire global config lock
- Remove from vm-types.conf
- Rebuild vm-types.json
- Rebuild cache
- Option: Remove image
- Release lock

**State Transition**: Registry Updated

---

## Common Operations

### Complete Lifecycle Example
```zsh
# Initialize system
vde init

# Add new VM type
vde add

# Create and start container
vde create python
vde start python

# Enter and work
vde enter python
# ... work as devuser ...
exit

# Stop when done
vde stop python

# Remove when no longer needed
vde remove python
```

### Quick Start Workflow
```zsh
# For existing VM types
vde create python
vde start python
vde enter python
```

### Rebuild with Changes
```zsh
# After modifying VM type definition
vim data/vm-types.conf
vde rebuild python  # Rebuilds image and container
vde start python
```

### Batch Operations
```zsh
# Create multiple VMs
for vm in python nodejs go; do
    vde create "$vm"
    vde start "$vm"
done

# Stop all VMs
vde ps --all | awk '{print $1}' | xargs -I {} vde stop {}
```

---

## Operational Considerations

### State Management
- **Authoritative State**: data/vm-types.json is source of truth
- **Runtime State**: .docker-state/ caches Docker state
- **Port Registry**: .cache/port-registry/ tracks allocations
- **Lock State**: .locks/ coordinates concurrent operations

### Error Handling
- **Validation**: Each operation validates prerequisites
- **Rollback**: Failed operations attempt cleanup
- **Context**: Errors include full context for debugging
- **Deterministic**: Same error conditions produce same errors

### Performance
- **Parallel Creation**: Lock-Queue enables safe parallelism
- **Image Caching**: Docker layer caching speeds rebuilds
- **State Caching**: .docker-state/ avoids repeated Docker calls
- **Lazy Loading**: Libraries loaded on-demand

---

## Troubleshooting

### Create Fails
1. Check VM type exists: `vde ps --types`
2. Check port availability: `vde port <alias>`
3. View error details: `vde logs --system`
4. Verify Docker: `docker ps`

### Start Fails
1. Check container exists: `docker ps -a | grep vde`
2. Check image exists: `docker images | grep vde`
3. View container logs: `vde logs <alias>`
4. Verify network: `docker network ls | grep vde`

### Enter Fails
1. Check container running: `vde ps`
2. Check SSH port: `vde port <alias>`
3. Test SSH: `ssh vde-<alias>`
4. Verify key: `ls -la ~/.ssh/vde/vde_student`

### Stop Fails
1. Force stop: `docker stop vde-<alias>`
2. Check for processes: `docker exec vde-<alias> ps aux`
3. Kill if needed: `docker kill vde-<alias>`

### Remove Fails
1. Stop first: `vde stop <alias>`
2. Force remove: `docker rm -f vde-<alias>`
3. Check for volumes: `docker volume ls`

---

## References

- `docs/governance/vde-spec.md` - Mandate L (Proof of Life Contract)
- `docs/Lifecycle_Of_A_Spoke.md` - Detailed lifecycle documentation
- `lib/vde-core` - Core lifecycle implementation
- `tests/features/lifecycle.feature` - BDD lifecycle tests

---

**This is the Way.**
