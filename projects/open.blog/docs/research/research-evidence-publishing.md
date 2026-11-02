# Research and evidence publishing

Research date: 2026-10-23

## Summary

open.blog should treat research as a content profile and evidence as a reusable publishing
capability. The smallest useful release can describe a research work, expose a DOI and
license, preserve citations as ordinary Markdown, and publish conservative machine-readable
metadata without claiming that a work is peer reviewed, correct, or indexed by a scholarly
search service.

The first release should not invent a nested contributor or bibliography format inside the
project's deliberately flat front matter
([front matter parser](../../crates/openblog-core/src/frontmatter.rs)). In particular, a
manually pasted ORCID iD is not the same as an authenticated ORCID iD, and an organization
identifier without a role and display name is not a sufficient contributor or funding
model.

## Verified findings

### Works and identifiers

- A DOI name has a prefix and suffix separated by `/`; suffixes are assigned by the
  registrant and can contain Unicode. The DOI proxy resolves a properly URI-encoded name
  with the `https://doi.org/<doi-name>` form. The older `dx.doi.org` proxy is no longer
  preferred
  ([DOI Handbook](https://www.doi.org/doi-handbook/html/),
  [DOI resolver guidance](https://doi.org/help.html)). A DOI should therefore be normalized
  for output, not treated as a second canonical page URL, decoded for meaning, or rejected
  by a narrow ASCII-only regular expression.
- Crossref's display guideline uses the full actionable HTTPS URL without a `doi:` label or
  the older `dx` host
  ([Crossref DOI display guidelines](https://www.crossref.org/display-guidelines)).
- ORCID's preferred visible form is the full HTTPS URI associated with the contributor.
  ORCID distinguishes iDs collected through an authenticated workflow from manually entered
  iDs and requires unauthenticated iDs to be identified as such when displayed
  ([ORCID iD display guidelines](https://info.orcid.org/documentation/integration-guide/orcid-id-display-guidelines/)).
- ROR prefers the complete `https://ror.org/...` URL. Its identifier is opaque and contains
  no organization information
  ([ROR identifier pattern](https://ror.readme.io/docs/identifier)).

### Citations and references

- Crossref distinguishes registering reference metadata from linking references. It strongly
  encourages complete references and DOI identifiers, including references to data and
  software
  ([Crossref reference best practices](https://www.crossref.org/documentation/principles-practices/best-practices/references/),
  [data and software citation guide](https://www.crossref.org/documentation/reference-linking/data-and-software-citation-deposit-guide/)).
  open.blog is not a Crossref deposit system, but the distinction supports keeping human
  references visible while also emitting identifiers when they are known.
- Schema.org defines `ScholarlyArticle` for a scholarly article. Its inherited CreativeWork
  properties include `citation`, `identifier`, `license`, and `funder`
  ([ScholarlyArticle](https://schema.org/ScholarlyArticle),
  [citation](https://schema.org/citation),
  [identifier](https://schema.org/identifier),
  [license](https://schema.org/license),
  [funder](https://schema.org/funder)).
- Dublin Core defines `bibliographicCitation` as the citation for the resource being
  described and recommends enough detail to identify it unambiguously. That is not the same
  as the resource's list of cited works
  ([DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/#bibliographicCitation)).
- Pandoc citation processing uses an additional citation syntax plus bibliographic input
  such as BibTeX, CSL JSON, or YAML. This is useful interoperability evidence, but it is an
  extension rather than ordinary Markdown and requires a citation processor
  ([Pandoc citations](https://pandoc.org/MANUAL.html#citations)).

### Discovery output and its limits

- Google Scholar asks scholarly hosts to expose bibliographic HTML metadata. It recognizes
  Highwire Press tags and requires at least a title, one actual author, and a publication
  date; journal and conference works need enough additional venue data to identify a formal
  citation
  ([Google Scholar inclusion guidelines](https://scholar.google.com/intl/en/scholar/inclusion.html#indexing)).
- This research did not find a maintained Highwire-owned normative tag specification.
  Google's consumer-facing subset does not document `citation_doi`, so the first release
  should not emit or promise that tag
  ([Google Scholar inclusion guidelines](https://scholar.google.com/intl/en/scholar/inclusion.html#indexing)).
- Those tags do not guarantee inclusion. Google Scholar also requires eligible scholarly
  content, crawlable article URLs, and visible full text or a complete author-written
  abstract
  ([Google Scholar inclusion guidelines](https://scholar.google.com/intl/en/scholar/inclusion.html)).
  open.blog must present the output as machine-readable metadata, not an indexing badge or
  promise.

## Recommended first-release contract

This section is an engineering recommendation derived from the sources above.

### Profile and capability boundary

- Add `research` as an opt-in content profile. It identifies the published work as a
  `ScholarlyArticle` and enables research-specific author guidance.
- Model evidence as a reusable capability owned by the core, not as behavior exclusive to
  the research profile. References can also support articles, recipes, reporting, lessons,
  and documentation.
- Keep one content profile per post. Capabilities may be combined later without creating
  profile variants such as `research-with-code` or `article-with-citations`.

In v0.9, only the research profile activates reference extraction, scholarly output, and
evidence findings. The implementation seam must be profile-independent so another profile
can opt into it later, but ordinary article and recipe output remains byte-for-byte
unchanged in this slice.

### Canonical author input

Use the existing fields `title`, `date`, `updated`, `description`, `canonical`, and the
site author. Add only these work-level front matter fields in the first slice:

| Field | Shape | Meaning |
|---|---|---|
| `doi` | scalar DOI name or `https://doi.org/` URL | Persistent identifier assigned to this work. |
| `license` | scalar absolute URL | License document applying to this work. |

The engine should normalize DOI output to a properly encoded HTTPS resolver URL while
preserving the DOI name as an identifier value. It should reject empty values, control
characters, and values without the broad DOI prefix/separator structure, but must not use a
narrow suffix regex or require a network lookup during a deterministic build. A
syntactically plausible DOI is not proof that it is registered or belongs to the post.

Use ordinary Markdown for evidence:

- Markdown links and existing footnotes remain the in-text citation mechanism.
- A visible section headed `References` or `Bibliography` contains the reference list.
- The engine will expose resolvable links from that section as Schema.org `citation` values.
  It must not classify every outbound link in the document as a citation.
- The first slice does not format references, fetch metadata, or introduce `[@key]` syntax.
  A later CSL/BibTeX integration can add those behaviors without invalidating plain Markdown.

### Safe generated output

For a research-profile post, generate:

- the existing visible title, author, dates, description, body, a complete author-written
  `Abstract` section, and a References/Bibliography section without hiding or replacing
  author prose;
- Schema.org `ScholarlyArticle` JSON-LD, including normalized DOI `identifier`, license URL,
  and reference links when supplied;
- Google-documented Highwire tags for data the engine actually owns: `citation_title`,
  repeated `citation_author`, and `citation_publication_date`.

Do not emit journal title, ISSN, volume, issue, page range, publisher, peer-review status,
funding, or contributor roles until the author can represent those concepts explicitly.
Do not call the page indexed, peer reviewed, verified, or publication-ready merely because
metadata is present.

Defer Dublin Core HTML and citation-file exports from the first slice. Dublin Core remains a
valid general mapping target, but Google Scholar explicitly prefers Highwire for journal
metadata, and adding a third metadata plane before contributor and venue concepts exist
would create more partial output rather than more fidelity.

### Admin evidence guidance

The admin may deterministically identify:

- a missing visible Abstract or References/Bibliography section for a research-profile post;
- malformed DOI or non-absolute license values;
- unresolved Markdown footnotes;
- references with no resolvable link, as a review item rather than an error;
- DOI links in the reference section that do not use the preferred HTTPS resolver form.

Guidance should say what structure was detected and what an author can repair. It must not
score truth, source authority, peer review, methodological quality, or whether a citation
actually supports a claim. Network resolution, when added, must be an explicit optional
check and still cannot establish those qualities.

## Deferred contracts

These are valuable but require a structured model or another product decision:

1. **Contributors and ORCID.** Multiple contributors need names, ordered roles, identifiers,
   and identifier provenance. Authentication requires an ORCID workflow. Existing site
   author `sameAs` links may carry an ORCID URL, but the product must not label a pasted link
   as authenticated.
2. **Organizations, affiliations, and funding.** A ROR URL should be paired with an
   organization name and a defined relationship such as affiliation or funder. A list of
   opaque URLs is not adequate authoring data.
3. **Venue metadata.** Journal/conference name, ISSN/ISBN, volume, issue, pages, publisher,
   and report number need a publication-container model before complete Highwire output is
   safe.
4. **Bibliography processing.** CSL/BibTeX import, citation keys, formatting styles, and
   bibliography generation require a processor and a round-trip policy for source files.
5. **Artifacts.** Datasets, software, protocols, and supplements need a typed relationship
   and identifier. A generic URL list would discard the distinctions Crossref preserves.
6. **Review assertions.** Peer review and editorial status require provenance. They must
   never be inferred from the `research` profile.

## Incremental decision frontier

The [v0.9 implementation ticket](https://github.com/journey-to-code-org/open.blog/issues/7)
covers only the research foundation above. After that release is reviewed, tested, and
deployed, take these decisions in dependency order. Each decision can become one or more
independently releasable vertical slices:

1. **Contributor identity:** structured multiple contributors, ordered roles, author display,
   ORCID provenance, and the migration from the single site author.
2. **Organizations and funding:** named affiliations and funders, ROR identifiers, award
   identifiers, and visible disclosure output, built on contributor identity.
3. **Publication containers:** scholarly article versus report, venue, publisher, ISSN/ISBN,
   volume, issue, pages, and complete type-appropriate Highwire output.
4. **Related research objects:** typed datasets, software, protocols, and supplements with
   explicit relationships and identifiers.
5. **Bibliography processing:** sidecar BibTeX/CSL JSON, citation keys, CSL styles, generated
   bibliographies, and lossless admin round trips.
6. **Review provenance:** author-supplied versus externally verified editorial and peer-review
   assertions, with no inferred trust badge.
7. **Reporting profile:** sources, methods/backstory, correction history, and datelines using
   the shared evidence and contributor capabilities.
8. **Learning profile:** outcomes, educational level, resource type, standards alignment, and
   assessments using the same attribution and licensing model.

Do not pre-assign semantic versions to those later decisions. Release numbers depend on the
compatibility and migration impact found when each decision is researched.

## Decision checks

- The contract remains valid Markdown outside open.blog.
- A build remains deterministic and offline.
- Existing article and recipe profiles keep their current semantics.
- Machine output is derived from explicit author data or a bounded References/Bibliography
  section, not guessed from arbitrary links.
- The admin distinguishes structural assistance from judgments about evidence quality.
