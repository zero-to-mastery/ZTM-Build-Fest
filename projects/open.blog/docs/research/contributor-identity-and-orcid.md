# Contributor identity and ORCID provenance

Research date: 2026-10-23

## Summary

open.blog should separate reusable person identity from a person's ordered, work-specific
credits. The smallest safe model is a contributor registry in `openblog.json` plus an
adjacent, versioned JSON credit sidecar for a post. Existing posts without a sidecar keep
using the single site author, so adoption is additive and does not rewrite Markdown.

An ORCID iD typed into editable configuration is manual and unauthenticated. The engine can
validate its URI shape and checksum offline, but only a later OAuth-backed workflow may
create authenticated provenance. Author order, secondary contribution, and CRediT roles
must remain distinct so visible attribution and machine-readable metadata do not overstate
authorship.

## Verified findings

### Current open.blog boundary

- `SiteConfig` currently contains one `Author` with `name`, `url`, `email`, and `sameAs`.
  That identity supplies post bylines, structured data, research `citation_author` tags,
  and feed authors
  ([configuration model](../../crates/openblog-core/src/config.rs),
  [renderer](../../crates/openblog-core/src/render.rs),
  [feeds](../../crates/openblog-core/src/feeds.rs)).
- Posts do not contain an author or contributor relationship. The front matter parser
  intentionally supports scalar strings and string lists and rejects nested values
  ([post model](../../crates/openblog-core/src/model.rs),
  [front matter parser](../../crates/openblog-core/src/frontmatter.rs)).
- The accepted research-profile decision explicitly deferred contributor roles and
  authenticated person identifiers until a structured model exists
  ([ADR 0002](../adr/0002-research-profile-and-evidence-capability.md)).

### Author order and contribution roles

