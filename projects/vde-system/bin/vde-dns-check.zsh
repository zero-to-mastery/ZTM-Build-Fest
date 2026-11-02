#!/usr/bin/env zsh
# @armor (Engine Core)
# ZSH-native shibboleth: ${(%):-%x}
#===============================================================================
# vde-dns-check - Verify cross-Spoke DNS resolution within vde-net
# Usage: vde-dns-check <source_vm> <target_vm> [port]
#===============================================================================

set -e

# Establish context
VDE_ROOT_DIR="${0:h:h}"
export VDE_ROOT_DIR

# Source libraries
source "${VDE_ROOT_DIR}/lib/vde-shell-compat"
source "${VDE_ROOT_DIR}/lib/vde-constants"
source "${VDE_ROOT_DIR}/lib/vde-log"
source "${VDE_ROOT_DIR}/lib/vde-naming"
source "${VDE_ROOT_DIR}/lib/vm-common"

# Parse arguments
SOURCE_VM="${1}"
TARGET_VM="${2}"
TARGET_PORT="${3:-22}"

if [[ -z "${SOURCE_VM}" || -z "${TARGET_VM}" ]]; then
    echo "Usage: vde dns-check <source_vm> <target_vm> [port]"
    exit ${VDE_ERR_INVALID_INPUT}
fi

# Resolve canonical names
SRC_CANONICAL=$(resolve_vm_name "${SOURCE_VM}" 2>/dev/null)
TGT_CANONICAL=$(resolve_vm_name "${TARGET_VM}" 2>/dev/null)

vde_log_info "Initiating DNS Handshake: ${SRC_CANONICAL} -> ${TGT_CANONICAL} (Port: ${TARGET_PORT})..." "dns"

# 1. ICMP Handshake (Alias)
vde_log_info "Probing ICMP resolution for alias '${TARGET_VM}'..." "dns"
if docker exec "${SRC_CANONICAL}" ping -c 2 "${TARGET_VM}" >/dev/null 2>&1; then
    vde_log_success "ICMP Handshake (Alias) Verified." "dns"
else
    vde_log_error "ICMP Handshake (Alias) FAILED." "dns"
    exit 1
fi

# 2. ICMP Handshake (Canonical)
vde_log_info "Probing ICMP resolution for canonical '${TGT_CANONICAL}'..." "dns"
if docker exec "${SRC_CANONICAL}" ping -c 2 "${TGT_CANONICAL}" >/dev/null 2>&1; then
    vde_log_success "ICMP Handshake (Canonical) Verified." "dns"
else
    vde_log_error "ICMP Handshake (Canonical) FAILED." "dns"
    exit 1
fi

# 3. Service Bridge Handshake (TCP)
vde_log_info "Probing TCP bridge to ${TGT_CANONICAL}:${TARGET_PORT}..." "dns"
if docker exec "${SRC_CANONICAL}" nc -zv "${TARGET_VM}" "${TARGET_PORT}" >/dev/null 2>&1; then
    vde_log_success "Service Bridge (TCP) Verified." "dns"
else
    vde_log_error "Service Bridge (TCP) FAILED." "dns"
    exit 1
fi

vde_log_success "Sovereign Bridge DNS Certification: PASS." "dns"
exit ${VDE_SUCCESS}
