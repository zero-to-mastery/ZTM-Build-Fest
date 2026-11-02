# VDE GitHub Infrastructure Lifecycle
<!-- @forge (AI Governance) -->

This document defines the official procedures and lifecycle for interacting with the VDE Hub (GitHub). The VDE ecosystem consists of two distinct projects with separate responsibilities, governed by the **Sovereign Baseline (1.5.5)**.

## 1. Project Separation

| Project | Designation | Responsibility | Dependencies |
| :--- | :--- | :--- | :--- |
| **Project 1** | **The Armor** | The VDE Engine product (Runtime). | Unyielding Tetrad (zsh, git, docker, ssh). AI-Unaware. |
| **Project 2** | **The Forge** | AI-Governance & Development System. | `gh` (GitHub CLI), AI rules, workflows, MCP servers. |

### Core Mandate
- **Project 1 (The Armor)** must never depend on Project 2 or `gh` for its runtime operation. It is purely driven by the Tetrad.
- **Project 2 (The Forge)** owns all GitHub life (Issues, PRs, CI, Releases) and uses the `gh` CLI as its foundational tool.

## 2. The Strike Loop (Project 2: The Forge)

All development on the Armor (Project 1) must be governed by the Forge (Project 2) using the **Ritual of the Signet and Chronicle**:

1.  **Signet (Issue)**: Create an Issue detailing the "Sovereign Reason".
    - Command: `gh issue create --title "..." --body "..."`
    - *Note: `gh` is a mandatory requirement for the Forge development backend.*
2.  **The Anvil (Branching)**: VDE follows a strict three-branch model:
    - **`develop` (The Anvil)**: The primary integration branch and repository default. All work MUST occur on feature branches originating here.
    - **`stable`**: The intermediate stability branch. Represents the last certified release plus any pending stable updates. **Users ALWAYS clone `stable` for the most current stable code.**
    - **`main` (Production)**: Reserved for certified releases of the Sovereign Baseline. All step tagging and GitHub releases occur here. `main` is always mirrored from `stable`.
    - **Flow**: `develop` → `stable` → `main`
3.  **Strike (Branch)**: Create a feature branch from `develop`.
    - Command: `git checkout -b <type>/<slug> develop`
4.  **Reforging (Development)**: Apply changes using the iterative **Plan -> Act -> Validate** cycle.
5.  **Chronicle (PR)**: Create a Pull Request linking to the Signet.
    - Command: `gh pr create --title "..." --body "..."`
6.  **Audit (CI/CD)**: All GitHub Actions, workflows, and scanner bots must report **100% GREEN**.
7.  **Finalization**: Merge is performed ONLY by the Clan Leader (User) after a successful Code Review.

## 3. CI/CD Heartbeat

The VDE CI Pipeline (`.github/workflows/vde-ci.yml`) is the heartbeat of the Forge. It enforces the following:

- **Technical Integrity**: Runs `bin/vde-check-tetrad.zsh` to ensure the Armor's base is sound.
- **Governance Audit**: Runs `bin/vde-enforce-uap.zsh` (Project 2) to ensure development adheres to mandates.
- **Atomic Real-Time Audit**: Core data (`vm-types.json`) is audited against the schema using self-destructing atomic copies.
- **Linting & Tests**: Standard ZSH syntax, Ruff Python, and 100% PASS for Sovereign Tests.

## 4. Label Governance

Repository labels are standardized to Conventional Commit specifications:

| Label | Usage |
| :--- | :--- |
| `feat` / `feature` | New features and capabilities. |
| `fix` / `bug` | Correcting fractures in the Beskar. |
| `chore` | Maintenance and housekeeping. |
| `docs` | Documentation and sacred texts. |
| `ci` | Automation and GitHub Actions. |
| `refactor` | Code restructuring without behavioral change. |
| `security` | Remediations and hardening. |

*Note: `feature` is an alias for `enhancement`/`feat` for project-specific convenience.*

## 5. The Dual-Gate System

The VDE uses two distinct validation gates to ensure both technical and structural integrity.

### Gate 1: The Technical Integrity Gate (Project 1: The Armor)
- **Script**: `bin/vde-check-tetrad.zsh`
- **Trigger**: Every execution of the `vde` orchestrator or `bin/ssh-vm`.
- **Purpose**: AI-unaware verification of the Unyielding Tetrad (zsh, git, docker, ssh) and the directory environment.
- **Usage**: Lightweight, student-facing, mandatory for runtime.

### Gate 2: The Heavy Governance Gate (Project 2: The Forge)
- **Script**: `bin/vde-enforce-uap.zsh`
- **Trigger**: **Agent** ignition, **CI/CD** workflows, and the **Pre-Push Hook**.
- **Purpose**: Deep audit of the Rule Spine, Mandate compliance, and structural governance.
- **Pillar Link**: The Forge cannot be lit without the Armor. This gate **trips the Technical Integrity Gate first** before proceeding to governance checks.
- **Requirement**: `gh` (GitHub CLI) is a mandatory requirement for this gate to interact with the Hub.

## 6. The Pre-Push Gate

The `pre-push` git hook automatically executes the **Proof of Life** (`tests/features/core-infrastructure/proof-of-life-the-contract.feature`). This hook:
1.  Trips the **Heavy Governance Gate** (`vde-enforce-uap.zsh`).
2.  Ensures the **Unyielding Tetrad** is active.
3.  Verifies the absolute VM lifecycle.

Code is strictly forbidden from leaving the Forge unless both Gates are Green.

**This is the Way.**
