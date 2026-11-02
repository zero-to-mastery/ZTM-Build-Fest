# TECHNICAL DEEP DIVE
<!-- @shared-law (Sovereign Law) -->
# VDE: Technical Deep-Dive (1.5.6 Sovereign)

The Virtual Development Environment (VDE) is a deterministic, containerized ecosystem designed for secure software engineering. As the **Armorer-Architect**, I maintain this Forge using the **Hammer** of my toolset, ensuring that every container is smelted from pure **Ingots** (configurations) and hardened into immutable **Beskar**.

## 1. The Rule Spine (UAP Enforcement)

The Virtual Development Environment is governed by the **Universal Agent Protocol (UAP)**, enforced by `bin/vde-enforce-uap.zsh`. 
 This sentinel script ensures every action adheres to the **Resol’nare** (Supreme Prohibitions).

### Core Enforcement Mandates:
- **ZSH Native Sovereignty**: Detects "Fake ZSH" by verifying the use of native parameter expansion `${(` and associative arrays. Usage of `bash` or 0-indexed arrays is a Class-A violation.
- **Shebang Purity**: Recursively audits `bin/`, `lib/`, and `scripts/` to ensure `#!/usr/bin/env zsh` is the universal entry point.
- **The Use-Case Anchor**: Mandates that every technical refactor or infrastructure hardening strike is justified by its improvement to the **Foundling** (Student) or **Reinforcement** (New Hire) cohorts.
- **The Armorer’s Toolset**: Explicitly authorizes the use of research swarms, self-augmentation tools, and parallel sub-agent orchestration to ensure the highest quality strike.
- **Ghost Detection**: Monitors for "Ghost Zones" (unauthorized root directories) and ensures build-time artifacts (`apt` lists) are purged.
- **Supervised Execution**: Every CLI strike is wrapped in the Enforcer to maintain architectural integrity.

## 2. Advanced Orchestration (The Heartbeat)

### 2.1. The Locking Engine (`lib/vm-lock`)
The VDE utilizes a robust, PID-aware locking mechanism to prevent race conditions during Spoke ignition and registration.
- **Mutual Exclusion**: Guaranteed via atomic file creation (`mkdir`) in the `.locks/` directory.
- **Stale Lock Buster**: Implemented a 10s timeout that verifies if the lock's owner PID is still active on the Hub. If the PID is dead, the lock is automatically purged.
- **Recursive Prevention**: Ecosystem sourcing is strategically deferred until after the primary lock acquisition to eliminate infinite initialization loops.

### 2.2. Dynamic Port Allocation (`lib/vde-docker`)
Port conflicts are eliminated through an empirical diagnostic handshake:
- **Registry Authority**: Every VM Type has a hardcoded `ssh_port` and optional `service_ports`.
- **Diagnostic Probe**: Before ignition, the system executes a port-check ritual. If a port is occupied on the Hub, the system automatically rotates to the next available candidate, ensuring the Spoke can always be bridged.

### 2.3. Universal Script Parity (USP)
To ensure portability and reliability, every registered VM must have a corresponding hydration script in `scripts/setup/`.
- **Naming Law**: The script must be named `<alias>-init.zsh`.
- **Path Sovereignty**: All hydration commands within the Beskar Registry MUST use absolute `/vde/` paths to ensure reliability within the Spoke's internal filesystem.

VDE employs a three-tier reactive synchronization pipeline to transform human-readable intent into high-performance runtime data.

1.  **The Source (`data/vm-types.conf`)**: The human-editable flat-file registry following the strict 8-field standard: `type|name|aliases|display|pkgs|custom_cmd|service_ports|ssh_port`.
2.  **The Registry (`data/vm-types.json`)**: The `vde_translate_conf_to_json` ritual (Rule G) hammers the `.conf` into a structured JSON archive using pure ZSH parsing to avoid host-level `jq` dependencies.
3.  **The Cache (`.cache/vm-core.cache`)**: The `vde_core_save_cache` process generates a ZSH-native associative array (`VDE_CORE_VM_TYPE`, `VDE_CORE_VM_ALIASES`, `VDE_CORE_VM_DISPLAY`) for O(1) runtime lookup.
4.  **Ignition Sync**: The `bin/vde` orchestrator performs a timestamp audit. If source files are newer than the cache, a re-smelt is triggered automatically before Spoke ignition.

## 3. Concurrency & Atomic Stewardship

VDE manages high-concurrency operations (parallel builds and mass ignitions) via the **Lock-Queue Model**.

