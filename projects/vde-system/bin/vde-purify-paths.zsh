#!/usr/bin/env zsh
# @forge (Sovereign Path Purifier)

# This script performs the mass path purification across the VDE ecosystem.
# It replaces absolute path derivation logic with relative derivation logic.

# Purify bin/ scripts ($0 based)
for f in bin/**/*(N); do
  [[ ! -f "$f" ]] && continue
  [[ "$f" == "bin/vde-purify-paths.zsh" ]] && continue
  
  # Replace standard pattern
  sed -i "" 's/VDE_ROOT_DIR="\${0:a:h:h}"/VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
  sed -i "" 's/export VDE_ROOT_DIR="\${0:a:h:h}"/export VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
  
  # Modernize legacy patterns
  sed -i "" 's/VDE_ROOT_DIR="\$(cd "\${VDE_SCRIPTS_DIR}\/.." \&\& pwd)"/VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
  sed -i "" 's/VDE_ROOT_DIR="\$(cd "\$(dirname "$0")\/.." \&\& pwd)"/VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
  sed -i "" 's/VDE_ROOT_DIR="\$(cd "\$(dirname "\$0")\/.." \&\& pwd)"/VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
  sed -i "" 's/VDE_ROOT_DIR="\$(cd "\$(dirname "\${0}")\/.." \&\& pwd)"/VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
  sed -i "" 's/export VDE_ROOT_DIR="\${VDE_SCRIPTS_DIR:h}"/export VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
  sed -i "" 's/VDE_ROOT_DIR="\${VDE_BIN_DIR:h}"/VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
  sed -i "" 's/VDE_ROOT_DIR="\$(cd "\$(dirname "\${_VDE_CORE_SCRIPT_PATH}")\/.." \&\& pwd)"/VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
  sed -i "" 's/_VDE_CORE_SCRIPT_PATH="\${(%):-%x}"/_VDE_CORE_SCRIPT_PATH="\${0}"/g' "$f"
  
  # Special case for .
  sed -i "" 's/VDE_ROOT_DIR="."/VDE_ROOT_DIR="\${0:h:h}"/g' "$f"
done

# Purify lib/ scripts (%x based)
for f in lib/**/*(N); do
  [[ ! -f "$f" ]] && continue
  # Replace standard pattern
  sed -i "" 's/VDE_ROOT_DIR="\${\${(%):-%x}:a:h:h}"/VDE_ROOT_DIR="\${\${(%):-%x}:h:h}"/g' "$f"
  sed -i "" 's/export VDE_ROOT_DIR="\${\${(%):-%x}:a:h:h}"/export VDE_ROOT_DIR="\${\${(%):-%x}:h:h}"/g' "$f"
  
  # Modernize legacy patterns
  sed -i "" 's/VDE_ROOT_DIR="\$(cd "\$(dirname "\${_VDE_PATH_UTILS_SCRIPT_PATH}")\/.." \&\& pwd)"/VDE_ROOT_DIR="\${\${(%):-%x}:h:h}"/g' "$f"
  sed -i "" 's/VDE_ROOT_DIR="\$(cd "\$(dirname "\${_vde_templates_source}")\/.." \&\& pwd)"/VDE_ROOT_DIR="\${\${(%):-%x}:h:h}"/g' "$f"
  
  # Handle special cases in lib/ (some use $0 erroneously or need specific anchors)
  sed -i "" 's/VDE_ROOT_DIR="\${0:a:h:h}"/VDE_ROOT_DIR="\${\${(%):-%x}:h:h}"/g' "$f"
  sed -i "" 's/VDE_ROOT_DIR="."/VDE_ROOT_DIR="\${\${(%):-%x}:h:h}"/g' "$f"
done

echo "Path purification complete."
