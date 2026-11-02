#!/usr/bin/env python3
# @forge (Governance Sentinel)
"""
Step definitions for JupyterLab Data Science Spoke verification.
"""

import subprocess
from behave import then, when, step_matcher
from vm_common import VDE_ROOT, load_vm_types_raw, vde_sleep

# Use regex matcher
step_matcher("re")

@then(r'the VM "(.+)" must be registered as a "(.+)"')
def step_verify_vm_type(context, vm_name, expected_type):
    """Verify the VM type in the registry."""
    vm_types = load_vm_types_raw()
    vms = vm_types.get("vms", {}).get(expected_type, [])
    found = any(vm["name"] == vm_name for vm in vms)
    assert found, f"VM '{vm_name}' not found in category '{expected_type}'"

@then(r'the VM "(.+)" must have service ports "(.+)"')
def step_verify_service_ports(context, vm_name, expected_port):
    """Verify the service port in the registry."""
    vm_types = load_vm_types_raw()
    found = False
    for cat in ["language", "service"]:
        for vm in vm_types.get("vms", {}).get(cat, []):
            if vm["name"] == vm_name:
                assert vm.get("service_ports") == expected_port, f"Expected port {expected_port}, got {vm.get('service_ports')}"
                found = True
                break
    assert found, f"VM '{vm_name}' not found"

@then(r'the VM "(.+)" must have SSH port "(.+)"')
def step_verify_ssh_port(context, vm_name, expected_port):
    """Verify the SSH port in the registry."""
    vm_types = load_vm_types_raw()
    found = False
    for cat in ["language", "service"]:
        for vm in vm_types.get("vms", {}).get(cat, []):
            if vm["name"] == vm_name:
                assert str(vm.get("ssh_port")) == expected_port, f"Expected SSH port {expected_port}, got {vm.get('ssh_port')}"
                found = True
                break
    assert found, f"VM '{vm_name}' not found"

@then(r'the VM "(.+)" must support alias "(.+)"')
def step_verify_alias(context, vm_name, expected_alias):
    """Verify the alias in the registry."""
    vm_types = load_vm_types_raw()
    found = False
    for cat in ["language", "service"]:
        for vm in vm_types.get("vms", {}).get(cat, []):
            if vm["name"] == vm_name:
                assert expected_alias in vm.get("aliases", []), f"Alias '{expected_alias}' not found for '{vm_name}'"
                found = True
                break
    assert found, f"VM '{vm_name}' not found"

@then(r'the setup script for "(.+)" must exist')
def step_verify_setup_script_exists(context, alias):
    """Verify the setup script exists."""
    script_path = VDE_ROOT / "scripts" / "setup" / f"{alias}-init.zsh"
    assert script_path.exists(), f"Setup script missing: {script_path}"
    context.current_script = script_path

@then(r'the setup script for "(.+)" must be USP compliant')
def step_verify_usp_compliance(context, alias):
    """Verify USP compliance of the setup script."""
    script_path = VDE_ROOT / "scripts" / "setup" / f"{alias}-init.zsh"
    content = script_path.read_text()
    
    assert "set -e" in content, "Missing 'set -e'"
    assert "apt-get clean" in content or "vde_purge_ghosts" in content, "Missing 'apt-get clean' (or canonical vde_purge_ghosts delegation)"
    assert "DEBIAN_FRONTEND=noninteractive" in content, "Missing DEBIAN_FRONTEND"
    assert "Forged in Beskar" in content, "Missing Beskar header"

@then(r'the workspace mount for "(.+)" must point to "(.+)"')
def step_verify_mount(context, vm_name, expected_path):
    """Verify mount resolution via shell command."""
    cmd = f"source {VDE_ROOT}/lib/vde-core && source {VDE_ROOT}/lib/vm-common && get_vm_mounts {vm_name}"
    result = subprocess.run(["zsh", "-c", cmd], capture_output=True, text=True)
    assert result.returncode == 0, f"Failed to get mounts: {result.stderr}"
    assert expected_path in result.stdout, f"Expected path '{expected_path}' not in mounts: {result.stdout}"

@when(r'I start the VM "(.+)"')
def step_start_vm(context, alias):
    """Start the VM via VDE CLI and trigger persistence anchor."""
    # 1. Start VM
    cmd = [str(VDE_ROOT / "bin" / "vde"), "start", alias]
    subprocess.run(cmd, capture_output=True, text=True)
    
    # 2. Trigger .zshenv (Persistence Anchor)
    # This is required because VDE services started in .zshenv only fire on session entry
    exec_cmd = [str(VDE_ROOT / "bin" / "vde-exec"), alias, "true"]
    subprocess.run(exec_cmd, capture_output=True, text=True)

@then(r'the VM "(.+)" must be running')
def step_verify_running(context, vm_name):
    """Verify the container is running."""
    cmd = ["docker", "ps", "--filter", f"name={vm_name}", "--filter", "status=running", "--format", "{{.Names}}"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    assert vm_name in result.stdout, f"VM '{vm_name}' is not running"

@then(r'the service on port "(.+)" must be responsive')
def step_verify_port_responsive(context, port):
    """Verify the service port responds to HTTP using curl with retries."""
    import time
    max_retries = 10
    for i in range(max_retries):
        cmd = ["curl", "-s", "-I", f"http://localhost:{port}"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if "HTTP/1.1" in result.stdout or "HTTP/2" in result.stdout:
            return
        vde_sleep(2)
    
    # Final attempt to show output if failed
    cmd = ["curl", "-s", "-I", f"http://localhost:{port}"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    assert "HTTP/1.1" in result.stdout or "HTTP/2" in result.stdout, f"Port {port} not responsive after {max_retries} retries: {result.stdout}"
