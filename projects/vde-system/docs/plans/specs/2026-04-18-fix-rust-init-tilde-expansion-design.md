# Strike Design: Fix Tilde Expansion Bug in rust-init.zsh
<!-- @shared-law (Sovereign Law) -->

## Fracture Analysis
File: `scripts/setup/rust-init.zsh`
Location: Line 37
Issue: `local dev_home="~devuser"` uses double quotes, which prevents Zsh from performing tilde expansion. This results in the literal string `~devuser` being assigned to the variable, causing downstream operations (touch, grep, echo) to fail when they expect a valid filesystem path.

## The Reforging
Change: `local dev_home="~devuser"` -> `local dev_home=~devuser`
Rationale: Per Zsh specification and Mandate, unquoted tilde at the start of an assignment allows for expansion to the user's home directory.

## Success Criteria
1. `local dev_home=~devuser` is unquoted in `scripts/setup/rust-init.zsh`.
2. No other changes are made to the file.
3. Verification script confirms the change is applied correctly.

## Beskar Set
- `scripts/setup/rust-init.zsh`
