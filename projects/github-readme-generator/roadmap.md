Yes. Looking at the actual repo, I’d treat **v0.1.0 as genuinely complete foundation work**, not a prototype. You already have the editor, preview, blocks, templates, badges, stack/projects/social builders, widgets, imports, drafts, health checks, responsive preview, CI, security boundary, and now GitHub profile autofill. 

I’d use each **minor `.0` release for the new capability**, then `.1–.3` to deepen, polish, and harden it. That gives you a predictable rhythm and prevents every PR from ballooning.

## Road to 2.0

| Release | Theme | Main goal |
|---|---|---|
| **1.0.0** | Stable Studio | Profile README authoring, analysis, publishing, portability |
| **1.1.0** | Repository README Audit | Scan repos and identify missing/minimal READMEs |
| **1.1.1** | Project-Type Intelligence | Judge README needs based on app/library/CLI/API/etc. |
| **1.1.2** | README Attention Queue | Prioritize active/important repos needing work |
| **1.1.3** | Audit Hardening | Stale docs, broken links, scale, false-positive tuning |
| **1.2.0** | Repository README Builder | First-class repo README templates and workflows |
| **1.2.1** | Documentation Sections | Installation, usage, config, testing, contributing, API |
| **1.2.2** | Repo-Specific Builders | CLI, library, web app, API, package, crate, game, OSS |
| **1.2.3** | Repo README Polish | Template quality, import/merge, mobile, accessibility |
| **1.3.0** | Stack Intelligence | Inspect manifests and understand actual project stacks |
| **1.3.1** | Dependency Detection | package.json, Cargo.toml, pyproject, go.mod |
| **1.3.2** | Stack DNA | Framework/testing/build/database/tooling classification |
| **1.3.3** | Stack-to-README | Turn detected stack into editable docs suggestions |
| **1.4.0** | Writing Assistant | Optional AI-assisted README writing |
| **1.4.1** | Context-Aware Writing | Use repo/profile/stack context safely |
| **1.4.2** | Rewrite & Compare | Tone/length variants with diff-before-apply |
| **1.4.3** | AI Safety & Provider Abstraction | Privacy, opt-in context, provider boundaries |
| **1.5.0** | Multi-README Workspace | Manage profile + many repo READMEs together |
| **1.5.1** | Shared Components | Reuse badges, sections, banners across repos |
| **1.5.2** | Cross-README Updates | Preview changes across multiple documents |
| **1.5.3** | Batch Review | Improve many repos without unsafe bulk writes |
| **1.6.0** | Dynamic README Studio | Build refreshable README sections |
| **1.6.1** | Data Sources | Releases, RSS, packages, activity |
| **1.6.2** | Workflow Composer 2.0 | Coordinated README automation workflows |
| **1.6.3** | Automation Health | Validate schedules, secrets, outputs, stale actions |
| **1.7.0** | Organization Studio | Profile/org README support and org-aware docs |
| **1.7.1** | Organization Intelligence | Repos, languages, contributors, activity |
| **1.7.2** | Community Documentation | Featured projects, contributing, ecosystem, history |
| **1.7.3** | Large-Org Hardening | Sampling, pagination, API budgets, scale |
| **1.8.0** | Extension Platform | Formal plugin/provider architecture |
| **1.8.1** | Provider SDK | Badge/widget/data-source/analyzer contracts |
| **1.8.2** | Local Extension Packs | Import trusted extension packs |
| **1.8.3** | Extension Security | Permissions, validation, sandbox boundaries |
| **1.9.0** | 2.0 Convergence | Unify audit, multi-README, extensions, dynamic docs |
| **1.9.1** | Schema 2 Prep | Durable migrations for multi-doc workspaces |
| **1.9.2** | Final UX/Perf/A11y | Large workspaces, mobile, offline, extension perf |
| **1.9.3** | 2.0 RC | Feature freeze, migration/security/plugin QA |
| **2.0.0** | README Platform | Multi-README, intelligent, extensible documentation workspace |

