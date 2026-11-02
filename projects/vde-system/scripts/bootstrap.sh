#!/usr/bin/env bash
# @armor (Engine Core)
#===============================================================================
# VDE Bootstrap - The Front Door
#
# This is the first thing a student runs. It works in bash, zsh, or any
# POSIX shell — because Zsh might not be installed yet. It does NOT install
# anything. It checks the 4 pillars, tells you exactly what's missing with
# a one-line fix for each, and once everything is present, it clones VDE
# and launches the onboarding ritual.
#
# Usage:
#   bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)
#===============================================================================
# NOTE: We intentionally do NOT use `set -e` here because check_pillar returns
# non-zero for missing pillars, and we need to check ALL pillars before exiting.
set -u
set -o pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

MISSING=0

#===============================================================================
# Detect platform
#===============================================================================
detect_platform() {
    local uname_s
    uname_s="$(uname -s 2>/dev/null || echo "unknown")"

    case "${uname_s}" in
        Darwin)
            echo "macos"
            ;;
        Linux)
            # Check for WSL
            if grep -qi "microsoft\|wsl" /proc/version 2>/dev/null; then
                echo "wsl"
            else
                echo "linux"
            fi
            ;;
        MINGW*|MSYS*|CYGWIN*)
            echo "windows"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

PLATFORM="$(detect_platform)"

#===============================================================================
# Banner
#===============================================================================
echo ""
echo -e "${BOLD}${CYAN}╔════════════════════════════════════════════════════════════╗"
echo -e "║                                                            ║"
echo -e "║              VDE - Virtual Development Environment         ║"
echo -e "║                                                            ║"
echo -e "║         Isolated dev environments. Zero setup pain.        ║"
echo -e "║                                                            ║"
echo -e "╚════════════════════════════════════════════════════════════╝${RESET}"
echo ""

#===============================================================================
# Platform detection and guidance
#===============================================================================
case "${PLATFORM}" in
    macos)
        echo -e "  Platform: ${GREEN}macOS${RESET}"
        ;;
    wsl)
        echo -e "  Platform: ${GREEN}Windows (WSL2)${RESET}"
        ;;
    linux)
        echo -e "  Platform: ${GREEN}Linux${RESET}"
        ;;
    *)
        echo -e "  Platform: ${RED}Not detected${RESET}"
        echo ""
        #=======================================================================
        # Windows without WSL2 — can't proceed. Give them the one command.
        #=======================================================================
        echo -e "  ${BOLD}You're on Windows without WSL2.${RESET}"
        echo ""
        echo "  You need a Linux environment to run VDE."
        echo "  Open ${BOLD}PowerShell as Administrator${RESET} and run:"
        echo ""
        echo -e "    ${CYAN}wsl --install${RESET}"
        echo ""
        echo "  Then restart your computer, open 'Ubuntu' from your Start menu,"
        echo "  and run this command again:"
        echo ""
        echo -e "    ${DIM}bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)${RESET}"
        echo ""
        exit 1
        ;;
esac

echo ""
echo -e "  ${BOLD}Checking the 4 pillars...${RESET}"
echo ""

#===============================================================================
# Pillar checks — one at a time, with a fix for each
#===============================================================================
check_pillar() {
    local name="$1"
    local cmd="$2"
    local version_flag="${3:---version}"
    local install_hint="$4"

    if command -v "${cmd}" >/dev/null 2>&1; then
        local ver
        ver="$(${cmd} ${version_flag} 2>&1 | head -1)"
        echo -e "  ${GREEN}✓${RESET}  ${name}  ${DIM}${ver}${RESET}"
        return 0
    else
        echo -e "  ${RED}✗${RESET}  ${name}"
        echo -e "    ${YELLOW}→${RESET} ${install_hint}"
        echo ""
        MISSING=1
        return 1
    fi
}

case "${PLATFORM}" in
    macos)
        check_pillar "Zsh"     "zsh"    "--version" "Comes with macOS. If missing: brew install zsh"
        check_pillar "Git"     "git"    "--version" "Run: xcode-select --install"
        check_pillar "Docker"  "docker" "version"   "Install Docker Desktop: https://docker.com/products/docker-desktop"
        check_pillar "SSH"     "ssh"    "-V"        "Comes with macOS. If missing: brew install openssh"
        ;;
    wsl)
        check_pillar "Zsh"     "zsh"    "--version" "Run: sudo apt update && sudo apt install zsh -y"
        check_pillar "Git"     "git"    "--version" "Run: sudo apt install git -y"
        check_pillar "Docker"  "docker" "version"   "Install Docker Desktop: https://docker.com/products/docker-desktop"
        check_pillar "SSH"     "ssh"    "-V"        "Run: sudo apt install openssh-client -y"
        ;;
    linux)
        # Try to detect the package manager for better hints
        if command -v apt >/dev/null 2>&1; then
            PKG="sudo apt install zsh git openssh-client -y"
            DOCKER_URL="https://docs.docker.com/engine/install/"
        elif command -v dnf >/dev/null 2>&1; then
            PKG="sudo dnf install zsh git openssh-clients -y"
            DOCKER_URL="https://docs.docker.com/engine/install/"
        elif command -v pacman >/dev/null 2>&1; then
            PKG="sudo pacman -S zsh git openssh"
            DOCKER_URL="https://docs.docker.com/engine/install/"
        else
            PKG="Install via your package manager: zsh, git, openssh-client"
            DOCKER_URL="https://docs.docker.com/engine/install/"
        fi

        check_pillar "Zsh"     "zsh"    "--version" "Run: ${PKG%% *}"
        check_pillar "Git"     "git"    "--version" "Run: ${PKG%% *}"
        check_pillar "Docker"  "docker" "version"   "Install: ${DOCKER_URL}"
        check_pillar "SSH"     "ssh"    "-V"        "Run: ${PKG%% *}"
        ;;
