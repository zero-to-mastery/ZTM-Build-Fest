# VDE Function Tracing
# @forge (Forge Diagnostic Tooling)

Diagnostic tool for tracing the complete execution path of any `vde` command from user input to the final executor boundary—without executing side effects.

---

## Quick Start

```bash
# Trace any vde command
vde function-trace start python
vde function-trace rebuild rust --no-cache
vde function-trace enter python ls -la
vde function-trace stop python
```

**Key Feature**: Commands are traced but NOT executed. No containers start, no SSH connections are made.

---

## User Guide

### Syntax

```bash
vde function-trace <command> [arguments...]
```

The syntax mirrors normal `vde` commands exactly:

```bash
# Normal command
vde start python

# Traced version (no execution)
vde function-trace start python

# With flags
vde function-trace rebuild rust --no-cache

# With complex arguments
vde function-trace enter python 'ls -la /home'
```

### Output Format

The trace produces three sections:

#### 1. Function Trace

Shows the call chain from dispatch to executor:

```
[dispatch: vde start]
Params: targets=(python) force=false
File: $VDE_ROOT_DIR/bin/vde

Function: resolve_vm_name()
Params: python
File: $VDE_ROOT_DIR/lib/vm-common

Function: is_vm_running()
Params: vde-python
File: $VDE_ROOT_DIR/lib/vde-docker

Function: get_vm_compose_file()
Params: vde-python
File: $VDE_ROOT_DIR/lib/vm-common
```

- **Indentation**: Shows call depth (nested functions are indented)
- **Params**: Arguments passed to each function
- **File**: Library or script where the function lives

#### 2. Command Building

Shows step-by-step assembly of the final command:

```
[debug] compose_up_cmd=docker compose
[debug] compose_up_cmd=docker compose -f configs/docker/languages/python/docker-compose.yml
[debug] compose_up_cmd=docker compose -f ... --env-file ./.env
[debug] compose_up_cmd=docker compose -f ... --env-file ./.env up -d
```

#### 3. Summary

Key events and the final command:

```
────────────────────────────────────────────────
  SUMMARY
────────────────────────────────────────────────

  Command: vde start
  Targets: targets=(python) force=false

  Key Events:
    • Disk space check (threshold: 95%)
    • Resolved 'python' → vde-python
    • VM running check: vde-python
    • Compose file resolved for vde-python

  Final Command:
    docker compose -f configs/docker/languages/python/docker-compose.yml --env-file ./.env up -d

  3 infrastructure hidden, 4 repeats suppressed
```

### Reading the Trace

**Dispatch**: Entry point from `bin/vde`

**Function calls**: The actual code path through VDE libraries

**[debug]**: Intermediate state showing command assembly