### The important progression

**0.2–0.4 = Make beautiful things.**  
Badges → projects → banners/themes.

**0.5–0.6 = Make sophisticated things easily.**  
Reusable components → GitHub-aware generation.

**0.7 = Make the studio smart.**  
This is where Rust finally earns a clear role. Your architecture already deliberately leaves an `analyze(markdown)` boundary for a future WASM implementation, which is exactly where I would introduce it rather than forcing Rust into UI code. 

**0.8 = Make it operational.**  
Instead of “copy this and go to GitHub,” README Studio can actually publish—with diff/confirmation and safe conflict handling.

**0.9 = Stop building features.**  
This is crucial. `0.9.0–0.9.3` should increasingly become stabilization rather than finding three more shiny things to add.

## Some features I'd specifically reserve for 1.0

By 1.0, I’d want someone to be able to come in with **no README**, an **existing messy README**, or a **really advanced hand-written README** and all three users still benefit.

The finished flow should be:

> Import my GitHub → choose what to autofill → build sections visually → generate badges/assets → insert external widgets → edit Markdown directly whenever I want → check GitHub compatibility/accessibility → preview desktop/mobile/light/dark → compare changes → publish safely to GitHub.

And importantly, their resulting `README.md` remains completely ordinary Markdown/HTML with **zero README Studio dependency**.

### One thing I would *not* add before 1.0

I would keep generative AI out of this roadmap for now.

You can always add something like **1.1 “Writing Assistant”** later. Right now the much more distinctive product is:

> **README Studio understands GitHub READMEs exceptionally well.**

There are already endless products that will generate an “About Me” paragraph. Far fewer tools understand `<picture>` dark mode, Shields, GitHub HTML restrictions, badge density, widgets, imported Markdown preservation, repository metadata, safe refreshing, project layouts, responsive rendering, and eventually direct GitHub publishing.

That specialization is your moat.

And your existing v0.1 design around **preserving raw Markdown when the visual builder can’t safely own it** is something I would carry all the way to 1.0. It keeps the tool useful for exactly the sort of nerdy README you already maintain instead of eventually becoming a restrictive template editor. 

# README Studio — 1.1.0 through 2.0.0

Repository:

mnichols08/readme-studio

General rules that apply to EVERY release:

- Inspect current `main` before changing anything.
- Treat all previously released features as baseline.
- Do not rebuild working systems unnecessarily.
- Do not pull future roadmap features into the current release unless required architecturally.
- Preserve ordinary Markdown/HTML as the exported product.
- Preserve raw Markdown exactly whenever structured ownership becomes uncertain.
- Never silently rewrite user content.
- Every GitHub write requires explicit review.
- Every generated transformation requires preview/diff when destructive.
- Keep accessibility, mobile, security, offline behavior, and migration compatibility in scope.
- Maintain `CHANGELOG.md`.
- Update `package.json` to the exact release version.
- Update relevant docs.
- Add/adjust tests.
- Run the complete required test/build suite before completing each release.
- Leave each release in a genuinely releasable state.
- Create a clear release commit/checkpoint before beginning the next release.

Do not implement multiple numbered releases and only bump the version at the end.

---

# v1.1.0 — Repository README Audit

## Goal

Make README Studio capable of scanning a developer's public repositories and identifying which repositories:

- have no README
- have a stub README
- have a minimal README
- have a basic README
- have a detailed README

This is not a score system.

Do not rank developers or assign arbitrary quality percentages.

## Implement

Add a new repository documentation audit workspace.

Given a GitHub username:

1. Fetch public owned repositories.
2. Exclude forks by default.
3. Allow archived repositories to be included/excluded.
4. Fetch the root README for selected repositories using GitHub's README endpoint.
5. Normalize repository + README metadata.
6. Analyze each README using the existing analyzer.
7. Produce evidence-based classifications.

