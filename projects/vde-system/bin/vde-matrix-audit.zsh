#!/usr/bin/env zsh
# @armor (Engine Core)
VDE_ROOT_DIR="${0:h:h}"
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-log"
source "${VDE_ROOT_DIR}/lib/vm-common"

# Ensure technical integrity
load_vm_types

typeset -a all_vms
all_vms=(${lang_vms[@]} ${service_vms[@]})

vde_log_info "Starting Spoke Matrix Certification gauntlet (${#all_vms[@]} VMs)..." "audit"

for vm in "${all_vms[@]}"; do
    vde_log_info "Auditing Spoke: ${vm}" "audit"
    if "${VDE_ROOT_DIR}/bin/vde" start "${vm}" >/dev/null 2>&1; then
        vde_log_success "${vm} Verified." "audit"
        "${VDE_ROOT_DIR}/bin/vde" stop "${vm}" >/dev/null 2>&1
    else
        vde_log_error "${vm} FRACTURED during audit." "audit"
        exit 1
    fi
done

vde_log_success "Absolute Spoke Matrix Certification: PASS." "audit"
