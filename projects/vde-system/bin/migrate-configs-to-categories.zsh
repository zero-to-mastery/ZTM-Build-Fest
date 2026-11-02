#!/usr/bin/env zsh
# @armor (Engine Core)
# migrate-configs-to-categories.zsh - Reorganize VDE configs into languages/services
set -e
# Part of Phase P Architectural Refactoring

# Reset all zsh options to defaults to avoid local var printing issues
emulate zsh

# Determine VDE root directory
VDE_SCRIPTS_DIR="${0:A:h}"
if [[ -z "${VDE_ROOT_DIR}" ]]; then
    export VDE_ROOT_DIR="${0:h:h}"
fi

# Load VDE libraries
if [[ -f "${VDE_ROOT_DIR}/lib/vm-common" ]]; then
    source "${VDE_ROOT_DIR}/lib/vm-common"
else
    echo "Error: lib/vm-common not found" >&2
    exit 1
fi

CONFIGS_ROOT="${VDE_ROOT_DIR}/configs/docker"
LANG_DIR="${CONFIGS_ROOT}/languages"
SVC_DIR="${CONFIGS_ROOT}/services"

# Portable Sed Helper (Rule G)
vde_sed_inplace() {
    local pattern="$1"
    local file="$2"
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "${pattern}" "${file}"
    else
        sed -i "${pattern}" "${file}"
    fi
}

echo "Starting configuration migration..."

# 1. Create category directories
mkdir -p "${LANG_DIR}" "${SVC_DIR}"

# 2. Load VM types (already done by sourcing vm-common)
# Iterate through all known VMs and move them
for vm in ${(k)VM_TYPE}; do
    type="${VM_TYPE[$vm]}"
    raw_name="${vm#vde-}"
    
    old_path="${CONFIGS_ROOT}/${raw_name}"
    
    # Only move if the directory exists and is NOT a category directory
    if [[ -d "${old_path}" ]] && [[ "${raw_name}" != "languages" ]] && [[ "${raw_name}" != "services" ]]; then
        target_parent=""
        if [[ "${type}" == "lang" ]]; then
            target_parent="${LANG_DIR}"
        elif [[ "${type}" == "service" ]]; then
            target_parent="${SVC_DIR}"
        fi
        
        if [[ -n "${target_parent}" ]]; then
            new_path="${target_parent}/${raw_name}"
            
            # Skip if already in the new structure (idempotency)
            if [[ "${old_path}" == "${new_path}" ]]; then
                continue
            fi
            
            echo "Moving ${raw_name} (${type}) -> ${new_path#${VDE_ROOT_DIR}/}"
            
            # Move directory
            mv "${old_path}" "${new_path}"
            
            # Update docker-compose.yml relative paths
            compose_file="${new_path}/docker-compose.yml"
            if [[ -f "${compose_file}" ]]; then
                echo "  Updating paths in ${compose_file#${VDE_ROOT_DIR}/}"
                # Replace ../../../ with ../../../../
                # Use a specific pattern to avoid over-replacing
                if grep -q "\.\.\/\.\.\/\.\.\/" "${compose_file}" && ! grep -q "\.\.\/\.\.\/\.\.\/\.\.\/" "${compose_file}"; then
                    vde_sed_inplace 's|\.\./\.\./\.\./|\.\./\.\./\.\./\.\./|g' "${compose_file}"
                fi
            fi
        fi
    fi
done

echo "Migration complete!"
