#!/usr/bin/env zsh
# @armor (Engine Core)
#===============================================================================
# vde-tactical-sweep.zsh - Comprehensive Forge Cleanup Tool
set -e
#
# Part of the Sovereign Baseline 1.5.6.
# Mandate: Zero-Host Dependency & Zero-Ghost Persistence.
# Forged in Beskar.
#===============================================================================

# ZSH-native logic demonstration (UAP Mandate 1)
typeset _zsh_compliance_flag=${(z):-"zsh native tactical sweep"}

VDE_BIN_DIR="${0:h}"
VDE_ROOT_DIR="${0:h:h}"

# Source Constants & Errors for Protocol Integrity
[[ -f "${VDE_ROOT_DIR}/lib/vde-constants" ]] && . "${VDE_ROOT_DIR}/lib/vde-constants"
[[ -f "${VDE_ROOT_DIR}/lib/vde-log" ]] && . "${VDE_ROOT_DIR}/lib/vde-log"

# Tactical Sweep Parameters
VDE_LOCKS_VMS_DIR="${VDE_ROOT_DIR}/.locks/vms"
VDE_PORT_REGISTRY_DIR="${VDE_ROOT_DIR}/.cache/port-registry"
# VDE_DOCKER_STATE_DIR sourced from vde-constants

vde_log_info "[SWEEP] Commencing Tactical Forge Sweep..." "sweep"

# 1. THE QUENCH: Stop and Purge ALL VDE Containers
vde_log_info "[SWEEP] Purging all 'vde-' containers..." "sweep"
typeset containers
containers=($(docker ps -aq --filter "name=vde-"))

if [[ ${#containers} -gt 0 ]]; then
    # We use -f to force removal of running/paused spirits
    docker rm -f ${=containers} >/dev/null 2>&1
    vde_log_success "[SWEEP] ${#containers} Spokes quenched and purged." "sweep"
else
    vde_log_info "[SWEEP] No active Spokes detected." "sweep"
fi

# 2. THE LOCK BREAK: Clear ALL VM and global configuration locks
if [[ -d "${VDE_LOCKS_VMS_DIR}" ]]; then
    vde_log_info "[SWEEP] Breaking all VM locks..." "sweep"
    rm -rf "${VDE_LOCKS_VMS_DIR}"/*(N) 2>/dev/null
    vde_log_success "[SWEEP] VM locks cleared." "sweep"
fi

# Break global locks and queues (Phase 25/26)
if [[ -d "${VDE_ROOT_DIR}/.locks" ]]; then
    vde_log_info "[SWEEP] Breaking global configuration locks and queues..." "sweep"
    # Target specific global lock files and their .queue companions
    rm -rf "${VDE_ROOT_DIR}/.locks"/global-config.lock*(N) 2>/dev/null
    rm -rf "${VDE_ROOT_DIR}/.locks"/global-config.lock.queue*(N/) 2>/dev/null
    vde_log_success "[SWEEP] Global locks and queues purged." "sweep"
fi

# 3. THE REGISTRY PURGE: Clear ALL port reservations
if [[ -d "${VDE_PORT_REGISTRY_DIR}" ]]; then
    vde_log_info "[SWEEP] Purging port registry..." "sweep"
    rm -rf "${VDE_PORT_REGISTRY_DIR}"/*(N) 2>/dev/null
    vde_log_success "[SWEEP] Port registry at ${VDE_PORT_REGISTRY_DIR#${VDE_ROOT_DIR}/} cleared." "sweep"
fi

# 4. THE STATE PURGE: Clear ALL VM state JSON files
if [[ -d "${VDE_DOCKER_STATE_DIR}" ]]; then
    vde_log_info "[SWEEP] Purging Docker state registry..." "sweep"
    # Use (N) to avoid errors if directory is empty
    local states=("${VDE_DOCKER_STATE_DIR}"/*(N))
    if [[ ${#states} -gt 0 ]]; then
        rm -rf "${VDE_DOCKER_STATE_DIR}"/* 2>/dev/null
    fi
    vde_log_success "[SWEEP] Docker state directory at ${VDE_DOCKER_STATE_DIR#${VDE_ROOT_DIR}/} cleared." "sweep"
fi

# 5. THE TMP PURGE: Clear ephemeral artifact directory
if [[ -d "${VDE_ROOT_DIR}/.tmp" ]]; then
    vde_log_info "[SWEEP] Purging ephemeral artifacts (.tmp/)..." "sweep"
    rm -rf "${VDE_ROOT_DIR}/.tmp"/*(N) 2>/dev/null
    vde_log_success "[SWEEP] Ephemeral artifacts purged." "sweep"
fi

# 6. THE GHOST PURGE: Remove all *.bak files recursively
vde_log_info "[SWEEP] Purging all ghost files (*.bak)..." "sweep"
typeset ghost_files=("${VDE_ROOT_DIR}"/**/*.bak(N))
if [[ ${#ghost_files} -gt 0 ]]; then
    rm -f "${ghost_files[@]}" 2>/dev/null
    vde_log_success "[SWEEP] ${#ghost_files} ghost files purged." "sweep"
else
    vde_log_info "[SWEEP] No ghost files detected." "sweep"
fi

vde_log_success "[SWEEP] Tactical Sweep Complete. The Forge is Pristine." "sweep"
exit ${VDE_SUCCESS}
