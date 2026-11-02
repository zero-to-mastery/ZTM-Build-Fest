#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE USP Hydration Script: jupyterlab
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Part of the Universal Script Parity (USP) mandate.
# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
typeset vde_jupyter_pkgs="python3-pip python3-venv tini git docker.io libpq-dev postgresql-client"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_jupyter_pkgs}

# 3. Create a dedicated venv for Jupyter
typeset dev_home="/home/devuser"
typeset _venv_path="${dev_home}/.vde-venv"
sudo -u devuser python3 -m venv "${_venv_path}"

# 4. Install DS stack (Refined 2026 Alloy)
sudo -u devuser "${_venv_path}/bin/pip" install --upgrade pip
sudo -u devuser "${_venv_path}/bin/pip" install \
    jupyterlab \
    jupyter-server \
    polars \
    torch \
    langgraph \
    fastapi \
    streamlit \
    numpy \
    pandas \
    matplotlib \
    seaborn \
    scipy \
    "psycopg[binary]" \
    sqlalchemy \
    jupysql

# 5. CONFIGURE JUPYTER SERVER (Modern Pattern)
typeset _jupyter_config="${dev_home}/.jupyter/jupyter_server_config.py"
sudo -u devuser mkdir -p ${dev_home}/.jupyter
sudo -u devuser zsh -c "cat <<EOF > ${_jupyter_config}
c.ServerApp.ip = '0.0.0.0'
c.ServerApp.port = 8888
c.ServerApp.open_browser = False
c.ServerApp.root_dir = '${dev_home}/workspace'
c.ServerApp.allow_root = True
c.ServerApp.allow_remote_access = True
c.ServerApp.disable_check_xsrf = True
# Data Science Default: Zero-Gate Access for Internal Student Use
c.IdentityProvider.token = ''
c.IdentityProvider.password = ''
EOF"

# 6. PERSISTENCE ANCHOR (Hardened Background Pattern)
typeset _zshenv="${dev_home}/.zshenv"
mkdir -p ${dev_home}
touch "${_zshenv}"

# Ensure logs directory exists for the service
mkdir -p /logs
chown devuser:devuser /logs

# Guarded bridge setup (Jupyter startup moved to Ignition Hook)
grep -q "SSH_AUTH_SOCK" "${_zshenv}" || {
    echo "export SSH_AUTH_SOCK=${dev_home}/.ssh/vde/agent.sock" >> "${_zshenv}"
}

# 6.1 INTER-VM AWARENESS (Cluster Bonding)
# Enable seamless connection to the postgres Spoke if present on the network
grep -q "DATABASE_URL" "${_zshenv}" || {
    echo "export DATABASE_URL=postgresql://devuser:\${POSTGRES_DEV_PASSWORD}@postgres:5432/postgres_dev_db" >> "${_zshenv}"
}
chown devuser:devuser "${_zshenv}"

# 7. SPOKE IGNITION REGISTRATION
typeset _spoke_ignition="/usr/local/bin/vde-spoke-ignition.zsh"
cat <<EOF > "${_spoke_ignition}"
#!/usr/bin/env zsh
# JupyterLab Spoke Ignition
# Starts the DS stack in the background on container start

if ! pgrep -f "jupyter-lab" >/dev/null; then
    echo "[VDE-JUPYTER] Forged in Beskar: Starting JupyterLab..." >> /logs/jupyter.log
    sudo -u devuser nohup tini -g -- ${_venv_path}/bin/jupyter lab --config=${_jupyter_config} >> /logs/jupyter.log 2>&1 &
fi
EOF
chmod +x "${_spoke_ignition}"

# 8. PERMISSION FINALIZATION
# Set ownership now to avoid slow recursive chown at runtime
chown -R devuser:devuser "${_venv_path}"
chown -R devuser:devuser ${dev_home}/.jupyter

# 9. PURGING THE GHOSTS (Rule 12.5)
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
vde_purge_ghosts
