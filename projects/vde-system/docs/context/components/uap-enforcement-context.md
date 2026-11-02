# UAP Enforcement Context
<!-- @forge (Context Documentation) -->

**Component**: UAP Enforcement (Universal Agent Protocol)  
**Project**: The Forge (@forge)  
**Last Updated**: 2026-04-30

---

## Purpose

The Universal Agent Protocol (UAP) Sentinel enforces architectural compliance across the entire VDE codebase. It is the governance layer that ensures all code, scripts, and configurations adhere to the Resol'nare (Supreme Prohibitions) and architectural mandates.

The sentinel detects violations, enforces standards, and prevents architectural drift. It is the technical manifestation of the Mandalorian Creed at the operational level.

---

## Key Files

### UAP Sentinel
- `bin/vde-enforce-uap.zsh` - Main UAP enforcement script
- `bin/vde-spine-check.zsh` - Four Pillars verification
- `bin/vde-check-tetrad.zsh` - Lightweight technical gate
- `bin/vde-gospel-audit.zsh` - Sovereign Artifact Set validation
- `bin/vde-security-audit.zsh` - Security posture verification

### Audit Scripts
- `bin/vde-armor-heal.zsh` - Armor-specific compliance checks
- `bin/vde-tactical-sweep.zsh` - Comprehensive code audit
- `bin/vde-matrix-audit.zsh` - Cross-reference validation
- `bin/vde-heal-docs.zsh` - Documentation validation

### Enforcement Libraries
- `lib/vde-audit` - Audit function library
- `lib/vde-security` - Security enforcement functions
- `lib/vde-root-guard` - Root privilege protection

---

## Dependencies

### System Dependencies
- **Zsh 5.0+**: Required for native associative array detection
- **Git**: For version control integration
- **File System**: For deep content inspection

### Internal Dependencies
- **Hub System**: Wraps all CLI commands
- **Spoke System**: Validates Spoke compliance
- **Documentation System**: Validates architectural tagging

### External Dependencies
- **None**: Pure ZSH implementation

---

## Integration Points

### APIs Exposed
- **vde-enforce-uap.zsh**: Main enforcement entry point
- **vde-spine-check**: Four Pillars verification
- **vde-check-tetrad**: Technical gate check

### Events Published
- **Violation Events**: Logged with file and line number
- **Compliance Events**: Logged on successful checks
- **Remediation Events**: Logged when violations fixed

### Events Consumed
- **Pre-Commit**: Runs on git commit (via githooks)
- **CLI Execution**: Wraps all vde commands
- **CI/CD**: Runs in GitHub Actions

### Database Interactions
- **None**: Violations logged to stdout/stderr

---

## Architecture Patterns

### UAP Sentinel Pattern
```zsh
#!/usr/bin/env zsh
# @forge (UAP Enforcement)

# Deep content inspection for ZSH purity
detect_fake_zsh() {
    local dir="$1"
    
    # Check for native ZSH parameter expansion
    if grep -r '\${(' "$dir" 2>/dev/null | grep -v '.zwc'; then
        return 0  # True ZSH
    else
        return 1  # Fake ZSH (likely bash)
    fi
}

# Check for bash patterns
detect_bash_patterns() {
    local dir="$1"
    
    # 0-indexed arrays are bash pattern
    if grep -r '\[0\]' "$dir" 2>/dev/null; then
        return 0  # Bash detected
    fi
    
    return 1
}

# Check shebang purity
check_shebang_purity() {
    local dir="$1"
    
    # Find all executable files
    find "$dir" -type f -perm +111 | while read -r file; do
        local shebang=$(head -n 1 "$file")
        
        if [[ "$shebang" =~ '#!/usr/bin/env zsh' ]]; then
            continue  # Valid
        elif [[ "$shebang" =~ '#!/' ]]; then
            echo "VIOLATION: Invalid shebang in $file"
            return 1
        fi
    done
}

# Main enforcement
vde_enforce_uap() {
    local violations=0
    
    echo "🛡️  UAP Sentinel: Starting enforcement..."
    
    # Check ZSH purity
    if ! detect_fake_zsh "bin/" "lib/" "scripts/"; then
        echo "❌ VIOLATION: Non-ZSH shell detected"
        ((violations++))
    fi
    
    # Check for bash patterns
    if detect_bash_patterns "bin/" "lib/" "scripts/"; then
        echo "❌ VIOLATION: Bash patterns detected"
        ((violations++))
    fi
    
    # Check shebang purity
    if ! check_shebang_purity "bin/" "lib/" "scripts/"; then
        echo "❌ VIOLATION: Invalid shebangs detected"
        ((violations++))
    fi
    
    if (( violations > 0 )); then
        echo "❌ UAP ENFORCEMENT FAILED: $violations violation(s)"
        return 1
    else
        echo "✅ UAP ENFORCEMENT PASSED: All checks compliant"
        return 0
    fi
}
```

