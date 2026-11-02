#!/usr/bin/env python3
# @forge (Governance Sentinel)
from behave import given, when, then
import subprocess
from pathlib import Path
from vm_common import VDE_ROOT, BIN_DIR, VM_TYPES_JSON

@given('the environment is being initialized')
def step_impl(context):
    # Using absolute paths via VDE_ROOT
    locks_dir = VDE_ROOT / ".locks"
    if locks_dir.exists():
        # Valid locks are directories (FIFO queues)
        # Rogue locks would be unexpected individual files
        rogue_locks = []
        for p in locks_dir.rglob("*"):
            if p.is_file() and p.suffix == ".lock":
                rogue_locks.append(str(p))
        
        assert not rogue_locks, f"Rogue VDE lock files found: {rogue_locks}"

    # Verify presence of bin/vde
    vde_script = BIN_DIR / "vde"
    assert vde_script.exists(), f"bin/vde missing from {BIN_DIR}"

@given('the Unyielding Tetrad is installed')
def step_impl(context):
    for tool in ['git', 'docker', 'ssh']:
        res = subprocess.run(['command', '-v', tool], shell=True, capture_output=True)
        assert res.returncode == 0, f"Missing Tetrad tool: {tool}"

@when('I check for command "{command}"')
def step_impl(context, command):
    context.last_result = subprocess.run(['command', '-v', command], shell=True, capture_output=True)

@given('the VDE root directory is active')
def step_impl(context):
    assert VM_TYPES_JSON.exists(), f"data/vm-types.json missing from {VM_TYPES_JSON.parent}"
    vde_script = BIN_DIR / "vde"
    assert vde_script.exists(), f"bin/vde missing from {BIN_DIR}"
