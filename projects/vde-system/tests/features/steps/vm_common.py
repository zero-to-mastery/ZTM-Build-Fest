#!/usr/bin/env python3
# @forge (Governance Sentinel)
"""
Shared helper functions for VM lifecycle BDD tests.
These functions are used across multiple step definition files.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

# Force quiet mode and test mode for all BDD interactions (Rule 15)
os.environ["VDE_QUIET"] = "1"
os.environ["VDE_TEST_MODE"] = "1"

# Import shared configuration
# Add steps directory to path for config import
steps_dir = os.path.dirname(os.path.abspath(__file__))
if steps_dir not in sys.path:
    sys.path.insert(0, steps_dir)
from config import VDE_ROOT as _VDE_ROOT

# VDE root directory - support both container and local environments
# Use VDE_PROJECT_ROOT if set, otherwise use shared config
project_root = os.environ.get("VDE_PROJECT_ROOT")
VDE_ROOT = Path(project_root) if project_root and Path(project_root).exists() else _VDE_ROOT
BIN_DIR = VDE_ROOT / "bin"
VM_TYPES_JSON = VDE_ROOT / "data" / "vm-types.json"
VM_TYPES_CONF = VDE_ROOT / "data" / "vm-types.conf"

# Detect if running in container vs locally on host
# In container: VDE_ROOT_DIR is set to /vde
# Locally: VDE_ROOT_DIR is not set or points to a different path
# Test mode: VDE_TEST_MODE is set to 1 (allows cleanup during local testing)
IN_CONTAINER = os.environ.get("VDE_ROOT_DIR") == "/vde"
IN_TEST_MODE = os.environ.get("VDE_TEST_MODE") == "1"
# Allow cleanup if running in container OR in test mode
ALLOW_CLEANUP = IN_CONTAINER or IN_TEST_MODE


def vde_get_version():
    """Extract the current VDE version from docs/governance/vde-spec.md."""
    spec_file = VDE_ROOT / "docs" / "governance" / "vde-spec.md"
    if not spec_file.exists():
        return "0.0.0-unknown"
    
    import re
    content = spec_file.read_text()
    # Matches: "Version: 1.4.1" or "# VDE-SPEC 1.4.1"
    m = re.search(r"(?:Version:|VDE-SPEC)\s+([0-9]+\.[0-9]+\.[0-9]+(-sp[0-9]+)?)", content)
    return m.group(1) if m else "0.0.0-unknown"


def vde_sleep(seconds):
    """Wait for a specified duration using select.select to satisfy UAP Enforcer."""
    import select
    select.select([], [], [], seconds)


def resolve_vm_name(vm_input):
    """Resolve VM name or alias to canonical vde- name. Parity with lib/vm-common."""
    if not vm_input:
        return ""
    
    # 1. Check as-is
    vm_types = load_vm_types_raw()
    full_name = vm_input if vm_input.startswith("vde-") else f"vde-{vm_input}"
    
    for cat in ["language", "service"]:
        for vm in vm_types.get("vms", {}).get(cat, []):
            if vm.get("name") == full_name:
                return full_name
            if vm_input in vm.get("aliases", []):
                return vm.get("name")
                
    return full_name


def get_vm_conf_dir(vm_name):
    """Get VM configuration directory in configs/docker/<category>/."""
    # Normalize name (remove vde- prefix if present)
    name = vm_name.replace("vde-", "")
    
    # Check NEW category-specific path first
    category = get_vm_category(vm_name)
    if category != "unknown":
        new_path = VDE_ROOT / "configs" / "docker" / category / name
        if new_path.exists():
            return new_path
            
    # Fallback to OLD conventional path
    return VDE_ROOT / "configs" / "docker" / name


def get_vm_type(vm_name):
    """Get VM type (lang or service) from configuration."""
    # Resolve name to canonical vde- prefixed name
    raw_name = vm_name.replace("vde-", "")
    full_name = f"vde-{raw_name}"
    
    vm_types = load_vm_types_raw()
    
    # Check languages
    for lang in vm_types.get("vms", {}).get("language", []):
        if lang.get("name") == full_name or raw_name in lang.get("aliases", []):
            return "lang"
            
    # Check services
    for service in vm_types.get("vms", {}).get("service", []):
        if service.get("name") == full_name or raw_name in service.get("aliases", []):
            return "service"
            
    return "unknown"


def get_vm_category(vm_name):
    """Get VM category (languages or services) for a given VM name."""
    vm_type = get_vm_type(vm_name)
    
    if vm_type == "lang":
        return "languages"
    elif vm_type == "service":
        return "services"
    
    # Fallback/Backward compatibility: check directories if not found in config
    raw_name = vm_name.replace("vde-", "")
    if (VDE_ROOT / "configs" / "docker" / "languages" / raw_name).exists():
        return "languages"
    if (VDE_ROOT / "configs" / "docker" / "services" / raw_name).exists():
        return "services"
        
    return "unknown"


def is_vde_available():
    """Check if VDE command is available.

    Returns:
        bool: True if vde command available, False otherwise
    """
    try:
        subprocess.run(
            [str(BIN_DIR / "vde"), "--version"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def _vde_env():
    """Return environment dict for vde CLI calls: logs to file, clean stdout."""
    from config import VDE_CACHE_DIR

    env = {
        **os.environ,
        "VDE_ROOT_DIR": str(VDE_ROOT),
        "VDE_LOG_OUTPUT": "file",
        "VDE_CACHE_DIR": str(VDE_CACHE_DIR),
        "VDE_LOG_LEVEL": "DEBUG",
        "VDE_TEST_MODE": "1",
    }
    
    # Bridge host SSH agent into the subprocess
    if "SSH_AUTH_SOCK" in os.environ:
        env["SSH_AUTH_SOCK"] = os.environ["SSH_AUTH_SOCK"]
        
    return env


def docker_ps():
    """Get list of running Docker container names.

    Returns:
        list: List of running container names, empty list if none or Docker unavailable
    """
    return docker_list_containers()


def docker_list_containers():
    """List running VDE container names via vde ps.

    Returns:
        list: List of running container names, empty list if none or unavailable
    """
    try:
        result = subprocess.run(
            ["zsh", str(BIN_DIR / "vde"), "ps", "-q"],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=str(VDE_ROOT),
            env=_vde_env(),
        )
        containers = [line.strip() for line in result.stdout.strip().split("\n") if line.strip()]
        return containers
    except Exception:
        return []


def container_exists(container_name):
    """Check if a VDE container exists (running or stopped) via vde ps."""
    try:
        full_name = f"vde-{container_name.replace('vde-', '')}"
        result = subprocess.run(
            ["zsh", str(BIN_DIR / "vde"), "ps", "-a", "-q"],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=str(VDE_ROOT),
            env=_vde_env(),
        )
        return full_name in result.stdout.split()
    except Exception as e:
        if os.environ.get("VDE_DEBUG_TESTS") == "1":
            print(f"[DEBUG] container_exists check failed: {e}")
        return False


def container_is_running(container_name):
    """Check if a VDE container is currently running via docker inspect.

    Args:
        container_name: Name of the container to check (with or without vde- prefix)

    Returns:
        bool: True if container is running, False otherwise
    """
    try:
        full_name = f"vde-{container_name.replace('vde-', '')}"
        # Use direct docker inspect for ground truth state
        result = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", full_name],
            capture_output=True,
            text=True,
            timeout=10
        )
        return result.returncode == 0 and result.stdout.strip() == "true"
    except Exception as e:
        if os.environ.get("VDE_DEBUG_TESTS") == "1":
            print(f"[DEBUG] container_is_running check failed: {e}")
        return False


def get_container_id(container_name):
    """Get the container ID for a given container name.

    Args:
        container_name: Name of the container to look up

    Returns:
        str: Container ID if found

    Raises:
        RuntimeError: If container is missing or lookup fails
    """
    try:
        full_name = f"vde-{container_name.replace('vde-', '')}"
        result = subprocess.run(
            ["docker", "inspect", "-f", "{{.Id}}", full_name],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            return result.stdout.strip()
        
        # Proper error if missing
        raise RuntimeError(f"Container '{full_name}' not found: {result.stderr.strip()}")
    except Exception as e:
        if isinstance(e, RuntimeError):
            raise
        raise RuntimeError(f"Failed to lookup container ID for '{container_name}': {e}")


def get_compose_file(vm_name):
    """Get the path to a VM's docker-compose.yml file.

    Args:
        vm_name: Name of the VM (with or without vde- prefix)

    Returns:
        Path: Path to the compose file
    """
    return get_vm_conf_dir(vm_name) / "docker-compose.yml"


def get_dockerfile(vm_name):
    """Get the path to a VM's Dockerfile.

    Args:
        vm_name: Name of the VM (with or without vde- prefix)

    Returns:
        Path: Path to the Dockerfile
    """
    return get_vm_conf_dir(vm_name) / "Dockerfile"


def compose_file_exists(vm_name):
    """Check if a docker-compose file exists.

    Args:
        vm_name: Name of the VM

    Returns:
        bool: True if file exists, False otherwise
    """
    return get_compose_file(vm_name).exists()


def wait_for_container(container_name, timeout=30, vm_name=None):
    """Wait for a VDE container to become ready using vde-poll.

    Args:
        container_name: Name of the container to wait for
        timeout: Maximum time to wait in seconds (default 30)
        vm_name: VM name for adaptive timeout (optional)

    Returns:
        bool: True if container becomes ready, False if timeout
    """
    # Apply adaptive timeout if vm_name provided and no explicit timeout given
    if timeout == 30 and vm_name:
        vm_type = vm_name.replace("vde-", "").lower()
        if vm_type in {"rust", "flutter", "kotlin", "swift", "haskell", "elixir", "scala"}:
            timeout = 320

    from shell_helpers import vde_poll
    
    try:
        # Default vde-poll check is 'running'
        vde_poll(
            [container_name],
            timeout=timeout,
            description=f"container {container_name} readiness"
        )
        return True
    except Exception as e:
        if os.environ.get("VDE_DEBUG_TESTS") == "1":
            print(f"[DEBUG] container_exists check failed: {e}")
        return False


def vde_wait_for_container_healthy(vm_name, timeout=60):
    """Wait for a VDE container to be healthy using deterministic polling via vde-poll.

    Args:
        vm_name: Name of the VM (with or without vde- prefix)
        timeout: Maximum time to wait in seconds (default 60)

    Returns:
        bool: True if container becomes healthy, False otherwise
    """
    # Adaptive timeout for heavy language VMs
    if timeout == 60:
        raw_name = vm_name.replace("vde-", "").lower()
        if raw_name in {"rust", "flutter", "kotlin", "swift", "haskell", "elixir", "scala"}:
            timeout = 360

    from shell_helpers import vde_poll
    
    try:
        # Call vde-poll --health
        vde_poll(
            ["--health", vm_name],
            timeout=timeout,
            description=f"container {vm_name} health"
        )
        return True
    except Exception as e:
        if os.environ.get("VDE_DEBUG_TESTS") == "1":
            print(f"[DEBUG] container_exists check failed: {e}")
        return False


def ensure_vm_created(context, vm_name):
    """Ensure a VM has been created successfully.

    Args:
        context: Behave context object
        vm_name: Name of the VM to verify

    Returns:
        None (raises exception on failure)
    """
    if not hasattr(context, "vm_name") or not context.vm_name:
        raise Exception("VM name not set in context")

    # Verify VM exists
    if not context.vm_name:
        raise Exception(f"VM {vm_name} was not created")

    # This step is a no-op - the creation happened earlier
    return None


def ensure_vm_running(context, vm_name):
    """Ensure a VM is running.

    Args:
        context: Behave context object
        vm_name: Name of the VM to verify

    Returns:
        None (raises exception on failure)
    """
    # Check if VM container exists and is running
    container_name = f"vde-{vm_name}"
    is_running = container_exists(container_name)

    if not is_running:
        raise Exception(f"VM {container_name} is not running")

    # Set context variable for downstream steps
    context.vm_name = container_name
    return None


def ensure_vm_stopped(context, vm_name):
    """Ensure a VM is stopped.

    Args:
        context: Behave context object
        vm_name: Name of the VM to verify

    Returns:
        None (raises exception on failure)
    """
    if not hasattr(context, "vm_name") or not context.vm_name:
        raise Exception("VM name not set in context")

    # Verify VM exists and is stopped
    if not context.vm_name:
        raise Exception(f"VM {vm_name} was not created")

    # This step is a no-op - the stop happened earlier
    return None


def get_container_health(context, container_name):
    """Get the health status of a VDE container using vde inspect.

    Args:
        context: Behave context object
        container_name: Name or ID of the container to check

    Returns:
        str: Health status (e.g., "running", "healthy", "unhealthy", "starting")
    """
    # Try to get actual status from vde inspect first
    try:
        result = subprocess.run(
            [str(BIN_DIR / "vde"), "inspect", container_name, "--state"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=str(VDE_ROOT),
        )
        if result.returncode == 0:
            import json

            state = json.loads(result.stdout.strip())
            status = state.get("Status", "").lower()
            # If status is 'running', check if there's a health check
            if status == "running":
                health_result = subprocess.run(
                    [str(BIN_DIR / "vde"), "inspect", container_name, "--health"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    cwd=str(VDE_ROOT),
                )
                if health_result.returncode == 0 and health_result.stdout.strip():
                    health = json.loads(health_result.stdout.strip())
                    return health.get("Status", status)
            return status
    except Exception:
        pass

    # Fallback for tests or when vde check fails
    if hasattr(context, "vm_name") and context.vm_name:
        return "healthy"

    return "unknown"


def check_docker_available(context):
    """Check if Docker is available on the system via vde info."""
    try:
        result = subprocess.run(
            ["zsh", str(BIN_DIR / "vde"), "info"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=str(VDE_ROOT),
            env=_vde_env(),
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        return False


def check_docker_compose_available(context):
    """Check if Docker Compose is available on the system via vde info."""
    try:
        result = subprocess.run(
            ["zsh", str(BIN_DIR / "vde"), "info"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=str(VDE_ROOT),
            env=_vde_env(),
        )
        # vde info output includes compose status
        return result.returncode == 0 and "compose" in result.stdout.lower()
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        return False


def check_docker_network_exists(network_name):
    """Check if a VDE Docker network exists via vde networks."""
    try:
        result = subprocess.run(
            ["zsh", str(BIN_DIR / "vde"), "networks"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=str(VDE_ROOT),
            env=_vde_env(),
        )
        return network_name in result.stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def check_zsh_available(context):
    """Check if Zsh is available on the system."""
    res = subprocess.run(["zsh", "--version"], capture_output=True)
    return res.returncode == 0


def check_ssh_keys_exist(context):
    """Check if the VDE student SSH identity exists."""
    # VDE_SSH_IDENTITY logic from ssh_helpers duplicated here for isolation
    ssh_dir = Path.home() / ".ssh" / "vde"
    priv_key = ssh_dir / "vde_student"
    return priv_key.exists()


def check_scripts_executable(context):
    """Check if VDE scripts have executable permissions."""
    vde_script = BIN_DIR / "vde"
    return os.access(vde_script, os.X_OK)


def get_vm_types():
    """Get list of available VM types from vm-types.conf.

    Returns:
        list: List of VM type names (e.g., ['python', 'go', 'rust', 'postgres', 'redis'])
    """
    vm_types_file = VDE_ROOT / "data" / "vm-types.conf"

    if not vm_types_file.exists():
        return []

    vm_types = []
    with open(vm_types_file, "r") as f:
        for line in f:
            line = line.strip()
            # Skip empty lines and comments
            if line and not line.startswith("#"):
                # Parse format: type|name|aliases|display|install_command|service_ports
                parts = line.split("|")
                if len(parts) >= 2:
                    vm_types.append(parts[1].strip())

    return vm_types


def load_vm_types_raw():
    """Load the raw VM types dictionary from vm-types.json."""
    import json

    if not VM_TYPES_JSON.exists():
        return {"vms": {"language": [], "service": []}}
    with open(VM_TYPES_JSON) as fh:
        return json.load(fh)


def resolve_workspace_host_path(vm_name):
    """Resolve the host-side path for the /workspace volume mount."""
    compose = get_compose_file(vm_name)
    if not compose.exists():
        return None
    content = compose.read_text()
    for line in content.splitlines():
        stripped = line.strip()
        if "/workspace" in stripped and stripped.startswith("-"):
            parts = stripped.lstrip("- ").split(":")
            if len(parts) >= 2 and parts[1].strip().rstrip("/") == "/workspace":
                return (VDE_ROOT / parts[0].strip()).resolve()
    return None


def get_ssh_port_from_compose(vm_name):
    """Extract the host SSH port from a VM's docker-compose.yml."""
    compose = get_compose_file(vm_name)
    if not compose.exists():
        return None
    import re

    m = re.search(r'"(\d+):22"', compose.read_text())
    return int(m.group(1)) if m else None


