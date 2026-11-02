# Development Workflow
<!-- @forge (Context Documentation) -->

**Workflow**: Development and Code Review  
**Project**: The Forge (@forge)  
**Last Updated**: 2026-04-30

---

## Purpose

The development workflow defines how code gets written, reviewed, tested, and integrated into the VDE codebase. It enforces the Mandalorian Creed principles, ensures architectural compliance, and maintains the integrity of the dual-project architecture (Armor + Forge).

This workflow is governed by the Sovereign Charter and implemented via GitHub lifecycle automation.

---

## Core Principles

### 1. The Test of the Two Fires
Before any strike, classify the work:
- **Armor Strike (@armor)**: Satisfies physical runtime requirement for VDE product
- **Forge Strike (@forge)**: Satisfies universal requirement for governed development
- **Shared-Law Strike (@shared-law)**: Modifies foundational bridge or pillars

### 2. The Creed-frame
All technical work must be justified by its improvement to:
- **Foundlings (Students)**: Onboarding and educational experience
- **Reinforcements (New Hires)**: Quick understanding and productivity

### 3. The Symbiotic Covenant
- **Forge mode, Armor mission**: We touch Forge to better build Armor, not for its own sake
- Any Forge change must be evaluated by how well it improves the Armor product

### 4. The Triple-Check Mandate
1. **First Check**: Verify the solution against requirements
2. **Second Check**: Verify against architectural principles
3. **Third Check**: Verify against UAP and governance

---

## Workflow Stages

### Stage 1: The Signet (Issue Creation)

**Purpose**: Define and track work  
**Command**: GitHub Issue  

**Requirements**:
- Title uses Conventional Commits format: `type(scope): description`
- Labels applied: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`
- Impact labels: `breaking-change` (if applicable)
- Linked to epic (if part of larger initiative)

**Template**:
```markdown
## Type
feat/fix/chore/docs/test/refactor

## Scope
Armor/Forge/Shared-Law

## Description
Clear description of what needs to be done

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Foundling/Reinforcement Impact
How this improves student or new hire experience
```

---

### Stage 2: The Strike (Feature Branch)

**Purpose**: Implement changes in isolation  
**Command**: `git checkout -b feat/issue-123-description`

**Branch Naming**:
- `feat/issue-123-add-new-vm-type`
- `fix/issue-456-ssh-connection-failure`
- `chore/issue-789-update-dependencies`

**Development Process**:

1. **Classify Strike**: Determine Armor/Forge/Shared-Law
2. **Write Code**: Follow coding standards and architecture
3. **Architectural Tagging**: Tag every file with `@armor`, `@forge`, or `@shared-law`
4. **UAP Compliance**: Ensure ZSH-only, no bash patterns
5. **Testing**: Write/update tests for changes
6. **Documentation**: Update docs as needed

**Code Standards**:
- All scripts use `#!/usr/bin/env zsh`
- Tags on line 2 or 3
- No runtime apt calls (Born Ready)
- Pure relative pathing (VDE_ROOT_DIR)
- Clear, descriptive function names

---

### Stage 3: The Local Audit

**Purpose**: Verify quality before pushing  
**Commands**:
```zsh
# Run UAP enforcement
bin/vde-enforce-uap.zsh

# Check architectural tagging
bin/vde-tactical-sweep.zsh

# Run tests
bin/run-tests

# Verify Four Pillars
vde spine-check
```

**Pre-Commit Hook**:
Automatically runs:
- UAP enforcement
- Tagging validation
- Format checks
- Basic tests

**Commit Message** (Conventional Commits):
```
type(scope): description

Breaking change: if applicable

Closes #123
```

Examples:
```
feat(armor): add rust vm type to registry

Closes #456

---
Tagging Report:
- data/vm-types.conf: @shared-law (Registry)
- templates/compose-rust.yml: @armor (Template)
- scripts/setup/rust-init.zsh: @armor (USP Script)
```

---

### Stage 4: The Chronicle (Pull Request)

**Purpose**: Code review and integration  
**Command**: GitHub PR  

**Requirements**:
- Title uses Conventional Commits format
- Auto-labeled by type and impact
- Linked to Signet (Issue) with `Closes #N`
- Description includes:
  - Summary of changes
  - Testing performed
  - Tagging Report (all touched files with tags)
  - Screenshots/docs if UI changes

