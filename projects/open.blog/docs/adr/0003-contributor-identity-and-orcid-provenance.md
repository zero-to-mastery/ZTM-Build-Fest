# ADR 0003: Separate contributor identity from ordered work credits

- Status: Accepted
- Date: 2026-10-23
- Decision issue: [#8](https://github.com/journey-to-code-org/open.blog/issues/8)
- Research: [Contributor identity and ORCID provenance](../research/contributor-identity-and-orcid.md)

## Context

open.blog has one site-level author and no per-work attribution model. Multiple authors,
editors, translators, and research contributors need reusable identities, deterministic
display order, and roles that belong to a particular work. ORCID also distinguishes a
manually entered identifier from one authenticated through OAuth.

The front matter parser intentionally supports flat scalar and list values. Encoding a
structured relationship as delimiter-separated strings would contradict the boundary set
in ADR 0002 and create an ambiguous, project-specific mini-language. Expanding all front
matter into nested YAML would broaden parsing and round-trip behavior far beyond contributor
identity.

## Decision

Add a person-only contributor registry to `openblog.json`. Store each post's ordered,
work-specific credits in an optional adjacent, versioned `<stem>.credits.json` sidecar.
Each credit references a registry key and holds an ordered list of explicit
`{ vocabulary, role }` objects. Initially support the documented Crossref and CRediT
vocabularies. `crossref:author` identifies actual authors; other credited people are
secondary contributors.

When no sidecar exists, resolve the legacy site author as the post's single author. When a
sidecar exists, it is authoritative, including an intentionally empty credit list. Keep the
legacy author for site ownership, footer substitution, and default authorship. Normal load
and save operations never create or rewrite a sidecar for a legacy post.

Treat every ORCID value in editable configuration as manual and unauthenticated. Validate
and normalize its HTTPS URI and checksum offline, but never expose an editable authenticated
flag or infer ownership. Only a future OAuth callback may create authenticated provenance;
that workflow, its token lifecycle, and its offline public binding require a separate
security decision.

The resolved contributor model is a core publishing capability shared by all content
profiles. Themes receive resolved credits; they do not parse sidecars or infer authorship.

## Output contract

- Visible bylines contain actual authors in credit order. A visible contribution disclosure
  preserves contributor and role order.
- JSON-LD uses ordered `author` Persons and secondary `contributor` Persons. Manual ORCID is
  a Person identifier; detailed roles stay in visible disclosure or conservative
  `creditText`.
- Research Highwire repeats `citation_author` for actual authors only, in order.
- Item feeds use resolved post authors. Site/feed ownership remains the legacy site author
  until a distinct publisher model exists.
- Manual ORCID display and Admin Studio guidance explicitly identify unauthenticated
  provenance.

## Consequences

- Existing sites and Markdown remain valid without migration.
- The adjacent JSON file adds a second source artifact for attributed posts; admin rename,
  delete, and publish operations must manage it atomically with the Markdown source.
- Credit relationships are structured and evolvable without expanding the YAML subset.
- CLI-only authors must edit JSON for advanced credits until dedicated commands exist.
- Builds remain deterministic and do not contact ORCID, Crossref, or DataCite.
- Organizations, affiliations, funding, deposits, name-part inference, and OAuth remain
  deferred instead of being approximated by strings.

## Delivery slices

1. Registry, sidecar parser, validation, resolver, diagnostics, and legacy fallback.
2. Visible and generated output, Admin Studio editing, manual ORCID treatment, migration
   tooling, and documentation.
3. OAuth-authenticated ORCID provenance after a separate security decision.

Versions are assigned only after each slice's compatibility impact is known.
