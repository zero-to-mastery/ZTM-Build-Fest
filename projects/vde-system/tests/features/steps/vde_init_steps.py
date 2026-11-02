#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
from behave import given, when, then
import os
import shutil
import subprocess
from pathlib import Path
from vm_common import VDE_ROOT, run_vde_command

@given('the Hub is uninitialized')
def step_hub_uninitialized(context):
    """Confirm the Hub is ready for initialization."""
    assert VDE_ROOT.exists(), f"VDE root {VDE_ROOT} does not exist"
    
    # 1. Quench all
    subprocess.run(["zsh", "bin/vde", "stop", "all"], capture_output=True, cwd=VDE_ROOT)
    
    # 2. Break all locks
    lock_dir = VDE_ROOT / ".locks"
    if lock_dir.exists():
        shutil.rmtree(lock_dir)
    
    # 3. Purge cache
    cache_dir = VDE_ROOT / ".cache"
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    
    # 4. Remove network
    subprocess.run(["docker", "network", "rm", "vde-net"], capture_output=True, cwd=VDE_ROOT)

@when('I execute "bin/vde init"')
def step_impl(context):
    context.result = subprocess.run(["zsh", "bin/vde", "init"], capture_output=True, text=True, cwd=VDE_ROOT)
    context.command_exit_code = context.result.returncode
    context.command_output = context.result.stdout + context.result.stderr

@then('the mandatory directories should exist:')
def step_impl(context):
    for row in context.table:
        path = VDE_ROOT / row['directory']
        assert path.is_dir(), f"Directory {path} does not exist"

@then('the SSH identity "{identity}" should exist in the SSH directory')
def step_impl(context, identity):
    # Get VDE_SSH_DIR from constants
    cmd = f'export VDE_ROOT_DIR="{VDE_ROOT}"; source "{VDE_ROOT}/lib/vde-constants"; echo "$VDE_SSH_DIR"'
    res = subprocess.run(["zsh", "-c", cmd], capture_output=True, text=True)
    ssh_dir = Path(res.stdout.strip())
    
    priv_key = ssh_dir / identity
    pub_key = ssh_dir / f"{identity}.pub"
    
    assert priv_key.exists(), f"Private key {priv_key} missing"
    assert pub_key.exists(), f"Public key {pub_key} missing"

@then('the Docker network "{network_name}" should be active')
def step_impl(context, network_name):
    res = subprocess.run(["docker", "network", "ls", "--filter", f"name={network_name}", "-q"], capture_output=True, text=True)
    assert res.stdout.strip() != "", f"Docker network {network_name} is not active"
