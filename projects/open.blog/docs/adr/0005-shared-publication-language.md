# ADR 0005: Separate private collaboration from public publication and credit

- Status: Accepted
- Date: 2026-10-24
- Decision issue: [#153](https://github.com/journey-to-code-org/open.blog/issues/153)
- Parent story: [#144](https://github.com/journey-to-code-org/open.blog/issues/144)
- Contract: [Shared perspectives collaboration contract](../specs/shared-perspectives-collaboration.md)

## Context

A shared reflection begins with source material and private contributions from one or more people.
Those people may coordinate, reveal drafts, and approve a revision before anything becomes canonical
content. Existing open.blog language already gives public meaning to Post, Published work,
Contributor, Author, and Work credit. Reusing those terms for private workflow state would imply
publication, site authority, authorship, or public attribution before those decisions have occurred.

The group-safe contract established by #155 already represents participants, contributions,
reveals, layout, and approvals as ordered collections keyed by stable opaque IDs. It deliberately
contains no couple, left/right, or author-A/author-B fields and remains isolated from the document
model and renderer. The authorization policy from #154 binds an Admin user and a contributor ID to
one participant with publication-scoped roles. This decision names the surrounding domain without
adding another persistence format or weakening either boundary.

## Decision

Adopt the collaboration vocabulary in
[CONTEXT.md](../../CONTEXT.md#shared-publication-collaboration): Shared publication, Source
reference, Participant, Collaboration role, Contribution draft, Reveal, Approval, and Published
assembly. Keep them apart from the public and authentication terms Post, Contributor, Author,
Work credit, and Admin user, which retain their existing meaning.

A Shared publication is identified by a stable opaque publication ID and has one or more ordered
Source references and one or more ordered Participants. All relationships use collections and
stable opaque IDs; no contract field names a couple, a left or right side, an author A or B, or a
single primary source. A two-person experience is only a projection of the same group model; it
never creates pair-specific persisted or API state. The version 1 `participants`,
`contributions`, `reveals`, `layout`, and `approvals` collections from #155 realize the
corresponding workflow vocabulary and retain their existing validation and ordering rules, and the
version 1 authorization policy's `publicationId` names the Shared publication. The `layout` collection
is the exception: it is a reserved v1 field that no assembly, preview or renderer reads, and
[ADR 0029](0029-reflection-structure-is-separate-from-layout.md) makes the reflection structure the
only authority for arrangement. It is dropped at the next contract version.

Participant and Collaboration role describe private workflow involvement. A Participant reaches an
Admin user and a contributor registry entry (by its contributor ID) only through an explicit
binding in the publication's authorization policy. That registry entry becomes a Contributor for a
work only when the work's Work credit names it, never through the binding. The Collaboration roles are that policy's publication-scoped roles: site owner,
coordinator, contributor, editor, and reader. The `contributor` role means writing one's own
Contribution draft; it is not the public Contributor relationship. No participant, binding, or
role establishes that a person is a Contributor or Author, creates a Work credit, or grants
site-wide Admin authority. Public attribution continues to use
[ADR 0003's ordered work-credit model](0003-contributor-identity-and-orcid-provenance.md). Any
future publication transition must request or resolve public credits explicitly rather than
deriving them from participant order, collaboration roles, contribution ownership, reveals, or
approvals.

A Contribution draft is untrusted collaboration content. Reveal controls which ordered participant
IDs may receive a draft. Approval records consent to exactly the containing contract revision,
which covers every Contribution draft as it appears in that revision; drafts have no revision of
their own in the contract (amended by [ADR 0016](0016-private-contribution-revisions-and-mutual-reveal.md):
draft content keeps numbered revisions in a separate draft set). Neither concept
publishes content, defines a quorum, or authorizes a workflow transition. A Published assembly
exists only when a separate explicit publication operation incorporates an ordered selection of
Source references and Contribution drafts, as they appear in one approved collaboration revision,
into an author-owned Document. It names that publication-time assembly, not a
second stored artifact; the Document continues through the existing Post, Published work,
rendering, and portability paths.

Source reference is intentionally narrower than Citation and Reference. Source material may prompt
a shared publication without being cited as evidence. If the canonical document uses it as
evidence, the existing citation and reference model applies. A source URL never replaces the
published work's canonical URL or Work identifier. Author-entered attribution, such as a title,
source type, and optional original link, is the Source reference; optional provider metadata may
only suggest values and never overwrites what an author saved. Each Source reference keeps a
stable ID and its provenance so that reusable source records from
[#17](https://github.com/journey-to-code-org/open.blog/issues/17) can be adopted later without
rewriting published articles. The version 1 collaboration contract has no source collection yet;
the private collaboration artifact in
[#156](https://github.com/journey-to-code-org/open.blog/issues/156) adds one as an ordered
collection keyed by stable IDs under this decision. Its acceptance fixtures must cover one and
many ordered Source references with stable IDs and reject a Shared publication with zero Source
references.

## Trust and failure boundary

The #155 validation contract and #154 authorization policy remain authoritative for collaboration
fields: unknown or oversized data is rejected; access denies by default; participant and
contribution references must resolve; URLs are bounded safe HTTPS URLs; Markdown is bounded
untrusted source; and replacement is whole-contract and revision-checked.
Errors remain non-identifying and cannot echo another participant's content, identity, token, URL,
or metadata.

The #154 `ViewRevealed` grant targets one Contribution draft and is allowed only when that draft's
Reveal lists the bound participant
([ADR 0006](0006-collaborator-identity-binding.md)). Every later delivery path, including the
collaborative draft in #156 and the preview and publication path in #158, must authorize each
draft it delivers and must test that an unlisted participant receives nothing.

Collaboration parsing, validation, and authorization do not mutate a Document, Post, credits,
feeds, or rendered output. Under
[ADR 0004's explicit-projection rule](0004-portable-projections-from-canonical-work.md), private
collaboration state never reaches public output, feeds, or exports; a Published assembly is the
explicit, author-approved projection through which any of it can enter canonical content. A
malformed or stale collaboration replacement returns no new value. Publication is a later,
explicit boundary, so failure leaves canonical content and public output unchanged and
independently reviewable.

## Compatibility fixtures

| Fixture | Required interpretation |
| --- | --- |
| One participant | A valid Shared publication; no absent partner is implied. |
| Two participants | The ordinary group contract may project first and second UI slots without pair fields. |
| Three or ten participants | Authored participant order and stable-ID relationships remain intact. |
| Reordered or removed participant | References are revalidated; stale references fail as one private error. |
| Participants bound to registry contributors | Bindings, roles, and approvals create no Work credit; explicit credit keeps sidecar order. This holds by construction today because site loading takes no collaboration input; the first collaboration-to-publication seam must route bindings and approvals through it and assert credits are unchanged. |
| One or many Source references | Deferred to #156, which adds the source collection: ordered stable IDs are kept and zero sources are rejected. |
| Legacy Post without collaboration state | The existing parser, legacy-author fallback, credits, renderer, feeds, and output remain unchanged. |
| Legacy Post with collaboration-shaped front matter | Keys such as `participants` or `left` stay lossless unknown front matter and change no credit or output. |

`crates/openblog-core/tests/shared_publication_language.rs` checks that the glossary keeps each
collaboration term apart from the public terms and exercises the credit and legacy fixtures for
one, two, three, and ten participants. The collaboration contract and authorization tests
introduced with #155 and #154 exercise the group-size, reorder, removal, and failure fixtures. No
migration is required because this decision adds language, not collaboration persistence on a
Post or Document.

## Consequences

- Product and implementation work can discuss private participation without promising authorship,
  publication, or site authority.
- One-, two-, and many-person experiences share the same group-safe vocabulary and contract shape.
- Public credits remain explicit, ordered, and independent from collaboration workflow state.
- Source-led collaboration can later adopt richer research references without redefining a source
  prompt as a citation or canonical identity.
- Persistence, workflow UI, reveal delivery, approval quorum, assembly rendering, authentication,
  and publication transitions require separate decisions and implementation slices.