Suggested classifications:

- `missing`
- `stub`
- `minimal`
- `basic`
- `detailed`
- `documentation-heavy`

Classification should consider combinations of:

- README existence
- source length
- meaningful word count
- number of headings
- presence of substantive prose
- images
- examples/code
- installation/setup-like content
- usage-like content
- project links

Avoid classifying solely by word count.

## Audit UI

Add a repository audit view showing:

Repository
README state
Activity status
Primary language
Last push/update
Evidence

Example:

`rustbound-idle`

`Minimal README`

Evidence:
- 112 words
- overview present
- no setup instructions
- no usage/controls section
- active within last 30 days

Actions:

- Open README
- Open repository
- Improve README

## Important language

Use:

- "README needs attention"
- "Minimal documentation"
- "Missing setup information"

Do NOT use:

- bad README
- worst README
- low-quality developer

## Scale

Support at least:

- 100 repositories comfortably
- pagination to 1,000 public repos using current GitHub patterns

Use bounded concurrency for README fetching.

Cache during the session.

## Testing

Cover:

- missing README
- tiny README
- code-only README
- badge-only README
- basic README
- detailed README
- archived repo
- fork exclusion
- partial fetch failures
- rate limits
- deterministic classification

## Release completion

Before completion:

- version = `1.1.0`
- changelog updated
- docs added for repository auditing
- tests pass
- browser tests pass
- build passes

---

# v1.1.1 — Project-Type Intelligence

## Goal

README Studio should recognize that different project types require different documentation.

A tiny CLI and a full-stack web application should not be evaluated using identical expectations.

## Implement

Add a project-type model.

Supported initial types:

- Web App
- Library
- CLI
- API
- npm Package
- Rust Crate
- Python Package
- Game
- PWA
- Documentation
- Open Source Project
- Tutorial
- Experiment
- Generic Repository

Allow:

- automatic suggestion
- manual override

Automatic detection may use public evidence such as:

- repository topics
- primary language
- homepage
- package files already available
- repository name
- README patterns

Do not pretend inference is certain.

Show:

`Suggested type: CLI`

with reason.

## Type-specific README expectations

Create deterministic expectation profiles.

Examples:

### Web App

Relevant:

- overview
- screenshot/demo
- setup
- environment/configuration
- testing
- deployment

### Library

Relevant:

- purpose
- installation
- usage
- API
- compatibility
- examples
- contributing

### CLI

Relevant:

- installation
- commands
- flags/options
- examples
- configuration

### API

Relevant:

- setup
- authentication
- endpoints
- environment
- sample requests/responses

### Game

Relevant:

- overview
- controls
- how to run
- screenshots
- gameplay
- build instructions

### Experiment

A short README may be entirely appropriate.

## Audit integration

Repository Audit should now say:

`Minimal for a Web App`

rather than simply:

`Minimal`.

Evidence should reflect type expectations.

Never claim a missing section is universally required.

Use:

"Commonly useful for this project type."

## Testing

Cover project type suggestion and type-specific expectations.

## Release completion

- version `1.1.1`
- changelog/docs/tests/build
- checkpoint before 1.1.2

---

# v1.1.2 — README Attention Queue

## Goal

Help developers answer:

"Which repository README should I improve next?"

Do this without creating a vanity score.

## Implement

Create:

README Attention Queue

Use descriptive priority signals.

Potential signals:

- no README
- minimal README
- recently active repository
- pinned/featured repository where available
- stars/forks
- homepage/live demo present
- non-archived
- recent release/activity
- project-type gaps

Archived/inactive repositories should generally be deprioritized.

## Priority model

Do not display:

`82/100`.

Instead produce:

### High attention

Active repository with minimal documentation.

### Medium attention

Useful README, but key project-type sections are missing.

### Low attention

Older/archived project with minimal documentation.

Show reasoning.

Example:

`Swing or Cast`

High attention because:

