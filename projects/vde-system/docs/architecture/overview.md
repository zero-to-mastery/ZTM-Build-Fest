# ARCHITECTURE
<!-- @shared-law (Sovereign Law) -->
# ARCHITECTURE 1.5.6 (The Sovereign Baseline)

## 1. Philosophical Pillars (The Way)

- **The Sovereign Charter (The Law of the Two Projects)**: The VDE is architected as two distinct but symbiotic projects:
    1. **Project 1: The Armor (`@armor`)**: The student-facing Engine. It is AI-blind, Hub-blind, and depends strictly on the Unyielding Tetrad. It provides the runtime environment.
    2. **Project 2: The Forge (`@forge`)**: The universal Development AI-Governance system. It manages the GitHub lifecycle, enforces mandates, and audits technical integrity.
- **The Symbiotic Covenant**: The Forge shapes the Armor. Every change to the Forge must be justified by how it improves the Armor product for Foundlings (Students).
- **The Creed-frame**: The narrative fuel established in `data/vde_core/**` must guide all thematic world-building.
- **The Gospel**: The Sovereign Artifact Set is the absolute authority. 1.5.5 is the unique Sovereign Baseline.
- **The Spine**: The system is built upon the **Unyielding Tetrad**: **Zsh, Git, Docker, and SSH**.

## 2. Structural Design (The Armor)

- **Hub**: The host machine, governing orchestration and security.
- **Spokes**: Isolated containers (jails) where hydration and development occur.
- **Bridges**: Secure transversal connections (SSH, socat) between the Hub and Spokes.
- **Unified Command Router (`bin/vde`)**: A centralized CLI orchestrator that routes all operations, including Spoke lifecycles and infrastructure tasks (`vde ssh-setup`, `vde ssh-sync`), ensuring all execution occurs under the UAP Enforcer.
- **Initialization Ritual (`vde init`)**: The automated process of forging keys and priming configurations to transform a raw clone into a battle-ready Hub. Subject to the **SSH Hard Rule**, missing keys are generated inline without restarting the process.
- **Path of the Foundling (`vde path-of-the-foundling`)**: The interactive induction script for new students. Launched automatically by the bootstrap script below.
- **Bootstrap (`scripts/bootstrap.sh`)**: The front door. A POSIX-compatible script that checks the 4 pillars, clones VDE, and launches onboarding. Works in any shell before Zsh is installed.

## 3. Security posture (The Beskar)

- **Identity Isolation**: Development occurs exclusively as `devuser` within Spokes. The `vde_student` key is the unique identity used to authenticate the bridge.
- **Static Guards**: UAP enforcement and pre-commit hooks verify mandate compliance at every strike.

## 4. Absolute Mandates (The Laws)

- **Unyielding Tetrad**: Every operation depends on the guaranteed presence and behavior of Zsh, Git, Docker, and SSH.
- **Project Separation**: Project 1 (The Armor) must remain strictly AI-blind and depend only on the Tetrad. Project 2 (The Forge) provides the governance layer.
- **The Mandate of Architectural Tagging**: 100% of artifacts (code, tests, docs, config) MUST be tagged according to their Project alignment (@armor, @forge, or @shared-law).
    - **The Positioning Law**: Tags MUST be placed on **line 2 or 3** of every file. Line 1 is reserved for shebangs or file-specific headers.
    - **Literate Syntax**: Tags must use the native comment syntax for the file format.
    - **Operational Modes**: "Forge mode, Armor mission" — Forge development must prioritize product excellence.
- **Universal Script Parity (USP)**: Every VM entry MUST point to a setup script at `scripts/setup/<alias>-init.zsh`.
- **The Heartbeat**: Continuous certification of the VM lifecycle via BDD automation.

## 5. The Sovereign Artifact Set (The Gospel)

The following nine files move as a single artifact set for every Sovereign Baseline. They must be in perfect agreement with the Forge state before any tag is struck:
1. `docs/architecture/overview.md` (The Strategy)
2. `docs/architecture/data-flow.md` (The Mechanics)
3. `docs/changelogs/current.md` (The Archive)
4. `docs/governance/vde-spec.md` (The Gospel Lead & Version Arbiter)
5. `USE_CASES.md` (The Audit)
6. `VDE_ANALYSIS.md` (The Engineering Verdict)
7. `PROJECT_STATUS.md` (The Living Heartbeat)
8. `docs/governance/sovereign-charter.md` (The Dual-Mission Constitution)
9. `docs/api/library-api.md` (The Main Library)

## 5. The Release Ritual (The Living Mark)

VDE enforces a strict branch-based release lifecycle to maintain the purity of the Baseline:
1.  **Develop (`develop`)**: The Anvil. Primary integration branch and repository default. All work occurs here or on feature branches originating from it.
2.  **Stable (`stable`)**: Intermediate stability branch. Represents the last certified release plus pending stable updates. `develop` merges into `stable`.
3.  **Main (`main`)**: Production branch. Reserved for certified releases. **All step tagging (X.X.X) and GitHub releases MUST occur exclusively on this branch.** `main` is mirrored from `stable`.
4.  **The Ritual**: Work flows: `develop` → `stable` → `main`. Only `main` receives version tags and GitHub releases.
5.  **X.X.X Releases**: Step and milestone releases are applied against `main` only after merging from `stable`.

---
Version: 1.5.5
Status: SOVEREIGN BASELINE CERTIFIED
Identity: The Covert
---
