#!/usr/bin/env zsh
# @armor (Engine Core)
VDE_ROOT_DIR="${0:a:h:h:h}"
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-log"
source "${VDE_ROOT_DIR}/lib/vm-common"

# Ensure technical integrity
load_vm_types

typeset -a all_vms
all_vms=(${lang_vms[@]} ${service_vms[@]})

vde_log_info "Initiating Great Re-forging (${#all_vms[@]} Spokes)..." "forge"

for vm in "${all_vms[@]}"; do
    vde_log_info "Re-forging: ${vm}" "forge"
    if "${VDE_ROOT_DIR}/bin/vde" rebuild --no-cache "${vm}" >/dev/null 2>&1; then
        vde_log_success "${vm} HARDENED." "forge"
    else
        vde_log_error "${vm} FRACTURED during re-forge." "forge"
        exit 1
    fi
done

vde_log_success "Absolute Matrix Re-forging: PASS. Foundations synchronized." "forge"
