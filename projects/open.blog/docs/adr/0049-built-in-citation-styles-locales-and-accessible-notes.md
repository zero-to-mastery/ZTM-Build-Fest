# ADR 0049: Two built-in citation styles, four built-in locales, accessible notes, and refusal on any citation problem

- Status: Accepted (amended below: only a post the load publishes is refused)
- Date: 2026-10-25
- Decision issue: [#42](https://github.com/journey-to-code-org/open.blog/issues/42)
- Parent story: [#19](https://github.com/journey-to-code-org/open.blog/issues/19)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0045](0045-citation-locators-reuse-notebook-locators.md),
  [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md)
- Contract: [Citation format](../specs/citations.md)

## Context

Readers need enough information to find a source, in the post's language, and keyboard and
screen-reader users need to move between a citation and its note. Full CSL style rendering needs
a CSL processor and style downloads, which are out of scope; generation must stay offline and
deterministic. ADR 0045 lets resolution drop one bad citation and keep the others, but a
published post with a silently missing citation would mislead readers.

## Decision

- **Styles.** `notes`: one numbered note per distinct citation (same reference and same
  locators); a repeated identical citation reuses its note. Heading "Notes". `bibliography`: one
  numbered entry per cited reference in order of first citation; each marker points at the
  reference's entry and the citation's locators stay visible in the text after it, as
  `[^cite-1] (p. 514)`. Heading "References".
- **Reference text.** Authors; title; editors and translators with a role label; container
  title; place and publisher; date; then each publicly resolvable identifier. Locators read
  `p. 514`, `pp. 514–520`, `fol. 12r`, `l. 3`, `§ 4`, `ch. 2`, `at 1:02:03`; a canonical locator
  is its value alone, and an `x-` kind is its name in words (`x-csl-sub-verbo 3` reads
  `sub verbo 3`).
- **Locales.** English, German, French and Spanish are built in (headings, locator and role
  labels, and the words assistive technology hears). A post's `citationLocale` must name one of
  them; without it the site language is used when it matches, and English otherwise. Nothing is
  downloaded and the machine's locale is never read.
- **Accessible anchors on the native page.** A generated marker is a `doc-noteref` link with a
  visually hidden "Citation" before its number and an id of its own (`cite-1-ref-2`); each note
  ends with a `doc-backlink` to every place it is cited, named "Back to citation 1 (2)". The
  notes sit under a real heading, so they are reachable by heading navigation. Portable copies
  keep ordinary footnotes linked to the canonical article, as for any footnote.
- **Any problem refuses the post.** For publication, a malformed citation, an invalid or unknown
  key, an ambiguous locator, a missing library or an unreadable library stops that post (and so
  the build, as any content error does) before anything is written. Each problem is reported
  with its file line, key, code and a repair hint, and never with other records, notes or
  notebook text. ADR 0045's per-citation scoping still holds for the resolver and the Admin
  picker; publication simply requires all citations to resolve. (Amended below: this applies
  to a post the load actually publishes.)

### Amendment: refuse only what this load publishes

A site load refuses a post for a citation problem only when it publishes that post: a post
that is not a draft and is not held back. Everything else is reported as a warning
(`<file>: citations are not published <why>: <guidance>`) and keeps its citations as authored
text:

- a **draft**, whether or not the load includes drafts (`openblog check`, `serve --drafts`,
  the Admin editor), so an author can save and preview `[@not-yet]` while writing;
- a post **held back until its date**; it must resolve before it is due, and the scheduled
  rebuild refuses it if it still does not;
- in an Admin **preview**, every document other than the one previewed, since a preview
  publishes nothing. A failed preview names only the previewed document's problems when it has
  any, as saving does.

Because a published post can still become uncitable through a library edit (re-pointing a
reference so a page turns ambiguous, or removing a cited source), the library refuses such an
edit: `update`, `import_csl` and `remove` resolve every non-draft opted-in post's citations
against the edited library and refuse with `still-used`, naming the post's path and line and
never its text. A post that already failed against the stored library does not block
unrelated edits.

## Consequences

- An author fixes or escapes (`\[@...]`) every citation before an opted-in post publishes; a
  draft may hold unresolved citations, which `openblog check` lists as warnings.
- Adding a locale or a style is additive: one table or one branch, covered by the golden tests.
- CSL style accuracy (author-date, ibid., short forms) is not attempted.

## Domain language

**Citation note** and **Bibliography** are defined in [`CONTEXT.md`](../../CONTEXT.md).