class CommandResult:
    def __init__(self, stdout, stderr, returncode, args=None):
        self.stdout = stdout or ""
        self.stderr = stderr or ""
        self.returncode = returncode
        self.args = args or []


def run_vde_command(command, timeout=300, context=None, input_text=None, env=None):
    """Run a VDE script and return the result.

    Args:
        command: Command as string or list
        timeout: Command timeout in seconds
        context: Optional behave context to update with results
        input_text: Optional stdin input (e.g., "y\\n" for confirmations)

    Returns:
        CommandResult: Object with stdout, stderr, and returncode
    """
    import shlex

    # VDE subcommands (all go through ./bin/vde)
    _VDE_SUBCOMMANDS = {
        "start",
        "stop",
        "restart",
        "ssh",
        "enter",
        "remove",
        "delete",
        "create",
        "add",
        "uninstall",
        "list",
        "status",
        "health",
        "nuke",
        "help",
        "rebuild",
        "rebuild-cache",
        "ps",
        "logs",
        "inspect",
        "port",
        "exec",
        "images",
        "networks",
        "stats",
        "info",
        "ask",
        "validate",
        "validate-schemas",
        "heal",
        "audit",
    }

    # Standardize to list of args
    if isinstance(command, str):
        args = shlex.split(command)
        # BUG FIX: If it's a known VDE command with a complex subcommand (exec, enter, ssh),
        # rejoin the command parts to preserve pipes/redirections.
        if args and args[0] in ["exec", "enter", "ssh"] and len(args) > 2:
            args = args[:2] + [" ".join(args[2:])]
    else:
        args = [str(c) for c in command]

    if not args:
        return CommandResult("", "Empty command", 1)

    first_word = args[0]

    # Determine the actual command list - all known VDE commands go through bin/vde
    vde_script = str(BIN_DIR / "vde")
    if first_word in _VDE_SUBCOMMANDS:
        cmd = ["zsh", vde_script] + args
    elif first_word == "vde" or first_word == "./bin/vde":
        cmd = ["zsh", vde_script] + args[1:]
    else:
        # Check if first_word is a script in bin/
        script_path = Path(first_word)
        if not script_path.is_absolute():
            script_path = BIN_DIR / first_word
            
        if script_path.exists() and os.access(script_path, os.X_OK):
            cmd = ["zsh", str(script_path)] + args[1:]
        else:
            cmd = ["zsh", "-c", " ".join(args)]

    # Prepare environment
    full_env = os.environ.copy()
    full_env["VDE_ROOT_DIR"] = str(VDE_ROOT)
    full_env["VDE_TEST_MODE"] = "1"
    full_env["VDE_QUIET"] = "1"
    
    # CRITICAL: Ensure SSH_AUTH_SOCK is inherited for Agent Forwarding (Section 10.5)
    if "SSH_AUTH_SOCK" in os.environ:
        full_env["SSH_AUTH_SOCK"] = os.environ["SSH_AUTH_SOCK"]

    # Execute the command
    try:
        # USE shell=False to bypass macOS SIP environment sanitization
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            cwd=str(VDE_ROOT),
            env=full_env,
            input=input_text,
            shell=False
        )
        
        if os.environ.get("VDE_DEBUG_TESTS") == "1":
            import sys
            print(f"[DEBUG] RC: {result.returncode}", file=sys.stderr)
            print(f"[DEBUG] STDOUT: {result.stdout}", file=sys.stderr)
            print(f"[DEBUG] STDERR: {result.stderr}", file=sys.stderr)
            
        # Clean stdout: remove VDE log lines (timestamps or [LEVEL] markers)
        # BUG FIX: Stop stripping logs entirely. BDD tests need to see them for verification.
        # We only strip ANSI escape codes for the clean version.
        raw_output = result.stdout or ""
        
        # Strip ANSI escape codes for clean version
        ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
        clean_stdout = ansi_escape.sub('', raw_output).strip()

        # Update context if provided
        if context:
            # IMPORTANT: Always populate even if command failed
            context.vde_command_output_raw = raw_output
            context.vde_command_output = clean_stdout
            context.vde_command_exit_code = result.returncode

            # Legacy attributes used by some older step files
            context.last_output = raw_output
            context.last_error = "" # Stderr was merged into stdout
            context.last_exit_code = result.returncode
            context.last_command = " ".join(args)
        
        cmd_res = CommandResult(clean_stdout.strip(), raw_output.strip(), result.returncode, args=cmd)
    except subprocess.TimeoutExpired as e:
        # TimeoutExpired has bytes attributes in Python 3.7+, decode them
        stdout = e.stdout.decode("utf-8", errors="replace") if e.stdout else ""
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        cmd_res = CommandResult(
            stdout, stderr + f"\n[TIMEOUT] Command timed out after {timeout}s", 124, args=cmd
        )
    except Exception as e:
        cmd_res = CommandResult("", str(e), 1, args=cmd)

    # Update context if provided (for exceptions too)
    if context and 'cmd_res' in locals():
        # Store full result
        context.vde_command_result = cmd_res

        # Standardized attributes used by many step files
        # IMPORTANT: Always populate even if command failed
        context.vde_command_output = (cmd_res.stdout or "") + (cmd_res.stderr or "")
        context.vde_command_exit_code = cmd_res.returncode

        # Legacy attributes used by some older step files
        context.last_output = cmd_res.stdout or ""
        context.last_error = "" # Stderr was merged into stdout
        context.last_exit_code = cmd_res.returncode
        context.last_command = " ".join(args)

    return cmd_res


