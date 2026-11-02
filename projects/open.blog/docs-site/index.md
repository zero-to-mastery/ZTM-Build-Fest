---
title: open.blog Documentation
nav_order: 1
description: Complete technical documentation for open.blog.
has_children: true
---

# open.blog Documentation

Welcome to the technical documentation suite for **open.blog**.

This guide is built for people who need to:

- run and automate the CLI,
- use the Admin Panel for writing and publishing,
- author high-quality Markdown content, and
- deploy and operate a production blog.

## What you will find here

1. **Quick Start** to get from install to first publish.
2. **CLI Reference** with command patterns and practical workflows.
3. **Admin Panel Guide** for editor, preview, SEO, scheduling, and publishing.
4. **Content Authoring** guidance for Markdown, front matter, and quality checks.
5. **Deployment and Troubleshooting** for GitHub Pages and production operations.

## Documentation map

| Area | Purpose | Primary pages |
| --- | --- | --- |
| Getting Started | Fast path from install to first publish | [Quick Start](./getting-started) |
| CLI | Command usage and operational workflows | [CLI Overview](./cli/overview), [Command Reference](./cli/commands), [CLI Workflows](./cli/workflows) |
| Admin Panel | Browser-based drafting, preview, and publish flow | [Admin Panel Overview](./admin-panel/overview), [Drafting and Preview](./admin-panel/drafts-and-preview), [Publishing and Scheduling](./admin-panel/publishing-and-scheduling) |
| Content Authoring | Markdown conventions, metadata, and quality | [Markdown Style Guide](./content/markdown-style-guide), [Front Matter Guide](./content/front-matter-guide), [Content Quality Checklist](./content/quality-checklist) |
| Advanced Capabilities | Deep product features and operational workflows | [Advanced Capabilities](./advanced/overview), [Architecture and Mental Model](./advanced/architecture-and-mental-model), [Research and Evidence Workflows](./advanced/research-and-evidence-workflows) |
| Operations | Deployment, incidents, and maintenance | [GitHub Pages Deployment](./deployment), [Troubleshooting](./troubleshooting), [Contributing to Docs](./contributing) |
| Releases and Upgrades | Versioning policy, changelog expectations, and migrations | [Versioning and Migrations](./versioning-and-migrations) |
| Help | Quick answers for common operator and author questions | [FAQ](./faq) |

For the complete structure rationale, see [Information Architecture](./information-architecture).

## Audience

This documentation is intended for:

- maintainers running self-hosted blogs,
- authors publishing through Markdown and Admin,
- teams managing editorial workflows and release quality.

## Documentation conventions

- Commands are shown with `openblog` unless otherwise noted.
- Paths are shown relative to a blog root.
- “Admin” means `openblog serve --admin`.

## Next step

Start with [Quick Start](./getting-started).
