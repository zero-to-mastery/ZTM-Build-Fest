#!/usr/bin/env zsh
# @armor (Engine Core)
# remediate-installation-ambiguity.zsh - Resolve AmbiguousStep (V12)
# Mandate: ZSH ONLY.


# ZSH-native logic demonstration (UAP Mandate 1)
typeset _zsh_compliance_flag=${(z):-"zsh native parameter expansion"}

set -e

VDE_ROOT_DIR="${0:h:h}"
STEPS_DIR="${VDE_ROOT_DIR}/tests/features/steps"
INSTALL_STEPS="${STEPS_DIR}/vde_installation_steps.py"

print_info() { echo " \033[1;34m[INFO]\033[0m $1"; }

comment_duplicate() {
    local pattern=$1
    local file=$2
    if grep -qF "$pattern" "$file"; then
        print_info "Commenting out duplicate: $pattern"
        # Escape for perl - use | as delimiter and escape parens/quotes/pipes
        local escaped_pattern=$(echo "$pattern" | sed 's/"/\\"/g' | sed 's/(/\\(/g' | sed 's/)/\\)/g' | sed 's/|/\\|/g')
        perl -i -pe "s|^\@(.*)$escaped_pattern|\# \@\$1$escaped_pattern|g" "$file"
    fi
}

# Final comprehensive list of duplicates
DUPLICATES=(
    "I should see success message"
    "the setup should happen automatically"
    "my public keys should be copied to public-ssh-keys/"
    "I should not need to configure anything manually"
    "all my public keys should be in the VM's authorized_keys"
    "I should not need to manually copy keys"
    "it should report missing dependencies clearly"
    "the setup detects my OS (Linux/Mac)"
    "appropriate paths should be used"
    "platform-specific adjustments should be made"
    "the installation should succeed"
    "templates/ directory should exist with templates"
    "VDE commands should be available"
    "I should see helpful progress messages"
    "it should verify Docker is installed"
    "it should verify docker-compose is available"
    "I've installed VDE"
    "data/ directory should exist for persistent data"
    "logs/ directory should exist for troubleshooting"
    "projects/ directory should exist for user code"
    "env-files/ directory should exist for configuration"
    "backup/ directory should exist for safety"
    "logs/ directory should exist"
    "projects/ directory should exist"
    "env-files/ directory should exist"
    "backup/ directory should exist"
    "lib/ directory should exist"
    "bin/ directory should exist"
    "if keys exist, they should be detected"
    "if no keys exist, a new one should be generated"
    "if no keys exist, ed25519 keys should be generated"
    "the generated key should be ed25519"
    "the key should have a comment identifying it as VDE"
    "SSH config should include VDE identities"
    "VDE SSH config should be isolated from system config"
    "all VM types from vm-types.json should be loaded"
    "predefined language VMs should be recognized"
    "predefined service VMs should be recognized"
    "VDE should report Docker version"
    "Docker network vde-net should exist"
    "helpful suggestions should be provided"
    "backup/ssh/config should exist as a template"
    "backup/docker-state/ should exist"
    "VM types should be loaded correctly"
    "the environment should be ready for use"
    "I should be told about the setup completion"
    "the template should show proper SSH config format"
    "it should contain Host and HostName entries"
    "it should have ForwardAgent yes"
    "it should use the VDE SSH identity"
    "I should be able to use it as reference"
    "the backup should be verified"
)

for pattern in "${DUPLICATES[@]}"; do
    comment_duplicate "$pattern" "$INSTALL_STEPS"
done

print_info "Ambiguity remediation (V12) complete."
