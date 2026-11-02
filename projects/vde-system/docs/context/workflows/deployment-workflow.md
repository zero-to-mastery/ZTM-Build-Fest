# Deployment Workflow
<!-- @forge (Context Documentation) -->

**Workflow**: Release Ritual and Branching Strategy  
**Project**: The Forge (@forge)  
**Last Updated**: 2026-04-30

---

## Purpose

The deployment workflow defines the **Release Ritual**—the sacred process of promoting code from development to production. It enforces the Sovereign Branching Strategy, ensures the Sovereign Artifact Set is in perfect agreement, and maintains the purity of the Sovereign Baseline.

This workflow is the formal mechanism by which the Forge certifies that the Armor is battle-ready for Foundlings.

---

## Branching Strategy

### The Sovereign Branches

#### 1. `develop` (The Anvil)
- **Purpose**: Primary integration branch
- **Status**: Default branch for the repository
- **Workflow**: All feature branches branch from and merge to develop
- **Protection**:
  - Requires PR for merges
  - Status checks must pass
  - At least one approval required

#### 2. `main` (The Sovereign Baseline)
- **Purpose**: Stable production branch
- **Status**: Represents immutable releases
- **Workflow**: Receives merges from develop during release
- **Protection**:
  - Requires PR for merges (develop → main)
  - All status checks must pass
  - At least two approvals required
  - **ALL step tagging (X.X.X) and GitHub releases MUST occur on this branch**

#### 3. `stable` (The Living Mark)
- **Purpose**: Always points to current certified main SHA
- **Status**: Automated alias
- **Workflow**: Overwritten by release ritual after main merge
- **Protection**: Force push allowed (for automation)

#### 4. Feature Branches (The Strike)
- **Purpose**: Isolated development work
- **Naming**: `feat/`, `fix/`, `chore/`, `docs/`, `test/`, `refactor/`
- **Lifecycle**: Branch from develop → merge to develop → delete

---

## The Release Ritual

### Pre-Release Checklist

Before initiating release ritual, verify:

1. **All Chronicles Merged**: All approved PRs merged to develop
2. **Tests Pass**: Full test suite passes on develop
3. **Gospel Agreement**: All 9 Sovereign Artifact documents in sync
4. **UAP Compliance**: No violations in codebase
5. **Documentation Updated**: docs/changelogs/current.md, docs/governance/vde-spec.md, etc.
6. **No Blocking Issues**: No open issues blocking release

### Step 1: Create Release Branch (Optional)
```bash
# For major/minor releases, create release branch
git checkout develop
git checkout -b release/1.6.0

# Finalize release notes
vim docs/changelogs/current.md

# Update version in docs/governance/vde-spec.md
vim docs/governance/vde-spec.md

# Commit release prep
git add docs/changelogs/current.md docs/governance/vde-spec.md
git commit -m "chore(release): prepare 1.6.0 release"
```

### Step 2: Merge to Main
```bash
# For simple step releases, merge develop directly
gh pr create --base main --title "Release 1.6.0" --body "..."
# Get approvals, then:
gh pr merge --squash

# For release branch:
git checkout main
git merge release/1.6.0
git push origin main
```

### Step 3: Tag the Release
```bash
# Tag the merge SHA on main
git tag -a 1.6.0 -m "Release 1.6.0 - The Sovereign Evolution"
git push origin 1.6.0
```

**CRITICAL**: Tags MUST be applied to the main branch SHA, not develop

### Step 4: Create GitHub Release
```bash
# Create GitHub Release from tag
gh release create 1.6.0 \
  --title "VDE 1.6.0 - The Sovereign Evolution" \
  --notes-file docs/changelogs/current.md
```

### Step 5: Update Stable Alias
```bash
# Force push main SHA to stable
git checkout stable
git reset --hard main
git push --force origin stable
```

### Step 6: Back-Merge to Develop
```bash
# Merge main back to develop for future development
git checkout develop
git merge main
git push origin develop
```

### Step 7: Update Project Status
```bash
# Update PROJECT_STATUS.md
vim PROJECT_STATUS.md

# Commit and push
git add PROJECT_STATUS.md
git commit -m "docs(status): update project status for 1.6.0"
git push origin develop
```

---

## Versioning Strategy

### SemVer 2.0.0 Format
```
MAJOR.MINOR.STEP-spN
```

### Version Components

#### MAJOR (X.0.0)
- **When**: Breaking architectural changes, new major features
- **Impact**: May require migration or significant user action
- **Examples**:
  - 1.0.0 → 2.0.0: Complete architecture redesign
  - 2.0.0 → 3.0.0: Removal of deprecated features

#### MINOR (0.X.0)
- **When**: New features, backward-compatible changes
- **Impact**: New functionality, no breaking changes
- **Examples**:
  - 1.5.0 → 1.6.0: Add new VM type system
  - 1.6.0 → 1.7.0: Add new governance features

#### STEP (0.0.X)
- **When**: Bug fixes, small improvements, documentation
- **Impact**: No breaking changes, minimal impact
- **Examples**:
  - 1.5.0 → 1.5.1: Fix SSH connection issue
  - 1.5.1 → 1.5.2: Improve error messages

#### Security Patch (spN)
- **When**: Security fixes, critical vulnerabilities
- **Impact**: Urgent security updates
- **Examples**:
  - 1.5.1 → 1.5.1-sp1: Fix SSH key exposure
  - 1.5.1-sp1 → 1.5.1-sp2: Patch container escape vulnerability

---

## Sovereign Artifact Set Validation

