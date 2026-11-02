# ADR 0002: Research is a profile; evidence is a cross-profile capability

- Status: Accepted
- Date: 2026-10-23
- Decision issue: [#6](https://github.com/journey-to-code-org/open.blog/issues/6)
- Implementation issue: [#7](https://github.com/journey-to-code-org/open.blog/issues/7)
- Research: [Research and evidence publishing](../research/research-evidence-publishing.md)

## Context

open.blog currently gives each post one content profile. Profiles change the semantics and
output of the whole work: an article and a recipe are different public work types. Citations,
references, identifiers, licenses, and evidence guidance are not mutually exclusive in the
same way. They can support research writing, reporting, recipes, lessons, and ordinary
articles.

The source format intentionally supports flat scalar and list front matter. Contributor
roles, authenticated person identifiers, organization affiliations, funding, venue data,
and typed artifacts are structured relationships. Encoding them as positional strings or
parallel lists would create a fragile project-specific format.

## Decision

Add `research` as an opt-in content profile and create evidence as a reusable core publishing
capability. The research profile will identify the work as a Schema.org
`ScholarlyArticle`; it will not assert peer review, correctness, authority, or scholarly-index
inclusion.

The first release adds only work-level `doi` and `license` front matter. DOI output is
normalized to `https://doi.org/`, but build-time validation remains syntactic and offline.
The existing title, author, date, description, canonical URL, and body remain authoritative.

Citations stay portable: authors use normal Markdown links and footnotes, and write visible
`Abstract` and `References` or `Bibliography` sections. The engine will map resolvable links
from the bounded reference section to Schema.org `citation`; it will not treat every
outbound link as evidence and will not introduce custom citation syntax in this release.

Research pages emit conservative Schema.org metadata and Google-documented Highwire minimum
tags only for values the engine can represent unambiguously. The first release does not emit
the undocumented `citation_doi` tag. Dublin Core HTML and citation-file exports are deferred
until the underlying contributor and publication concepts are richer. The admin provides
structural and syntax guidance without an evidence score or claims about truth, source
quality, peer review, or indexing.

Contributor/ORCID, organization/ROR, funding, venue, CSL/BibTeX processing, typed artifacts,
and review provenance are deferred until each has a structured model. A manually supplied
identity link remains unauthenticated.

## Integration seam

The core owns profile semantics, DOI normalization, reference-section extraction, generated
metadata, and evidence findings. The CLI and admin consume the same findings. Themes render
the core's work model and do not independently infer citations or scholarly status.

The evidence capability must remain usable by other profiles. In v0.9 only the research
profile activates extraction, findings, and scholarly output; ordinary article and recipe
output remains unchanged. A later profile can activate the shared capability without
duplicating its parser or findings.

## Consequences

- The first release is small enough to test without expanding the front matter grammar.
- Source documents remain readable and useful in other Markdown systems.
- Builds remain deterministic and do not depend on DOI, Crossref, ORCID, or ROR services.
- Machine-readable metadata cannot silently outrun visible author content.
- Rich scholarly workflows need follow-up decisions and cannot be represented completely in
  the first release.
- A later citation processor can adopt CSL/BibTeX while retaining plain Markdown as a valid
  baseline.
