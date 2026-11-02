#!/usr/bin/env zsh
# @armor (Engine Core)
# Forged in Beskar: vde-lua
set -e
export DEBIAN_FRONTEND=noninteractive
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
source "${VDE_ROOT_DIR}/lib/vde-log" || { echo "CRITICAL: vde-log library missing" >&2; exit 1; }

vde_log_info "Igniting Lua environment..."
sudo apt-get update && sudo apt-get install -y lua5.4 luarocks

# PURGING THE GHOSTS (Rule 12.5)
vde_purge_ghosts
