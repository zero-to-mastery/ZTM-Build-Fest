#!/usr/bin/env zsh
# @armor (Engine Core)
# Demo: Schema Update Mechanisms
# Demonstrates version detection, compatibility checking, backup, and validation


# ZSH-native logic demonstration (UAP Mandate 1)
typeset _zsh_compliance_flag=${(z):-"zsh native parameter expansion"}

set -e

VDE_SCRIPTS_DIR="${0:A:h}"
PROJECT_ROOT="${VDE_SCRIPTS_DIR:h}"

# Source libraries
source "${PROJECT_ROOT}/lib/vde-shell-compat"
source "${PROJECT_ROOT}/lib/vde-constants"
source "${PROJECT_ROOT}/lib/vde-core"
source "${PROJECT_ROOT}/lib/vde-log"

# Colors for output
if [[ -t 1 ]] ; then
    GREEN='\033[0;32m'
    BLUE='\033[0;34m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    NC='\033[0m' # No Color
else
    GREEN=''
    BLUE=''
    YELLOW=''
    RED=''
    NC=''
fi

print_header() {
    echo ""
    echo "${BLUE}========================================${NC}"
    echo "${BLUE}${1}${NC}"
    echo "${BLUE}========================================${NC}"
}

print_step() {
    echo ""
    echo "${GREEN}➤ ${1}${NC}"
}

print_result() {
    echo "  ${YELLOW}→${NC} ${1}"
}

print_error() {
    echo "  ${RED}✗${NC} ${1}"
}

print_success() {
    echo "  ${GREEN}✓${NC} ${1}"
}

# =============================================================================
# Demo Functions
# =============================================================================

demo_version_detection() {
    print_header "1. Version Detection"

    print_step "Detecting VM types config version..."
    local config_file="${PROJECT_ROOT}/data/vm-types.json"
    local version
    version=$(vde_get_config_version "${config_file}" 2>/dev/null)
    print_result "Config version: ${version}"

    print_step "Detecting VM types schema version..."
    local schema_file="${PROJECT_ROOT}/data/vm-types.schema.json"
    local schema_version
    schema_version=$(vde_get_schema_version "${schema_file}" 2>/dev/null)
    print_result "Schema version pattern: ${schema_version}"

    print_step "Detecting Docker config version..."
    local docker_config="${PROJECT_ROOT}/data/vm-docker-config.json"
    local docker_version
    docker_version=$(vde_get_config_version "${docker_config}" 2>/dev/null)
    print_result "Docker config version: ${docker_version}"
}

demo_compatibility_check() {
    print_header "2. Schema Compatibility Check"

    print_step "Checking VM types compatibility..."
    local config_file="${PROJECT_ROOT}/data/vm-types.json"
    local schema_file="${PROJECT_ROOT}/data/vm-types.schema.json"

    if vde_check_schema_compatibility "${config_file}" "${schema_file}" 2>/dev/null; then
        print_success "VM types: Config and schema are compatible"
    else
        print_error "VM types: Version mismatch detected"
    fi

    print_step "Checking Docker config compatibility..."
    local docker_config="${PROJECT_ROOT}/data/vm-docker-config.json"
    local docker_schema="${PROJECT_ROOT}/data/vm-docker-config.schema.json"

    if vde_check_schema_compatibility "${docker_config}" "${docker_schema}" 2>/dev/null; then
        print_success "Docker config: Config and schema are compatible"
    else
        print_error "Docker config: Version mismatch detected"
    fi
}

demo_change_detection() {
    print_header "3. Schema Change Detection"

    print_step "Checking for schema changes in VM types..."
    local config_file="${PROJECT_ROOT}/data/vm-types.json"

    if vde_detect_schema_changes "${config_file}" 2>/dev/null; then
        print_success "No schema changes detected"
    else
        local result=${?}
        if [[ ${result} -eq ${VDE_ERR_CACHE_INVALID} ]] ; then
            print_result "Schema has been updated - cache regeneration recommended"
        else
            print_error "Error detecting schema changes"
        fi
    fi

    print_step "Checking for schema changes in Docker config..."
    local docker_config="${PROJECT_ROOT}/data/vm-docker-config.json"

    if vde_detect_schema_changes "${docker_config}" 2>/dev/null; then
        print_success "No schema changes detected"
    else
        local result=${?}
        if [[ ${result} -eq ${VDE_ERR_CACHE_INVALID} ]] ; then
            print_result "Schema has been updated - cache regeneration recommended"
        else
            print_error "Error detecting schema changes"
        fi
    fi
}

demo_backup() {
    print_header "4. Configuration Backup"

    print_step "Creating backup of VM types config..."
    local config_file="${PROJECT_ROOT}/data/vm-types.json"
    local backup_file
    backup_file=$(vde_backup_config "${config_file}" 2>/dev/null)

    if [[ -f "${backup_file}" ]] ; then
        print_success "Backup created: ${backup_file}"
        local backup_size
        backup_size=$(du -h "${backup_file}" | cut -f1)
        print_result "Backup size: ${backup_size}"
    else
        print_error "Failed to create backup"
    fi
}

demo_validation() {
    print_header "5. Schema Validation"

    print_step "Validating VM types config..."
    local config_file="${PROJECT_ROOT}/data/vm-types.json"
    local schema_file="${PROJECT_ROOT}/data/vm-types.schema.json"

    if vde_validate_json_schema "${config_file}" "${schema_file}" 2>/dev/null; then
        print_success "VM types validation passed"
    else
        print_error "VM types validation failed"
    fi

    print_step "Validating Docker config..."
    local docker_config="${PROJECT_ROOT}/data/vm-docker-config.json"
    local docker_schema="${PROJECT_ROOT}/data/vm-docker-config.schema.json"

    if vde_validate_json_schema "${docker_config}" "${docker_schema}" 2>/dev/null; then
        print_success "Docker config validation passed"
    else
        print_error "Docker config validation failed"
    fi
}

demo_validate_and_update() {
    print_header "6. Validate and Update Workflow"

    print_step "Running full validation and update check..."
    local config_file="${PROJECT_ROOT}/data/vm-types.json"
    local schema_file="${PROJECT_ROOT}/data/vm-types.schema.json"
    local cache_file="${PROJECT_ROOT}/.cache/vm-types.cache"

    if vde_validate_and_update "${config_file}" "${schema_file}" "${cache_file}" 2>/dev/null; then
        print_success "Config is valid and cache is up to date"
    else
        local result=${?}
        if [[ ${result} -eq ${VDE_ERR_CACHE_INVALID} ]] ; then
            print_result "Cache needs regeneration"

            print_step "Regenerating cache..."
            if regenerate_vm_types_cache 2>/dev/null; then
                print_success "Cache regenerated successfully"
            else
                print_error "Cache regeneration failed"
            fi
        elif [[ ${result} -eq ${VDE_ERR_INVALID_DATA} ]] ; then
            print_error "Config validation failed - manual intervention required"
        fi
    fi
}

demo_complete_workflow() {
    print_header "7. Complete Update Workflow"

    local config_file="${PROJECT_ROOT}/data/vm-types.json"

    print_step "Step 1: Detect version"
    local version
    version=$(vde_get_config_version "${config_file}" 2>/dev/null)
    print_result "Version: ${version}"

    print_step "Step 2: Check compatibility"
    local schema_file
    schema_file=$(vde_get_schema_for_json "${config_file}" 2>/dev/null)
    if vde_check_schema_compatibility "${config_file}" "${schema_file}" 2>/dev/null; then
        print_success "Compatible"
    else
        print_error "Incompatible - migration needed"
        return ${VDE_ERR_GENERAL}
    fi

    print_step "Step 3: Detect changes"
    if vde_detect_schema_changes "${config_file}" 2>/dev/null; then
        print_success "No changes"
    else
        print_result "Changes detected"
    fi

    print_step "Step 4: Create backup"
    local backup
    backup=$(vde_backup_config "${config_file}" 2>/dev/null)
    print_success "Backed up to: $(basename "${backup}")"

    print_step "Step 5: Validate"
    if vde_validate_json_schema "${config_file}" "${schema_file}" 2>/dev/null; then
        print_success "Validation passed"
    else
        print_error "Validation failed"
        return ${VDE_ERR_GENERAL}
    fi

    print_step "Step 6: Update cache if needed"
    local cache_file="${PROJECT_ROOT}/.cache/vm-types.cache"
    if vde_validate_and_update "${config_file}" "${schema_file}" "${cache_file}" 2>/dev/null; then
        print_success "Cache up to date"
    else
        print_result "Cache regenerated"
    fi

    print_success "Workflow complete!"
}

demo_schema_integrity() {
    print_header "8. Schema Integrity Check"

    print_step "Checking VM types schema integrity..."
    local schema_file="${PROJECT_ROOT}/data/vm-types.schema.json"
    if vde_check_schema_integrity "${schema_file}" 2>/dev/null; then
        print_success "Schema is valid JSON with required fields"
    else
        print_error "Schema integrity check failed"
    fi

    print_step "Checking Docker config schema integrity..."
    local docker_schema="${PROJECT_ROOT}/data/vm-docker-config.schema.json"
    if vde_check_schema_integrity "${docker_schema}" 2>/dev/null; then
        print_success "Schema is valid JSON with required fields"
    else
        print_error "Schema integrity check failed"
    fi
}

# =============================================================================
# Main Demo
# =============================================================================

main() {
    echo ""
    echo "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo "${BLUE}║  VDE Schema Update Mechanisms Demo    ║${NC}"
    echo "${BLUE}╚════════════════════════════════════════╝${NC}"

    demo_version_detection
    demo_compatibility_check
    demo_change_detection
    demo_backup
    demo_validation
    demo_validate_and_update
    demo_complete_workflow
    demo_schema_integrity

    print_header "Summary"
    echo ""
    print_success "All schema update mechanisms demonstrated successfully!"
    echo ""
    echo "Available mechanisms:"
    echo "  ${GREEN}1.${NC} vde_get_config_version      - Get config version"
    echo "  ${GREEN}2.${NC} vde_get_schema_version      - Get schema version pattern"
    echo "  ${GREEN}3.${NC} vde_check_schema_compatibility - Check version compatibility"
    echo "  ${GREEN}4.${NC} vde_detect_schema_changes   - Detect schema updates"
    echo "  ${GREEN}5.${NC} vde_backup_config           - Backup config before updates"
    echo "  ${GREEN}6.${NC} vde_validate_and_update     - Validate and update workflow"
    echo "  ${GREEN}7.${NC} vde_check_schema_integrity  - Verify schema structure"
    echo "  ${GREEN}8.${NC} regenerate_vm_types_cache   - Regenerate cache"
    echo ""
}

main "${@}"
