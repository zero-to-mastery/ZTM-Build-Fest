# Forge Bridge — Agent-Agnostic Local MCP Server
<!-- @shared-law (Forge Component) -->

**Status:** Founding Specification — Pre-Strike  
**Created:** 2026-04-25  
**Author:** Deryl Downey / HAL  
**Project Type:** Sovereign Standalone — Peer to VDE, not a sub-project  
**Target Repo:** TBD (e.g., `github.com/dderyldowney/forge-bridge`)

---

## Vision

Forge Bridge is a locally-hosted, agent-agnostic MCP (Model Context Protocol)
server that exposes the VDE filesystem, git operations, and Forge tooling as
discrete, composable tools callable by any MCP-compatible agent — including but
not limited to Claude (claude.ai chat), Claude Code CLI, Cursor, Windsurf,
Gemini, and any future agent that speaks the MCP spec.

The goal is to close the gap between cloud-hosted AI agents (which have no
native access to the local filesystem) and the live VDE repo at
`~/VDE`, without coupling the solution to any single AI
vendor or runtime.

---

## Design Principles

### 1. Agent-Agnostic by Spec
Forge Bridge is built cleanly against the MCP open protocol with no
Anthropic-specific assumptions. Tool names, descriptions, and response shapes
are written neutrally so any MCP-compatible agent can discover and invoke them
without special knowledge of Claude's conventions.

### 2. Stateless Tool Surface
Every tool call is fully self-contained. No session state is assumed between
calls. The server does not maintain a conversation model or agent context. This
makes the server composable across agents, runtimes, and orchestration layers.

### 3. Sovereign Capability Layer
Forge Bridge exposes VDE-specific capabilities (filesystem ops, git ops, Forge
Gospel reads, Strike audit tools) without encoding any VDE business logic into
the server itself. Logic lives in VDE. The server is a neutral conduit.

### 4. Transport Agnostic
- **stdio** — for local Claude Code CLI and other local agent integrations
- **SSE / Streamable HTTP** — for remote cloud-hosted agents (claude.ai chat
  via tunnel, Gemini, etc.)

Both transports are supported from day one.

### 5. Secure by Default
- Tunnel access (ngrok or Cloudflare Tunnel) for cloud agent connectivity
- No credentials baked into the server — auth via environment variables
- Read-only mode flag for safe inspection without write risk
- Filesystem scope locked to `~/VDE` by default; 
  configurable via `VDE_ROOT_DIR` environment variable but explicit

---

## Tool Surface (Planned)

### Filesystem Tools
| Tool | Description | Hints |
|------|-------------|-------|
| `fs_read_file` | Read file content by path | readOnly |
| `fs_write_file` | Write/overwrite file content by path | destructive |
| `fs_delete_file` | Delete a file by path | destructive |
| `fs_list_dir` | List directory contents with metadata | readOnly |
| `fs_move_file` | Move or rename a file | destructive |
| `fs_create_dir` | Create a directory | idempotent |
| `fs_exists` | Check if a path exists | readOnly |

### Git Tools
| Tool | Description | Hints |
|------|-------------|-------|
| `git_status` | Working tree status | readOnly |
| `git_diff` | Diff working tree or staged changes | readOnly |
| `git_log` | Recent commit log | readOnly |
| `git_add` | Stage files | destructive |
| `git_commit` | Commit staged changes | destructive |
| `git_push` | Push to remote | destructive, openWorld |
| `git_pull` | Pull from remote | destructive, openWorld |
| `git_branch_list` | List branches | readOnly |
| `git_checkout` | Switch or create branch | destructive |

### Forge Gospel Tools
| Tool | Description | Hints |
|------|-------------|-------|
| `gospel_read` | Read a named Gospel file (MEMORY.md, CLAUDE.md, etc.) | readOnly |
| `gospel_write` | Write/update a Gospel file | destructive |
| `gospel_diff` | Diff local Gospel against remote (GitHub) | readOnly, openWorld |
| `gospel_audit` | Run a full Gospel consistency check | readOnly |

