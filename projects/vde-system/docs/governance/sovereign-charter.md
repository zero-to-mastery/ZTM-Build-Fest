# SOVEREIGN CHARTER
<!-- @shared-law (Sovereign Law) -->
# VDE Sovereign Charter: The Law of the Two Projects

This Charter defines the dual-mission architecture of the VDE. It is the foundational covenant that ensures the absolute integrity of the product and its governed evolution.

---

## I. The Sovereign Architecture Definition

The VDE ecosystem is architected as two distinct projects that operate independently but work in hierarchical harmony to ensure the absolute integrity of the product and its development.

### 1. Project 1: The Armor (The VDE Engine Product) — @armor
**The Armor** is the physical, student-facing product—the core engine that enables the Virtual Development Environment.

*   **Individual Use**: Providing a robust, isolated, and standardized CLI for "Foundlings" (students) to ignite development Spokes (VMs). It handles container orchestration, network isolation, and workspace management.
*   **Target**: **Specific**. It serves *this* project (VDE) and its specialized container requirements.
*   **Sovereign Dependencies**: It depends **exclusively** on the **Unyielding Tetrad** (zsh, git, docker, ssh).
*   **AI-Blindness**: It is designed to be **AI-unaware** and **Hub-blind**. It must function perfectly without any Project 2 components or `gh` CLI access.
*   **Integrity Gate**: Protected by the **Lightweight Technical Gate** (`bin/vde-check-tetrad.zsh`).
*   **Architectural Tag**: `@armor` — Explicitly marks all Project 1 related files.

### 2. Project 2: The Forge (Development AI-Governance System) — @forge
**The Forge** is the universal development, auditing, and governance rig.

*   **Individual Use**: Enforcing the **Rule Spine** (Mandalorian Creed) and Mandates during the development lifecycle. It owns "GitHub Life," managing Issues, PRs, CI/CD, and release synchronization.
*   **Target**: **Universal**. It serves **"Any Thing"**—tools and protocols that could theoretically serve *any* project (regardless of tech stack) to ensure governed development.
*   **Core Tools**: It uses the **GitHub CLI (`gh`)** as its foundational binary to interact with the Hub. It includes all agent instructions, Forge rules, and CI workflows.
*   **Role**: It acts as the "Architect" that builds the Armor.
*   **Architectural Tag**: `@forge` — Explicitly marks all Project 2 related files.

### 3. The Spinal Cord (The Foundation) — @shared-law
**The Spinal Cord** represents the shared files and foundational pillars that both projects rely upon to maintain the integrity of the combined system.
*   **Architectural Tag**: `@shared-law` — Explicitly marks all shared foundational files.

---

## II. Operational Modes

To maintain strict focus and project separation, the VDE utilizes two primary operational modes:

1.  **Armor Mode**: Activated by the command "We are in Armor mode". The agent automatically switches focus to Project 1 (@armor) files and runtime product requirements. This is the top-level view of work until told otherwise.
2.  **Forge Mode**: Activated by the command "We are in Forge mode". The active work surface is @forge and allowed @shared-law files only. However, unless explicitly stated otherwise, the PRIMARY MISSION TARGET is the Armor product (@armor). Any change to Forge should be designed and evaluated by how well it improves the creation, reliability, and maintainability of Armor. Think: "Forge mode, Armor mission" — we touch Forge to better build Armor, not for its own sake. This is the top-level view of work until told otherwise.

**The Decision Rule**: When working on the Armor, if a change is needed to the Forge to better create the product, the mode must be explicitly switched to Forge mode.

---

## III. The Hierarchical Component Outline