esac

#===============================================================================
# Docker daemon check — installed but not running is a common gotcha
#===============================================================================
if command -v docker >/dev/null 2>&1; then
    if ! docker info >/dev/null 2>&1; then
        echo ""
        echo -e "  ${YELLOW}⚠  Docker is installed but not running.${RESET}"
        echo -e "     ${YELLOW}→${RESET} Start Docker Desktop (or: sudo systemctl start docker)"
        echo ""
        MISSING=1
    fi
fi

#===============================================================================
# If anything is missing, stop and tell them to come back
#===============================================================================
if [ "${MISSING}" -eq 1 ]; then
    echo ""
    echo -e "  ${BOLD}Install the missing pieces above, then re-run:${RESET}"
    echo ""
    echo -e "    ${CYAN}bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)${RESET}"
    echo ""
    exit 1
fi

#===============================================================================
# All 4 pillars present. Let's go.
#===============================================================================
set -e
echo ""
echo -e "  ${GREEN}${BOLD}All pillars strong.${RESET} Setting up your dev environment..."
echo ""

#-------------------------------------------------------------------------------
# Clone (or update) VDE
#-------------------------------------------------------------------------------
VDE_DIR="${HOME}/VDE"
BOOTSTRAP_URL="https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh"

if [ -d "${VDE_DIR}" ]; then
    echo -e "  ${DIM}VDE already exists at ${VDE_DIR}. Updating...${RESET}"
    (cd "${VDE_DIR}" && git fetch origin stable && git reset --hard origin/stable 2>/dev/null) \
        || echo -e "  ${YELLOW}⚠ Could not update. Continuing with existing version.${RESET}"
else
    echo -e "  Cloning VDE..."
    git clone -b stable https://github.com/dderyldowney/vde-system.git "${VDE_DIR}"
fi

cd "${VDE_DIR}"

#-------------------------------------------------------------------------------
# Add to PATH (in .zshrc or .bashrc, whichever exists)
#-------------------------------------------------------------------------------
PATH_LINE='export PATH="${HOME}/VDE/bin:$PATH"'
ADDED_PATH=0

for rc_file in "${HOME}/.zshrc" "${HOME}/.bashrc"; do
    if [ -f "${rc_file}" ]; then
        if ! grep -qF 'VDE/bin' "${rc_file}" 2>/dev/null; then
            echo "" >> "${rc_file}"
            echo "# VDE - Virtual Development Environment" >> "${rc_file}"
            echo "${PATH_LINE}" >> "${rc_file}"
            ADDED_PATH=1
        fi
        break
    fi
done

# Also create .zshrc if neither exists (fresh WSL/Linux install)
if [ ! -f "${HOME}/.zshrc" ] && [ ! -f "${HOME}/.bashrc" ]; then
    echo "" > "${HOME}/.zshrc"
    echo "# VDE - Virtual Development Environment" >> "${HOME}/.zshrc"
    echo "${PATH_LINE}" >> "${HOME}/.zshrc"
    ADDED_PATH=1
fi

# Make available in this session
export PATH="${VDE_DIR}/bin:${PATH}"

#-------------------------------------------------------------------------------
# Launch the onboarding ritual
#-------------------------------------------------------------------------------
echo ""
echo -e "${BOLD}${CYAN}╔════════════════════════════════════════════════════════════╗"
echo -e "║         Starting setup...                                  ║"
echo -e "╚════════════════════════════════════════════════════════════╝${RESET}"
echo ""

# bin/vde has a zsh shebang — the kernel handles the interpreter swap.
# We pass -y to auto-approve the onboarding steps.
bin/vde path-of-the-foundling -y

#===============================================================================
# Done.
#===============================================================================
echo ""
echo -e "${BOLD}${GREEN}╔════════════════════════════════════════════════════════════╗"
echo -e "║         You're ready. Start coding.                        ║"
echo -e "╚════════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  Create an environment:"
echo ""
echo -e "    ${CYAN}vde create python${RESET}      # Python"
echo -e "    ${CYAN}vde create rust${RESET}        # Rust"
echo -e "    ${CYAN}vde create js${RESET}          # JavaScript / Node"
echo -e "    ${CYAN}vde create go${RESET}          # Go"
echo ""
echo "  Jump in and code:"
echo ""
echo -e "    ${CYAN}vde start python${RESET}       # Start the container"
echo -e "    ${CYAN}vde enter python${RESET}       # Open a shell inside"
echo ""
if [ "${ADDED_PATH}" -eq 1 ]; then
    echo -e "  ${DIM}(Restart your terminal, or run: source ~/.zshrc)${RESET}"
    echo ""
fi
