# SECURITY
<!-- @shared-law (Security Policy Documentation) -->

## Sovereign Baseline: 1.5.5

This document defines the security policy, reporting procedures, and automated enforcement mechanisms for the **Virtualized Development Environment (VDE)**.

---

## Supported Versions

| Version | Supported | Notes |
|---------|-----------|-------|
| 1.5.5 | ✅ Yes | Current Sovereign Baseline |
| `stable` branch | ✅ Yes | Recommended for production |
| `develop` branch | ⚠️ Development | Integration branch — not for production |

For production deployments, clone the `stable` branch:
```zsh
git clone -b stable https://github.com/dderyldowney/vde-system.git VDE
```

---

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

### Reporting Channels

| Method | Contact |
|--------|---------|
| **Email** | 133974812+dderyldowney@users.noreply.github.com |
| **GitHub** | Use the [Report a vulnerability](https://github.com/dderyldowney/vde-system/security/advisories/new) button |

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact and severity assessment
- Proof-of-concept or exploit code (if applicable)
- Suggested mitigation (if known)

### Response Timeline

| Severity | Initial Response | Patch Target |
|----------|-----------------|--------------|
| Critical (RCE, data breach) | 24 hours | 48 hours |
| High (privilege escalation) | 48 hours | 7 days |
| Medium (local exploit) | 72 hours | 30 days |
| Low (info disclosure) | 7 days | 90 days |

### Disclosure Process

1. **Acknowledge** — Receipt confirmed within response window
2. **Investigate** — Severity assessed and impact analyzed
3. **Remediate** — Patch developed on isolated security branch
4. **Release** — Fix deployed; coordinated disclosure with reporter
5. **Advisory** — GitHub Security Advisory published (CVE assigned when appropriate)

---

## Automated Security Enforcement

VDE enforces security at multiple layers through automated tooling:

### UAP Enforcer (`bin/vde-enforce-uap.zsh`)

The Universal Agent Protocol Sentinel runs automated security audits on every action:
- **CodeQL Scan** — Detects high/critical vulnerabilities in pushed code
- **Privacy Leak Audit** — Scans for absolute path leaks and credential exposure
- **Shebang Purity** — Enforces ZSH-only execution (no bash/sh)
- **Ghost Zone Detection** — Identifies unauthorized file creation

### Pre-Push Security Hook

No code leaves the local Forge without certification:
- **Proof of Life** — Full lifecycle verification (6 scenarios, 72 steps)
- **Sovereign Audit** — Technical integrity verification
- **Gospel Audit** — Sovereign Artifact Set synchronization check

### Security Audit Tool (`bin/vde-security-audit.zsh`)

Dedicated security audit tooling for comprehensive system inspection:
- File permission verification across all sensitive directories
- SSH identity and key integrity validation
- Network isolation checks for `vde-net`
- Container privilege escalation detection

---

## Security Architecture

### Identity Isolation

- **Dedicated SSH Identity** — `vde_student` key stored in `~/.ssh/vde/`, isolated from user's personal SSH configuration
- **Key Type** — ed25519 (modern, secure, efficient)
- **Revocation** — Delete `~/.ssh/vde/` to revoke all VDE SSH access in one action

### Container Security

| Feature | Implementation |
|---------|---------------|
| **Non-root Execution** | All containers run as `devuser` (non-root) |
| **SSH Authentication** | Key-based only; password authentication disabled |
| **Immutable Images** | Build-time hydration only; no runtime package installs |
| **Volume Separation** | Data volumes decoupled from container lifecycle |

### Network Isolation

- **Dedicated Bridge** — `vde-net` Docker network with `vde.managed=true` label
- **Localhost Binding** — SSH ports exposed on localhost only by default
- **DNS Discovery** — Spoke-to-Spoke resolution via container names (no external DNS)
- **Drift Correction** — Automatic network re-attachment for drifted containers

### File System Hardening

| Path | Mode | Rationale |
|------|------|-----------|
| `.cache/`, `.docker-state/`, `.locks/` | `0700` | Internal state — owner only |
| `data/`, `logs/` | `0700` | Service data — owner only |
| `env-files/` | `0700` | May contain credentials |
| `env-files/*.env` | `0600` | Credential files — owner read/write |
| `~/.ssh/vde/` | `0700` | SSH directory — owner only |
| SSH identity, config, known_hosts | `0600` | SSH files — owner read/write |
| `bin/` scripts | `0755` | Must be executable |

---

## Security Best Practices

### For Foundlings (Students)

- Follow the **Path of the Foundling** onboarding to establish secure defaults
- Never commit `.env` files or secrets to `projects/`
- Use `$HOME/workspace/` inside Spokes for persistent, synced code storage
- Report suspicious behavior to your instructor

### For Operators (Administrators)

- Keep Docker runtime updated to latest stable version
- Rebuild containers periodically with `vde rebuild --no-cache <alias>`
- Monitor base image security advisories
- Restrict host firewall rules for SSH ports if network-accessible
- Review `scripts/setup/` hydration scripts before introducing new VM types

### Secret Management

- Use `env-files/` for environment-specific configuration (automatically protected)
- Never commit credentials, API keys, or tokens to any VDE directory
- Rotate SSH keys periodically via `vde init` re-initialization

---

## The Two Projects: Security Posture

VDE is architected as two distinct projects with different security considerations:

| Project | Scope | Security Model |
|---------|-------|---------------|
| **The Armor** (`@armor`) | Student-facing runtime | AI-blind, Hub-blind, deterministic |
| **The Forge** (`@forge`) | Development governance | AI-governed, audit-enforced, BDD-verified |

The Armor runtime contains no AI components, ensuring a 100% deterministic student environment. The Forge operates under strict UAP enforcement with automated security scanning on every action.

---

## Dependency Security

VDE's core dependencies:

| Dependency | Role | Update Strategy |
|------------|------|----------------|
| **Docker** | Container runtime | Keep updated; monitor advisories |
| **Base Images** | Official language images | Rebuild periodically |
| **Zsh** | Shell runtime | Minimum 5.0 (associative array support) |
| **OpenSSH** | Transversal bridge | System-managed |

---

## Acknowledgments

We thank all security researchers who responsibly disclose vulnerabilities and help keep the VDE ecosystem secure.

---

**Report vulnerabilities privately. Never open a public issue for security concerns.**

This is the Way.
