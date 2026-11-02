#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE USP Hydration Script: c
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Part of the Universal Script Parity (USP) mandate.
# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
typeset vde_c_pkgs="gcc make cmake gdb git docker.io"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_c_pkgs}

# 3. PURGING THE GHOSTS (Rule 12.5)
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
vde_purge_ghosts
