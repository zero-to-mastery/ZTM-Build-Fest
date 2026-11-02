#!/usr/bin/env zsh
# @shared-law (Forge Component)

VDE_ROOT_DIR="${0:a:h:h}"
export VDE_ROOT_DIR

files_bin=(
    bin/vde-stats
    bin/vde-networks
    bin/nuke-vde
    bin/vde-matrix-audit.zsh
    bin/remediate-installation-ambiguity.zsh
    bin/ssh-setup
    bin/vde-enforce-uap.zsh
    bin/vde-inspect
    bin/vde-armor-heal.zsh
    bin/vde-vision
    bin/migrate-configs-to-categories.zsh
    bin/vde-init
    bin/vde-rebuild-cache
    bin/vde-cluster
    bin/generate-all-configs
    bin/vde-images
    bin/vde-tactical-sweep.zsh
    bin/vde-health
    bin/vde-port
    bin/vde-matrix-rebuild.zsh
    bin/add-vm-type
    bin/coverage.zsh
    bin/vde
    bin/vde-dns-check.zsh
    bin/vde-poll
    bin/ssh-sync
    bin/vde-rebuild
    bin/vde-path-of-the-foundling
    bin/validate-schemas.zsh
    bin/vde-logs
    bin/uninstall-vm-type
    bin/vde-info
    bin/ssh-agent-setup
    bin/vde-exec
    bin/vde-sync-version
    bin/vde-ps
    bin/vde-bootstrap
    bin/vde-check-tetrad.zsh
    bin/cleanup-ports
    bin/ssh-vm
    bin/list-vms
)

files_lib=(
    lib/vde-docker
    lib/vde-log
    lib/vde-audit
    lib/vm-common
    lib/vde-templates
    lib/vde-metrics
    lib/vde-core
    lib/vde-path-utils
    lib/vde-constants
    lib/vde-root
    lib/vde-pulse.zsh
)

# Update bin files
for f in "${files_bin[@]}"; do
    if [[ -f "$f" ]]; then
        echo "Updating $f..."
        # Replace various VDE_ROOT_DIR assignments with standardized one
        sed -i '' 's|VDE_ROOT_DIR="\${0:h:h}"|VDE_ROOT_DIR="${0:a:h:h}"|g' "$f"
        sed -i '' 's|typeset VDE_ROOT_DIR="\${0:h:h}"|VDE_ROOT_DIR="${0:a:h:h}"|g' "$f"
        sed -i '' 's|VDE_ROOT_DIR=\$(cd "\$(dirname "\$0")/.." \&\& pwd)|VDE_ROOT_DIR="${0:a:h:h}"|g' "$f"
        sed -i '' 's|VDE_ROOT_DIR=\$(cd "\$(dirname "\${_VDE_CORE_SCRIPT_PATH}")/.." \&\& pwd)|VDE_ROOT_DIR="${0:a:h:h}"|g' "$f"
        sed -i '' 's|export VDE_ROOT_DIR="\${0:h:h}"|VDE_ROOT_DIR="${0:a:h:h}"|g' "$f"
        sed -i '' 's|VDE_ROOT_DIR="\${VDE_SCRIPTS_DIR:h}"|VDE_ROOT_DIR="${0:a:h:h}"|g' "$f"
        sed -i '' 's|VDE_ROOT_DIR="\${VDE_BIN_DIR:h}"|VDE_ROOT_DIR="${0:a:h:h}"|g' "$f"

        # Ensure export VDE_ROOT_DIR is present after the assignment
        if ! grep -q "export VDE_ROOT_DIR" "$f"; then
            sed -i '' '/VDE_ROOT_DIR="${0:a:h:h}"/a\
export VDE_ROOT_DIR' "$f"
        fi
    fi
done

# Update lib files using Zsh string replacement for safety
for f in "${files_lib[@]}"; do
    if [[ -f "$f" ]]; then
        echo "Updating $f (Lib)..."
        local content=$(<"$f")
        # Handle variants with and without square brackets around %
        content="${content//VDE_ROOT_DIR=\"\${\${\(%):-%x}:h:h}\"/VDE_ROOT_DIR=\"\${\${\(%):-%x}:a:h:h}\"}"
        content="${content//VDE_ROOT_DIR=\"\${\${\[(%):-%x}:h:h}\"/VDE_ROOT_DIR=\"\${\${\(%):-%x}:a:h:h}\"}"
        printf "%s\n" "$content" > "$f"
    fi
done

echo "Update complete."