- pushed 3 days ago
- README is minimal
- no build/run instructions
- game controls not documented

## Filters

Allow:

- High / Medium / Low
- missing only
- active only
- archived
- language
- project type
- stars
- pushed recently

## Actions

- Improve next
- Open in Studio
- Ignore for now
- Mark intentionally minimal

"Intentionally minimal" should suppress future nagging unless README changes.

## Testing

Cover deterministic queue ordering and explainability.

## Release completion

Version `1.1.2`.

---

# v1.1.3 — Repository Audit Hardening

## Goal

Make repository auditing reliable enough for real accounts with many repos.

## Implement

Add:

- stale README detection
- placeholder/template-text detection
- broken README links/images using existing health systems
- large-account performance
- bounded concurrency
- retry/rate-limit handling
- partial-result reporting
- false-positive tuning

## Stale docs

Compare:

README last modification if discoverable

against:

recent repository activity

Do not claim documentation is stale solely because repo changed.

Use language:

`README may need review — repository has significant activity after the last observed README update.`

## Placeholder detection

Recognize common unresolved patterns:

- `TODO`
- `your-project-name`
- boilerplate framework README
- untouched starter templates

Do not flag code examples containing these terms.

## Scale target

Test synthetic accounts with:

100
500
1000

repositories.

## Release completion

Version `1.1.3`.

This closes the audit cycle.

---

# v1.2.0 — Repository README Builder

## Goal

Make repository README creation first-class rather than profile-only.

## Implement

Add repository README templates:

- Web App
- Library
- CLI
- API
- npm Package
- Rust Crate
- Python Package
- Game
- Open Source
- Tutorial
- Documentation
- Generic

The user can launch:

`Improve README`

from the audit queue and land directly in an appropriate template.

## Repository context

Carry:

repo name
description
homepage
language
topics
project type

into the builder as reviewed suggestions.

Do not invent content.

## Release completion

Version `1.2.0`.

---

# v1.2.1 — Documentation Section Builders

## Goal

Provide structured builders for common repository documentation.

## Add section types

- Overview
- Features
- Installation
- Quick Start
- Usage
- Configuration
- Environment Variables
- Commands
- API
- Examples
- Architecture
- Testing
- Deployment
- Troubleshooting
- Contributing
- Security
- License
- Roadmap

Every section remains ordinary Markdown.

## Example: Installation

Fields:

Package manager
Install command
Prerequisites
Additional notes

## Example: Environment Variables

Structured rows:

Name
Required
Description
Example placeholder

Never encourage committing real secrets.

## Example: Testing

Commands
Test types
Coverage notes

## Release completion

Version `1.2.1`.

---

# v1.2.2 — Project-Specific Documentation Builders

## Goal

Make the section builder respond intelligently to project type.

## CLI

Add structured:

- install
- command syntax
- commands
- flags/options
- examples

## API

- authentication
- endpoints
- parameters
- request example
- response example

## Library/package

- installation
- import
- basic example
- API surface
- compatibility

## Game

- controls
- gameplay
- running locally
- screenshots
- save/data behavior

## Rust crate

- Cargo dependency
- features
- example
- docs.rs
- crates.io links

## Web app

- demo
- screenshots
- setup
- env
- architecture
- testing
- deployment

## Release completion

Version `1.2.2`.

---

# v1.2.3 — Repository README Builder Hardening

## Goal

Polish the repository README workflow.

## Implement

- safe import into templates
- section matching
- merge existing README with template suggestions
- project-type completeness guidance
- keyboard/a11y audit
- responsive preview
- template quality review
- repository README fixtures
- false-positive tuning

Never replace an existing README with a generated template without diff review.

## Release completion

Version `1.2.3`.

---

# v1.3.0 — Stack Intelligence

## Goal

Understand the actual technologies used by repositories.

Do not confuse detection with developer skill.

## Implement

Create opt-in manifest analysis framework.

Initial language ecosystems:

