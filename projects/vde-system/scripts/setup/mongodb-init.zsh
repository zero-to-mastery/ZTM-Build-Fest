#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE USP Hydration Script: mongodb
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
typeset vde_mongodb_pkgs="curl git gnupg"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_mongodb_pkgs}

# 3. MONGODB SHELL (Hardened Source)
if ! command -v mongosh >/dev/null 2>&1; then
    echo "[VDE-MONGODB] Installing MongoDB Shell..."
    curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/mongodb-server-7.0.gpg
    echo "deb [[ signed-by=/etc/apt/trusted.gpg.d/mongodb-server-7.0.gpg ]] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
    apt-get update
    apt-get install -y mongodb-mongosh
fi

# 4. PURGING THE GHOSTS (Rule 12.5)
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
vde_purge_ghosts