- Google Scholar requires a separate `citation_author` tag for each actual author. It says
  not to put a site owner, advisor, or other contributor in that field and requires at
  least one actual author for its minimum metadata
  ([Google Scholar inclusion guidance](https://scholar.google.com/intl/en/scholar/inclusion.html#indexing)).
- Crossref contributor metadata preserves document order for practical display. Its current
  schema supports multiple roles with explicit Crossref or CRediT vocabularies, and it
  distinguishes an author from other contribution roles
  ([Crossref contributor guidance](https://www.crossref.org/documentation/schema-library/markup-guide-metadata-segments/contributors)).
- CRediT defines 14 contribution roles. It is designed to describe contributions, not to
  decide who qualifies as an author; one person may hold several roles and one role may
  apply to several people
  ([CRediT roles](https://credit.niso.org/contributor-roles/),
  [role definitions](https://credit.niso.org/contributor-roles-defined%20/)).
- DataCite separates creators from broader contributors, supports repeated name identifiers,
  and recommends a full ORCID URL with its scheme
  ([DataCite Metadata Schema](https://schema.datacite.org/),
  [DataCite name identifier guidance](https://support.datacite.org/docs/what-is-the-recommended-format-for-including-nameidentifiers-in-the-datacite-metadata)).

### ORCID provenance

- An ORCID iD has a 16-character ISO/IEC 7064 MOD 11-2 identifier and is displayed as a
  full `https://orcid.org/...` URI. Shape and checksum can be checked without a network
  lookup, but those checks do not establish registry existence or ownership
  ([ORCID identifier structure](https://support.orcid.org/hc/en-us/articles/360006897674-Structure-of-the-ORCID-Identifier)).
- ORCID distinguishes authenticated iDs collected from the record holder from
  unauthenticated iDs entered manually or obtained elsewhere. Its display rules require an
  unauthenticated iD to be identified as unauthenticated
  ([ORCID display guidelines](https://info.orcid.org/documentation/integration-guide/orcid-id-display-guidelines/)).
- An integration claiming authenticated collection must use OAuth and store the returned
  identity and token data. Manual entry must not be presented as that workflow
  ([ORCID minimum integration requirements](https://info.orcid.org/documentation/integration-guide/minimum-requirements-for-member-integrations/),
  [ORCID OAuth guidance](https://info.orcid.org/documentation/integration-guide/orcid-oauth-sign-in-guidelines/)).

### Web metadata

- Schema.org `author` and `contributor` accept a `Person` or `Organization`; `contributor`
  describes a secondary contributor. `Role` exists, but it is not in the documented range
  of those two properties. `identifier` can carry a URL and `creditText` can carry a
  human-readable credit statement
  ([author](https://schema.org/author), [contributor](https://schema.org/contributor),
  [Role](https://schema.org/Role), [identifier](https://schema.org/identifier),
  [creditText](https://schema.org/creditText)).

## Recommended contract

This section is an engineering recommendation derived from the sources and repository
constraints above.

### Reusable identity

Add a person-only contributor registry to `openblog.json`, keyed by a stable ASCII slug:

```json
{
  "contributors": {
    "ada": {
      "name": "Ada Lovelace",
      "url": "https://ada.example",
      "sameAs": [],
      "orcid": "https://orcid.org/0000-0002-1825-0097"
    }
  }
}
```

`name` is required. `url`, `sameAs`, and `orcid` are optional. Do not split a display name
into guessed given and family names. Organizations belong to the later affiliation and
funding decision.

Every `orcid` value in this editable registry is manual by construction. Normalize the full
HTTPS URI and validate its checksum offline. Do not expose an `authenticated: true` switch,
resolve the record during a build, or describe the value as verified.

### Work-specific credits

Store ordered relationships in an adjacent sidecar named after the Markdown source:

```text
content/posts/my-study.md
content/posts/my-study.credits.json
```

The first version has this shape:

```json
{
  "version": 1,
  "credits": [
    {
      "contributor": "ada",
      "roles": [
        { "vocabulary": "crossref", "role": "author" },
        { "vocabulary": "credit", "role": "conceptualization" }
      ]
    },
    {
      "contributor": "grace",
      "roles": [
        { "vocabulary": "crossref", "role": "editor" },
        { "vocabulary": "credit", "role": "software" }
      ]
    }
  ]
}
```

Arrays preserve contributor order and authored role order. Explicit vocabulary and role
properties avoid positional strings, parallel arrays, and a project-specific front matter
mini-language. The sidecar is versioned so future migrations can be explicit.

Accept the documented Crossref roles and 14 CRediT values. Reject unknown vocabularies,
unknown roles, duplicate contributor rows, duplicate roles, and missing registry keys with
source-scoped diagnostics. `crossref:author` determines the ordered author set. A contributor
appears only once in author output even when they also have CRediT roles.

### Compatibility and migration

1. If no adjacent sidecar exists, synthesize one author credit from `config.author`. Preserve
   legacy visible and generated output where practical.
2. If a sidecar exists, it is authoritative. An empty `credits` array explicitly opts out
   of inherited authorship; research Highwire output is then omitted because no actual
   author is available.
3. Keep legacy `author` for site ownership, footer substitution, and default authorship.
   Do not silently reinterpret or delete it.
4. The admin should create, update, rename, and delete a post's sidecar with the post while
   preserving source order. Loading or saving an old post must not create a sidecar merely
   because the post was opened.
5. A later explicit migration command may register the legacy author and create sidecars.
   It must preview its changes and never rewrite content during normal load.

### Output mapping

- Show ordered authors near the title and link their configured profiles. Show a visible
  Contributions disclosure for all credited people and roles; roles are attribution, not
  quality or authority badges.
- Display a manual ORCID with ORCID's required unauthenticated treatment. The admin should
  state the same provenance plainly.
- Emit an ordered Schema.org `author` array for people with the author role and a
  `contributor` array for nonauthors. Emit the ORCID URL as a Person `identifier`. Keep
  detailed role mappings visible in HTML or conservative `creditText` rather than placing
  an unsupported `Role` object in `author` or `contributor`.
- Emit repeated research `citation_author` tags for actual authors only, in order.
- Resolve per-item feed authors from the post. Keep site/feed ownership on the legacy site
  author until open.blog has a separate publisher/owner model.
- Apply this resolver to ordinary articles, recipes, research posts, and later profiles. It
  is a publishing capability, not a research-only field.

## Incremental delivery plan

1. **Identity foundation:** registry types and validation, sidecar discovery and parsing,
   resolved-credit domain model, diagnostics, legacy fallback, and contract tests. No output
   change for sites without sidecars.
2. **Publishing and Admin Studio:** ordered bylines and disclosure, JSON-LD, Highwire and
   item-feed mappings, source-order editor controls, manual ORCID validation/display, docs,
   and safe rename/delete behavior.
3. **Authenticated ORCID:** a separately researched security and operations slice covering
   OAuth, secrets and token storage, disconnect/re-authentication, durable provenance for
   offline builds, and export rules.

Each slice must be reviewed and pass the full Rust, web, starter-build, and deployment gates
before release. Semantic versions are assigned only after the compatibility impact of a
slice is known.

## Deferred contracts

- Organization and group authors, affiliations and ROR, funders and awards.
- Public contributor email/contact fields.
- Crossref or DataCite deposits and inferred given/family names.
- Free-text or custom role vocabularies.
- Contributor-based trust, expertise, or quality scoring.
- OAuth credentials, access tokens, and authenticated ORCID assertions.

## Decision checks

- Existing sites need no migration and retain their default author.
- Credit structure is explicit, ordered, versioned, and not encoded as a delimiter grammar.
- Builds stay deterministic and offline.
- Secondary contributors never leak into scholarly author tags.
- Editable data cannot assert authenticated ORCID provenance.
- The same resolved contributor model serves every content profile.