Node
Rust
Python
Go

Display:

`Detected in selected repositories`

not:

`Skills`.

## Security

Never:

- install dependencies
- execute package scripts
- run repository code
- execute build tools

Read manifests only.

## Release completion

Version `1.3.0`.

---

# v1.3.1 — Dependency Detection

## Add parsers

- package.json
- Cargo.toml
- pyproject.toml
- requirements.txt
- go.mod

Direct dependencies only.

Normalize:

name
ecosystem
dependency kind
repo association

Support:

dependencies
dev dependencies
peer dependencies
build dependencies where applicable.

Cache during session.

## Release completion

Version `1.3.1`.

---

# v1.3.2 — Stack DNA

## Goal

Turn raw dependencies into a meaningful technology model.

## Categories

- Language
- Framework
- Runtime
- Testing
- Build
- Database
- Styling
- State Management
- API
- Deployment
- WebAssembly
- Utility
- Unknown

Create curated deterministic mappings.

Do not AI-classify dependencies.

## Workspace summary

Example:

Core:
React · Node.js · Rust

Testing:
Vitest · Playwright · RTL

Build:
Vite · GitHub Actions

Data:
MongoDB · PostgreSQL

## Release completion

Version `1.3.2`.

---

# v1.3.3 — Stack-to-README

## Goal

Use detected stack to accelerate README documentation.

## Suggestions

From manifests suggest:

- technology badges
- stack sections
- installation commands
- testing commands
- package manager
- build commands
- package/crate links

Every suggestion requires review.

Never claim detected technology means proficiency.

## Release completion

Version `1.3.3`.

---

# v1.4.0 — Writing Assistant

## Goal

Introduce optional AI assistance without making README Studio AI-dependent.

## Actions

- Draft section
- Improve wording
- Shorten
- Expand
- Make more technical
- Make more casual
- Turn notes into bullets
- Turn bullets into paragraph
- Grammar cleanup

Operate primarily on selected content or selected section.

## Mandatory UX

Original
Proposed
Diff
Apply

Never replace immediately.

## Release completion

Version `1.4.0`.

---

# v1.4.1 — Context-Aware Writing

## Goal

Allow users to explicitly give the writing assistant trusted context.

Selectable context:

- GitHub profile
- selected repository
- project type
- Stack DNA
- project metadata
- selected section
- current writing style

Show exactly what context will be sent.

Never silently send whole workspace.

## Grounding rule

Generated text must use supplied facts only when making factual claims.

If context doesn't support a claim, omit it.

## Release completion

Version `1.4.1`.

---

# v1.4.2 — Rewrite & Compare

## Goal

Improve author control over AI suggestions.

Generate distinct alternatives such as:

- Concise
- Technical
- Friendly

Allow side-by-side comparison.

Also support transformations:

long → short
paragraph → bullets
bullets → paragraph
technical notes → README summary

Apply remains diff-reviewed.

## Release completion

Version `1.4.2`.

---

# v1.4.3 — AI Safety & Provider Abstraction

## Goal

Make AI optional, transparent, and replaceable.

## Implement

Provider abstraction.

No provider should be hardwired into document logic.

Settings should make clear:

- provider
- what context is transmitted
- whether API key is required
- where data goes

Never persist keys in project exports.

Support complete non-AI workflow.

Audit prompt injection possibilities from imported repository content.

Treat repo/README content as untrusted context.

## Release completion

Version `1.4.3`.

---

# v1.5.0 — Multi-README Workspace

## Goal

Manage many README documents in one Studio workspace.

## Workspace model

Example:

Profile
- mnichols08/README.md

Repositories
- constellation/README.md
- readme-studio/README.md
- game/README.md

Each document:

- has independent Markdown
- independent GitHub target
- independent health
- independent undo
- recoverable source

## Workspace navigation

Add document switcher.

Audit queue can open documents directly.

## Release completion

Version `1.5.0`.

---