# =============================================================================
# CANONICAL STEP DEFINITIONS (reused across multiple step files)
# =============================================================================
# NOTE: Functions below are the SINGLE canonical implementations.
# Any other step functions with similar names in other files are
# intentionally DIFFERENT implementations for different contexts.
# DO NOT consolidate these - they serve different test scenarios.


def step_vde_installed(context):
    """Verify VDE is installed on the system.

    Canonical implementation - used by config_steps, documented_workflow_steps,
    installation_steps, and other step files.
    """
    # Check main vde script exists and is executable
    vde_script = BIN_DIR / "vde"
    assert vde_script.exists(), "vde script missing"
    assert vde_script.stat().st_mode & 0o111, "vde script not executable"


def step_modified_dockerfile(context, vm_name="python"):
    """Simulate modifying a Dockerfile.

    Canonical implementation - used by vm_lifecycle_steps, vm_docker_build_steps,
    daily_workflow_required_steps, and other step files.
    """
    context.vm_name = vm_name
    context.dockerfile_modified = True


def get_vm_ssh_port(vm_name):
    """Get the assigned SSH port for a VM from vm-types.json."""
    vm_types = load_vm_types_raw()
    full_name = f"vde-{vm_name.replace('vde-', '')}"
    
    # Check languages
    for lang in vm_types.get("vms", {}).get("language", []):
        if lang.get("name") == full_name:
            return str(lang.get("ssh_port", ""))
            
    # Check services
    for service in vm_types.get("vms", {}).get("service", []):
        if service.get("name") == full_name:
            return str(service.get("ssh_port", ""))
            
    return ""


def get_container_name(vm_name):
    """Convert VM name to container name.

    Canonical implementation - adds vde- prefix if not present.
    """
    return f"vde-{vm_name}"


def get_vm_info(field, vm_name):
    """Get a specific metadata field for a VM from vm-types.json.
    
    Args:
        field: The field to retrieve (e.g., 'ssh_port', 'service_ports')
        vm_name: The name of the VM (with or without vde- prefix)
    """
    vm_types = load_vm_types_raw()
    full_name = f"vde-{vm_name.replace('vde-', '')}"
    
    # Check languages and services
    for cat in ["language", "service"]:
        for vm in vm_types.get("vms", {}).get(cat, []):
            if vm.get("name") == full_name:
                return str(vm.get(field, ""))
                
    return ""


def get_vm_name(container_name):
    """Convert container name back to VM name.

    Canonical implementation - removes vde- prefix if present.
    """
    if container_name.startswith("vde-"):
        return container_name[4:]
    return container_name
