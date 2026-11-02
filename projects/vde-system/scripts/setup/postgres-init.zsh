#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE USP Hydration Ritual: postgres
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Part of the Universal Script Parity (USP) mandate.
# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
typeset vde_postgres_pkgs="postgresql postgresql-contrib git docker.io"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_postgres_pkgs}

# Start Service for setup
service postgresql start || true

# Dynamic Path Resolution
PG_VER=$(ls /etc/postgresql | head -n 1)
PG_BASE="/etc/postgresql/${PG_VER}/main"

# Configuration Hardening
grep -q "0.0.0.0/0" "${PG_BASE}/pg_hba.conf" || \
echo "host all all 0.0.0.0/0 md5" >> "${PG_BASE}/pg_hba.conf"
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" "${PG_BASE}/postgresql.conf"

# Final Reset & Verification
service postgresql restart
pg_isready -h localhost

# 3. SPOKE IGNITION REGISTRATION
typeset _spoke_ignition="/usr/local/bin/vde-spoke-ignition.zsh"
cat <<EOF > "${_spoke_ignition}"
#!/usr/bin/env zsh
# PostgreSQL Spoke Ignition
# Forged in Beskar

if ! pg_isready -h localhost >/dev/null 2>&1; then
    echo "[VDE-POSTGRES] Igniting PostgreSQL cluster..."
    sudo service postgresql start
fi

# User & DB Creation (Idempotent Runtime Initialization)
if [[ -n "\${POSTGRES_DEV_PASSWORD}" ]]; then
    echo "[VDE-POSTGRES] Ensuring 'devuser' exists with secure credentials..."
    sudo su - postgres -c "psql -tc \"SELECT 1 FROM pg_user WHERE usename = 'devuser'\" | grep -q 1" || \
    sudo su - postgres -c "psql -c \"CREATE USER devuser WITH PASSWORD '\${POSTGRES_DEV_PASSWORD}' SUPERUSER;\""

    sudo su - postgres -c "psql -lqt | cut -d \| -f 1 | grep -qw devuser" || \
    sudo su - postgres -c "createdb -O devuser devuser"
else
    echo "[VDE-POSTGRES] WARNING: POSTGRES_DEV_PASSWORD not set. Skipping user initialization."
fi
EOF
chmod +x "${_spoke_ignition}"

# 4. PERSISTENCE ANCHOR (Hardened Bridge)
typeset dev_home=$HOME
typeset _zshenv="${dev_home}/.zshenv"
mkdir -p "${dev_home}"
touch "${_zshenv}"
# Remove legacy startup if present
sed -i "/postgresql start/d" "${_zshenv}"
# Ensure bridge identity is available
grep -q "SSH_AUTH_SOCK" "${_zshenv}" || {
    echo "export SSH_AUTH_SOCK=${dev_home}/.ssh/vde/agent.sock" >> "${_zshenv}"
}
chown devuser:devuser "${_zshenv}"

# Stop service to maintain BTO state
service postgresql stop || true

# 5. PURGING THE GHOSTS (Rule 12.5)
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
vde_purge_ghosts
