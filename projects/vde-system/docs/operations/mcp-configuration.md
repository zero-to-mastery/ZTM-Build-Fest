# MCP Configuration Documentation
<!-- @forge (AI Governance) -->

## Overview

This document describes the MCP (Model Context Protocol) server configuration for the VDE project. MCP servers extend the capabilities of AI agents by providing specialized tools for various tasks.

> **MANDATE**: All agents MUST utilize connected MCP servers as their primary interface for system interaction. Documentation updates and technical queries MUST utilize `context7`.

## Configuration Location

The project-specific Kilo configuration is located at:
```
kilo.json
```

Global configuration can be found at:
```
~/.config/kilo/settings.json
```

## Configured Services

| Service | Purpose | Status |
|---------|---------|--------|
| `context7` | Up-to-date documentation and code examples | ✅ Configured |
| `github` | GitHub repository and issue management | ✅ Configured |

## context7

Context7 provides up-to-date documentation and code examples. It is configured to run via `npx`. Ensure you have an internet connection for the first run.

- **Package:** `@upstash/context7-mcp`
- **Purpose:** Prevents outdated or hallucinated API responses by providing real-time documentation.
- **Usage:** "Researcher, use context7 to find the latest Next.js routing patterns."

## GitHub MCP

The GitHub MCP server provides access to repository management, issues, PRs, and code search.

- **Purpose:** GitHub lifecycle automation (Issues, PRs, code search, repository management)
- **Requirement:** `gh` CLI authenticated and active

---

## Troubleshooting

### Check Configuration

```zsh
cat kilo.json | python3 -m json.tool
```

### Verify context7 Connectivity

```zsh
npx -y @upstash/context7-mcp@latest --help
```

---

## References

- [Kilo Documentation](https://kilo.ai/docs)
- [Context7 Documentation](https://github.com/upstash/context7-mcp)
