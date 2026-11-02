# VDE-SPEC
# @shared-law (Sovereign Law)
# VDE-SPEC 1.5.6 (The Sovereign Evolution)

**Date**: 2026-09-29
**Status**: SOVEREIGN BASELINE CERTIFIED
**Reference**: ARCHITECTURE 1.5.6
**Identity**: The Covert

## 1. Absolute Mandates (The Rule Spine & The Gospel)


- **The Mandalorian Code**: The VDE is a Mandalorian Forge. All agents operate as Mandalorian Armorer-Architects, bound by the **Creed** and the **Contract**. This is the Supreme Law.
- **The Sovereign Charter (The Law of the Two Projects)**: The VDE ecosystem is architected as two distinct projects with hierarchical responsibilities, as codified in `docs/governance/sovereign-charter.md`. You MUST apply the **Test of the Two Fires** to determine the strike lineage:
    1. **Project 1: The Armor (`@armor`)**: The physical VDE Engine product. AI-blind and Hub-blind. Responsible for container orchestration, SSH bridges, and the core VM registry. Includes `lib/vde-core`, `lib/vde-constants`, and foundational rituals.
    2. **Project 2: The Forge (`@forge`)**: The universal Development AI-Governance system. Enforces the Rule Spine, handles the GitHub lifecycle, and executes BDD verification tests (`tests/features/`). It encompasses **"Any Thing"** logic adaptable to any project.
- **The Unyielding Tetrad (The System Spine)**: The system MUST empirically verify the four core pillars before any mission ignition:
    1. **Pillar I: Zsh** (The Voice) - Minimum version 5.0. Verifies native associative array support.
    2. **Pillar II: Git** (The Chronicler) - Minimum version 2.30. Enforces Conventional Commits.
    3. **Pillar III: Docker** (The World-Forge) - Version 20.10+. Manages Spoke lifecycles.
    4. **Pillar IV: SSH** (The Transversal Bridge) - Requires the `vde_student` identity to be active in the Hub's agent.
    - **Core Guards**: `vde_require_ssh` verifies SSH binary availability and `vde_student` identity file existence; `vde_require_docker` verifies Docker binary availability and daemon responsiveness via `docker info`.
- **The Proof of Life Contract (Mandate L)**: The lifecycle defined in `plans/system-spine-contract.md` is the project's **Heartbeat**. It mandates that ALL Spokes must reliably execute: `init`, `create`, `rebuild`, `start`, `enter`, `stop`, `remove`, `add`, and `uninstall`. Failure of any state is a Protocol Blockade.
- **The Creed-frame**: The narrative fuel established in `data/vde_core/**` must guide all thematic world-building. No Spoke shall be ignited and no structure stabilized that does not align with the mythos.
- **The Gospel Authority**: The Sovereign Artifact Set (specified in Section 3) is the **Gospel of the Forge**. These documents are the **limiting, or expanding, decision makers** on the **WHAT** and the **HOW** of all creation and refactoring. **1.5.6 is now the unique Sovereign Baseline. All prior versions and releases are of historical archival value only.**
- **The Use-Case Creed**: The Forge exists solely to serve the Foundlings (Students) and Reinforcements (New Hires). This is **Creed**. All technical work MUST be centrally driven by its direct improvement to the onboarding and educational experience of these two cohorts.
- **The Mandate of Architectural Tagging**: ALL artifacts (code, tests, docs, config) MUST be tagged according to their Project alignment (@armor, @forge, or @shared-law) to maintain clear ownership and visibility.
    - **The Positioning Law**: Tags MUST be placed on **line 2 or 3** of every file. Line 1 is reserved for shebangs or file-specific headers.
    - **Literate Syntax**: Tags must use the native comment syntax for the file format:
        - **Shell/ENV/Python**: `# @tag (Effect)`
        - **JSON**: `"@tag": "(Effect)",`
        - **Markdown**: `<!-- @tag (Effect) -->`
        - **YAML/Dockerfile**: `# @tag (Effect)`
        - **SQL**: `-- @tag (Effect)`
    - **The Universal Sentinel**: Detection is enforced by the UAP Sentinel via the **Universal Architectural Regex**.
