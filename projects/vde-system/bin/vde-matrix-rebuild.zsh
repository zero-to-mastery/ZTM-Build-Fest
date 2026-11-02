#!/usr/bin/env zsh
# @armor (Engine Core)
# ZSH-native shibboleth: ${(%):-%x}
# Use zsh-native absolute path detection (Rule 1)
VDE_ROOT_DIR="${0:h:h}"
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-log"
source "${VDE_ROOT_DIR}/lib/vm-common"

# Ensure technical integrity
load_vm_types

typeset -a all_vms
all_vms=(${lang_vms[@]} ${service_vms[@]})

# Resolve base image timestamp
typeset base_created=$(docker inspect -f '{{.Created}}' vde-base:latest 2>/dev/null || echo "0")

vde_log_info "Initiating Smart Re-forging (${#all_vms[@]} Spokes)..." "forge"

for vm in "${all_vms[@]}"; do
    local vm_image="${vm}:latest"
    local vm_created=$(docker inspect -f '{{.Created}}' "${vm_image}" 2>/dev/null || echo "0")

    # Rebuild if VM doesn't exist OR if base is newer than VM
    if [[ "${vm_created}" != "0" && "${vm_created}" > "${base_created}" ]]; then
        vde_log_info "Skipping ${vm} (Already HARDENED relative to current base)." "forge"
        continue
    fi

    vde_log_info "Re-forging: ${vm}..." "forge"
    if "${VDE_ROOT_DIR}/bin/vde" rebuild --no-cache "${vm}" >/dev/null 2>&1; then
        vde_log_success "${vm} HARDENED." "forge"
    else
        vde_log_error "${vm} FRACTURED during re-forge." "forge"
        exit 1
    fi
done

vde_log_success "Absolute Matrix Re-forging: PASS. All Spokes synchronized with base." "forge"
