# CONTRIBUTING
<!-- @forge (Governance) -->
# Contributing to the Forge

Thank you for seeking to join the Tribe. Contributing to VDE means working within a dual-project ecosystem governed by the **Rule Spine**. We value technical integrity and narrative alignment above all else.

---

## 1. The Two Fires (Architecture)

Before you strike, determine which project you are modifying:

1. **Project 1: The Armor (`@armor`)**: The development product used by students. Changes here must be AI-blind and Hub-blind. Focus on the Unyielding Tetrad and Spoke performance.
2. **Project 2: The Forge (`@forge`)**: The governance and AI system. This is the **"Any Thing"** engine. Changes here affect how we build, audit, and release the Armor through agentic intelligence.

---

## 2. The Ritual of the Strike (Workflow)

Every modification to the Forge follows a strict lifecycle mandated by the **Sovereign Release Law**:

1. **The Signet (Issue)**: Open a GitHub Issue documenting the **Sovereign Reason** (Fracture Analysis).
2. **The Anvil (Branch)**: Create a feature branch off `develop` (**The Anvil**) using the format `<type>/<slug>` (e.g., `feat/add-new-spoke`).
3. **The Trial of the Gauntlet (TDD)**: No functional code is committed until its purpose is defined by a failing test.
4. **The Chronicle (PR)**: Submit a Pull Request targeting `develop`. It must include:
    - **Fracture Analysis**: What was broken or missing.
    - **The Reforging**: How the fix or feature was implemented.
    - **The Beskar Set**: List of involved files.
    - **Empirical Proof**: Terminal output of 100% passing tests.

---

## 3. The Laws of the Forge

- **Mandate C (ZSH ONLY)**: We do not speak bash. All scripts, hooks, and tools must be Zsh-native.
- **Mandate 24 (Tagging)**: Every file MUST have an architectural tag (`@armor`, `@forge`, or `@shared-law`) and a **Functional Effect** description on line 2 or 3.
- **Conventional Commits**: Commit messages must follow the `type(scope): description` standard (e.g., `feat(core): add cluster discovery`).
- **Proof of Life (Mandate L)**: Your changes must pass the `proof-of-life-the-contract.feature` audit.
- **The Gospel**: All changes must align with the Sovereign Artifact Set (SAS) in `docs/`.

---

## 4. Development Setup

```zsh
# 1. Clone the Anvil
git clone https://github.com/dderyldowney/vde-system.git
cd vde-system
git checkout develop

# 2. Ignite the Sentinels (Pre-push and Commit Hooks)
bin/install-githooks

# 3. Verify the Spine
bin/vde-spine-check.zsh
```

---

## 5. Testing Mandate

We use **Behave** (Python) for BDD and Zsh-native unit tests.

```zsh
# Run the full audit
make check

# Run the Heartbeat proof
python3 -m behave tests/features/core-infrastructure/proof-of-life-the-contract.feature
```

**Certification**: No PR is merged until the **Dual-Gate Review** (AI Sentinel approval + Clan Leader written authorization) is complete.

**This is the Way.**