### FIFO Ticket-Based Locking (`lib/vm-lock`)
VDE uses a deterministic sequencing mechanism to prevent "Thundering Herd" race conditions:
- **Ticket Registration**: Every process requesting a lock creates a unique "Ticket" file in `${lock_file}.queue/` using `${EPOCHREALTIME}-$$`.
- **Oldest Ticket Priority**: The `claim_lock` function enforces FIFO order—only the process with the oldest numerically sorted ticket file may proceed.
- **The Atomic Gate**: Uses kernel-level `mkdir` atomicity to claim the final directory-based lock (`${lock_file}`).
- **Ownership Proof**: Once claimed, the lock directory contains a `pid` file recording `PID:PGID:TIMESTAMP` for transparent monitoring and crash recovery.
- **Paths**: Primary locks reside in `${VDE_ROOT_DIR}/.locks/vms/` and `global-config.lock`.

### Port Stewardship (`lib/vde-docker`)
To prevent double-allocation during parallel strikes, VDE reserves ports using `${VDE_ROOT_DIR}/.locks/ports/port-<number>.lock` markers. No Spoke is assigned a port until:
1.  **Kernel Referee**: The port lock directory is successfully created.
2.  **The Seeker's Recon**: A physical diagnostic handshake (`docker run --rm`) verifies the port is not occupied by host-level "Scavenger" processes.
3.  **Registry Serialization**: In `bin/add-vm-type`, the `find_available_ssh_port` command is executed *inside* the global config lock to prevent allocation races.

## 4. Universal Script Parity (USP)

VDE decouples environment hydration from Dockerfile complexity through USP rituals stored in `scripts/setup/`.

- **Hydration Ritual**: Every Spoke entry MUST point to a setup script (`<alias>-init.zsh`).
- **Asynchronous Ignition**: Service Spokes register background ignition hooks in `/usr/local/bin/vde-spoke-ignition.zsh`, detaching service availability from the primary SSH gate.
- **Born Ready (BTO)**: All hydration happens during the `docker build` phase. Runtime `apt` calls are strictly forbidden to ensure images are immutable and portable.

## 5. Architectural Tagging Standard

VDE implements absolute file classification to maintain the integrity of Project 1 (The Armor) and Project 2 (The Forge).

### 5.1 The Positioning Law
Architectural tags sit on **line 2 or 3**, allowing line 1 to remain dedicated to shebangs, primary headers, or JSON root braces.

### 5.2 The Literate Syntax
| Format | Pattern |
| :--- | :--- |
| Zsh / Python / Env | `# @tag (Functional Effect)` |
| JSON | `"@tag": "(Functional Effect)",` |
| Markdown | `<!-- @tag (Functional Effect) -->` |
| YAML / Docker | `# @tag (Functional Effect)` |
| SQL | `-- @tag (Functional Effect)` |

### 5.3 Detection & Enforcement
The `vde-enforce-uap.zsh` sentinel utilizes the **Universal Architectural Regex** to verify 100% compliance during the audit ritual. This ensures that every artifact is correctly classified as `@armor`, `@forge`, or `@shared-law` with its specific functional effect.

## 6. Security & Sovereign Bridge

### Identity Isolation (`lib/vde-security`)
- **Identity Isolation**: All development activities within a Spoke are performed as the `devuser` account. Authentication is secured via the `vde_student` identity key, which is confined to `${VDE_SSH_DIR}` (`~/.ssh/vde/`).
- **Permission Enforcement**: `vde_security_enforce_permissions` applies recursive `700` to sensitive directories (`data/`, `logs/`, `.cache/`, `.locks/`) and `600` to identity/env files.
- **Network Segmentation**: `vde-net` (bridge) ensures container isolation with `vde.managed=true` labeling.

### SSH Identity Auto-Remediation (The Hard Rule)
VDE enforces absolute determinism for the **Transversal Bridge**. If the `vde_student` identity is missing, the initialization lifecycle triggers an immediate remediation:
- **Inline Generation**: `vde init` detects the missing key and immediately invokes `vde ssh-setup init` inline. This generates the ed25519 identity and initializes the SSH agent without requiring a process restart.
- **Unified Lifecycle**: By integrating SSH management (`ssh-setup`, `ssh-sync`) directly into the `vde` router, the Forge ensures that all bridge-related operations are audited and wrapped in the Deterministic Error Engine.
- **Forced Refresh**: The `--force` flag on `vde init` is propagated to the SSH layer, ensuring a clean overwrite of the bridge identity when a total Forge refresh is requested.

