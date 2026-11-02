# README
<!-- @armor (Student Documentation) -->
<p align="center"><img src="docs/imgs/vde-system-logo.png" alt="Virtualized Development Environment System Logo"></p>

# The Way of the VDE: 1.5.6 (The Sovereign Baseline)

![CI Status](https://github.com/dderyldowney/vde-system/actions/workflows/vde-ci.yml/badge.svg)

A sovereign, template-based ecosystem of Dockerized Spokes. Forged for the warrior who demands absolute isolation, consistent hydration, and governed development. 1.5.5 is the **Sovereign Baseline**, certified through the Proof of Life contract.

**🛡️ The Sovereign Record:** The default branch for this Forge is `develop` (**The Anvil**). Stable, certified releases reside on `main` (**Production**).

---

## This is the Way. 👋

Welcome, Foundling, to the VDE. You are entering a dual-project ecosystem:

1. **Project 1: The Armor (`@armor`)**: The student-facing development engine. It is AI-blind and Hub-blind, providing the physical Spokes (containers) where you work as the `devuser`.
2. **Project 2: The Forge (`@forge`)**: The universal development AI-governance system. It enforces the Rule Spine, manages the GitHub lifecycle, and audits your path through agentic intelligence.

---

## The Unyielding Tetrad (The System Spine) 🏗️

The Forge does not ignite without the four pillars. Every mission begins with a Spine Check:

| Pillar | Requirement | Purpose |
| :--- | :--- | :--- |
| **I. Zsh** | Version 5.0+ | The Voice of the Tribe. **ZSH ONLY.** |
| **II. Git** | Version 2.30+ | The Chronicler of your Strike. |
| **III. Docker** | Desktop / Engine | The World-Forge for your Spokes. |
| **IV. SSH** | `vde_student` key | The Transversal Bridge connecting the Hub to the Spokes. |

---

## Get Coding in 60 Seconds 🚀

**One command. That's it.**

```zsh
bash <(curl -sL https://raw.githubusercontent.com/dderyldowney/vde-system/stable/scripts/bootstrap.sh)
```

This checks your system, installs nothing you don't want, and walks you through setup.
If something's missing, it tells you exactly what to install and how.

**Windows?** Open PowerShell as Administrator, run `wsl --install`, restart,
then run the command above from your Ubuntu terminal.

---

### Manual install

```zsh
git clone -b stable https://github.com/dderyldowney/vde-system.git ~/VDE
cd ~/VDE
bin/vde path-of-the-foundling
```

---

## Core Mandates (The Resol’nare) 🛡️

- **Mandate L (Proof of Life)**: The lifecycle (`init`, `create`, `rebuild`, `start`, `enter`, `stop`, `remove`, `add`, `uninstall`) is the project's **Heartbeat**. Failure in any state is a Protocol Blockade.
- **Identity Purity**: You operate as `devuser` inside all Spokes. Access is secured via the `vde_student` SSH identity key.
- **Workspace Persistence**: Save your code in `$HOME/workspace/` inside the Spoke to ensure it is persistently synced to your Hub.
- **Mandate C (Zsh Only)**: All rituals, scripts, and shells are Zsh-native.
- **Mandate 24 (Architectural Tagging)**: Every file is marked as `@armor`, `@forge`, or `@shared-law`.

---

## The Archivist's Intel 📇

| Section | Description |
|---------|-------------|
| **📘 Warrior's Guide** | [Getting Started](docs/guides/getting-started.md) - Complete walkthrough for students. |
| **🛠️ Installation** | [Installation Guide](docs/operations/installation.md) - Prerequisite setup and Induction. |
| **📜 Protocol** | [VDE Protocol](docs/governance/vde-protocol.md) - The Laws of the Forge and Branching. |
| **🤝 Contributing** | [Contributing](docs/development/contributing.md) - How to join the Tribe's effort. |
| **📐 Architecture** | [Architecture 1.5.6](docs/architecture/overview.md) - The Blueprint. |

---

## Reinforcements (The Tracking Fob) 🆘

If the Forge stalls, consult the Sentinel:

```zsh
vde health        # Audit the Hub's health (Spine Check)
vde info <alias>  # Inspect a specific Spoke's state
vde nuke          # The Great Quench (Reset everything)
```

**This is the Way.**
