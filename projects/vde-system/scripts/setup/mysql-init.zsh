#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE USP Hydration Ritual: mysql
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
typeset vde_mysql_pkgs="default-mysql-server git docker.io"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_mysql_pkgs}

# 3. SPOKE IGNITION REGISTRATION
typeset _spoke_ignition="/usr/local/bin/vde-spoke-ignition.zsh"
cat <<EOF > "${_spoke_ignition}"
#!/usr/bin/env zsh
# MySQL Spoke Ignition
# Starts the server in the background on container start

if ! service mysql status >/dev/null 2>&1; then
    echo "[VDE-MYSQL] Forged in Beskar: Starting MySQL..."
    sudo service mysql start >/dev/null 2>&1
fi
EOF
chmod +x "${_spoke_ignition}"

# 4. PERSISTENCE ANCHOR (Hardened Bridge)
typeset dev_home=$HOME
typeset _zshenv="${dev_home}/.zshenv"
mkdir -p ${dev_home}
touch "${_zshenv}"
# Remove legacy startup if present
sed -i "/mysql start/d" "${_zshenv}"
# Ensure bridge identity is available
grep -q "SSH_AUTH_SOCK" "${_zshenv}" || {
    echo "export SSH_AUTH_SOCK=${dev_home}/.ssh/vde/agent.sock" >> "${_zshenv}"
}
chown devuser:devuser "${_zshenv}"

# Stop service to maintain BTO state
service mysql stop || true

# 5. PURGING THE GHOSTS (Rule 12.5)
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
vde_purge_ghosts
