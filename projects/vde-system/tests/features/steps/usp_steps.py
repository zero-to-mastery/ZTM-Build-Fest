#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
"""
Step definitions for Universal Script Parity (USP) validation.
Ensures all setup scripts are present and hardened according to Phase 24 mandates.
"""

import os
import subprocess
from pathlib import Path
from behave import given, then, step_matcher
from vm_common import load_vm_types_raw, VDE_ROOT

# Use regex matcher for more flexible step definitions
step_matcher("re")

@given(r"the VDE registry is loaded")
def step_load_registry(context):
    """Load the VM types registry into context."""
    context.vm_types = load_vm_types_raw()
    assert "vms" in context.vm_types, "Registry missing 'vms' key"
    
    # Flatten all VMs into a single list for easier iteration
    context.all_vms = []
    for category in ["language", "service"]:
        context.all_vms.extend(context.vm_types["vms"].get(category, []))
    
    assert len(context.all_vms) > 0, "No VMs found in registry"

@then(r"every VM must have a setup script in scripts/setup/")
def step_verify_scripts_exist(context):
    """Verify that every VM's custom_cmd points to an existing setup script."""
    for vm in context.all_vms:
        vm_name = vm['name']
        
        # Use the ritual to resolve the script path
        cmd = f'source "{VDE_ROOT}/lib/vm-common"; load_vm_types >/dev/null 2>&1; vde_get_hydration_script "{vm_name}"'
        res = subprocess.run(["zsh", "-c", cmd], capture_output=True, text=True, cwd=VDE_ROOT)
        script_path_str = res.stdout.strip()
        
        assert res.returncode == 0, f"Ritual failed to resolve script for '{vm_name}'"
        assert script_path_str, f"Ritual returned empty path for '{vm_name}'"
        
        script_path = Path(script_path_str)
        assert script_path.exists(), f"Setup script missing for '{vm_name}': {script_path}"
        
        # Store scripts for subsequent checks
        if not hasattr(context, "setup_scripts"):
            context.setup_scripts = []
        if script_path not in context.setup_scripts:
            context.setup_scripts.append(script_path)

@then(r"every script must follow the '(.+)' standardized header ritual")
def step_verify_header_ritual(context, ritual_name):
    """Verify that every setup script follows the required header ritual."""
    assert hasattr(context, "setup_scripts"), "No setup scripts found to check"
    
    missing = []
    for script in context.setup_scripts:
        content = script.read_text()
        if ritual_name not in content:
            missing.append(script.name)
            
    assert not missing, f"Scripts missing ritual '{ritual_name}': {', '.join(missing)}"

APT_CLEANUP_PATTERNS = {"apt-get clean", "rm -rf /var/lib/apt/lists/*"}

@then(r"every script must have '(.+)' (?:for|to) (.+)")
def step_verify_script_content(context, pattern, reason):
    """Verify that every setup script contains the required hardening pattern."""
    assert hasattr(context, "setup_scripts"), "No setup scripts found to check"

    missing = []
    for script in context.setup_scripts:
        content = script.read_text()
        if pattern not in content:
            if pattern in APT_CLEANUP_PATTERNS and "vde_purge_ghosts" in content:
                continue
            missing.append(script.name)

    assert not missing, f"Scripts missing '{pattern}' ({reason}): {', '.join(missing)}"

@then(r'every script in "(.+)" must be associated with a registered VM')
def step_verify_no_ghost_scripts(context, directory):
    """Verify that every script in the specified directory is registered in the Hub."""
    setup_dir = VDE_ROOT / directory
    all_scripts = list(setup_dir.glob("*-init.zsh"))
    
    # Get all registered script names
    registered_scripts = []
    for vm in context.all_vms:
        custom_cmd = vm.get("custom_cmd", "")
        if custom_cmd:
            script_name = custom_cmd.split()[-1].split("/")[-1]
            registered_scripts.append(script_name)
            
    ghosts = []
    for script in all_scripts:
        if script.name not in registered_scripts:
            ghosts.append(script.name)
            
    assert not ghosts, f"Ghost scripts detected in {directory} (not registered): {', '.join(ghosts)}"
