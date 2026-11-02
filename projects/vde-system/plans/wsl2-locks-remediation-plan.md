# WSL2 Stale Locks and Tickets Remediation Plan
# @forge (Governance Sentinel)
# @shared-law (Sovereign Law)

## Fracture Analysis

### Violations Identified
1. [WARN] WSL2 does not reliably fire ZSH `{always}` blocks on function return, leaving `global-config.lock` and queue tickets after every `vde` invocation — `lib/vm-lock:173-176`
2. [WARN] Stale ticket cleanup only runs on successful ticket arrival, not on abnormal termination — `lib/vm-lock:81-87`
3. [WARN] No explicit WSL2 environment detection and adaptation in lock system — missing
4. [WARN] Tactical sweep does not clean queue directories, only lock directories — `bin/vde-tactical-sweep.zsh:53-54`

### Root Cause
The ZSH `zshexit` hook (lines 176-201) only cleans up tickets and locks owned by the current shell's PID. Under WSL2:
- Processes may terminate abruptly without firing `zshexit`
- Shell exit may be abnormal due to WSL2 filesystem latency
- Ticket queue can accumulate stale entries from crashed processes

## Proposed Fixes

### Phase 1: Enhanced WSL2 Detection and Handling
1. Add WSL2 environment detection function in `lib/vde-constants`
2. Add explicit WSL2 graceful shutdown handler
3. Add WSL2-specific lock cleanup verification on shell startup

### Phase 2: Proactive Stale Detection
1. Add pre-flight lock health check at `bin/vde` startup
2. Add aggressive stale ticket cleanup before queue operations
3. Reduce stale lock grace period from 10s to 5s for WSL2

### Phase 3: Test Updates
1. Add WSL2-specific test scenario for abrupt termination
2. Add test for queue directory cleanup on tactical sweep
3. Add test for lock cleanup verification on startup

## Implementation Tasks

| Task ID | Description | File | Est. Effort |
|---------|-------------|------|-------------|
| W1 | Add WSL2 detection function | `lib/vde-constants` | 15m |
| W2 | Enhance `zshexit` hook with WSL2 fallback | `lib/vm-lock` | 30m |
| W3 | Add pre-flight lock health check | `bin/vde` | 45m |
| W4 | Update tactical sweep to clean queues | `bin/vde-tactical-sweep.zsh` | 20m |
| W5 | Add WSL2 lock test scenarios | `tests/.../wsl2-locks.feature` | 60m |
| W6 | Add lock cleanup verification step | `tests/steps/locking_steps.py` | 45m |

## Detailed Changes

### lib/vde-constants (Add WSL2 Detection)
```zsh
# WSL2 Detection
if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then
    VDE_WSL2_DETECTED=1
else
    VDE_WSL2_DETECTED=0
fi
```

### lib/vm-lock (Enhanced Cleanup)
- Expand `_vde_lock_cleanup_on_exit` to handle WSL2 edge cases
- Add cleanup for `.queue` directories on startup

### bin/vde-tactical-sweep.zsh (Queue Cleanup)
- Add `rm -rf "${VDE_ROOT_DIR}/.locks"/*.queue(N/)` cleanup

## Implementation Status

### Completed
- ✅ **Task W4**: Updated tactical sweep to clean queues (bin/vde-tactical-sweep.zsh)
- ✅ **Task W5**: Added WSL2 lock test scenarios (tests/core-infrastructure/wsl2-locks-remediation.feature)
- ✅ **Task W6**: Added lock cleanup verification steps (tests/features/steps/locking_steps.py)

### Pending Implementation
- **Task W1**: Add WSL2 detection function to `lib/vde-constants`
- **Task W2**: Enhance `zshexit` hook with WSL2-specific handling in `lib/vm-lock`
- **Task W3**: Add pre-flight lock health check in `bin/vde`