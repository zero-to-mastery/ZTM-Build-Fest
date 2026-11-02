#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE USP Hydration Ritual: redis
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
typeset vde_redis_pkgs="redis-server redis-tools git docker.io"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_redis_pkgs}

# Stop the auto-started service to prepare for configuration
service redis-server stop || true
pkill redis-server || true

# Configure Redis for inter-VM communication
sed -i 's/^bind .*/bind 0.0.0.0/' /etc/redis/redis.conf
sed -i 's/^protected-mode yes/protected-mode no/' /etc/redis/redis.conf

# 3. SPOKE IGNITION REGISTRATION
typeset _spoke_ignition="/usr/local/bin/vde-spoke-ignition.zsh"
cat <<EOF > "${_spoke_ignition}"
#!/usr/bin/env zsh
# Redis Spoke Ignition
# Forged in Beskar

if ! pgrep -x "redis-server" >/dev/null; then
    echo "[VDE-REDIS] Igniting Redis server..."
    /usr/bin/redis-server /etc/redis/redis.conf --daemonize yes
fi
EOF
chmod +x "${_spoke_ignition}"

# 4. PERSISTENCE ANCHOR (Hardened Bridge)

typeset dev_home="/home/devuser"
typeset _zshenv="${dev_home}/.zshenv"
mkdir -p "${dev_home}"
touch "${_zshenv}"
# Remove legacy startup if present
sed -i "/redis-server/d" "${_zshenv}"
# Ensure bridge identity is available
grep -q "SSH_AUTH_SOCK" "${_zshenv}" || {
    echo "export SSH_AUTH_SOCK=${dev_home}/.ssh/vde/agent.sock" >> "${_zshenv}"
}
chown devuser:devuser "${_zshenv}"

# Stop service to maintain BTO state
service redis-server stop || true
pkill redis-server || true

# 5. PURGING THE GHOSTS (Rule 12.5)
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
vde_purge_ghosts
