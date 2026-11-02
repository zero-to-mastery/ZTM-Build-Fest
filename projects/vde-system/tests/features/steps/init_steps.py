#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
import os
import subprocess
from pathlib import Path
from behave import then
from vm_common import VDE_ROOT, run_vde_command

@then('the VDE_SSH_DIR should contain the "{identity}" identity')
def step_verify_vde_ssh_identity(context, identity):
    # Determine VDE_SSH_DIR by sourcing vde-constants
    cmd = f'export VDE_ROOT_DIR="{VDE_ROOT}"; source "{VDE_ROOT}/lib/vde-constants"; echo "$VDE_SSH_DIR"'
    res = subprocess.run(["zsh", "-c", cmd], capture_output=True, text=True)
    ssh_dir = Path(res.stdout.strip())
    
    assert ssh_dir.exists(), f"VDE_SSH_DIR '{ssh_dir}' does not exist"
    
    priv_key = ssh_dir / identity
    pub_key = ssh_dir / f"{identity}.pub"
    
    assert priv_key.exists(), f"Private key '{priv_key}' missing in {ssh_dir}"
    assert pub_key.exists(), f"Public key '{pub_key}' missing in {ssh_dir}"

@then('the VM "{vm_alias}" should no longer be registered')
def step_vm_not_registered(context, vm_alias):
    from vm_common import VM_TYPES_CONF, VM_TYPES_JSON
    # Check .conf
    with open(VM_TYPES_CONF, 'r') as f:
        conf_content = f.read()
    assert vm_alias not in conf_content, f"VM {vm_alias} still present in {VM_TYPES_CONF}"
    
    # Check .json
    with open(VM_TYPES_JSON, 'r') as f:
        json_content = f.read()
    assert vm_alias not in json_content, f"VM {vm_alias} still present in {VM_TYPES_JSON}"

@then('the file "{filename}" should exist')
def step_file_exists(context, filename):
    path = VDE_ROOT / filename
    assert path.exists(), f"File {path} does not exist"

@then('the file "{filename}" should contain "{text}"')
def step_file_contains(context, filename, text):
    path = VDE_ROOT / filename
    assert path.exists(), f"File {path} does not exist"
    content = path.read_text()
    assert text in content, f"Expected '{text}' in {filename}, but not found."
