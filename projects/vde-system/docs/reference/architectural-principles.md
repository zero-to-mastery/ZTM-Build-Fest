# ARCHITECTURAL PRINCIPLES
<!-- @shared-law (Forge Component) -->
The architectural principles defining the **Sovereign Baseline 1.5.5** are governed by a hierarchical and narrative-driven framework designed for absolute technical integrity and portability. This environment, referred to as the **Forge**, operates under the following core architectural pillars:

### **1. The Gospel: Sovereign Artifact Set (SAS)**

The SAS is the "synchronized baseline of truth" for the environment. Version 1.5.5 formally defines this set as **nine authoritative documents** that must be in perfect agreement before any version tag is struck. These documents serve as the definitive "decision-makers" on all system logic and implementation:

1. **docs/governance/vde-spec.md (The Rule of One)**: The absolute authority for versioning and laws.
2. **USE_CASES.md (The Creed)**: Defines the "Why" and filters work by educational value for Students (Foundlings) and New Hires (Reinforcements).
3. **docs/architecture/overview.md (The Skeleton)**: High-level design and structural principles.
4. **docs/architecture/data-flow.md (The Nervous System)**: Granular component logic and workflows.
5. **VDE_ANALYSIS.md (The Context)**: Research findings and empirical engineering verdicts.
6. **PROJECT_STATUS.md (The Pulse)**: The authoritative record of active system health and state.
7. **docs/changelogs/current.md (The Chronicle)**: Historical record of every Sovereign Baseline release.
8. **docs/governance/sovereign-charter.md (The Law)**: The dual-mission architecture and symbiotic covenant.
9. **docs/api/library-api.md (The Muscle)**: The detailed reference for core library functions.

### **2. The Rule Spine: Universal Agent Protocol (UAP)**

The system architecture is strictly enforced by the **UAP**, a sentinel layer (`bin/vde-enforce-uap.zsh`) that prevents architectural drift.

* **Sovereign ZSH Purity**: All CLI tools, libraries, and shells must use `#!/usr/bin/env zsh`. The use of `bash` is strictly prohibited and enforced via deep content inspection for native ZSH features.
* **Zero-Host Dependency (Scavenger's Ban)**: The system must not depend on the tools of the host machine (e.g., avoiding `jq` in favor of native ZSH parsing). It relies only on the "Unyielding Tetrad": **Zsh, Git, Docker, and SSH**.
* **Born Ready (BTO)**: Every Spoke (VM) must be fully functional at image creation. Runtime `apt` calls or network-dependent configurations are prohibited to ensure immutability.

### **3. Structural Design: Hub-and-Spoke Model**

The 1.5.5 baseline utilizes a three-tier inheritance model:

* **The Hub**: The host machine governing orchestration, security, and global configuration.
* **The Spoke**: Isolated containers (Jails) where hydration occurs via **Universal Script Parity (USP)**—a mandate that every VM entry points to a specific setup script.
* **The Transversal Bridge**: A secure SSH-native connection between the Hub and Spokes, bypassing non-standard behaviors of `docker exec` to mimic production cloud infrastructure.

### **4. Concurrency & Determinism**

Architectural stability in 1.5.5 is maintained through deterministic state management:

* **Lock-Queue Model**: Competitive spinlocks are replaced with a First-In-First-Out (FIFO) sequencing mechanism using unique ticket files to prevent "Thundering Herd" race conditions during high-volume operations.
* **Registry Serialization**: All modifications to VM registries and port allocations must occur inside a global configuration lock (`global-config.lock`).

### **5. The Sovereign Release Law**

The Forge mandates a strict three-branch lifecycle:

* **`develop` (The Anvil)**: The primary integration branch. All work occurs on feature branches originating here.
* **`stable`**: The intermediate stability branch. Represents the last certified release plus pending stable updates. **Users clone `stable` for the most current stable code.**
* **`main` (Production)**: Reserved for certified releases. All version tags and GitHub releases occur exclusively here. `main` is always mirrored from `stable`.
* **Flow**: `develop` → `stable` → `main`

### **6. The Creed-frame Narrative**

The integration of the **Mandalorian and Forge Mythos** as a core architectural mandate. Technical work is not merely code; it is a "strike on the anvil," and all infrastructure must align with this foundational narrative established in `data/vde_core/**`.