### Architectural Tagging Detection Pattern
```zsh
# Universal Architectural Regex
detect_tagging_compliance() {
    local file="$1"
    local ext="${file##*.}"
    
    local tag_pattern=""
    case "$ext" in
        zsh|sh|py)     tag_pattern='^# @\(armor\|forge\|shared-law\)' ;;
        md)            tag_pattern='^<!-- @\(armor\|forge\|shared-law\)' ;;
        json)          tag_pattern='"@\\(armor\|forge\|shared-law\)"' ;;
        yml|yaml)      tag_pattern='^# @\(armor\|forge\|shared-law\)' ;;
        *)             return 0  # Skip unknown formats ;;
    esac
    
    # Check lines 2-3 for tag
    if ! head -n 3 "$file" | grep -q "$tag_pattern"; then
        echo "VIOLATION: Missing architectural tag in $file"
        return 1
    fi
    
    return 0
}
```

### Ghost Detection Pattern
```zsh
# Detect "Ghost Zones" (unauthorized root directories)
detect_ghost_zones() {
    local unauthorized_dirs=(
        "/tmp"
        "/var/tmp"
        "$HOME/Downloads"
    )
    
    for dir in "${unauthorized_dirs[@]}"; do
        if [[ -f "$dir/vde-*.zsh" ]] || [[ -d "$dir/.vde" ]]; then
            echo "VIOLATION: Ghost Zone detected in $dir"
            return 1
        fi
    done
    
    return 0
}

# Detect runtime apt calls (Born Ready violation)
detect_runtime_apt() {
    local file="$1"
    
    if grep -q 'apt-get install\|apt install' "$file"; then
        # Check if in Dockerfile (allowed) or script (forbidden)
        if ! [[ "$file" =~ Dockerfile ]]; then
            echo "VIOLATION: Runtime apt call in $file"
            return 1
        fi
    fi
    
    return 0
}
```

---

## Key Architectural Decisions

### Deep Content Inspection
**Decision**: Analyze code content, not just file extensions  
**Rationale**: Detects "Fake ZSH" (bash scripts with zsh shebang)

### Zero-Host Dependency
**Decision**: No external tools (jq, etc.) for enforcement  
**Rationale**: Maintains Scavenger's Ban, uses only ZSH native features

### Fail-Fast Enforcement
**Decision**: Block operations on first violation  
**Rationale**: Prevents architectural drift, forces immediate remediation

### Comprehensive Coverage
**Decision**: Audit all code, tests, docs, and config  
**Rationale**: Architecture is systemic, applies everywhere

---

## Enforcement Categories

### 1. ZSH Purity Enforcement
**Purpose**: Ensure all shell scripts use true ZSH  
**Checks**:
- Native parameter expansion `${(` detection
- 0-indexed array detection (bash pattern)
- Shebang purity verification
- Associative array usage

**Violations**: Class-A (critical)

### 2. Architectural Tagging Enforcement
**Purpose**: Ensure all files have proper tags  
**Checks**:
- Tag presence on line 2 or 3
- Tag validity (@armor, @forge, @shared-law)
- Tag syntax matches file format

**Violations**: Class-A (critical)

### 3. Born Ready Enforcement
**Purpose**: Prevent runtime apt calls  
**Checks**:
- No apt-get install in scripts
- No network-dependent configurations
- All packages installed in Dockerfile

**Violations**: Class-B (serious)

### 4. Ghost Zone Detection
**Purpose**: Prevent unauthorized file locations  
**Checks**:
- No VDE files in /tmp, /var/tmp, Downloads
- No .vde directories in unauthorized locations

**Violations**: Class-B (serious)

