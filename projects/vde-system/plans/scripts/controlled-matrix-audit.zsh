#!/usr/bin/env zsh
# @forge (Audit Engine)
VDE_ROOT_DIR="$(pwd)"
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-log"
source "${VDE_ROOT_DIR}/lib/vm-common"

# Ensure technical integrity
load_vm_types

typeset -a all_vms
all_vms=(${lang_vms[@]} ${service_vms[@]})

AUDIT_LOG="${VDE_ROOT_DIR}/plans/matrix-audit-report.md"
echo "# Matrix Audit Report: $(date)" > "${AUDIT_LOG}"
echo "## Sovereign Baseline: 1.5.1" >> "${AUDIT_LOG}"
echo "| Spoke | Status | Details |" >> "${AUDIT_LOG}"
echo "| :--- | :--- | :--- |" >> "${AUDIT_LOG}"

vde_log_info "Starting Controlled Matrix Audit (${#all_vms[@]} Spokes)..." "audit"

for vm in "${all_vms[@]}"; do
    vde_log_info "Auditing ${vm}..." "audit"
    
    # Attempt Start
    if "${VDE_ROOT_DIR}/bin/vde" start "${vm}" > /tmp/audit_start.log 2>&1; then
        # Attempt Enter (Proof of Connection)
        if "${VDE_ROOT_DIR}/bin/vde" enter "${vm}" "echo 'Handshake'" > /tmp/audit_enter.log 2>&1; then
             echo "| ${vm} | PASS | Start and Handshake successful |" >> "${AUDIT_LOG}"
             vde_log_success "${vm} PASS" "audit"
        else
             echo "| ${vm} | FAILED | Handshake failed: $(cat /tmp/audit_enter.log | tr '\n' ' ') |" >> "${AUDIT_LOG}"
             vde_log_error "${vm} Handshake FAILED" "audit"
        fi
        
        # Cleanup
        "${VDE_ROOT_DIR}/bin/vde" stop "${vm}" > /dev/null 2>&1
    else
        echo "| ${vm} | FAILED | Start failed: $(cat /tmp/audit_start.log | tr '\n' ' ') |" >> "${AUDIT_LOG}"
        vde_log_error "${vm} Start FAILED" "audit"
    fi
    
    # Ensure cleanup
    docker rm -f "${vm}" >/dev/null 2>&1
done

vde_log_info "Audit complete. Report saved to ${AUDIT_LOG}" "audit"
