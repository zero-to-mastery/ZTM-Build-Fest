# LINEAGE OF A STRIKE: vde start <target>
<!-- @shared-law (Forge Component) -->

This document traces the technical and architectural lineage of a single `vde start` command as it moves from the initial sparks of the Forge through the armored shell of the Engine.

## I. INITIAL IGNITION: Governance & Verification (The Forge @forge)
Before the first plate is struck, the Forge ensures the warrior and the environment are worthy.
1.  **Enforcement**: `bin/vde-enforce-uap.zsh`
    *   *Job*: The heavy gatekeeper. Enforces the Rule Spine, scans for path leaks, and verifies architectural tags before any command ignites.
2.  **Spine Check**: `bin/vde-spine-check.zsh`
    *   *Job*: Empirically verifies the Unyielding Tetrad (Zsh, Git, Docker, SSH) are functional on the Hub.

## II. COMMAND DISPATCH: The Entrypoint (The Armor @armor)
Once cleared by the Forge, the request enters the Orchestrator.
3.  **The Orchestrator**: `bin/vde`
    *   *Job*: Resolves aliases (e.g., `py` to `python`), identifies clusters, and dispatches to the internal logic handler.

## III. INFRASTRUCTURE HANDSHAKE: The Core (@shared-law)
The shared DNA that both projects require for technical stability.
4.  **Constants & Errors**: `lib/vde-constants`, `lib/vde-errors`
    *   *Job*: Provides the unique exit codes and environment variables used across the Forge.
5.  **Logging Engine**: `lib/vde-log`
    *   *Job*: Provides structured, level-controlled output (silenced during BDD, verbose during manual strikes).
6.  **Shell Compatibility**: `lib/vde-shell-compat`
    *   *Job*: Ensures associative arrays and path detection remain Zsh-native and pure.

## IV. RESOURCE RESOLUTION: The Blueprint (The Armor @armor)
Translating the intent into physical container requirements.
7.  **Naming Logic**: `lib/vde-naming`
    *   *Job*: Normalizes the user input into canonical container and image names (`vde-python`).
8.  **Registry Logic**: `lib/vm-common`
    *   *Job*: Loads the Beskar Registry (`data/vm-types.json`) to retrieve package lists, ports, and hydration scripts.
9.  **Locking System**: `lib/vm-lock`
    *   *Job*: Acquires the VM-level lock at `.locks/vms/<name>.lock` to prevent concurrent ignition collisions (Rule K).

## V. PHYSICAL IGNITION: The World-Forge (The Armor @armor)
Calling upon the power of Docker to build and start the Spoke.
10. **Docker Orchestration**: `lib/vde-docker`
    *   *Job*: Generates the internal `docker compose` command, resolves volume mounts, and maps the host ports.
11. **Blueprint Template**: `templates/compose-language.yml` (or `compose-service.yml`)
    *   *Job*: The YAML template used to define the physical container isolation.

## VI. LIFE-BREATHING: Spoke Hydration (The Armor @armor)
The Spoke is running, but it must be hydrated with the tools of the tribe.
12. **The Gateway**: `scripts/vde-entrypoint.zsh`
    *   *Job*: The first process inside the container. It sets up the `devuser`, mounts the SSH bridge, and triggers hydration.
13. **The USP Script**: `scripts/setup/<target>-init.zsh`
    *   *Job*: The Universal Script Parity logic that installs the specific Beskar alloy (Python, GCC, etc.) into the Spoke.

## VII. FINAL CERTIFICATION: The Heartbeat Handshake (@shared-law)
Verifying that the bridge is functional and the warrior can enter.
14. **Identity Pulse**: `lib/vde-pulse.zsh`
    *   *Job*: Performs the diagnostic handshake via the SSH socket to ensure the identity bridge is active.
15. **SSH Connector**: `bin/ssh-vm`
    *   *Job*: (Optional/Final) The transversal bridge used to formally enter the Spoke if the command was `vde enter`.
