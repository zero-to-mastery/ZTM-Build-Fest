# ADR-001: ZSH-Only Requirement
<!-- @forge (Context Documentation) -->

**Status**: Accepted  
**Date**: 2026-04-30  
**Context**: Core architectural decision enforcing Zsh as the only permitted shell

---

## Context

VDE requires strict control over shell behavior for portability, consistency, and epistemic integrity. Bash is widely available but has behavioral variations across versions and platforms that could introduce subtle bugs in production deployments. Additionally, the project's governance framework requires deterministic, predictable shell behavior that can be thoroughly audited and validated.

The Universal Agent Protocol (UAP) enforces that all CLI tools, libraries, and container shells must use Zsh exclusively. This is not a preference—it is a hard architectural requirement enforced via deep content inspection.

---

## Decision

VDE SHALL use Zsh 5.0+ as the exclusive shell for all operations. Bash is strictly prohibited.

### Technical Rationale

1. **Portability**: `#!/usr/bin/env zsh` provides consistent behavior across platforms without version-specific bash quirks
2. **Feature Parity**: Zsh provides native associative arrays (`typeset -A`) and 1-indexed arrays that bash lacks or implements differently
3. **Epistemic Integrity**: Deterministic shell behavior is essential for the constrained epistemic agent architecture
4. **Production Parity**: Enforces the same shell behavior in development containers that will be used in production

### Enforcement Mechanism

The UAP Sentinel (`bin/vde-enforce-uap.zsh`) performs deep content inspection:

```zsh
# Detects native ZSH parameter expansion
grep -r '${(' bin/ lib/ scripts/

# Detects 0-indexed arrays (bash pattern)
grep -r '\[0\]' bin/ lib/ scripts/
```

Any file using bash-specific syntax or bash shebang constitutes a Class-A violation.

---

## Alternatives Considered

### Alternative 1: Allow Bash with Version Pinning
**Rejected**: Bash versions have behavioral differences even with pinning. The shell compatibility matrix would become a maintenance burden, and bash arrays lack the associative array support needed for core functionality.

### Alternative 2: POSIX Shell Compliance
**Rejected**: POSIX shell lacks associative arrays and many modern features required for VDE's sophisticated orchestration logic. It would require complex workarounds that introduce fragility.

### Alternative 3: Shell Abstraction Layer
**Rejected**: Adding a shell abstraction layer would increase complexity and introduce potential bugs in the abstraction itself. The cost outweighs the benefit given that Zsh is available on all target platforms.

### Alternative 4: Multi-Shell Support with Feature Detection
**Rejected**: Runtime feature detection introduces nondeterminism and makes the system harder to audit. The epistemic architecture requires predictable, auditable behavior.

---

## Consequences

### Positive Outcomes

1. **Consistency**: All scripts behave identically across all environments
2. **Auditable**: Single shell implementation makes security and UAP enforcement straightforward
3. **Portability**: Zsh 5.0+ is available on all modern Unix-like systems without configuration
4. **Feature Access**: Native associative arrays and advanced features enable elegant solutions
5. **Production Parity**: Development containers use the same shell as production deployments

### Negative Outcomes

1. **Learning Curve**: Developers unfamiliar with Zsh must learn its syntax and features
2. **Compatibility**: Existing bash scripts cannot be reused without porting
3. **Tool Assumptions**: Some tools assume bash as default shell and may require explicit invocation

### Mitigation Strategies

1. **Documentation**: All guides and examples use Zsh syntax
2. **Onboarding**: Path of the Foundling ritual includes Zsh primer
3. **UAP Enforcement**: Sentinel immediately flags bash usage during development
4. **Templates**: All project templates use Zsh by default

---

## Related Decisions

- **ADR-002**: SSH Bridge Architecture - Also motivated by production parity
- **ADR-003**: Born Ready Containers - Enforces same runtime environment as development
- **UAP Sentinel**: Enforcement mechanism for this decision

---

## References

- `bin/vde-enforce-uap.zsh` - UAP Sentinel implementation
- `bin/check-zsh-shebang.zsh` - Shebang validation script
- `lib/vde-shell-compat` - Shell compatibility library
- `docs/architecture/data-flow.md` - Technical details on enforcement
- `docs/governance/project-philosophy.md` - Epistemic architecture rationale

---

**This is the Way.**