- **The Armorer’s Toolset**: The agent possesses both the authority and the capability to run research swarms and self-augmentation tools as needed. Failure to utilize these capabilities to ensure the highest quality strike is a rejection of the mandate.
- **The Four Pillars Gateway**: Before the Proof of Life ritual is ignited, the host environment MUST pass the Four Pillars Gateway verification (`gateway-pillars.feature`). This verifies the presence and basic capability of Zsh, Git, Docker, and SSH. Any failure in this gateway constitutes an immediate **Program Blockade**.
- **Language of the Tribe (ZSH ONLY)**: All CLI tools, libraries, and jail shells MUST use `#!/usr/bin/env zsh`. `bash` is strictly prohibited. Enforcement is performed via deep content inspection for native parameter expansion `${(` and 1-indexed array usage.
    - **HELMET LEVEL FAILURE**: Use of `sh`, `bash`, `fish`, or any shell OTHER THAN zsh constitutes immediate helmet removal and Protocol Blockade. This is a CREED VIOLATION of the highest order.
- **The Armorer’s Command (UAP)**: Every action MUST be run under `bin/vde-enforce-uap.zsh`. This sentinel detects "Ghost Zones", enforces shebang purity, and forbids `sleep` calls in favor of deterministic polling.
- **Registry Serialization**: To prevent "Thundering Herd" race conditions, all modifications to the VM registry and port allocation MUST be performed *inside* the global config lock (`global-config.lock`). Port availability MUST be verified via a physical diagnostic handshake (`docker run --rm`).
- **Born Ready (BTO)**: Every jail MUST be fully functional at image creation. Runtime `apt` calls or network-dependent configurations are prohibited to ensure immutability.
- **Universal Script Parity (USP)**: Every VM entry MUST point to a setup script at `scripts/setup/<alias>-init.zsh`. USP rituals are mandated to "Purge the Ghosts" (`apt-get clean`) to maintain image hygiene.
- **The AI-Blind Runtime (Core Tenet)**: The Forge (AI logic, agentic intelligence, and GitHub lifecycle automation) SHALL NOT be active, available, or accessible during Project 1 (Armor) runtime. The student environment must be 100% deterministic, autonomous, and AI-blind.
- **Pure Relative Pathing**: All artifacts MUST be executed and accessed relative to VDE_ROOT_DIR to ensure absolute portability of both the combined system and its individual projects.
- **The Rule of One**: This SPEC is the unique and absolute authority on the project version and the Sovereign Artifact Set state. Any discrepancy between implementation and SPEC must be resolved in favor of the SPEC.


## 2. Technical Inventory Control (SemVer)

- **Standard**: MAJOR.MINOR.STEP-spN (SemVer 2.0.0 compliant).
- **Versioning**: MAJOR/MINOR are user-decided architectural shifts. STEP represents incremental technical progress. spN is reserved for security patches.
- **Chronicle Standard**: All commits MUST adhere to the **Conventional Commits** specification (e.g., `feat(core):`, `fix(security):`).

## 3. The Sovereign Artifact Set (The Gospel of the Forge)

Before any tag is struck, these nine files MUST be in perfect agreement with the Forge state. Together, they constitute the **Gospel of the Forge**:
1. `docs/architecture/overview.md`
2. `docs/architecture/data-flow.md`
3. `docs/changelogs/current.md`
4. `docs/governance/vde-spec.md` (The Gospel Lead)
5. `USE_CASES.md`
6. `VDE_ANALYSIS.md`
7. `PROJECT_STATUS.md`
8. `docs/governance/sovereign-charter.md`
9. `docs/api/library-api.md`

## 4. The Sovereign Branching Strategy

