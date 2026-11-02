# Remediation Plan: VDE-AGENT-DISCOVERY (Global Agent Discovery)

## Background & Motivation
The Clan Leader's clean-slate bootstrap test requires the ability to wipe the VDE installation, start a completely fresh shell (without `SSH_AUTH_SOCK` or VDE in the `PATH`), clone the repository, and run `bin/vde path-of-the-foundling`. 

While `vde init` successfully generates the keys and starts the isolated SSH agent, it saves the agent's socket details to `~/.ssh/vde/agent_env`. Because the user is in a fresh shell that hasn't loaded this environment file (e.g., via `.zshrc` autostart), subsequent commands orchestrated by `vde` (like `vde start` and `vde enter` triggered during the foundling path) fail to communicate with the SSH agent, leading to `Permission denied (publickey)` errors.

## Scope & Impact
This remediation targets the central `bin/vde` orchestrator. By making the orchestrator itself proactively discover and source the isolated agent environment, all sub-commands will inherit the correct `SSH_AUTH_SOCK` regardless of the host shell's configuration.

## Proposed Solution
We will inject a "Global SSH Agent Discovery" block into `bin/vde` immediately after the core libraries are sourced. If the `agent_env` file exists, `bin/vde` will source it. This guarantees the Transversal Bridge is always accessible to orchestrated commands.

## Alternatives Considered
An alternative is requiring the user to run `vde ssh-setup autostart` and restart their shell before continuing the `path-of-the-foundling`. However, this breaks the seamless flow of the interactive onboarding ritual and places an unnecessary burden on the user. The orchestrator should be self-sufficient.

## Implementation Plan
1. Edit `bin/vde`.
2. Locate the library sourcing block (around line 25).
3. Inject the following code:
   ```zsh
   # Global SSH Agent Discovery
   # Ensures all orchestrated commands inherit the isolated VDE agent,
   # even if launched from a clean shell without ~/.zshrc integration.
   if [[ -f "${HOME}/.ssh/vde/agent_env" ]]; then
       source "${HOME}/.ssh/vde/agent_env" >/dev/null 2>&1
   fi
   ```

## Verification
1. Execute `python3 -m behave tests/features/core-infrastructure/proof-of-life-the-contract.feature`.
2. Verify that Scenario 3 ("Spoke Interaction and Maintenance") passes, confirming that `vde enter` successfully communicates with the isolated agent.

## Migration & Rollback
If this causes variable pollution issues, it can be reverted by removing the injected lines from `bin/vde`.