*   **VDE Sovereign System**
    *   **Project 1: The Armor (@armor)**
        *   **Code (Binaries)**: `bin/vde`, `bin/ssh-vm`, `bin/vde-init`, `bin/vde-rebuild`, `bin/vde-ps`, `bin/list-vms`, `bin/vde-info`, `bin/vde-port`, `bin/vde-health`, `bin/vde-images`, `bin/vde-stats`, `bin/vde-logs`, `bin/vde-bootstrap`, `bin/vde-cluster`, `bin/vde-dns-check.zsh`, `bin/vde-spine-check.zsh`, `bin/vde-check-tetrad.zsh`.
        *   **Code (Libraries)**: `lib/vde-core`, `lib/vde-constants`, `lib/vde-shell-compat`, `lib/vm-common`, `lib/vde-docker`, `lib/vde-ssh`, `lib/vm-lock`, `lib/vde-naming`, `lib/vde-path-utils`, `lib/vde-progress`.
        *   **Data**: `data/vm-types.json`, `data/vm-types.conf`, `data/vm-types.schema.json`.
        *   **Docs**: `docs/operations/installation.md`, `docs/guides/getting-started.md`, `docs/guides/foundling-guide.md`.
        *   **Tests**: `tests/unit/*.zsh` (Engine Unit Tests).
        *   **Rituals**: Engine Ignition (`vde init`), Spoke Smelting (`vde rebuild`), Transversal Bridge (`vde enter`).
    *   **Project 2: The Forge (@forge)**
        *   **Code (Binaries)**: `bin/vde-enforce-uap.zsh`, `bin/paired_update_enforcer`, `bin/cleanup-ports`, `bin/vde-tactical-sweep.zsh`.
        *   **Code (Libraries)**: `lib/vde-audit`, `lib/vde-metrics` (Generic Governance).
        *   **Docs**: `AGENTS.md`, `GEMINI.md`, `docs/development/github-lifecycle.md`, `docs/development/contributing.md`.
        *   **Tests**: `tests/features/*.feature` (BDD Features), `tests/features/steps/*.py` (Step Definitions), CI/CD Workflows.
        *   **Rituals**: The Signet and Chronicle (GitHub Flow), Code Review Gates, AI-Agent Dispatch.
    *   **The Foundation (@shared-law)**
        *   **The Spinal Cord**: The foundational bridge and shared law defining the relationship between Armor and Forge.
        *   **Docs (The Gospel)**: `docs/architecture/overview.md`, `docs/architecture/data-flow.md`, `docs/changelogs/current.md`, `docs/governance/vde-spec.md`, `USE_CASES.md`, `VDE_ANALYSIS.md`, `PROJECT_STATUS.md`, `docs/governance/sovereign-charter.md`, `docs/api/library-api.md`.
        *   **Records**: `MEMORY.md`.
        *   **Infrastructure**: `Makefile`, `.gitignore`, `.editorconfig`.

---

## III. How They Work Together (The Symbiotic Covenant)

The relationship is hierarchical: **The Forge builds the Armor.**

1.  **The Foundation Link**: The Forge cannot be lit without the Armor. The Heavy Gate (P2) ALWAYS trips the Technical Gate (P1) first.
2.  **The Shielded Product**: During development, we use the Forge (AI agents, `gh`, CI/CD) to modify the codebase. However, the resulting code (The Armor) is meticulously decoupled so that it remains purely driven by the Tetrad.
3.  **The Forge Restriction (Core Tenet)**: The Forge (AI-Agentic Intelligence, GitHub automation, and Governance auditing) burns exclusively for the Armorer-Architect during the development strike. Once the Armor is forged and delivered to the Foundling, the Forge is quenched. The Forge SHALL NOT be running, available, or accessible during the student's primary runtime. The Armor must remain 100% autonomous, deterministic, and AI-blind.
4.  **The Decision Rule (Test of the Two Fires)**: Before a strike acts, classify the strike:
    - **Armor Strike (@armor)**: Satisfies a physical runtime requirement for the specific VDE product (Naked Machine Audit).
    - **Forge Strike (@forge)**: Satisfies a universal requirement for governed development, "Any Thing" automation, or AI discipline (Governance Guard Audit).
    - **Shared-Law Strike (@shared-law)**: Modifies the foundational bridge or pillars used by both (Symbiotic Link Audit).

4.  **The Tagging Report**: For EVERY strike, the agent MUST produce an explicit **Tagging Report** listing each touched artifact and its classification. This report is recorded in the permanent Chronicle (PR body) to build an empirical database of architectural ownership.

## IV. Sovereign Tagging Specification

To ensure total architectural accountability, all artifacts MUST adhere to the following specification:

### 1. The Positioning Law
Architectural tags sit exclusively on **line 2 or 3**. Line 1 is reserved for shebangs, primary document headers, or JSON root structures.

### 2. The Literate Syntax Standard
| Language / Format | Literate Syntax | Example |
| :--- | :--- | :--- |
| **ZSH / Python / Shell / ENV** | `# @tag (Effect)` | `# @armor (Engine Core)` |
| **JSON / JSON-Schema** | `"@tag": "(Effect)",` | `"@shared-law": "(Data Schema)",` |
| **Markdown** | `<!-- @tag (Effect) -->` | `<!-- @forge (Governance) -->` |
| **YAML / Dockerfile** | `# @tag (Effect)` | `# @armor (Base Image)` |
| **SQL** | `-- @tag (Effect)` | `-- @shared-law (Storage)` |

### 3. Verification
Tag compliance is verified by the **UAP Sentinel** via the **Universal Architectural Regex**. Non-compliant artifacts constitute a **Protocol Fracture** and must be remediated before any further work proceeds.

---

**This is the Way.**