**PR Template**:
```markdown
## Summary
Brief description of changes

## Type
feat/fix/chore/docs/test/refactor

## Scope
Armor/Forge/Shared-Law

## Testing
How changes were tested

## Tagging Report
| File | Tag | Effect |
|------|-----|--------|
| file1.zsh | @armor | Core logic |
| file2.md | @forge | Documentation |

## Foundling/Reinforcement Impact
How this improves student or new hire experience

## Checklist
- [ ] Code follows project style
- [ ] All files tagged
- [ ] UAP compliance verified
- [ ] Tests pass
- [ ] Documentation updated
- [ ] Closes #issue-number
```

---

### Stage 5: The Review

**Purpose**: Quality gate before integration  
**Process**:

1. **Automated Checks** (CI/CD):
   - UAP enforcement
   - Gospel audit (Sovereign Artifact Set)
   - Security audit
   - Unit tests
   - BDD features
   - Tagging validation

2. **Code Review**:
   - Architectural alignment
   - Code quality
   - Test coverage
   - Documentation completeness
   - Foundling/Reinforcement impact

3. **Review Criteria**:
   - Does it improve the Armor product?
   - Is it architecturally sound?
   - Are all files properly tagged?
   - Does it pass UAP?
   - Are tests adequate?

**Approval**: Requires at least one reviewer approval

---

### Stage 6: The Merge

**Purpose**: Integrate changes into develop branch  
**Command**: `gh pr merge --squash`

**Requirements**:
- All automated checks pass
- At least one approval
- No conflicts
- Tagging Report complete
- Linked to Signet (Issue)

**Merge Method**: Squash and merge (clean history)

**Post-Merge**:
- Branch automatically deleted
- Issue automatically closed (if `Closes #N` used)
- Tagging Report archived in PR body

---

## Quality Gates

### Gate 1: Four Pillars Gateway
**Purpose**: Verify system readiness  
**Command**: `vde spine-check`  
**Blocks**: Development if any pillar fails

### Gate 2: UAP Sentinel
**Purpose**: Enforce architectural compliance  
**Command**: `bin/vde-enforce-uap.zsh`  
**Blocks**: Commits with Class-A violations

### Gate 3: Gospel Audit
**Purpose**: Validate Sovereign Artifact Set  
**Command**: `bin/vde-gospel-audit.zsh`  
**Blocks**: Commits that desynchronize Gospel

### Gate 4: Test Suite
**Purpose**: Verify functionality  
**Command**: `bin/run-tests`  
**Blocks**: Commits with failing tests

### Gate 5: Code Review
**Purpose**: Human quality gate  
**Process**: GitHub PR review  
**Blocks**: Merges without approval

---

## Common Workflows

### Adding a New VM Type
```bash
# 1. Create Issue
gh issue create --title "feat(armor): add elixir vm type" --body "..."

# 2. Create Branch
git checkout -b feat/123-add-elixir-vm-type

# 3. Implement
vim data/vm-types.conf
vim templates/compose-elixir.yml
vim scripts/setup/elixir-init.zsh

# 4. Test Locally
vde rebuild elixir
vde create elixir
vde start elixir
vde enter elixir

# 5. Run Checks
bin/vde-enforce-uap.zsh
bin/vde-tactical-sweep.zsh
bin/run-tests

# 6. Commit
git add .
git commit -m "feat(armor): add elixir vm type

Closes #123

---
Tagging Report:
- data/vm-types.conf: @shared-law
- templates/compose-elixir.yml: @armor
- scripts/setup/elixir-init.zsh: @armor"

# 7. Push and Create PR
git push origin feat/123-add-elixir-vm-type
gh pr create --title "feat(armor): add elixir vm type" --body "..."
```

### Fixing a Bug
```bash
# 1. Create Issue
gh issue create --title "fix(armor): ssh connection timeout" --body "..."

# 2. Create Branch
git checkout -b fix/456-ssh-timeout

# 3. Investigate and Fix
# ... debugging ...
vim lib/vde-ssh

# 4. Test Fix
# ... test scenario ...

# 5. Run Checks
bin/vde-enforce-uap.zsh
bin/run-tests

# 6. Commit
git add lib/vde-ssh
git commit -m "fix(armor): resolve ssh connection timeout

Closes #456

---
Tagging Report:
- lib/vde-ssh: @armor"

# 7. Push and Create PR
git push origin fix/456-ssh-timeout
gh pr create --title "fix(armor): resolve ssh connection timeout" --body "..."
```

---

## References

- `docs/development/github-lifecycle.md` - GitHub lifecycle details
- `docs/governance/vde-spec.md` - Chronicle Mandates section
- `docs/governance/sovereign-charter.md` - Test of the Two Fires
- `docs/development/contributing.md` - Contribution guidelines

---

**This is the Way.**
