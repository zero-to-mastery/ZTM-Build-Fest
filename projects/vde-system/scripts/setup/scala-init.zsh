#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE USP Hydration Script: scala
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
typeset vde_scala_pkgs="curl git unzip zip default-jdk scala"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_scala_pkgs}

# 3. SBT INSTALLATION (Hardened Source)
if ! command -v sbt >/dev/null 2>&1; then
    echo "[VDE-SCALA] Installing SBT..."
    echo "deb https://repo.scala-sbt.org/scalasbt/debian all main" | tee /etc/apt/sources.list.d/sbt.list
    echo "deb https://repo.scala-sbt.org/scalasbt/debian /" | tee /etc/apt/sources.list.d/sbt_old.list
    curl -sL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x2EE0EA64E40A89B84B2DF73499E82A75642AC823" | gpg --dearmor | tee /etc/apt/trusted.gpg.d/sbt.gpg > /dev/null
    apt-get update
    apt-get install -y sbt
fi

# 4. PURGING THE GHOSTS (Rule 12.5)
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
vde_purge_ghosts
