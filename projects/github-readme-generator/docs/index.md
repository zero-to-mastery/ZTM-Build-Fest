# Documentation

README Studio exports ordinary Markdown/HTML. Its preview is an approximation of GitHub, and optional remote images/widgets depend on their providers.

- [Getting started](getting-started.md)
- [Guided start](guided-start.md) — choose a profile README, repository README or audit goal, keep every earlier Start path, and see where your work is kept
- [Next steps](next-steps.md) — up to three suggested tools after an import, audit, template or blank start; they only open existing reviewed flows
- [Usability scripts](usability-scripts.md) and [findings](usability-findings.md) — scripted task scenarios with step budgets, a facilitator protocol for real sessions, and the Friction tracker; no in-app analytics
- [Editing and recovery](editing.md)
- [Importing source](imports.md)
- [Task tutorials](tutorials.md)
- [Synthetic examples](../examples/README.md)
- [Public formats](public-formats.md)
- [Known limitations](known-limitations.md)
- [Third-party notices](../THIRD_PARTY_NOTICES.md)
- [Portable Studio projects](studio-projects.md)
- [Project schema](project-schema.md) and [migrations](migrations.md)
- [Security](security.md) and [privacy](privacy.md)
- [Workspace navigation, search and settings](workspace.md)
- [Badges and collections](badges.md)
- [Project showcases and packs](projects.md)
- [Themes and visual presets](themes.md)
- [Banners and local SVG assets](banners.md)
- [Section styling](section-styling.md)
- [Components and custom snippets](components.md)
- [External widgets](widgets.md)
- [Portable snippet packs](snippet-packs.md)
- [GitHub data](github-aware.md)
- [Repository README auditing and project types](repository-auditing.md)
- [Improvement plans](repository-auditing.md#improvement-plans) — evidence-backed, advisory recommendations for each audited repository
- [Audit snapshot history](repository-auditing.md#audit-snapshot-history-1910) — explicit, bounded local captures and conservative Added/Resolved/Unknown comparisons
- [README Attention Queue](readme-attention-queue.md)
- [Refreshing generated content](refreshing.md)
- [Analyzer](analyzer.md)
- [Audience review](audience-review.md) — advisory reader perspectives, first-visit checks and explicitly reviewed section ordering
- [Learning studio](learning-studio.md) — optional project-type lessons, synthetic annotated examples and portable advisory checklists
- [Multilingual documentation](multilingual.md) — explicit language editions, conservative translation drift, and language-aware uncertainty
- [GitHub compatibility](compatibility.md)
- [Safe refactors](refactors.md)
- [Optional GitHub publishing](github-publishing.md): [Preflight](github-publishing.md#preflight) and [change set review](github-publishing.md#change-set-review)
- [Asset publishing](assets.md)
- [Workflow generation](workflows.md)
- [Accessibility, recovery and performance checks](hardening.md)
- [Offline authoring and updates](offline.md)
- [Performance and browser baseline](performance.md)
- [Architecture](architecture.md)
- [Rust/WASM core and fallback](rust-core.md)
- [Contributor checks](contributing.md)

The [1.0 readiness audit](releases/1.0-readiness.md) tracks release gates separately from currently available features. It is not a stable-release announcement.

See [repository audit hardening](audit-hardening.md) for conservative placeholder/history findings, optional link checks, retry policy and large-account limits.

In v1.2.0, Improve README / Improve next opens the [repository README builder](repository-builder.md) with an appropriate template and reviewed metadata. Open in Studio still preserves the exact original source.

[Documentation section builders](documentation-sections.md): structured repository sections, command examples, environment-variable placeholders and ordinary Markdown output.

[Project-specific documentation](project-documentation.md): CLI, API, packages, games, Rust crates and web-app recommendations and forms.

- [Stack Intelligence](stack-intelligence.md) — opt-in manifest analysis, including monorepo [Nested discovery](stack-intelligence.md#nested-discovery-monorepos) and per-declaration [Provenance, confidence and staleness](stack-intelligence.md#provenance-confidence-and-staleness).

- [Stack-to-README suggestions](stack-to-readme.md) — review detected stack, commands and links before inserting.

- [Writing Assistant](writing-assistant.md) — optional selected-content AI with Original / Proposed / Diff / Apply.

- [AI safety audit](ai-safety.md) — provider boundaries, imported context and credential handling.

- [Workspace documents](workspace-documents.md) — multiple README sources, independent targets, switching and recovery.

- [Repository worksets](repository-worksets.md) — bounded local repository sets, missing-document visibility, and reviewed portable backup/restore.

- [Documentation suites](documentation-suites.md) — explicitly choose, edit and exact-review a project-appropriate set of local documentation files.

- [Cross-document link checks](document-link-checks.md) — locally resolve relative paths and anchors among workspace documents before export.

- [Example provenance](example-provenance.md) — explicitly label structured commands and examples, then review placeholders before exact copy/export without running source.

- [Shared components](shared-components.md) — reusable Markdown definitions and explicit multi-document update previews.

- [Cross-README updates](cross-readme-updates.md) — affected counts and recipient selection beside document diffs.

- [Batch review](batch-review.md) — attention-queue progression and reviewed common sections for selected repositories.

- [Evidence snapshots](evidence-snapshots.md) — explicit, read-only records of repository revisions, Baselines and change checks for documentation drift.

- [Drift checks](drift-checks.md) — read-only warnings when commands, paths, links or config keys in your Markdown no longer match the repository, with observed mismatches kept apart from heuristics.
- [Reviewed drift fixes](drift-remediation.md) — opt-in, line-by-line edit proposals for drift findings with evidence, exact diffs, per-change approval, conflict rejection and Undo; never published automatically.
