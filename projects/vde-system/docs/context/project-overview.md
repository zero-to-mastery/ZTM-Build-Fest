# VDE - Context Overview
<!-- @forge (Context Documentation) -->

**Project**: Virtual Development Environment (VDE)  
**Version**: 1.5.5 (The Sovereign Baseline)  
**Last Updated**: 2026-05-03

---

## Quick Navigation for AI

This is the master context file. Based on your current task, refer to:

### Architecture & Decisions
- **ADR-001**: [Why ZSH-Only Requirement](architecture/decisions/adr-001-zsh-only-requirement.md) - Technical rationale for bash prohibition
- **ADR-002**: [SSH Bridge Architecture](architecture/decisions/adr-002-ssh-bridge-architecture.md) - Security and production parity
- **ADR-003**: [Born Ready Containers](architecture/decisions/adr-003-born-ready-containers.md) - Immutability requirements
- **ADR-004**: [Lock-Queue Concurrency Model](architecture/decisions/adr-004-lock-queue-concurrency-model.md) - Determinism and race prevention

### Component Details
- **Hub System**: [Hub Context](components/hub-system-context.md) - Host orchestration and global configuration
- **Spoke System**: [Spoke Context](components/spoke-system-context.md) - Container lifecycle and USP
- **Transversal Bridge**: [Bridge Context](components/transversal-bridge-context.md) - SSH connectivity and identity
- **Lock System**: [Lock Context](components/lock-system-context.md) - Concurrency control
- **UAP Enforcement**: [UAP Context](components/uap-enforcement-context.md) - Protocol compliance
- **Lifecycle Management**: [Lifecycle Context](components/lifecycle-management-context.md) - VM operations

### Development & Deployment
- **Development Workflow**: [How code gets written and reviewed](workflows/development-workflow.md)
- **Deployment Workflow**: [Release ritual and branching strategy](workflows/deployment-workflow.md)

---

## Project Essentials

### Purpose
VDE is a sovereign, template-based ecosystem of Dockerized Spokes designed for developers who demand absolute isolation, consistent hydration, and governed development. It provides a deterministic containerized environment for software engineering with strict architectural governance.

### Tech Stack
- **Shell**: Zsh 5.0+ (strict requirement - NO bash allowed)
- **Orchestration**: Docker Desktop/Engine 20.10+
- **Version Control**: Git 2.30+
- **Connectivity**: SSH (vde_student identity key)
- **Language**: Shell (zsh) - Core tooling, Python/Node/Go/etc. for spoked containers

### Architecture Pattern
**Hub-and-Spoke Model**:
- **The Hub**: Host machine governing orchestration, security, and global configuration
- **The Spokes**: Isolated containers (jails) where hydration and development occur
- **The Transversal Bridge**: SSH-native connection between Hub and Spokes

### Dual-Project Architecture
1. **The Armor (@armor)**: Student-facing VDE Engine - AI-blind, Hub-blind, depends only on the Tetrad
2. **The Forge (@forge)**: Development AI-Governance System - enforces Rule Spine, manages GitHub lifecycle
3. **The Spinal Cord (@shared-law)**: Shared foundational pillars used by both projects

---

## Current Focus
**Version 1.5.5 (The Sovereign Baseline)** — CERTIFIED:
- Version sync from 1.5.3 to 1.5.5 complete
- Heartbeat: 72/72 BDD steps green (6/6 scenarios)
- All Sovereign Artifact Set documents aligned to 1.5.5
- Branching strategy: develop → stable → main

---

## Key Context Files

### Sovereign Artifact Set (The Gospel - Authoritative Documents)
These 9 documents move as a single artifact and must be in perfect agreement before any release:
1. `docs/architecture/overview.md` - High-level system design and structural principles
2. `docs/architecture/data-flow.md` - Granular component logic and workflows
3. `docs/changelogs/current.md` - Historical record of all Sovereign Baseline releases
4. `docs/governance/vde-spec.md` - Version authority and system laws (The Gospel Lead)
5. `USE_CASES.md` - Defines the "Why" and filters work by educational value
6. `VDE_ANALYSIS.md` - Research findings and empirical engineering verdicts
7. `PROJECT_STATUS.md` - Authoritative record of active system health and state
8. `docs/governance/sovereign-charter.md` - The dual-mission constitution (Armor + Forge)
9. `docs/api/library-api.md` - The main library reference

### Additional Essential Documentation
- `docs/governance/project-philosophy.md` - The Mandalorian Creed framework and epistemic architecture
- `docs/governance/vde-epistemic-mapping.md` - VDE governance mapped to arxiv 2506.17331 (epistemic integrity)
- `docs/development/github-lifecycle.md` - Signet (Issue) and Chronicle (PR) rituals
- `docs/governance/vde-protocol.md` - The Laws of the Forge and branching strategy
- `docs/guides/getting-started.md` - Complete walkthrough for students

---

## AI Collaboration Notes