**[EXECUTOR]**: The final command that *would* have run (but didn't)

**Suppressed**: Repetitive calls with same params are hidden to reduce noise

---

## Developer Guide

### Architecture

The tracing system uses three components:

1. **`lib/vde-function-trace`** - Core tracing library
2. **`lib/vde-trace-bootstrap`** - Enables cross-script tracing
3. **Executor shims** - Intercept side-effecting commands

### How It Works

#### 1. Function Wrapping

When `vde_trace_install()` runs, it wraps every loaded VDE function:

```zsh
# Original function
resolve_vm_name() {
    # ... implementation ...
}

# Becomes wrapped
resolve_vm_name() {
    if [[ -n "${VDE_TRACE_MODE}" ]]; then
        _vde_trace_record_entry 'resolve_vm_name' 'lib/vm-common' "$@"
        local _tr_rc=0
        _vde_trace_orig_resolve_vm_name "$@" || _tr_rc=$?
        _vde_trace_record_exit
        return ${_tr_rc}
    fi
    _vde_trace_orig_resolve_vm_name "$@"
}
```

#### 2. Record Format

Each call is recorded as tab-separated fields:

```
TYPE    DEPTH    FUNCTION_NAME    SOURCE_FILE    IS_INTERNAL    PARAMS
```

Types: `CALL`, `EXEC`, `DEBUG`, `DISPATCH`

#### 3. Cross-Script Tracing

External scripts (`bin/vde-rebuild`, etc.) source the bootstrap:

```zsh
source "${VDE_ROOT_DIR}/lib/vm-common"
source "${VDE_ROOT_DIR}/lib/vde-trace-bootstrap"
```

The bootstrap checks for `VDE_TRACE_MODE` and installs wrappers if active.

#### 4. Executor Shims

Docker and SSH are shimmed to intercept side effects:

```zsh
docker() {
    if [[ -n "${VDE_TRACE_MODE}" ]]; then
        # Read-only commands pass through
        case "${1:-}" in
            image|ps|inspect|logs)
                command docker "$@"
                return $?
                ;;
        esac
        
        # Side-effect commands are recorded, not executed
        _VDE_TRACE_RECORDS+=("EXEC|${_VDE_TRACE_CALL_DEPTH}|docker $*||")
        return 0
    fi
    command docker "$@"
}
```

### Adding Debug Output

Use `vde_trace_debug()` to show intermediate variable states:

```zsh
local -a cmd=(docker compose -f "${compose_file}")
[[ -n "${VDE_TRACE_MODE}" ]] && vde_trace_debug "cmd=${cmd[*]}"
cmd+=(--env-file "${env_file}")
[[ -n "${VDE_TRACE_MODE}" ]] && vde_trace_debug "cmd=${cmd[*]}"
```

Output:
```
[debug] cmd=docker compose -f configs/docker/languages/python/docker-compose.yml
[debug] cmd=docker compose -f ... --env-file ./.env
```

### Filtering

Two filtering lists control output noise:

**Suppressed (first occurrence shown)**:
- `resolve_vm_name`, `vde_normalize_name`, `get_vm_type`, etc.
- Shown once per unique function+params combination

**Hidden (never shown)**:
- `vde_log_*`, `vde_security_*`, `ensure_ssh_environment`, etc.
- Pure infrastructure that never aids debugging

---

## Troubleshooting Guide

### Scenario: Command not working as expected

**Trace it** to see what VDE is actually doing:

```bash
vde function-trace start python
```

Look for:
1. **Resolution**: Did `resolve_vm_name()` return what you expected?
2. **Checks**: Did `is_vm_running()` or `image_exists()` fail?
3. **Command**: Is the final `docker compose` command correct?

### Scenario: Alias not resolving

```bash
vde function-trace start py
```

Check the trace for:
```
Function: resolve_vm_name()
Params: py
```

If it shows `vde-python`, the alias resolved correctly.

### Scenario: Flags not being passed

```bash
vde function-trace rebuild rust --no-cache
```

Look in the command building section:
```
[debug] build_cmd=docker compose -f ... build --no-cache
```

### Scenario: Understanding the code path

Use the trace to learn VDE internals:

```bash
vde function-trace start python
```

Shows the complete flow:
1. `vde_ensure_disk_space()` - Pre-flight check
2. `vde_check_system_breath()` - Resource check
3. `resolve_vm_name()` - Alias → canonical name
4. `get_vm_compose_file()` - Find docker-compose.yml
5. `image_exists()` - Check if image is built
6. `vde_run()` - Execute the command

### Scenario: Verifying no side effects

All traced commands end with:

```
▶ [EXECUTOR] docker compose ... up -d
```

But the container is NOT running:
```bash
docker ps -a --filter "name=vde-python"
# (empty output)
```

---

## Examples

### Shallow Trace (simple command)

```bash
$ vde function-trace enter python ls -la

[dispatch: vde enter]
Params: targets=(python) force=false

Function: vde_run()
Params: enter ./bin/ssh-vm python ls -la

▶ [EXECUTOR] ssh -A -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes -o LogLevel=ERROR -o ConnectTimeout=5 \
    -i ~/.ssh/vde/vde_student -p 2217 devuser@127.0.0.1 ls -la

────────────────────────────────────────────────
  SUMMARY
────────────────────────────────────────────────

  Command: vde enter
  Final Command:
    ssh -A ... -p 2217 devuser@127.0.0.1 ls -la
```

### Deep Trace (complex command)

```bash
$ vde function-trace rebuild rust --no-cache

[dispatch: vde rebuild]
Params: targets=(rust --no-cache) force=false

Function: vde_run()
Params: rebuild ./bin/vde-rebuild rust --no-cache

Function: resolve_vm_name()
Params: rust

Function: get_vm_compose_file()
Params: vde-rust

Function: claim_lock()
Params: ./.locks/vms/vde-rust.lock

[debug] build_cmd=docker compose
[debug] build_cmd=docker compose -f configs/docker/languages/rust/docker-compose.yml
[debug] build_cmd=docker compose -f ... --env-file ./.env build --no-cache

Function: vde_run()
Params: vde-rust docker compose -f ... build --no-cache

▶ [EXECUTOR] docker compose -f configs/docker/languages/rust/docker-compose.yml \
    --env-file ./.env build --no-cache

────────────────────────────────────────────────
  SUMMARY
────────────────────────────────────────────────

  Command: vde rebuild
  Key Events:
    • Resolved 'rust' → vde-rust
    • Lock acquired: ./.locks/vms/vde-rust.lock

  Final Command:
    docker compose -f configs/docker/languages/rust/docker-compose.yml \
      --env-file ./.env build --no-cache
```

---

## Limitations

1. **External binaries**: Commands not using `vde_run()` may execute
2. **Subprocesses**: Scripts not sourcing `vde-trace-bootstrap` won't be traced
3. **Background tasks**: Async operations may not be captured

---

## Support

For issues or questions about function tracing:

1. Run `vde function-trace <your-command>` and review the output
2. Check the trace for unexpected function calls or parameters
3. Share the trace output when reporting issues