### 5. Four Pillars Verification
**Purpose**: Verify Tetrad dependencies  
**Checks**:
- Zsh 5.0+ with native features
- Git 2.30+ with Conventional Commits
- Docker 20.10+ operational
- SSH with vde_student key

**Violations**: Class-A (blocks operations)

---

## Common Operations

### Running UAP Enforcement
```zsh
# Full enforcement check
vde-enforce-uap.zsh

# Output:
# 🛡️  UAP Sentinel: Starting enforcement...
# ✅ ZSH Purity: PASSED
# ✅ Architectural Tagging: PASSED
# ✅ Born Ready: PASSED
# ✅ Ghost Zones: PASSED
# ✅ UAP ENFORCEMENT PASSED: All checks compliant
```

### Four Pillars Check
```zsh
# Verify Tetrad
vde spine-check

# Output:
# 🏗️  Spine Check: Verifying Four Pillars...
# ✅ Pillar I (Zsh): 5.9 PASSED
# ✅ Pillar II (Git): 2.43.0 PASSED
# ✅ Pillar III (Docker): 24.0.7 PASSED
# ✅ Pillar IV (SSH): vde_student key found
# ✅ ALL PILLARS VERIFIED
```

### Gospel Audit
```zsh
# Validate Sovereign Artifact Set
vde-gospel-audit.zsh

# Checks that all 9 documents are in agreement
```

### Security Audit
```zsh
# Verify security posture
vde-security-audit.zsh

# Checks permissions, identity isolation, network segmentation
```

---

## Integration Points

### Pre-Commit Hook
```bash
# .git/hooks/pre-commit
#!/usr/bin/env zsh
# @forge (Pre-Commit UAP Enforcement)

# Run UAP enforcement before commit
if ! bin/vde-enforce-uap.zsh; then
    echo "❌ UAP violation detected. Commit blocked."
    exit 1
fi

# Run tagging validation
if ! bin/vde-tactical-sweep.zsh; then
    echo "❌ Tagging violation detected. Commit blocked."
    exit 1
fi

echo "✅ All checks passed. Committing..."
```

### CLI Wrapper
```zsh
# bin/vde wraps all commands
#!/usr/bin/env zsh

# Source UAP sentinel
source "${VDE_ROOT_DIR}/bin/vde-enforce-uap.zsh"

# Run enforcement
if ! vde_enforce_uap; then
    echo "❌ UAP violation. Command blocked."
    exit 1
fi

# Execute actual command
...
```

### CI/CD Integration
```yaml
# .github/workflows/vde-ci.yml
- name: UAP Enforcement
  run: |
    bin/vde-enforce-uap.zsh
    bin/vde-gospel-audit.zsh
    bin/vde-security-audit.zsh
```

---

## Operational Considerations

### Enforcement Severity
- **Class-A Violations**: Block operations immediately (ZSH purity, Four Pillars)
- **Class-B Violations**: Log warnings but allow continuation (Ghost zones, runtime apt)
- **Class-C Violations**: Informational only (style issues, minor inconsistencies)

### Remediation Workflow
1. UAP detects violation
2. Violation logged with file and line number
3. Operation blocked (Class-A) or warning issued (Class-B/C)
4. Developer fixes violation
5. UAP re-checks
6. Operation proceeds if all checks pass

### Performance Impact
- **Full Enforcement**: ~2-3 seconds for entire codebase
- **Incremental**: <100ms for single file checks
- **CI/CD**: ~5 seconds for comprehensive audit

---

## Troubleshooting

### False Positives
1. Verify ZSH version: `zsh --version`
2. Check file permissions: `ls -la bin/ lib/ scripts/`
3. Review violation details: `vde-enforce-uap.zsh --verbose`

### Persistent Violations
1. Check file type: `file <filename>`
2. Review shebang: `head -n 1 <filename>`
3. Validate syntax: `zsh -n <filename>`

### Pre-Commit Blocking
1. Check git hooks: `ls -la .git/hooks/`
2. Run manually: `bin/vde-enforce-uap.zsh`
3. Fix violations, then commit again

---

## References

- `adr-001-zsh-only-requirement.md` - ZSH-only architectural decision
- `ARCHITECTURAL_PRINCIPLES.md` - UAP specification
- `docs/governance/vde-spec.md` - Mandate of Architectural Tagging
- `bin/vde-enforce-uap.zsh` - UAP Sentinel implementation

---

**This is the Way.**
