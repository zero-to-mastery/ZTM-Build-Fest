# VDE INSTALLATION
<!-- @armor (Installation Ritual) -->
# The Installation Ritual (1.5.5)

Welcome, Foundling. To ignite your own Forge and walk the path of the VDE, you must first secure the **Unyielding Tetrad** on your host machine. This process establishes and certifies your **Sovereign Baseline 1.5.5**.

---

## 1. One-Command Install (The Fast Path)

Run this in any terminal (bash or zsh):

```zsh
bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)
```

This single command will:

1. **Check the 4 pillars** (Zsh, Git, Docker, SSH) and tell you exactly what to install if anything's missing.
2. **Clone VDE** from the `stable` branch.
3. **Launch the onboarding ritual** (`path-of-the-foundling`) which sets up SSH keys, builds the base image, and walks you through your first spoke.
4. **Add VDE to your PATH** automatically.

If anything is missing, the script prints the one command you need to fix it. Re-run the bootstrap command after installing.

---

## 2. Platform-Specific Prerequisites (If You Prefer Manual Setup)

The 4 pillars below are required. The bootstrap script checks for all of them automatically — but if you want to install them yourself first:

| Pillar | Requirement | Purpose |
| :--- | :--- | :--- |
| **I. Zsh** | Version 5.0+ | The Voice of the Tribe. **ZSH ONLY.** |
| **II. Git** | Version 2.30+ | The Chronicler of your history. |
| **III. Docker** | Desktop / Engine | The World-Forge for your Spokes. |
| **IV. SSH** | Agent Active | The Transversal Bridge to your Spokes. |

### 🪟 Windows (The WSL2 Path)
1.  **Enable WSL2**: Open PowerShell as Administrator and run `wsl --install`. Restart your computer.
2.  **Install Ubuntu**: If it didn't install automatically, find "Ubuntu" in the Microsoft Store and launch it.
3.  **Install Docker Desktop**: Download and install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop). In Settings, ensure **"Use the WSL 2 based engine"** is enabled and your Ubuntu distribution is checked under **Resources > WSL Integration**.
4.  **Enter your Shell**: Open the "Ubuntu" terminal. You are now in a Linux environment.
5.  **Install Prereqs**:
    ```zsh
    sudo apt update && sudo apt install zsh git openssh-client -y
    ```

### 🍎 macOS
1.  **Install Docker Desktop**: Download and install [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop).
2.  **Install Git**: Open Terminal and run `git --version` (macOS will prompt to install command line tools if missing).
3.  **Zsh**: macOS uses Zsh by default. Verify with `zsh --version`.
4.  **SSH**: OpenSSH is built into macOS. Verify with `ssh -V`.

### 🐧 Linux
1.  **Install Docker**: Follow the [official engine installation](https://docs.docker.com/engine/install/) for your distro.
2.  **Install Prereqs**: Use your package manager to install `zsh`, `git`, and `openssh-client` (e.g., `sudo apt install zsh git openssh-client`).

---

## 3. Manual Installation

If you prefer to set everything up yourself:

```zsh
git clone -b stable https://github.com/dderyldowney/vde-system.git ~/VDE
cd ~/VDE
bin/vde path-of-the-foundling
```

The `path-of-the-foundling` ritual is the onboarding mechanism. It performs `vde init` automatically, sets up your `vde_student` SSH identity, builds the base image, and walks you through creating your first Python spoke.

**This is the Way.**
