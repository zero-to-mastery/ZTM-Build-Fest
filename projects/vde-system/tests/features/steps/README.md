# BDD Step Definitions Directory
<!-- @forge (BDD Registry Sync) -->

This directory contains the purified BDD (Behavior-Driven Development) step definitions for the VDE test suite. Every step in this directory performs **real physical verification** of the Forge.

## Pure Beskar: Active Step Files

The following files contain the 100%Green certified step definitions:

| File | Purpose |
|------|---------|
| `system_spine_steps.py` | Core Hub/Spoke integrity and Pillar verification. |
| `technical_integrity_steps.py` | Technical integrity verification and Tetrad presence checks. |
| `critical_steps.py` | Cross-feature common assertions and ANSI stripping. |
| `vde_init_steps.py` | Initialization ritual verification. |
| `tech_stack_steps.py` | Tech Stack Cluster coordination checks. |
| `jupyterlab_steps.py` | Data Science Spoke specific verification. |
| `usp_steps.py` | Universal Script Parity (USP) compliance audits. |
| `usp_alias_steps.py` | Alias resolution and hydration ritual verification. |
| `error_handling_steps.py` | Signal translation and lock contention engine. |
| `concurrency_queue_steps.py` | FIFO lock-queue ordering verification. |
| `init_steps.py` | General lifecycle setup and teardown. |

## Shared Helpers

- `config.py`: Single source of truth for BDD path calculations and test environments.
- `vm_common.py`: The single source of truth for VM constants and command execution.
- `ssh_helpers.py`: Isolated SSH agent and identity verification logic.
- `shell_helpers.py`: Adaptive polling (`vde-poll`) and container execution.

## The Purification Mandate

1. **No Fake Testing**: Every step must verify actual system state (files, containers, sockets).
2. **No "Pink" Steps**: `pass` or `assert True` placeholders are prohibited.
3. **No Ghost Files**: Any step file not associated with an active feature in `tests/features/` must be purged.

This is the Way.
