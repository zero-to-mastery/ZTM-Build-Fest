#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
"""
Step definitions for USP Alias Resolution.
Verifies that aliases distill correctly to primary rituals using the vde_get_hydration_script ritual.
"""

import os
import subprocess
from pathlib import Path
from behave import given, then, step_matcher
from vm_common import VDE_ROOT

# Use regex matcher
step_matcher("re")

def vde_resolve_ritual(alias):
    """Call the vde_get_hydration_script ritual via zsh."""
    cmd = f'VDE_ROOT_DIR="{VDE_ROOT}"; source "{VDE_ROOT}/lib/vm-common"; vde_get_hydration_script "{alias}"'
    res = subprocess.run(["zsh", "-c", cmd], capture_output=True, text=True, cwd=VDE_ROOT)
    return res.stdout.strip(), res.returncode

@then(r"every registered alias must resolve to its primary hydration ritual")
def step_verify_alias_resolution(context):
    """Verify that every alias in the registry resolves to its custom_cmd script."""
    assert hasattr(context, "vm_types"), "Registry not loaded"
    
    failures = []
    # context.all_vms is already populated from the Given step in usp_steps.py
    for vm in context.all_vms:
        expected_cmd = vm.get("custom_cmd", "")
        # Extract filename (e.g., "python-init.zsh")
        expected_script = expected_cmd.split("/")[-1]
        
        for alias in vm.get("aliases", []):
            resolved_path, rc = vde_resolve_ritual(alias)
            resolved_script = os.path.basename(resolved_path)
            
            if rc != 0 or resolved_script != expected_script:
                failures.append(f"Alias '{alias}' -> '{resolved_script}' (Expected: '{expected_script}')")
                
    assert not failures, f"Alias resolution failures detected:\n" + "\n".join(failures)

@then(r"the resolution must point to a physical script on the Hub")
def step_verify_physical_script(context):
    """Verify that resolved ritual paths exist on the filesystem."""
    # We'll check a sample of aliases to ensure the full path is correct
    sample_aliases = ["py", "rs", "js", "go", "postgres"]
    
    for alias in sample_aliases:
        resolved_path_str, rc = vde_resolve_ritual(alias)
        assert rc == 0, f"Failed to resolve alias '{alias}'"
        
        resolved_path = Path(resolved_path_str)
        # Handle cases where VDE_ROOT might be absolute or relative
        if not resolved_path.is_absolute():
             resolved_path = VDE_ROOT / resolved_path
             
        assert resolved_path.exists(), f"Resolved script for '{alias}' does not exist: {resolved_path}"