### Session / Handover Tools
| Tool | Description | Hints |
|------|-------------|-------|
| `session_read_handover` | Read current session_handover.md | readOnly |
| `session_write_handover` | Write session handover state | destructive |
| `session_phase_status` | Read PROJECT_STATUS.md phase summary | readOnly |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Cloud-Hosted Agents                 │
│   claude.ai (HAL)  │  Gemini  │  Future Agents  │
└──────────────┬──────────────────────────────────┘
               │ MCP over SSE / Streamable HTTP
               │ via Cloudflare Tunnel or ngrok
┌──────────────▼──────────────────────────────────┐
│           Forge Bridge MCP Server                │
│              (FastMCP — Python)                  │
│         Running on localhost:<port> (default 8000)       │
│                                                  │
│  ┌─────────────┐  ┌──────────┐  ┌────────────┐  │
│  │ fs_tools    │  │git_tools │  │gospel_tools│  │
│  └──────┬──────┘  └────┬─────┘  └─────┬──────┘  │
└─────────┼──────────────┼──────────────┼──────────┘
          │              │              │
          └──────────────▼──────────────┘
                 ~/VDE
                      (Local Forge)
                           │
                    Claude Code CLI
                  (also MCP client via stdio)
```

---

## Implementation Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | Python | Deryl's primary language; FastMCP is mature |
| Framework | FastMCP | Pythonic, clean decorator API, Pydantic validation |
| Transport (local) | stdio | Native Claude Code CLI integration |
| Transport (remote) | SSE / Streamable HTTP | cloud agent connectivity |
| Tunnel | Cloudflare Tunnel | Free, stable, no port forwarding needed |
| Auth | API key via env var | Simple, agent-agnostic, no OAuth complexity |
| Schema validation | Pydantic v2 | Consistent with VDE codebase |
| Testing | pytest + MCP Inspector | Per mcp-builder skill guidance |

---

## Open Questions

1. **Tunnel strategy** — Cloudflare Tunnel (persistent domain) vs ngrok 
   (ephemeral URL). Cloudflare preferred for stability but needs a domain.
2. **Auth model** — API key sufficient for single-user local server? Or should 
   we add OAuth for future multi-agent/multi-user scenarios?
3. **Scope lock** — Hard-code VDE root or make it a config parameter? Config is
   more reusable but adds surface area.
4. **Read-only mode** — Should this be a server-level flag or per-tool 
   capability negotiation?
5. **Repo name** — `forge-bridge`? `vde-mcp`? Something more agnostic since 
   this is a peer project, not VDE-specific?

---

## Milestones

| Milestone | Description |
|-----------|-------------|
| M0 — Gospel | This document. Founding spec committed to Drive. |
| M1 — Scaffold | Repo created, FastMCP skeleton, stdio transport working with Claude Code |
| M2 — Filesystem | fs_* tool suite complete and tested |
| M3 — Git | git_* tool suite complete and tested |
| M4 — Tunnel | Cloudflare/ngrok tunnel operational, SSE transport live |
| M5 — Gospel Tools | gospel_* and session_* tools complete |
| M6 — HAL Integration | claude.ai (HAL) successfully calling local VDE tools |
| M7 — Hardening | Auth, scope lock, read-only mode, error handling audit |
| M8 — Sovereign | First non-Claude agent tested and working |

---

## Relationship to VDE

Forge Bridge is a **peer project** to VDE — a sovereign line of work with its
own repo, Gospel, strike cadence, and release notes. It is not a VDE module,
sub-project, or dependency. VDE does not depend on Forge Bridge.

Forge Bridge depends on VDE only in the sense that VDE is its primary initial
target filesystem. Forge Bridge is designed to be reusable against any local
project repo, with any agentic agent (like Gemini CLI+extension, Claude Code, Kilo, etc al.) with minimal configuration.

---

*"This is the Way."*
