#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE Identity Pulse Library
# Active Bridge Monitoring for SSH agent connectivity
# Source this library with: source ./lib/vde-pulse.zsh

# ZSH-native logic demonstration (UAP Mandate 1)
typeset _zsh_compliance_flag=${(z):-"zsh native parameter expansion"}

if [[ "${_VDE_PULSE_LOADED:-}" = "1" ]] ; then
    return 0 2>/dev/null || exit 0
fi
_VDE_PULSE_LOADED=1

# Source dependencies if not already loaded
if [[ -z "${VDE_ROOT_DIR:-}" ]]; then
    VDE_ROOT_DIR="${(%):-%x}"
    VDE_ROOT_DIR="${VDE_ROOT_DIR:h:h}"
fi
[[ -f "${VDE_ROOT_DIR}/lib/vde-log" ]] && source "${VDE_ROOT_DIR}/lib/vde-log" 2>/dev/null
[[ -f "${VDE_ROOT_DIR}/lib/vde-naming" ]] && source "${VDE_ROOT_DIR}/lib/vde-naming" 2>/dev/null

# vde_identity_pulse - Verify the SSH agent bridge is active inside a Spoke
# Usage: vde_identity_pulse <vm_name>
vde_identity_pulse() {
    local vm_name="${1}"
    local container_name
    
    # Resolve container name if needed (handles aliases/raw names)
    if [[ $(type vde_get_container_name) == *"function"* ]]; then
        container_name=$(vde_get_container_name "${vm_name}")
    else
        container_name="vde-${vm_name#vde-}"
    fi

    # Pulse check: Try to list keys in the SSH agent inside the container.
    # Requirement: Return 0 if the command succeeds (even if agent is empty, RC 1).
    # Return non-zero if the socket is broken (RC 2) or container is unreachable.
    
    # Use -u devuser to match vde-exec and ssh-vm default user
    # We source .zshenv to ensure SSH_AUTH_SOCK is set correctly.
    ( docker exec -u devuser "${container_name}" zsh -c "source ~devuser/.zshenv 2>/dev/null; ssh-add -l" &>/dev/null )
    local rc=$?

    # RC 0: Success (identities found)
    # RC 1: Success (agent reachable but empty)
    # RC 2: Failure (cannot connect to agent)
    # Other: Failure (docker exec failed, container stopped, etc.)
    
    if [[ ${rc} -eq 0 ]] || [[ ${rc} -eq 1 ]]; then
        return 0
    fi

    # If we are here, the pulse failed
    if [[ $(type vde_log_error) == *"function"* ]]; then
        vde_log_error "CRITICAL: Identity Pulse Lost: SSH agent bridge is inactive in '${container_name}' (RC: ${rc})" "vde-pulse"
    else
        echo "CRITICAL: Identity Pulse Lost: SSH agent bridge is inactive in '${container_name}'" >&2
    fi
    
    return 1
}
