#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
"""
Step definitions for Integrated Tech Stack verification.
"""

import subprocess
import time
from behave import when, then
from vm_common import run_vde_command

@when('I run the one true way to start the VMs "{vm_aliases}"')
def step_start_vms_anchored(context, vm_aliases):
    """Start multiple VMs and trigger their persistence anchors."""
    aliases = vm_aliases.split()
    context.vm_aliases = aliases
    
    # 1. Ignite all
    for alias in aliases:
        result = run_vde_command(f"start {alias}")
        assert result.returncode == 0, f"Failed to start {alias}: {result.stderr}"
    
    # 2. Trigger Anchors (Execute 'true' to fire .zshenv)
    # This ensures services like postgres/redis actually start
    for alias in aliases:
        run_vde_command(f"exec {alias} true")

@then('the stack should be gracefully terminated')
def step_stack_termination(context):
    """Gracefully shutdown all components of the verified stack."""
    # We use 'vde stop all' for a clean exit
    result = run_vde_command("stop all")
    assert result.returncode == 0, f"Failed to terminate stack: {result.stderr}"

@then('the VM "{vm_name}" must be responsive on port "{port}"')
def step_verify_port_responsive_generic(context, vm_name, port):
    """Verify a VM port is responsive using deterministic polling."""
    from shell_helpers import vde_poll
    # vde-poll uses 'nc' or 'zsh /dev/tcp' under the hood
    # and has built-in retry logic.
    vde_poll(
        ["--port", port, vm_name],
        timeout=60,
        description=f"service {vm_name} on port {port}"
    )
