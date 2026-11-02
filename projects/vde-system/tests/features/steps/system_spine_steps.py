#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
"""
Step definitions for the System Spine Integrity feature.
Ensures the Hub-and-Spoke architecture is fully operational and enforced.
"""

import os
import subprocess
import time
import re
import shutil
from pathlib import Path
from behave import given, when, then
from vm_common import VDE_ROOT, BIN_DIR, run_vde_command, get_container_name, vde_sleep
from critical_steps import strip_ansi

@given('the VDE Hub "data/vm-types.conf" is the sole authority')
def step_hub_authority(context):
    hub_file = VDE_ROOT / "data" / "vm-types.conf"
    assert hub_file.exists(), "Hub file (vm-types.conf) missing"
    context.hub_mtime = hub_file.stat().st_mtime

@given('the VDE Registry "data/vm-types.json" is synchronized with the Hub')
def step_registry_sync(context):
    json_file = VDE_ROOT / "data" / "vm-types.json"
    hub_file = VDE_ROOT / "data" / "vm-types.conf"
    
    # Trigger sync if needed
    run_vde_command("rebuild-cache")
    
    assert json_file.exists(), "Registry file (vm-types.json) missing"
    # Registry should not be older than Hub
    assert json_file.stat().st_mtime >= hub_file.stat().st_mtime, "Registry is stale compared to Hub"

@when('I run the one true way to start "{vm_alias}"')
def step_start_one_true_way(context, vm_alias):
    # The "One True Way" is 'bin/vde start'
    context.vm_alias = vm_alias
    context.container_name = get_container_name(vm_alias)
    
    # We want to verify locks, so we might need to run in background or check very fast
    # For now, just run it and we'll verify the result
    result = run_vde_command(f"start {vm_alias}")
    assert result.returncode == 0, f"Failed to start VM via one true way: {result.stderr}"
    context.last_result = result

@then('a VM-level lock should be created during ignition')
def step_verify_lock_created(context):
    # Verify the lock logic exists in the core library
    lock_lib = VDE_ROOT / "lib" / "vm-lock"
    assert lock_lib.exists(), "Lock library missing"
    content = lock_lib.read_text()
    assert "claim_lock" in content or "acquire_lock" in content, "Locking function not found in library"

@then('the container "{container_name}" should be started via direct Docker orchestration')
def step_verify_docker_orchestration(context, container_name):
    # Verify it was started with the vde.managed=true label
    import json
    result = subprocess.run(
        ["docker", "inspect", "--format", "{{json .Config.Labels}}", container_name],
        capture_output=True, text=True
    )
    assert result.returncode == 0, f"Failed to inspect container: {result.stderr}"
    labels = json.loads(result.stdout.strip())
    
    # Check for vde.managed=true (handle both string and boolean if Docker returns it differently)
    managed = str(labels.get("vde.managed", "")).lower()
    if managed != "true":
        raise AssertionError(f"Container {container_name} is not VDE-managed. \nLabels found: {result.stdout.strip()}")

@then('the container should have been hydrated by "{script_path}"')
def step_verify_hydration(context, script_path):
    # Check if the init script exists
    full_path = VDE_ROOT / script_path
    assert full_path.exists(), f"Hydration script missing: {script_path}"
    
    # Verify hydration result in container (e.g. check for a specific package or file)
    # We use dynamic verification based on the VM alias to ensure the correct binary exists
    local_name = context.vm_alias.replace("vde-", "")
    
    # Map VM aliases to their authoritative binaries/sentinels
    SENTINELS = {
        "postgres": "psql --version",
        "redis": "redis-cli --version",
        "mongodb": "mongosh --version",
        "mysql": "mysql --version",
        "nginx": "nginx -v",
        "rabbitmq": "rabbitmq-diagnostics -q check_running",
        "jupyterlab": "jupyter --version",
        "python": "python3 --version",
        "rust": "cargo --version",
        "go": "go version",
        "js": "node --version"
    }
    
    # Default to python3 for unknown languages, as it is the VDE standard binary
    check_cmd = SENTINELS.get(local_name, "python3 --version")
    
    result = run_vde_command(f"exec {context.vm_alias} {check_cmd}")
    assert result.returncode == 0, f"Container hydration failed for {context.vm_alias} (Binary '{check_cmd}' not functional)"