Before any release tag, these 9 documents MUST be in perfect agreement:

1. **docs/architecture/overview.md** - The Strategy
2. **docs/architecture/data-flow.md** - The Mechanics
3. **docs/changelogs/current.md** - The Archive
4. **docs/governance/vde-spec.md** - The Gospel Lead & Version Arbiter
5. **USE_CASES.md** - The Audit
6. **VDE_ANALYSIS.md** - The Engineering Verdict
7. **PROJECT_STATUS.md** - The Living Heartbeat
8. **docs/governance/sovereign-charter.md** - The Dual-Mission Constitution
9. **docs/api/library-api.md** - The Main Library

### Validation Command
```bash
# Run Gospel audit
bin/vde-gospel-audit.zsh

# Output:
# 📜 Gospel Audit: Validating Sovereign Artifact Set...
# ✅ docs/architecture/overview.md: PASSED
# ✅ docs/architecture/data-flow.md: PASSED
# ✅ docs/changelogs/current.md: PASSED
# ✅ docs/governance/vde-spec.md: PASSED (Version: 1.6.0)
# ✅ USE_CASES.md: PASSED
# ✅ VDE_ANALYSIS.md: PASSED
# ✅ PROJECT_STATUS.md: PASSED
# ✅ docs/governance/sovereign-charter.md: PASSED
# ✅ docs/api/library-api.md: PASSED
# ✅ GOSPEL AUDIT PASSED: All 9 documents in agreement
```

---

## Release Types

### Step Release (Routine)
**Frequency**: Weekly or as needed  
**Process**: develop → main → tag → release  
**Duration**: ~30 minutes  
**Risk**: Low  
**Example**: 1.5.1 → 1.5.2

### Minor Release (Feature)
**Frequency**: Monthly or quarterly  
**Process**: release branch → develop → main → tag → release  
**Duration**: ~2 hours  
**Risk**: Medium  
**Example**: 1.5.0 → 1.6.0

### Major Release (Architecture)
**Frequency**: Annually or as needed  
**Process**: release branch → develop → main → tag → release  
**Duration**: ~1 day  
**Risk**: High  
**Example**: 1.0.0 → 2.0.0

### Security Release (Urgent)
**Frequency**: As needed  
**Process**: develop → main → tag → release (skip merge back)  
**Duration**: ~15 minutes  
**Risk**: High (but necessary)  
**Example**: 1.5.1 → 1.5.1-sp1

---

## Rollback Procedure

If critical issue discovered after release:

### Step 1: Assess Severity
```bash
# Determine if rollback is necessary
# Consider: Security impact, user impact, workaround availability
```

### Step 2: Create Hotfix Branch
```bash
git checkout main
git checkout -b hotfix/critical-issue
```

### Step 3: Fix and Test
```bash
# Implement fix
# Run full test suite
# Verify in production-like environment
```

### Step 4: Security Patch Release
```bash
git commit -m "fix(security): critical security fix"
git checkout main
git merge hotfix/critical-issue
git tag 1.5.1-sp1
git push origin 1.5.1-sp1
gh release create 1.5.1-sp1 --notes "Security patch for critical issue"
```

### Step 5: Update Stable
```bash
git checkout stable
git reset --hard main
git push --force origin stable
```

### Step 6: Back-Merge
```bash
git checkout develop
git merge main
git push origin develop
```

---

## Post-Release Tasks

### 1. Update Documentation
- [ ] Verify docs/changelogs/current.md is complete
- [ ] Update docs/guides/getting-started.md if features changed
- [ ] Update docs/operations/installation.md if installation changed
- [ ] Update CHANGELOG if maintained

### 2. Communicate Release
- [ ] Announce in repository (GitHub Release)
- [ ] Notify team/stakeholders
- [ ] Update website/docs if applicable
- [ ] Post to communication channels

### 3. Monitor
- [ ] Watch for issues in first 24 hours
- [ ] Monitor error logs
- [ ] Gather user feedback
- [ ] Prepare for hotfix if needed

### 4. Archive
- [ ] Tag release branch if used
- [ ] Archive release notes
- [ ] Update metrics
- [ ] Document lessons learned

---

## Common Workflows

### Weekly Step Release
```bash
# 1. Verify develop is stable
git checkout develop
git pull origin develop
bin/run-tests

# 2. Create PR to main
gh pr create --base main --title "Release 1.5.2" --body "..."

# 3. Get approvals and merge
gh pr merge --squash

# 4. Tag and release
git tag 1.5.2
git push origin 1.5.2
gh release create 1.5.2 --notes-file docs/changelogs/current.md

# 5. Update stable
git checkout stable
git reset --hard main
git push --force origin stable

# 6. Back-merge
git checkout develop
git merge main
git push origin develop
```

### Security Hotfix
```bash
# 1. Create hotfix branch
git checkout main
git checkout -b hotfix/security-fix

# 2. Implement fix
# ... code changes ...

# 3. Test thoroughly
bin/run-tests

# 4. Merge and release
git checkout main
git merge hotfix/security-fix
git tag 1.5.1-sp1
git push origin 1.5.1-sp1
gh release create 1.5.1-sp1 --notes "Critical security fix"

# 5. Update stable
git checkout stable
git reset --hard main
git push --force origin stable
```

---

## References

- `docs/governance/vde-spec.md` - Sovereign Branching Strategy section
- `docs/development/github-lifecycle.md` - GitHub lifecycle details
- `docs/changelogs/current.md` - Release history
- `PROJECT_STATUS.md` - Current system status

---

**This is the Way.**