### Coding Standards
- **Mandate C (ZSH Only)**: All scripts MUST use `#!/usr/bin/env zsh`
- **Mandate L (Proof of Life)**: The lifecycle (init, create, rebuild, start, enter, stop, remove, add, uninstall) is the project's Heartbeat
- **Mandate 24 (Architectural Tagging)**: Every file tagged as `@armor`, `@forge`, or `@shared-law` on line 2 or 3
- **Pure Relative Pathing**: All artifacts accessed relative to VDE_ROOT_DIR for portability

### Common Patterns
- **Hub-and-Spoke**: Host orchestration + isolated containers + SSH bridge
- **Lock-Queue**: FIFO serialization preventing Thundering Herd race conditions
- **Universal Script Parity (USP)**: All VMs point to setup scripts in `scripts/setup/<alias>-init.zsh`
- **Born Ready**: Containers configured at build time - NO runtime apt calls
- **Sovereign Artifact Set**: 9 documents move as single synchronized artifact

### Important Constraints
- **NO BASH**: Strict ZSH-only requirement enforced by UAP sentinel
- **NO HOST DEPENDENCIES**: Only Zsh, Git, Docker, SSH allowed (Scavenger's Ban)
- **NO RUNTIME APT**: Containers must be Born Ready (configured at build time)
- **IDENTITY FIRST**: Always operate as devuser inside spokes using vde_student key
- **WORKSPACE PERSISTENCE**: Code goes in $HOME/workspace/ for sync to hub
- **AI-BLIND RUNTIME**: The Forge is not available during Armor runtime - Armor must function autonomously

### Epistemic Architecture
VDE implements a constrained epistemic agent architecture (mapped to arxiv 2506.17331):
- **Scout sub-agents** for research, main agent for cognition
- **Decompose found solutions** - never use wholesale
- **Identity-level constraints** - not just rule-level (the Contract)
- **Let technology push back** - that's information, not failure
- **Triple binary gate contract** for all agent work
- **The Helmet Mandate**: Never fabricate knowledge - that's removing the helmet

---

## System Components Overview

### Core Library Components (24 libraries)
- **Core Logic**: vde-core, vde-commands, vde-parser
- **Docker Management**: vde-docker, vde-docker-state
- **Security**: vde-security, vde-root-guard, vde-ssh
- **State Management**: vde-docker-state, vm-lock, vde-root
- **Monitoring**: vde-pulse.zsh
- **Utilities**: vde-audit, vde-cluster-utils, vde-constants, vde-errors, vde-health, vde-log, vde-metrics, vde-naming, vde-path-utils, vde-progress, vde-shell-compat, vde-templates, vm-common

### CLI Tools (56 scripts in bin/)
- **Lifecycle**: vde-init, vde-bootstrap, vde-path-of-the-foundling
- **Container Management**: vde-rebuild, vde-start/stop/restart/remove (inline in vde)
- **Access**: ssh-vm, vde-exec, ssh-setup, ssh-sync, ssh-agent-setup
- **Operations**: vde-health, vde-info, vde-inspect, vde-ps, vde-logs, vde-port, vde-stats
- **System**: vde-networks, vde-images, vde-cluster, vde-rebuild-cache, vde-dns-check.zsh, vde-vision
- **Registry**: add-vm-type, uninstall-vm-type, list-vms, validate-schemas.zsh
- **Governance**: vde-enforce-uap.zsh, vde-gospel-audit.zsh, vde-security-audit.zsh, vde-spine-check.zsh
- **Maintenance**: vde-prune.zsh, vde-purify-paths.zsh, vde-heal-docs.zsh, vde-check-tetrad.zsh, vde-armor-heal.zsh, vde-tactical-sweep.zsh, cleanup-ports
- **Versioning**: vde-sync-version, vde-sync-context
- **Matrix**: vde-matrix-audit.zsh, vde-matrix-rebuild.zsh
- **Infrastructure**: nuke-vde, install-githooks, generate-all-configs, vde-poll, paired_update_enforcer

---

## The Unyielding Tetrad (System Spine)

The system requires these four pillars to operate:

1. **Zsh** (The Voice) - Version 5.0+ with native associative array support
2. **Git** (The Chronicler) - Version 2.30+ enforcing Conventional Commits
3. **Docker** (The World-Forge) - Version 20.10+ managing Spoke lifecycles
4. **SSH** (The Transversal Bridge) - Requires vde_student identity in Hub's agent

Before any mission, the Four Pillars Gateway (`vde health` or `vde spine-check`) verifies these pillars are present and functional.

---

## Repository Information

- **Remote Origin**: https://github.com/dderyldowney/vde-system
- **Default Branch**: `develop` (The Anvil)
- **Production Branch**: `main` (Sovereign Baseline)
- **Stable Alias**: Always points to current certified main SHA
- **Root Directory**: `${VDE_ROOT_DIR}` (typically `~/VDE`)
- **Context Directory**: `${VDE_ROOT_DIR}/docs/context`

---

**For continuing context engineering work, see: [context-engineering-progress.md](context-engineering-progress.md)**

---

*This is the Way.*