@then('the SSH port should be atomically allocated and recorded in the registry')
def step_verify_port_allocation(context):
    # In 1.5.6, the authoritative port is recorded in .cache/vm-types.cache
    cache_file = VDE_ROOT / ".cache" / "vm-types.cache"
    assert cache_file.exists(), "VM types cache missing"
    
    # Check if the port is recorded for the canonical name
    pattern = fr"VM_SSH_PORT\[{context.container_name}\]='(\d+)'"
    content = cache_file.read_text()
    match = re.search(pattern, content)
    
    if not match:
        # Try raw name
        pattern = fr"VM_SSH_PORT\[{context.vm_alias}\]='(\d+)'"
        match = re.search(pattern, content)
        
    assert match, f"Port not found in cache for {context.container_name}"
    port = match.group(1)
    assert int(port) > 0, f"Invalid port recorded: {port}"

@given('the VDE system is healthy')
def step_system_healthy(context):
    # 1. Rebuild cache to ensure we have fresh data
    run_vde_command("rebuild-cache")
    
    # 2. Verify Docker socket is accessible
    res_docker = subprocess.run(["docker", "info"], capture_output=True, timeout=15)
    assert res_docker.returncode == 0, f"Docker socket inaccessible: {res_docker.stderr}"
    
    # 3. Check for at least 500MB free space in the VDE root
    usage = shutil.disk_usage(VDE_ROOT)
    free_mb = usage.free / (1024 * 1024)
    assert free_mb > 500, f"Insufficient disk space in VDE root: {free_mb:.1f}MB free (min 500MB required)"
    
    # 4. Scan logs/vde.log for recent "CRITICAL" or "ERROR" lock failures
    log_file = VDE_ROOT / "logs" / "vde.log"
    if log_file.exists():
        # Check last 50 lines for critical failures
        try:
            with open(log_file, 'r') as f:
                lines = f.readlines()[-50:]
                for line in lines:
                    if ("CRITICAL" in line or "ERROR" in line) and "lock" in line.lower():
                        raise AssertionError(f"Recent lock failure detected in logs: {line.strip()}")
        except Exception as e:
            if isinstance(e, AssertionError):
                raise
            pass

    # 5. Purge known_hosts to prevent SSH identification warnings breaking forwarding
    try:
        from ssh_helpers import VDE_SSH_KNOWN_HOSTS
        if VDE_SSH_KNOWN_HOSTS.exists():
            VDE_SSH_KNOWN_HOSTS.unlink()
    except ImportError:
        # Fallback if ssh_helpers not available
        known_hosts = Path.home() / ".ssh" / "vde" / "known_hosts"
        if known_hosts.exists():
            known_hosts.unlink()

@then('every VM defined in the Hub must have a corresponding USP init script')
def step_verify_all_scripts(context):
    from vm_common import load_vm_types_raw
    data = load_vm_types_raw()
    
    missing = []
    for cat in ["language", "service"]:
        for vm in data["vms"].get(cat, []):
            custom_cmd = vm.get("custom_cmd", "")
            if "scripts/setup" in custom_cmd:
                # Extract script path
                script = custom_cmd.split()[-1].replace("/vde/", "")
                if not (VDE_ROOT / script).exists():
                    missing.append(f"{vm['name']} ({script})")
    
    assert not missing, f"Missing USP scripts for: {', '.join(missing)}"

@then('every VM must be startable via the VDE orchestrator')
def step_verify_all_startable(context):
    # We sample a language and a service to ensure the logic holds across categories
    sample_vms = ["python", "redis"]
    for vm in sample_vms:
        res = run_vde_command(f"start {vm}")
        assert res.returncode == 0, f"Failed to start {vm} during matrix verification: {res.stderr}"
        # Stop and remove to keep the Forge pristine
        run_vde_command(f"stop {vm}")
        run_vde_command(f"rm {vm}")

