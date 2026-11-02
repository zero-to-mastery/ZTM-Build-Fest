# Remediation Plan: VDE-SPINE-01 (Isolated SSH Agent Discovery)

## Background & Motivation
The VDE ecosystem uses a strictly isolated SSH agent (`~/.ssh/vde/agent_env`) to prevent cross-contamination with a user's personal keys. The empirical verification script, `bin/vde-spine-check.zsh`, ensures that the Unyielding Tetrad (Zsh, Git, Docker, SSH) is functional. Currently, it fails on Pillar IV (SSH) because it attempts to verify and add the `vde_student` identity without first sourcing the isolated agent's environment variables (`SSH_AUTH_SOCK` and `SSH_AGENT_PID`).

## Scope & Impact
This remediation targets only the `bin/vde-spine-check.zsh` script. It ensures the empirical test correctly targets the VDE-specific SSH agent, restoring the Heartbeat to a Green state without modifying the actual agent lifecycle management.

## Proposed Solution
Modify `bin/vde-spine-check.zsh` to proactively check for and source `${HOME}/.ssh/vde/agent_env` immediately before executing any `ssh-add` commands in the Pillar IV verification block.

## Alternatives Considered
An alternative is to rely on the parent shell or orchestrator to export `SSH_AUTH_SOCK` before calling the spine check. However, the Spine Check is designed to be an independent, empirical diagnostic tool. Relying on inherited state violates its purpose as an objective observer. It must discover the state physically.

## Implementation Plan
1. Edit `bin/vde-spine-check.zsh`.
2. Locate the "Pillar IV: SSH" section.
3. Inject the following discovery logic before calling `ssh-add -l`:
   ```zsh
   if [[ -f "${HOME}/.ssh/vde/agent_env" ]]; then
       source "${HOME}/.ssh/vde/agent_env" >/dev/null 2>&1
   fi
   ```

## Verification
1. Execute `./bin/vde-spine-check.zsh`.
2. Verify that the output concludes with `[OK] Pillar IV: SSH identity (vde_student) is loaded.` and returns a `0` exit code.
3. Run the full Proof of Life ritual to confirm the Heartbeat is restored.

## Migration & Rollback
If this change causes unintended side effects in CI environments, it can be reverted via a simple `git checkout` or `git revert`. No persistent state is altered.