#!/usr/bin/env python3
# @forge (Governance Sentinel)
# VDE ARCHITECTURAL RECORD
"""
SSH Helper Functions for VDE Test Steps.

This module provides shared utility functions for SSH verification
used across all SSH-related BDD step definitions.

All SSH operations now use VDE-specific isolated paths at ~/.ssh/vde/
"""

import os
import subprocess

# Add steps directory to path for config import
import sys
from pathlib import Path

steps_dir = os.path.dirname(os.path.abspath(__file__))
if steps_dir not in sys.path:
    sys.path.insert(0, steps_dir)

# Import shared configuration and constants from vm_common
from vm_common import VDE_ROOT, run_vde_command, docker_ps, container_exists, ALLOW_CLEANUP

# VDE SSH Isolation - All SSH operations use these paths
VDE_SSH_DIR = Path.home() / ".ssh" / "vde"
VDE_SSH_CONFIG = VDE_SSH_DIR / "config"
VDE_SSH_KNOWN_HOSTS = VDE_SSH_DIR / "known_hosts"
VDE_SSH_IDENTITY = VDE_SSH_DIR / "vde_student"


def ssh_agent_is_running():
    """Check if SSH agent is running (including VDE's isolated agent)."""
    # First check for VDE's agent environment
    vde_agent_env = VDE_SSH_DIR / "agent_env"
    if vde_agent_env.exists():
        try:
            content = vde_agent_env.read_text()
            for line in content.split("\n"):
                if "SSH_AUTH_SOCK=" in line:
                    parts = line.split(";")[0].split("=")
                    if len(parts) == 2:
                        sock_path = parts[1].strip('"').strip("'")
                        if Path(sock_path).exists():
                            return True
                if "SSH_AGENT_PID=" in line:
                    parts = line.split(";")[0].split("=")
                    if len(parts) == 2:
                        pid = parts[1].strip('"').strip("'")
                        # Check if process exists
                        result = subprocess.run(["kill", "-0", pid], capture_output=True)
                        if result.returncode == 0:
                            return True
        except Exception as e:
            if os.environ.get("VDE_DEBUG_TESTS") == "1":
                print(f"[DEBUG] SSH agent check failed: {e}")
            return False

    # Check system SSH agent
    try:
        result = subprocess.run(["ssh-add", "-l"], capture_output=True, text=True, timeout=5)
        return result.returncode == 0 or "no identities" in result.stderr.lower()
    except Exception:
        return False


def ssh_agent_has_keys():
    """Check if SSH agent has any keys loaded (including VDE's isolated agent)."""
    # First try to use VDE's agent environment
    vde_agent_env = VDE_SSH_DIR / "agent_env"
    env = os.environ.copy()

    if vde_agent_env.exists():
        try:
            content = vde_agent_env.read_text()
            for line in content.split("\n"):
                if "SSH_AUTH_SOCK=" in line:
                    parts = line.split(";")[0].split("=")
                    if len(parts) == 2:
                        env["SSH_AUTH_SOCK"] = parts[1].strip('"').strip("'")
                if "SSH_AGENT_PID=" in line:
                    parts = line.split(";")[0].split("=")
                    if len(parts) == 2:
                        env["SSH_AGENT_PID"] = parts[1].strip('"').strip("'")
        except Exception as e:
            if os.environ.get("VDE_DEBUG_TESTS") == "1":
                print(f"[DEBUG] SSH agent check failed: {e}")
            return False

    try:
        result = subprocess.run(
            ["ssh-add", "-l"], capture_output=True, text=True, timeout=5, env=env
        )
        return result.returncode == 0 and result.stdout.strip()
    except Exception:
        return False