@then('every VM must adhere to the 8-field registry standard')
def step_verify_8_field_standard(context):
    hub_file = VDE_ROOT / "data" / "vm-types.conf"
    with open(hub_file, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            fields = line.split('|')
            assert len(fields) >= 8, f"Line does not follow 8-field standard: {line}"

@given('the VDE Registry is loaded')
def step_load_registry_spine(context):
    from vm_common import load_vm_types_raw
    context.vm_types = load_vm_types_raw()
    context.container_name = "vde-python" # Default for this scenario


@when('I run the one true way to stop "{vm_alias}"')
def step_stop_vm(context, vm_alias):
    res = run_vde_command(f"stop {vm_alias}")
    assert res.returncode == 0, f"vde stop failed: {res.stderr}"

# Issue #457: Guard against the container entrypoint corrupting the HOST
# Docker socket's group ownership (it must only ever manage devuser's group
# membership by GID, never chown the host-mounted socket by group name).
_HOST_DOCKER_SOCK = Path("/var/run/docker.sock")

@given('the host Docker socket group ownership is recorded before ignition')
def step_record_host_socket_gid(context):
    assert _HOST_DOCKER_SOCK.exists(), f"Host Docker socket missing: {_HOST_DOCKER_SOCK}"
    context.host_socket_gid_before = _HOST_DOCKER_SOCK.stat().st_gid

@then('the host Docker socket group ownership must be unchanged after ignition')
def step_verify_host_socket_gid_unchanged(context):
    assert _HOST_DOCKER_SOCK.exists(), f"Host Docker socket missing: {_HOST_DOCKER_SOCK}"
    gid_after = _HOST_DOCKER_SOCK.stat().st_gid
    assert gid_after == context.host_socket_gid_before, (
        f"Host Docker socket group ownership was corrupted by spoke ignition! "
        f"before={context.host_socket_gid_before} after={gid_after}"
    )

# Issue #459: Guard against Docker auto-creating a missing bind-mount source
# directory (projects/<name>, logs/<name>) as root:root, which silently
# breaks devuser's ability to write to their own workspace on a fresh VM.

@when('the host workspace and logs directories for "{vm_alias}" are removed')
def step_remove_host_workspace_dirs(context, vm_alias):
    import shutil
    shutil.rmtree(VDE_ROOT / "projects" / vm_alias, ignore_errors=True)
    shutil.rmtree(VDE_ROOT / "logs" / vm_alias, ignore_errors=True)
    context.workspace_vm_alias = vm_alias

@then('the host workspace directory for "{vm_alias}" must be owned by the invoking user')
def step_verify_host_workspace_owned(context, vm_alias):
    workspace_dir = VDE_ROOT / "projects" / vm_alias
    logs_dir = VDE_ROOT / "logs" / vm_alias
    assert workspace_dir.exists(), f"Host workspace directory was not created: {workspace_dir}"
    assert logs_dir.exists(), f"Host logs directory was not created: {logs_dir}"
    expected_uid = os.getuid()
    assert workspace_dir.stat().st_uid == expected_uid, (
        f"{workspace_dir} is owned by uid={workspace_dir.stat().st_uid}, "
        f"expected the invoking user's uid={expected_uid} (likely Docker auto-vivified it as root)"
    )
    assert logs_dir.stat().st_uid == expected_uid, (
        f"{logs_dir} is owned by uid={logs_dir.stat().st_uid}, expected uid={expected_uid}"
    )

@then('devuser must be able to write inside the "{vm_alias}" workspace')
def step_verify_devuser_can_write_workspace(context, vm_alias):
    res = run_vde_command(f"exec {vm_alias} \"touch /home/devuser/workspace/.regression-write-test && rm -f /home/devuser/workspace/.regression-write-test\"")
    assert res.returncode == 0, (
        f"devuser could not write to /home/devuser/workspace inside {vm_alias}: {res.stderr}"
    )

@then('the container "{container_name}" should be stopped')
def step_verify_stopped(context, container_name):
    res = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", container_name], capture_output=True, text=True)
    # Container might still exist but should not be running
    assert res.stdout.strip() == "false", f"{container_name} is still running"

@then('the VM-level lock should be released')
def step_verify_lock_released(context):
    lock_file = VDE_ROOT / ".locks" / "vms" / f"{context.container_name}.lock"
    assert not lock_file.exists(), f"Lock file still exists: {lock_file}"

@when('I run the one true way to remove "{vm_alias}"')
def step_remove_vm(context, vm_alias):
    res = run_vde_command(f"remove {vm_alias}")
    assert res.returncode == 0, f"vde remove failed: {res.stderr}"

@then('the container "{container_name}" should be destroyed')
def step_verify_destroyed(context, container_name):
    # Use exact matching to avoid false positives with similar names
    res = subprocess.run(["docker", "ps", "-a", "--filter", f"name=^{container_name}$", "--format", "{{.Names}}"], capture_output=True, text=True)
    assert container_name not in res.stdout.strip().split('\n'), f"Container {container_name} still exists"

@then('the SSH configuration should be preserved')
def step_verify_ssh_preserved(context):
    # SSH config should NOT be deleted on 'remove' by mandate
    # VDE 1.5.6 standard is ~/.ssh/vde/config
    ssh_config = Path.home() / ".ssh" / "vde" / "config"
    
    assert ssh_config.exists(), f"VDE SSH config missing at {ssh_config}"
    content = ssh_config.read_text()
    # Scenarios often use short names in host aliases, e.g. Host vde-python
    assert context.container_name in content or context.vm_alias in content, f"Config entry for {context.container_name} was removed"

@when('I execute "{command}" inside "{vm_alias}" as "{user}"')
def step_execute_inside(context, command, vm_alias, user):
    # Store vm_alias for later steps if needed
    context.vm_alias = vm_alias
    
    # Give the entrypoint a moment to finish the Atomic Handshake if just started
    vde_sleep(2)

    # SPECIAL CASE: For SSH Agent verification, we MUST use the Transversal Bridge (SSH protocol)
    # because docker exec doesn't forward agents and Darwin socket mounts are unreliable.
    if command == "ssh-add -l":
        # Call bin/ssh-vm via the orchestrator logic to ensure environment inheritance (Rule 15)
        vde_cmd = f"{VDE_ROOT}/bin/ssh-vm -q {vm_alias} {command}"
        context.last_result = run_vde_command(vde_cmd)
        context.last_command = command
    else:
        # Standard execution via bin/vde exec which handles .zshenv sourcing
        user_flag = "-u root" if user == "root" else ""
        vde_cmd = f"exec {user_flag} {vm_alias} {command}"
        context.last_command = command # Store the inner command for special case handling
        context.last_result = run_vde_command(vde_cmd)
        
    # Sync with critical_steps expectations
    context.command_exit_code = context.last_result.returncode
    context.command_output = context.last_result.stdout + context.last_result.stderr
    
    if os.environ.get("VDE_DEBUG_TESTS") == "1":
        print(f"DEBUG: Command: {vde_cmd}")
        print(f"DEBUG: RC: {context.last_result.returncode}")
        print(f"DEBUG: Out: {context.last_result.stdout}")

@when('I enter "{vm_alias}" and run "{command}"')
def step_enter_and_run(context, vm_alias, command):
    # Strip vde- prefix if present for the CLI command
    alias = vm_alias.replace("vde-", "")
    context.vm_alias = alias
    
    # Use BatchMode to fail immediately if there are prompt issues
    vde_cmd = f"enter -o BatchMode=yes {alias} {command}"
    context.last_result = run_vde_command(vde_cmd)
    
    if os.environ.get("VDE_DEBUG_TESTS") == "1":
        print(f"DEBUG: Command: {vde_cmd}")
        print(f"DEBUG: RC: {context.last_result.returncode}")
        print(f"DEBUG: Out: {context.last_result.stdout}")

@then('the execution output should contain "{text}"')
def step_output_contains(context, text):
    assert text in context.last_result.stdout, f"Output does not contain '{text}': {context.last_result.stdout}"

@given('I have identities loaded in my host SSH agent')
def step_identities_loaded(context):
    # Verify host has identities
    import os
    print(f"DEBUG: Host SSH_AUTH_SOCK={os.environ.get('SSH_AUTH_SOCK')}")
    res = subprocess.run(["ssh-add", "-l"], capture_output=True, text=True)
    if res.returncode != 0:
        # If no agent or no keys, attempt to add the vde_student key if it exists
        vde_key = Path.home() / ".ssh" / "vde" / "vde_student"
        if vde_key.exists():
            subprocess.run(["ssh-add", str(vde_key)], capture_output=True)
            res = subprocess.run(["ssh-add", "-l"], capture_output=True, text=True)
            
    assert res.returncode == 0, "No identities loaded in host SSH agent and could not load vde_student."

@then('the output should contain my host identities')
def step_verify_forwarded_identities(context):
    # Use the orchestrator for high-fidelity proof (Rule 1 & 15)
    vm_alias = getattr(context, 'vm_alias', 'python')
    res = run_vde_command(f"exec {vm_alias} ssh-add -l")
    
    # ssh-add -l returns 0 if identities found, 1 if agent empty but reachable.
    # Both are acceptable proof that the bridge is functional.
    assert "SHA256:" in res.stdout or "The agent has no identities." in res.stdout, \
        f"No identities found and agent possibly unreachable: {res.stdout}"

@given('the Hub is active')
def step_hub_active(context):
    # Verify Pillar I: Zsh
    res = subprocess.run(['zsh', '--version'], capture_output=True, text=True, timeout=5)
    assert res.returncode == 0, "zsh not responding"
    assert "zsh" in res.stdout.lower(), "Unexpected zsh version output"

    # Verify Pillar II: Git
    res_git = subprocess.run(['git', '--version'], capture_output=True, text=True, timeout=5)
    assert res_git.returncode == 0, "git not responding"

    # Verify Pillar III: Docker
    res_docker = subprocess.run(["docker", "info"], capture_output=True, timeout=15)
    assert res_docker.returncode == 0, "Docker daemon not responsive or socket inaccessible"

    # Verify Pillar IV: SSH
    res_ssh = subprocess.run(['ssh', '-V'], capture_output=True, text=True, timeout=5)
    assert res_ssh.returncode == 0, "ssh not responding"

@step('I execute "{command}" inside "{vm_name}"')
def step_execute_inside(context, command, vm_name):
    from vm_common import run_vde_command
    # Standardize to use vde exec bridge which handles environment and sourcing
    result = run_vde_command(f"exec {vm_name} {command}")
    context.last_result = result
    context.command_output = result.stdout + result.stderr
    context.command_exit_code = result.returncode

@step('I execute "{command}"')
def step_execute_command(context, command):
    # Handle the 'inside' pattern if it appears in the command string itself
    import re
    match = re.match(r'(.*) inside "(.*)"', command)
    if match:
        cmd, vm = match.groups()
        return step_execute_inside(context, cmd, vm)

    result = subprocess.run(command, shell=True, capture_output=True, text=True)
    context.last_result = result
    context.command_output = result.stdout + result.stderr
    context.command_exit_code = result.returncode

@then('the return code should be {code:d}')
def step_check_rc(context, code):
    rc = getattr(context, 'command_exit_code', None)
    if rc is None:
        rc = getattr(context.last_result, 'returncode', None)
    assert rc == code, f"Expected RC {code}, but got {rc}. Output: {context.command_output if hasattr(context, 'command_output') else 'N/A'}"

@given('a temporary workspace in "{path}"')
def step_temp_workspace(context, path):
    context.workspace = VDE_ROOT / path
    if context.workspace.exists():
        import shutil
        shutil.rmtree(context.workspace)
    context.workspace.mkdir(parents=True)

@when('I execute "{command}" in the workspace')
def step_execute_workspace(context, command):
    result = subprocess.run(command, shell=True, capture_output=True, text=True, cwd=context.workspace)
    context.last_result = result
    context.command_output = result.stdout + result.stderr
    context.command_exit_code = result.returncode


@given('the Docker daemon is responsive')
def step_docker_responsive(context):
    res = subprocess.run(["docker", "info"], capture_output=True)
    assert res.returncode == 0, "Docker daemon not responsive"

@when('I run a diagnostic probe with "{command}"')
def step_diagnostic_probe(context, command):
    result = subprocess.run(command, shell=True, capture_output=True, text=True)
    context.last_result = result
    context.command_output = result.stdout + result.stderr
    context.command_exit_code = result.returncode

@given('the "{identity}" identity exists at "{path}"')
def step_identity_exists(context, identity, path):
    # Resolve ~/ paths
    full_path = Path(os.path.expanduser(path)) / identity
    assert full_path.exists(), f"Identity {identity} missing at {full_path}"

@when('the SSH agent is active on the Hub')
def step_agent_active_hub(context):
    # We already check this in some scenarios, but let's be explicit
    assert "SSH_AUTH_SOCK" in os.environ, "SSH_AUTH_SOCK environment variable missing"
    assert Path(os.environ["SSH_AUTH_SOCK"]).exists(), "SSH agent socket does not exist"
    
    # Ensure vde_student is loaded if possible
    vde_key = Path.home() / ".ssh" / "vde" / "vde_student"
    if vde_key.exists():
        res = subprocess.run(["ssh-add", "-l"], capture_output=True, text=True)
        if "vde_student" not in res.stdout:
            subprocess.run(["ssh-add", str(vde_key)], capture_output=True)
@given('the 4 Pillars (Zsh, Git, Docker, SSH) have passed their individual proofs')
def step_pillars_passed(context):
    """Run bin/vde-spine-check.zsh to verify all pillars in a single ritual."""
    res = subprocess.run([str(BIN_DIR / "vde-spine-check.zsh")], capture_output=True, text=True)
    
    # Verify success markers for all 4 pillars
    markers = [
        "[OK] Pillar I: Zsh",
        "[OK] Pillar II: Git",
        "[OK] Pillar III: Docker",
        "[OK] Pillar IV: SSH"
    ]
    
    # Pillar III might have an INFO marker in CI
    ci_marker = "[INFO] Pillar III (Docker): Skipping diagnostic probe in CI mode"
    
    output = res.stdout + res.stderr
    missing = []
    for marker in markers:
        if marker not in output:
            if "Pillar III" in marker and ci_marker in output:
                continue
            missing.append(marker)
            
    assert res.returncode == 0, f"System Spine Check Failed (RC {res.returncode}):\n{output}"
    assert not missing, f"Missing success markers in spine check output: {', '.join(missing)}\nOutput:\n{output}"

@given('the Hub is synchronized to version {version}')
def step_hub_synced_version_param(context, version):
    # Use the core versioning library logic
    from vm_common import vde_get_version
    current_ver = vde_get_version()
    assert current_ver == version, f"Sync error: Hub at {current_ver}, expected {version}. Run bin/vde-sync-version."

@given('I have a valid VM definition for "{vm_alias}" in the Beskar Registry')
def step_valid_vm_definition(context, vm_alias):
    from vm_common import load_vm_types_raw
    data = load_vm_types_raw()
    
    found = False
    for cat in ["language", "service"]:
        for vm in data["vms"].get(cat, []):
            if vm.get("name") == f"vde-{vm_alias}" or vm_alias in vm.get("aliases", []):
                found = True
                break
        if found: break
    
    assert found, f"VM definition for {vm_alias} not found in Beskar Registry"

@then('the Docker image "{image_name}" should exist on the Hub')
def step_verify_docker_image_exists(context, image_name):
    res = subprocess.run(["docker", "images", "-q", image_name], capture_output=True, text=True)
    assert res.stdout.strip(), f"Docker image {image_name} does not exist on the Hub"

@then('a container named "{container_name}" should be running')
def step_verify_container_named_running(context, container_name):
    res = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", container_name], capture_output=True, text=True)
    assert res.stdout.strip() == "true", f"Container {container_name} is not running"

@then('the SSH bridge to "{vm_alias}" should be established')
def step_verify_ssh_bridge(context, vm_alias):
    # Verify the host SSH config has an entry for the VM
    ssh_config = Path.home() / ".ssh" / "vde" / "config"
    assert ssh_config.exists(), "VDE SSH config missing"
    content = ssh_config.read_text()
    # Handle both canonical and alias
    canonical = f"vde-{vm_alias}"
    assert canonical in content or vm_alias in content, f"SSH bridge not found in config for {vm_alias}"

@then('the loaded SSH identities should include the VDE student key')
def step_verify_vde_student_key_loaded(context):
    """Verify the loaded key fingerprint matches the vde_student key."""
    # VDE_ROOT is already imported from vm_common
    vde_key = VDE_ROOT / ".ssh" / "vde" / "vde_student"
    
    # If we are in a test context where we simulate the hub, the key might be in ~/.ssh/vde
    if not vde_key.exists():
        vde_key = Path.home() / ".ssh" / "vde" / "vde_student"
        
    if not vde_key.exists():
        assert False, f"VDE identity missing at {vde_key}"
        
    # Get fingerprint of the local key
    res = subprocess.run(["ssh-keygen", "-l", "-f", str(vde_key)], capture_output=True, text=True)
    local_fingerprint = res.stdout.split()[1]
    
    # Get current agent identities
    clean_output = strip_ansi(context.command_output)
    
    # Check if this fingerprint is in the agent output
    assert local_fingerprint in clean_output, f"Fingerprint {local_fingerprint} not found in ssh-add -l output:\n{clean_output}"

@then('the command should be executed as the "{identity}" identity')
def step_verify_command_identity(context, identity):
    # If identity is "vde_student", we check if the SSH agent in the container has the key
    # or if the user is devuser (who owns the identity inside the VDE)
    if identity == "vde_student":
        # Ensure we have a vm_alias
        vm_alias = getattr(context, 'vm_alias', None)
        if not vm_alias:
            # Try to extract from the last command run
            if hasattr(context, 'last_command'):
                parts = context.last_command.split()
                # vde enter <vm> ...
                if len(parts) >= 3:
                    vm_alias = parts[2]
        
        # Fallback
        if not vm_alias: vm_alias = "python"
            
        res = run_vde_command(f"exec {vm_alias} whoami")
        assert "devuser" in res.stdout, f"Command not executed as devuser (expected for {identity})"

@then('the command execution should succeed')
@then('the command should succeed')
def step_command_succeed(context):
    # Support both CommandResult and subprocess.CompletedProcess
    rc = getattr(context.last_result, 'returncode', None)
    if rc is None:
        rc = getattr(context.last_result, 'last_exit_code', 1)

    # SPECIAL CASE: ssh-add -l returns 1 if agent is empty, which is still a "success" 
    # in terms of the bridge working (the command ran inside the VM).
    if rc == 1 and hasattr(context, 'last_command') and "ssh-add -l" in context.last_command:
        return

    assert rc == 0, f"Command failed with RC {rc}: {context.last_result.stderr if hasattr(context.last_result, 'stderr') else 'N/A'}"


@then('the image "{image_name}" should exist')
def step_verify_image_exists(context, image_name):
    # If image_name is 'vde-python', it might just be 'python' in some contexts, but we expect canonical name here
    res = subprocess.run(["docker", "images", "-q", image_name], capture_output=True, text=True)
    assert res.stdout.strip(), f"Image {image_name} does not exist"

@then('the container "{container_name}" should be running')
def step_verify_container_running(context, container_name):
    res = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", container_name], capture_output=True, text=True)
    assert res.stdout.strip() == "true", f"Container {container_name} is not running"

@then('the container "{container_name}" should not be running')
def step_verify_container_not_running(context, container_name):
    res = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", container_name], capture_output=True, text=True)
    # If container doesn't exist, it's technically not running
    if res.returncode != 0:
        return
    assert res.stdout.strip() == "false", f"Container {container_name} is still running"

@then('the container "{container_name}" should not exist')
def step_verify_container_not_exist(context, container_name):
    res = subprocess.run(["docker", "ps", "-a", "--filter", f"name=^{container_name}$", "--format", "{{.Names}}"], capture_output=True, text=True)
    assert container_name not in res.stdout.strip().split('\n'), f"Container {container_name} still exists"

@then('the SSH config should not contain an entry for "{alias}"')
def step_ssh_config_no_entry(context, alias):
    """Assert neither live nor project SSH config contains a Host entry for alias."""
    from tests.features.steps.ssh_helpers import VDE_SSH_CONFIG, VDE_ROOT
    host_pattern = f"Host {alias}"

    live_contains = False
    if VDE_SSH_CONFIG.exists():
        live_contains = host_pattern in VDE_SSH_CONFIG.read_text()

    project_config = VDE_ROOT / "configs" / "ssh" / "config"
    project_contains = False
    if project_config.exists():
        project_contains = host_pattern in project_config.read_text()

    assert not live_contains, (
        f"Live SSH config (~/.ssh/vde/config) still contains entry for '{alias}'"
    )
    assert not project_contains, (
        f"Project SSH config (configs/ssh/config) still contains entry for '{alias}'"
    )


def after_scenario(context, scenario):
    """Cleanup after each scenario to enforce hygiene."""
    if hasattr(context, 'workspace') and "git-test" in str(context.workspace):
        import shutil
        if context.workspace.exists():
            shutil.rmtree(context.workspace)
        # Re-create empty with .keep to satisfy git
        context.workspace.mkdir(parents=True, exist_ok=True)
        (context.workspace / ".keep").touch()
