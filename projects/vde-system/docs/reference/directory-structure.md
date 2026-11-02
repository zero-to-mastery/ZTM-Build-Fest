# Directory Structure
<!-- @shared-law (Sovereign Law) -->

The complete directory layout of the **Sovereign Baseline (1.5.5)** installation.

[← Back to README](../../README.md)

---

## Root Structure

```
VDE_ROOT/
├── .cache/             # Persistent associative array caches and port registry
├── .docker-state/      # Real-time container state archives for status tracking
├── .gemini/            # Agent instructions, commands, and strike plans
├── .gemini_security/   # Security remediation plans and vulnerability audits
├── .git/               # The Chronicler's archive (Git repository)
├── .locks/             # FIFO ticket-based concurrency locks (global and per-VM)
├── backup/             # Automated backups of SSH keys and system states
├── bin/                # Unified CLI orchestrator and binary rituals
├── conductor/          # Strike orchestration and mass tagger logic
├── configs/            # Docker Compose and service-specific configurations
├── data/               # Beskar Registry (vm-types) and service persistence
├── docs/               # The Gospel of the Forge (Sovereign Artifact Set)
├── env-files/          # Per-Spoke environment variables and DNS aliases
├── githooks/           # Pre-strike sentinels and lifecycle gates
├── lib/                # Standard Library (stdlib) Zsh modules
├── logs/               # Per-Spoke application logs and audit trails
├── plans/              # Implementation plans, task logs, and staging artifacts
├── projects/           # Foundling workspace (Source code mounts for language VMs)
├── public-ssh-keys/    # SSH public keys for authorized container injection
├── scripts/            # Hydration rituals (setup) and Spoke ignition logic
├── templates/          # Blueprints including forge-mythos rituals
├── tests/              # BDD Feature specifications and empirical proofs
├── MEMORY.md           # Sovereign session record and mission history
└── README.md           # Entry point and high-level mission overview
```

---

## Key Directories Explained

### `.locks/`
VDE uses a deterministic FIFO locking model to manage concurrency.
- `global-config.lock`: Serializes modifications to the Beskar Registry.
- `vms/`: Per-Spoke locks for parallel builds and mass ignitions.
- `ports/`: Atomic reservations for SSH and service ports.

### `.docker-state/`
Contains JSON archives reflecting the real-time status of VDE containers. This directory ensures that `vde status` and `vde vision` remain accurate without polling the Docker daemon excessively.

### `bin/`
The unified command surface. **Mandate 10** requires all operations to flow through `bin/vde`.
- `vde`: The canonical command router (The Way).
- `vde-enforce-uap.zsh`: The Rule Spine sentinel (Governance).
- `vde-init`: The Initialization Ritual logic.
- `vde-path-of-the-foundling`: Interactive student onboarding.

### `lib/` (Standard Library)
Modular Zsh 5.0+ libraries following the **ZSH ONLY** mandate.
- `vm-common`: High-level Spoke orchestration.
- `vde-core`: Pathing, versioning, and deterministic execution.
- `vde-ssh`: The Sovereign Bridge (SSH management).
- `vde-docker`: Container lifecycle management.

### `projects/`
The primary workspace for language Spokes. Each subdirectory is mounted as a volume into the corresponding container at `$HOME/workspace/`.

### `data/`
Persistent storage for service Spokes (e.g., PostgreSQL databases, Redis dumps) and the authoritative **Beskar Registry** (`vm-types.json`).

### `env-files/`
Configuration payloads sourced by Docker Compose. These files contain the **Phase 31 DNS aliases** and Spoke-specific metadata.

---

[← Back to README](../../README.md)
