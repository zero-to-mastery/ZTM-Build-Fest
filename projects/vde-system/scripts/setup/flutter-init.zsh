#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE USP Hydration Script: flutter
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
typeset vde_flutter_pkgs="curl git xz-utils zip unzip libglu1-mesa"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_flutter_pkgs}

# 3. FLUTTER SDK INSTALLATION (Hardened Home)
typeset dev_home="/home/devuser"
mkdir -p "${dev_home}"

if [[ ! -d "${dev_home}/flutter" ]]; then
    echo "[VDE-FLUTTER] Cloning Flutter SDK..."
    # Clone as root into devuser home, then fix ownership
    git clone https://github.com/flutter/flutter.git "${dev_home}/flutter"
fi

# 4. PERSISTENCE ANCHOR
typeset _zshenv="${dev_home}/.zshenv"
{
    echo 'export PATH="${PATH}:${HOME}/flutter/bin"'
} >> "${_zshenv}"

# Set ownership for the whole home directory to ensure devuser has access
chown -R devuser:devuser "${dev_home}"

# 5. PURGING THE GHOSTS (Rule 12.5)
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
vde_purge_ghosts
