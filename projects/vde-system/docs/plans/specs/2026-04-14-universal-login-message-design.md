# Design Spec: Universal VM Login Message
<!-- @shared-law (Sovereign Law) -->

**Date:** 2026-04-14
**Status:** Approved
**Target:** Sovereign Baseline 1.3.1

## 1. Goal
Implement a consistent login message for all users across all VDE VMs (Base, Language, Service).

## 2. Technical Strategy
Inject the login message logic into the `vde-base` layer via `/etc/zsh/zlogin`. This ensures that every login shell outputs the required metadata automatically.

## 3. Implementation Details
The following block will be appended to `/etc/zsh/zlogin` in the `vde-base.Dockerfile`:

```zsh
# VDE Universal Login Message
echo "Hostname: $(hostname)"
echo "User: $(whoami)"
echo "Home Dir: $HOME"
echo "Shell: $SHELL"
echo "Workspace: $HOME/workspace"
```

## 4. Verification Plan
1. Rebuild the base image: `bin/vde rebuild --vm base`.
2. Start a VM (e.g., `python`).
3. Enter the VM: `bin/vde enter python`.
4. Verify the output matches the specification.

## 5. Compliance
- **ZSH Purity**: Uses native ZSH login mechanisms.
- **DRY**: Implemented once in the base image, inherited by all spokes.
- **Sovereign Baseline**: Aligned with 1.3.1 environment standards.