# v1.5.1 — Shared Components

## Goal

Reuse common documentation across multiple READMEs.

Shared examples:

- Contributing footer
- Testing stack
- Security section
- Sponsor/contact block
- common badge row
- organization/community links

Shared components must not silently update documents.

Changes produce preview.

## Release completion

Version `1.5.1`.

---

# v1.5.2 — Cross-README Updates

## Goal

Preview shared changes across documents.

Example:

Update Testing Stack

Affected:
8 READMEs

Show per-document diff.

User chooses which documents receive update.

No global auto-write.

## Release completion

Version `1.5.2`.

---

# v1.5.3 — Batch Review

## Goal

Combine audit queue + multi-document workspace.

Support:

`Improve next`

and reviewed batches.

Example:

12 READMEs need attention

Open first.

After resolving:
move to next.

Optional batch operation:

add same Contributing section to selected repos

must show each resulting diff.

No mass publish without explicit document-level review.

## Release completion

Version `1.5.3`.

---

# v1.6.0 — Dynamic README Studio

## Goal

Create blocks intended to refresh automatically through generated workflows.

## Initial dynamic blocks

- Recent releases
- Latest blog posts
- Package version
- Recent GitHub activity
- Active projects

Structured configuration should generate:

- fallback/static content
- workflow where necessary

## Release completion

Version `1.6.0`.

---

# v1.6.1 — Data Sources

## Add adapters

- GitHub releases
- GitHub repo metadata
- RSS
- Atom
- npm
- crates.io

Adapters normalize data.

Do not execute arbitrary feed HTML.

Sanitize descriptions.

## Release completion

Version `1.6.1`.

---

# v1.6.2 — Workflow Composer 2.0

## Goal

Coordinate dynamic README tooling.

Create workflow planner such as:

Daily README refresh

- Blog posts
- Constellation
- Snake
- Releases
- Package versions

Avoid creating unnecessary separate workflows when one coordinated workflow is practical.

Show:

triggers
permissions
secrets
outputs

## Release completion

Version `1.6.2`.

---

# v1.6.3 — Automation Health

## Goal

Analyze generated/existing workflows.

Check:

- invalid YAML where parsable
- bad cron
- duplicate schedules
- missing secrets
- overly broad permissions
- output path collisions
- stale action references when known
- broken feed/source configuration

Do not claim to fully validate GitHub Actions execution.

## Release completion

Version `1.6.3`.

---

# v1.7.0 — Organization Studio

## Goal

Support GitHub organization profile/repository documentation.

Auto-detect user vs organization.

Add organization README templates.

Org mode should remain documentation-centered.

## Release completion

Version `1.7.0`.

---

# v1.7.1 — Organization Intelligence

## Analyze public org data

- repositories
- languages
- topics
- activity
- contributors where practical
- README coverage

Distinguish sampled contributor counts from complete counts.

Large orgs require bounded strategies.

## Organization README Audit

Show:

- missing READMEs
- minimal READMEs
- strong docs
- active projects needing docs

## Release completion

Version `1.7.1`.

---

# v1.7.2 — Community Documentation

## Add organization blocks/templates

- Featured Projects
- How to Contribute
- Community
- Ecosystem
- Active Projects
- Organization History
- New Contributor Guide
- Code of Conduct link
- Security
- Governance links

Use public organization context as suggestions.

## Release completion

Version `1.7.2`.

---

# v1.7.3 — Large Organization Hardening

## Scale targets

50
500
1500+

repos.

Implement:

- pagination
- request budget
- deterministic representative sampling
- partial results
- cache
- bounded contributor scans
- rate-limit handling

Synthetic scale fixtures required.

## Release completion

Version `1.7.3`.

---

# v1.8.0 — Extension Platform

## Goal

Stop requiring core README Studio to implement every README trick.

Create safe extension architecture.

## Extension categories

- Component
- Template
- Widget
- Badge Provider
- Data Source
- Analyzer Rule
- Refactor
- Repository Auditor

