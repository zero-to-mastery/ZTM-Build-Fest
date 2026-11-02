# Standardize VDE_ROOT_DIR Derivation Design
<!-- @shared-law (Sovereign Law) -->


## Goal
Standardize the derivation of `VDE_ROOT_DIR` across all binaries and libraries to ensure absolute portability by using absolute path resolution (`:a:h:h`) in Zsh.

## Architecture
Every script or library that defines its own `VDE_ROOT_DIR` will be updated to use the absolute variant. This ensures that even if called via a symlink or from a different directory, the root is correctly identified.

### Binaries (`bin/*`)
Standard pattern:
```zsh
VDE_ROOT_DIR="${0:a:h:h}"
export VDE_ROOT_DIR
```

### Libraries (`lib/*`)
Standard pattern:
```zsh
if [[ -z "${VDE_ROOT_DIR:-}" ]]; then
    VDE_ROOT_DIR="${${(%):-%x}:a:h:h}"
    export VDE_ROOT_DIR
fi
```

## Affected Components
- All files in `bin/` currently defining `VDE_ROOT_DIR`.
- All files in `lib/` currently defining `VDE_ROOT_DIR`.
- Special focus on `lib/vde-root` and `lib/vm-common`.

## Verification Plan
1. `bin/vde-enforce-uap.zsh` to ensure mandates are still met.
2. `bin/vde-spine-check.zsh` to verify Zsh integrity.
3. `python3 -m behave tests/features/core-infrastructure/proof-of-life-the-contract.feature` for final certification.

## Risk Assessment
- Low risk, as `:a:h:h` is standard Zsh expansion for "absolute path, parent directory, parent directory".
- Potential issue if a script is not running in Zsh, but VDE is Zsh-only.