The Forge strictly enforces the following Git lifecycle to maintain the purity of the Baseline:
1. **`main` (Production)**: Reserved for certified releases of the Sovereign Baseline. **GitHub Releases and mandatory version tags (X.X.X) MUST occur exclusively on this branch.** `main` is always mirrored from `stable`.
2. **`stable`**: The intermediate stability branch. It represents the last certified release plus any pending stable updates. `develop` merges into `stable`.
3. **`develop` (The Anvil)**: The primary integration branch and repository default. All work MUST occur on feature branches originating from `develop`.
4. **Feature Branches (The Strike)**: All work MUST occur on a feature-named branch (`feat/`, `fix/`, `chore/`) branching off `develop`.
5. **The Ritual**: Every mission begins with a Signet (Issue) and ends with a Chronicle (PR). Feature branches are merged to `develop` ONLY upon acceptance and MUST be deleted immediately after.
6. **The Release Ritual**: Work flows: `develop` → `stable` → `main`. Only `main` receives version tags and GitHub releases.

## 5. The Chronicle Mandates (GitHub Workflow)

Automated orchestration ensures absolute traceability:
- **PR Title Validation**: All Pull Requests MUST use Conventional Commit titles. PRs with non-compliant titles will be rejected by the `verify-pr-title` sentinel.
- **Automated Labeling**: GitHub automatically tags Chronicles by type (`feat`, `fix`, `chore`) and impact (`breaking-change`) based on title prefixes and the `!` modifier.
- **Unbreakable Link**: Every Chronicle MUST be linked to its Signet using auto-closing keywords (e.g., `Closes #N`).
- **Evidence Mandate**: The Chronicle body MUST include literal terminal output proof of successful test runs.
- **Reporting Minimums (MANDATORY)**:
    - **Issue Bodies**: MUST include full documentation of what is wrong (the "Sovereign Reason" for the Issue).
    - **PR Bodies**: MUST include (1) What was wrong, (2) What the fix was, and (3) A complete list of Files involved. This is the absolute minimum acceptable information.
- **The Pre-Release Declaration Mandate**: BEFORE merging any release Chronicle into Production (`main`), a dedicated Declaration Ritual MUST be performed.
- **The Mandate of Non-Destructive Persistence**: The primary pillars (`main`, `develop`, `stable`) are immutable. They MUST NOT be deleted, force-pushed (except for initial mirror setup), or otherwise compromised. All synchronization between these branches MUST be additive and performed via the mandatory PR ritual. Use of `--delete-branch` on a primary pillar is a Class-A violation.

## 6. Security & Infrastructure Bridge

- **Identity Isolation**: The `vde_student` identity is confined to `~/.ssh/vde/`.
- **Bridge Integrity**: `socat` proxying for SSH agent forwarding. The bridge is "Hardened Conditional"—it only exports `SSH_AUTH_SOCK` if the variable is empty, protecting protocol-native forwarding.
- **Static Guards**: Pre-commit hooks verify shebang purity and secret scanning.

## 7. Phase Milestones (Expansion & Hardening)

- **Phase 29 (Infrastructure Hardening)**: [CERTIFIED]
    - Core guards (`vde_require_ssh`, `vde_require_docker`) verify binary availability and service responsiveness. `vde_require_docker` probes daemon via `docker info`; `vde_require_ssh` verifies binary presence and `vde_student` identity file.
    - **Cluster Expansion**: Registered MEAN and LAMP tech stack VMs with dedicated hydration scripts (`scripts/setup/mean-init.zsh`, `scripts/setup/lamp-init.zsh`).
    - **State Integrity**: Codified `VDE_DOCKER_STATE_DIR` in `lib/vde-constants` to ensure deterministic cluster and container state management.
- **Phase 31 (DNS Discovery & Bridge)**: [CERTIFIED] Implemented high-fidelity Spoke-to-Spoke and Hub-to-Spoke resolution with BDD verification (`bin/vde-dns-check.zsh`).
- **Phase 32 (Forge Intelligence)**: [CERTIFIED] Self-healing Gospel synchronization and auto-remediation (`bin/vde heal`). Restores registry from authority, corrects version drift, and detects path leaks via UAP enforcement.

---
Version: 1.5.6
**Status**: HARDENED
**Reference**: RESOL'NARE 1.5.6
---
