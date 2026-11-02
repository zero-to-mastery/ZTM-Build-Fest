#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
from behave import given, when, then
import subprocess
import os
import shutil
from pathlib import Path
from vm_common import VDE_ROOT, run_vde_command

@given('a background process holds a lock on "{vm_alias}"')
def step_background_lock(context, vm_alias):
    import time
    lock_dir = VDE_ROOT / ".locks" / "vms" / f"{vm_alias}.lock"
    lock_dir.mkdir(parents=True, exist_ok=True)
    # Use the behave process PID — guaranteed alive during the test.
    # A dead PID would be purged by the stale-ticket buster before
    # lock contention is ever reached.
    pid = os.getpid()
    now = int(time.time())
    # Format must match claim_lock's "PID:PGID:TIMESTAMP" so the
    # stale-buster sees a fresh timestamp and does NOT remove it.
    (lock_dir / "pid").write_text(f"{pid}:{pid}:{now}")
    # Ticket queue entry for the holding process
    queue_dir = lock_dir.parent / f"{vm_alias}.lock.queue"
    queue_dir.mkdir(parents=True, exist_ok=True)
    (queue_dir / f"0000000001-{pid}").touch()
    context.background_pid = pid
    context.add_cleanup(lambda: shutil.rmtree(str(lock_dir), ignore_errors=True))
    context.add_cleanup(lambda: shutil.rmtree(str(queue_dir), ignore_errors=True))

def _register_container_cleanup(context, cmd):
    """Register cleanup for any container started by a 'start <alias>' command.
    The signal rig may leave a container running if it was created before the
    signal killed the vde process — ensure stop+rm runs regardless of outcome.
    Uses docker directly to bypass VDE's lock system, which can be left in a
    stale state when the vde process is killed with SIGKILL."""
    parts = cmd.split()
    if len(parts) >= 2 and parts[0] == "start":
        alias = parts[1]
        def _cleanup(a=alias):
            subprocess.run(
                ["docker", "rm", "-f", f"vde-{a}"],
                capture_output=True
            )
            # Clear any stale VM lock left by a SIGKILL'd vde process
            lock_dir = VDE_ROOT / ".locks" / "vms" / f"{a}.lock"
            shutil.rmtree(str(lock_dir), ignore_errors=True)
        context.add_cleanup(_cleanup)

@when('I simulate a user interruption (SIGINT) during "{command_str}"')
def step_physical_sigint(context, command_str):
    # Strip 'bin/vde ' from the start if present
    cmd = command_str.replace("bin/vde ", "")
    rig_path = VDE_ROOT / "plans" / "scripts" / "signal-strike.zsh"

    _register_container_cleanup(context, cmd)

    # Execute the physical injection rig
    res = subprocess.run(
        [str(rig_path), "SIGINT", cmd],
        capture_output=True,
        text=True,
        cwd=VDE_ROOT
    )

    context.command_output = res.stdout + res.stderr
    context.command_exit_code = res.returncode

@when('I simulate a forceful termination (SIGKILL) during "{command_str}"')
def step_physical_sigkill(context, command_str):
    cmd = command_str.replace("bin/vde ", "")
    rig_path = VDE_ROOT / "plans" / "scripts" / "signal-strike.zsh"

    _register_container_cleanup(context, cmd)

    res = subprocess.run(
        [str(rig_path), "SIGKILL", cmd],
        capture_output=True,
        text=True,
        cwd=VDE_ROOT
    )

    context.command_output = res.stdout + res.stderr
    context.command_exit_code = res.returncode

@then('the output should contain the PID of the background process')
def step_verify_pid_in_output(context):
    from critical_steps import strip_ansi
    clean_output = strip_ansi(context.command_output)
    assert str(context.background_pid) in clean_output, f"PID {context.background_pid} not found in output: {clean_output}"

@when('I attempt to start "{vm_alias}" in the foreground')
def step_attempt_start(context, vm_alias):
    # Use the rig for consistency even here if we want to capture output and interrupt
    context.target_vm = vm_alias
    step_physical_sigint(context, f"start {vm_alias}")