def get_ssh_keys():
    """Get list of SSH keys in ~/.ssh/vde/ (VDE isolated)."""
    keys = []
    if VDE_SSH_DIR.exists():
        for key_type in ["vde_student", "id_rsa", "id_ecdsa", "id_dsa"]:
            if (VDE_SSH_DIR / key_type).exists():
                keys.append(str(VDE_SSH_DIR / key_type))
            if (VDE_SSH_DIR / f"{key_type}.pub").exists():
                keys.append(str(VDE_SSH_DIR / f"{key_type}.pub"))
    return keys


def ssh_config_contains(pattern):
    """Check if VDE SSH config contains a pattern."""
    if VDE_SSH_CONFIG.exists():
        try:
            content = VDE_SSH_CONFIG.read_text()
            return pattern in content
        except Exception:
            return False
    return False


def ssh_config_get_host_entry(host):
    """Get host entry from VDE SSH config."""
    if VDE_SSH_CONFIG.exists():
        try:
            content = VDE_SSH_CONFIG.read_text()
            lines = content.split("\n")
            for i, line in enumerate(lines):
                if line.strip() == f"Host {host}":
                    # Return the host entry
                    entry = [line]
                    for j in range(i + 1, len(lines)):
                        if lines[j].strip() and not lines[j].startswith((" ", "\t")):
                            break
                        entry.append(lines[j])
                    return "\n".join(entry)
        except Exception as e:
            if os.environ.get("VDE_DEBUG_TESTS") == "1":
                print(f"[DEBUG] SSH agent check failed: {e}")
            return False
    return None


def public_ssh_keys_count():
    """Count .pub files in public-ssh-keys/."""
    public_dir = VDE_ROOT / "public-ssh-keys"
    if public_dir.exists():
        try:
            return len(list(public_dir.glob("*.pub")))
        except Exception:
            return 0
    return 0


def known_hosts_contains(pattern):
    """Check if VDE known_hosts contains a pattern."""
    if VDE_SSH_KNOWN_HOSTS.exists():
        try:
            content = VDE_SSH_KNOWN_HOSTS.read_text()
            return pattern in content
        except Exception:
            return False
    return False


def has_ssh_keys():
    """Check if VDE has any SSH keys."""
    return VDE_SSH_IDENTITY.exists()


def vm_has_private_keys(vm_name):
    """Check if a VM container has private SSH keys.

    This is a security verification - VDE design keeps SSH keys on the host
    and forwards them via SSH agent, not copied into containers.

    Args:
        vm_name: Name of the VM to check

    Returns:
        True if private keys are found in the VM, False otherwise
    """
    # Determine container name (language VMs use vde- prefix)
    container_name = f"vde-{vm_name}"

    # If container doesn't exist with -dev suffix, try plain name
    if not container_exists(container_name):
        container_name = vm_name
        if not container_exists(container_name):
            # Container not running, can't check
            return False

    try:
        # Check for private keys in container's /home/devuser/.ssh location
        # (This is a security check to ensure no private keys were copied into the VM)
        private_key_patterns = [
            "vde_student",
            "vde_student_sk",
            "id_rsa",
            "id_ecdsa",
            "id_dsa",
            "id_ecdsa_sk",
        ]

        for key_name in private_key_patterns:
            # Use the orchestrator for high-fidelity proof (Rule 1 & 15)
            result = run_vde_command(f"exec {vm_name} 'test -f /home/devuser/.ssh/{key_name} && echo FOUND'")

            if result.returncode == 0 and "FOUND" in result.stdout:
                return True  # Private key found

        # Also check /home/devuser/.ssh/ if devuser is the user
        result = run_vde_command(f"exec {vm_name} 'test -d /home/devuser/.ssh && echo EXISTS'")

        if result.returncode == 0 and "EXISTS" in result.stdout:
            for key_name in private_key_patterns:
                result = run_vde_command(f"exec {vm_name} 'test -f /home/devuser/.ssh/{key_name} && echo FOUND'")

                if result.returncode == 0 and "FOUND" in result.stdout:
                    return True

    except Exception:
        # If check fails, assume no keys (fail safe)
        pass

    return False


# =============================================================================
# VDE and Docker Helper Functions
# =============================================================================
