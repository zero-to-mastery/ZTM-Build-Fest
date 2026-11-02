#!/usr/bin/env zsh
# @armor (Engine Core)
# VDE USP Hydration Script: elixir
# ZSH-native shibboleth (Rule 1)
typeset _ZSH_PURE=${(%):-%x}

# Part of the Universal Script Parity (USP) mandate.
# Forged in Beskar
set -e

# 1. THE PACKAGE ALLOY
export DEBIAN_FRONTEND=noninteractive
typeset vde_elixir_pkgs="git curl build-essential libssl-dev automake autoconf libncurses5-dev unzip wget locales ca-certificates docker.io"

# 2. THE FORGE WORK
apt-get update
apt-get install -y ${=vde_elixir_pkgs}

# Generate Locales
locale-gen en_US.UTF-8

# Installation for devuser
typeset dev_home=$HOME
INSTALL_SCRIPT="/tmp/install-elixir-as-devuser.sh"
cat <<EOF > "${INSTALL_SCRIPT}"
#!/usr/bin/env zsh
set -e
if [[ ! -d "\$HOME/.asdf" ]]; then
    git clone https://github.com/asdf-vm/asdf.git "\$HOME/.asdf" --branch v0.14.0
fi
source "\$HOME/.asdf/asdf.sh"
asdf plugin add erlang || true
asdf plugin add elixir || true
asdf install erlang 26.2.1
asdf global erlang 26.2.1
asdf install elixir 1.16.0-otp-26
asdf global elixir 1.16.0-otp-26
EOF

chmod +x "${INSTALL_SCRIPT}"
su - devuser -c "${INSTALL_SCRIPT}"

# 3. PERSISTENCE ANCHOR
typeset _zshenv="${dev_home}/.zshenv"
mkdir -p ${dev_home}
touch "${_zshenv}"
grep -q "asdf.sh" "${_zshenv}" || {
    echo 'source $HOME/.asdf/asdf.sh' >> "${_zshenv}"
    echo 'export LANG=en_US.UTF-8' >> "${_zshenv}"
}
chown devuser:devuser "${_zshenv}"

# 4. PURGING THE GHOSTS (Rule 12.5)
export VDE_ROOT_DIR="${VDE_ROOT_DIR:-${0:a:h:h:h}}"
source "${VDE_ROOT_DIR}/lib/vde-core" || { echo "CRITICAL: vde-core library missing" >&2; exit 1; }
vde_purge_ghosts
rm -f "${INSTALL_SCRIPT}"
