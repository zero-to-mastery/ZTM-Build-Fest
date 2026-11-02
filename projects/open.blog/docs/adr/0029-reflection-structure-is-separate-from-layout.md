# ADR 0029: A reflection's structure is separate from its layout and carries no identity

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#170](https://github.com/journey-to-code-org/open.blog/issues/170)
- Parent story: [#148](https://github.com/journey-to-code-org/open.blog/issues/148)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

Story SP5 presents the same approved contributions as side-by-side, sequential, point and
counterpoint, alternating dialogue or roundtable. [ADR 0005](0005-shared-publication-language.md)
forbids pair-specific fields, and [ADR 0018](0018-reveal-policy-readiness-and-comparison.md) gives a
publication one author set. Prose does not live in the collaboration contract:
`CollaborationContract.contributions` stays empty for real publications and
[ADR 0016](0016-private-contribution-revisions-and-mutual-reveal.md) says it is not the content
authority. It lives in the `DraftSet`, one draft per participant whose contribution id is the
participant id ([ADR 0017](0017-own-draft-routes-and-private-draft-storage.md)), and the publish gate
reads it from there.

## Decision

- `reflection::ReflectionStructure` is a versioned, revision-checked value: a `layout` mode and
  ordered `rounds`. A round has a stable id, an optional round prompt and ordered `turns`. A turn is
  `{ draft, part }`: the id of a draft (which is its participant's id) and a zero-based part index.
  Choosing which parts appear, and in which order, is the whole arrangement.
- **Parts.** ADR 0017's one draft per participant stays. A draft splits into ordered parts at every
  line that is exactly `<!-- openblog:part -->` (`reflection::PART_MARKER`; a trailing carriage
  return is allowed, indentation and trailing spaces are not). It is an HTML comment because ordinary
  prose never contains it by accident and it is invisible if it ever leaks into unsplit output; a
  Markdown thematic break is not used, because writers use those for their own purposes. Splitting
  never parses Markdown, so the marker counts inside a code fence. A draft without the marker is
  exactly one part. `split_parts` only reads the draft and returns exact slices, so the draft is
  byte-for-byte unchanged and approval keeps binding draft revisions
  ([ADR 0020](0020-approval-snapshots-bound-to-exact-content.md)). The marker lines belong to no
  part and never appear in rendered output. A blank part is the same as an unwritten one. A turn
  that names a part the draft lacks is handled like a turn that names a missing participant: the
  whole reading order fails and returns nothing. Unequal numbers of turns per person are therefore
  just a different number of parts per draft.
- All five modes are one `ReflectionLayout` enum over the same structure. Changing it
  (`with_layout`) changes no round, round prompt, turn or prose.
- A turn names a draft, never a person. Identity and display name come from the contract's
  participant at read time, so a structure holds no identity. Every struct is `deny_unknown_fields`,
  so `left`, `right`, `authorA`, `gender`, `pronouns`, `side`, `author`, `participantId` or
  `contributionId` are rejected, and layout names are a closed list with no positional or gendered
  member.
- Placement (`lane` of `lanes`) is derived from the reading order and the layout, from the order
  participants first appear, and is never stored. Side-by-side and roundtable give each participant a
  lane; point-counterpoint uses two lanes only when exactly two distinct participants are present
  (the first to appear, then the other) and one lane with three or more voices; alternating
  dialogue flips the lane only when the speaker changes; sequential has one lane. Any number of
  participants works. ADR 0032 holds the exact rules, including how lanes degrade when turns are
  missing.
- The structure is private collaboration state and is not wired to storage, routes, Admin or the
  publish gate here.

## One authority for arrangement

`ReflectionStructure` is the only authority for how a shared reflection is arranged: which parts
appear, in what order, under which round prompts, in which layout. No assembly, preview or renderer
reads the contract's `layout` field (`LayoutItem`, a list of contribution-to-region pairs).
That field is a reserved v1 field: it still validates and round-trips, nothing consults it, and it
is dropped at the next contract version. The contract schema is not changed now. The contract's
region layout is a different thing from a Reflection layout in the glossary. A "round prompt" is the
public cue of a round; it is not an editor prompt ([ADR 0019](0019-draft-editor-prompts-and-conflict-recovery.md)),
and a round is not an exchange (a mutual reveal).

## Failure boundary

Parsing is bounded (128 KiB, 200 rounds, 100 turns per round, 1,000 turns, part index at most 999,
1,000-byte round prompts), rejects control and bidi characters in round prompts, requires safe opaque
ids with each (draft, part) used at most once, and returns one `ReflectionError::Invalid` that never
echoes input. A replacement must name the current revision and the next number. Parsing and ordering
are pure and mutate nothing, so canonical content and public output are unchanged on any failure.
Round prompts and prose stay untrusted text for the renderer to escape.

## Consequences

- #171 and #172 render layouts from `reading_order_for` and `placements`; #173 may write the
  sequential equivalent from the same order.
- Because a structure is not tied to a revision of prose, switching layouts never needs re-approval
  of prose. Whether the arrangement itself is approved is decided in
  [ADR 0030](0030-one-deterministic-reading-order.md): it is.