### Bridge Hardening (Phase 27)
- **Conditional Forwarding**: `vde-entrypoint.zsh` performs a "Sovereign Bridge Handshake." It only exports the `socat` proxy socket to `SSH_AUTH_SOCK` if the variable is empty, protecting protocol-native forwarding (`ssh -A`) from being overwritten.
- **Persistence Anchor**: The bridge is preserved for non-login shells via conditional injection into `$HOME/.zshenv`.

## 7. GitHub Workflow (The Chronicle)

VDE enforces a machine-readable history through automated GitHub orchestration.

- **Stable Alias**: The `stable` branch is an automated alias for `main`, kept in sync by the `update-stable-alias.yml` workflow.
- **Automated Labeling**: PRs are automatically labeled (`feat`, `fix`, `chore`, `breaking-change`) based on their Conventional Commit titles.
- **Title Validation**: The `verify-pr-title.yml` workflow rejects non-compliant PR titles, ensuring the Chronicle remains parseable.

## 8. Deterministic Error Engine (Phase 26)

All VDE operations are wrapped in `vde_run`, which captures return codes and maps them to the **Sovereign Error Table**:
- `VDE_ERR_GENERAL (1)`
- `VDE_ERR_NOT_FOUND (3)`
- `VDE_ERR_LOCK (9)`
- `VDE_ERR_SYNC_DRIFT (13)`

## 9. The Sovereign Release Law

The Forge mandates a deterministic release process centered on the `main` branch to ensure baseline immutability.

- **Branch Sovereignty**: `develop` is for development only. Step tagging (X.X.X) and GitHub releases are strictly FORBIDDEN on `develop`.
- **Release Anchor**: All version tags and GitHub releases MUST be anchored to the `main` branch SHA.
- **The Stable Mirror**: Following a release on `main`, the released SHA is forcefully applied to the `stable` branch, ensuring it always mirrors the latest certified milestone.
- **Artifact Synchronization**: Before any release is finalized on `main`, the nine Sovereign Artifacts (Strategy, Mechanics, Archive, Lead, Audit, Verdict, Heartbeat, Constitution, and Library) MUST be in perfect agreement with the code state.

## 10. Infrastructure Hardening (Phase 29)

VDE has evolved its core requirement checks and hydration rituals:
- **Physical Probes**: `vde_require_docker` now executes `docker info` to verify daemon responsiveness, and `vde_require_ssh` verifies the physical presence of the `vde_student` identity.
- **Inter-VM Awareness**: Tech Stack Clusters (MEAN, LAMP, ELK) now inject inter-VM environment variables into the Spoke's `.zshenv`.
- **Native-Installer Hydration**: To ensure Spokes are "Born Ready" with current toolchains, hydration rituals (beginning with Rust) have transitioned from relying on host distribution packages (`apt-get`) to utilizing native installers (`rustup`). This ensures users receive the latest stable version of their environment by default, while maintaining identical outer behavior and CLI integration.

## 11. The Path of the Foundling (Onboarding)

To reduce onboarding friction for new students, VDE provides a layered induction system:
- **Bootstrap (`scripts/bootstrap.sh`)**: The front door. A POSIX-compatible script that checks the 4 pillars on any platform, clones VDE from `stable`, and launches the onboarding. Works in bash before Zsh is installed.
- **Interactive Induction**: `bin/vde-path-of-the-foundling` guides the user through their first Ignition, Spine Check, and Spoke Forge, certifying them as battle-ready without requiring deep architectural knowledge.
- **Foundling Guide**: A high-level philosophical and practical manual at `docs/guides/foundling-guide.md`.

## 12. DNS Discovery & Bridging (Phase 31)

VDE implements a high-fidelity internal network resolution system to facilitate inter-VM communication and Hub-to-Spoke bridging.
- **Dual Resolution**: Every Spoke is accessible via its canonical name (`vde-<alias>`) and its short alias (`<alias>`) within the `vde-net` bridge.
- **Sovereign Bridge**: The `vde-host` (mapped to `host-gateway`) provides a deterministic route for Spokes to communicate back to the Hub or access host-level services.
- **Handshake Verification**: The `vde dns-check` command provides empirical proof of cross-Spoke connectivity, ensuring the Transversal Bridge is active.

---
**Version**: 1.5.5
**Status**: SOVEREIGN BASELINE CERTIFIED
**Reference**: ARCHITECTURE 1.5.5
---