Prefer declarative extension definitions.

No arbitrary third-party JS execution by default.

## Release completion

Version `1.8.0`.

---

# v1.8.1 — Provider SDK

## Goal

Formalize extension contracts.

Examples:

Widget provider
Badge provider
Data source
Analyzer rule

Provide documented schemas.

Example conceptual definition:

{
  id,
  type,
  fields,
  template,
  validation,
  permissions
}

No eval.

Build example extensions.

## Release completion

Version `1.8.1`.

---

# v1.8.2 — Local Extension Packs

## Goal

Allow importing extension packs from:

- local file
- GitHub URL/repository

Validate schema before install.

Show:

name
publisher metadata
capabilities
domains
components included

User explicitly enables.

No centralized marketplace yet.

## Release completion

Version `1.8.2`.

---

# v1.8.3 — Extension Security

## Goal

Harden extensions before 2.0.

Implement capability permissions such as:

- markdown-template
- github-read
- remote-image
- network-domain
- analyzer-rule
- refactor

Extensions should not automatically receive GitHub write capabilities.

Require stronger trust for anything involving network access.

Add:

- package signature/hash metadata where feasible
- schema validation
- permission review
- disable/remove extension
- extension isolation

## Release completion

Version `1.8.3`.

---

# v1.9.0 — 2.0 Convergence

## Goal

Unify all mature 1.x systems.

No major new feature family.

Focus UI around:

Workspaces
Documents
Audit
Build
Review
Automation
Extensions
Publish

Avoid overwhelming navigation.

## Power workflow

A user should be able to:

Audit GitHub
→ select weak README
→ open repo document
→ detect stack
→ build missing sections
→ analyze
→ refactor
→ publish
→ move to next

## Release completion

Version `1.9.0`.

---

# v1.9.1 — Schema 2 Preparation

## Goal

Prepare durable multi-document workspace schema for 2.0.

Concept:

{
  schemaVersion: 2,
  workspace,
  documents: [],
  sharedComponents: [],
  assets: [],
  dataSources: [],
  extensions: [],
  githubTargets: []
}

Every document MUST contain recoverable Markdown source.

Migration from 1.x schemas must be deterministic.

Future schema versions must never be overwritten.

## Release completion

Version `1.9.1`.

---

# v1.9.2 — Final UX / Performance / Accessibility

## Goal

2.0 quality pass.

Test real/synthetic large workspace:

- 50 README docs
- 1000 repositories in audit
- 100 projects
- 500 badges
- 200 components
- multiple extensions
- WASM analyzer
- GitHub publishing

Audit:

- mobile
- keyboard
- screen readers
- workers
- memory
- object URLs
- extension performance
- offline
- sync-free workflows
- publishing

No new major features.

## Release completion

Version `1.9.2`.

---

# v1.9.3 — 2.0 Release Candidate

## Feature freeze

Allowed:

- bugs
- security
- migrations
- accessibility
- performance
- docs
- UX clarification

No new feature families.

## Migration matrix

Test representative:

1.0
1.1
1.2
1.3
1.4
1.5
1.6
1.7
1.8
1.9

workspaces into schema 2.

## Full acceptance flows

### Profile user

Profile README import/build/publish.

### Repo maintainer

Audit repos → improve README → publish.

### Multi-repo maintainer

Batch review → shared components → reviewed publishes.

### Organization

Audit org → build community docs.

### Extension user

Install local extension → review permissions → use → remove.

### AI user

Selected-context writing → diff → apply.

### No-AI/no-auth user

Everything core remains usable locally.

## Security review

Audit:

- Markdown
- SVG
- OAuth
- GitHub write
- AI context
- extensions
- workflow generation
- JSON imports
- URLs
- organization data

## Documentation

Complete 2.0 docs and examples.

## Release completion

Version `1.9.3`.

Prepare but do not yet tag 2.0.

---


