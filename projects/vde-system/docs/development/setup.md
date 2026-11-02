# VDE Development Guide
<!-- @forge (AI Governance) -->

**Version:** 1.5.5 (The Sovereign Baseline)

## Code Style

- **All shell scripts must use zsh** (`#!/usr/bin/env zsh`)
  - Zsh version: 5.0 or later required.
  - `bash` usage is strictly prohibited (Mandate C).
- **Indentation**: 2 spaces.
- **Mandate 24 (Tagging)**: Every file MUST be tagged as `@armor`, `@forge`, or `@shared-law` on Line 2 or 3.

## Architecture: The Two Projects

1.  **The Armor (`@armor`)**: The student-facing product. Must be AI-blind and depend strictly on the Tetrad.
2.  **The Forge (`@forge`)**: The governance and auditing system. Manages the lifecycle and AI integration.

### Libraries (`lib/`)

All VDE logic is modular. For detailed function references, see `docs/api/library-api.md`.

| Library | Domain | Purpose |
|---------|--------|---------|
| **vde-core** | `@armor` | Essential initialization and JSON queries. |
| **vm-common** | `@armor` | The primary orchestrator for Spoke lifecycles. |
| **vde-ssh** | `@armor` | Transversal Bridge management. |
| **vde-enforce-uap** | `@forge` | The Rule Spine enforcement engine. |

## Testing

As of 1.5.5, the suite is certified at **100% Fidelity**.

- **BDD Framework**: Behave (Python).
- **Counts**: 17 Scenarios, 137 Steps.
- **Protocol**: No functional code is committed without a failing test (Trial of the Gauntlet).

### Test Commands
```zsh
vde health              # Fast Spine Check
make test               # Full suite (Unit + BDD)
behave tests/features/  # BDD only
```

## Security

- **Identity**: Spokes run as `devuser`. The Hub uses the `vde_student` key for authentication.
- **Agent Forwarding**: Authentication is proxied via `socat`; private keys never enter the Spoke.
- **Sanitization**: All user input is normalized via `vde-naming` to prevent path traversal.

---

## Development Workflows (Examples)

### Example: Python + PostgreSQL Stack

```zsh
# 1. Forge the tech stack
vde start python postgres

# 2. Enter as devuser
vde enter python

# 3. Work in the synced workspace
cd ~/workspace
# (Syncs to projects/python on your Hub)

# 4. Connect to the database via DNS
psql -h vde-postgres -U devuser
```

### Daily Rhythm

1. **Morning**: `vde start python postgres`
2. **During**: `vde enter python` -> code in `~/workspace/`
3. **Evening**: `vde stop all`

---

[← Back to README](../../README.md)
**This is the Way.**
