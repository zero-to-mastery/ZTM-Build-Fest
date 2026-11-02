# ADR 0092: Publish approved comparisons as one rights-gated projection, as pages and `comparisons.json`

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#55](https://github.com/journey-to-code-org/open.blog/issues/55)
- Parent story: [#22](https://github.com/journey-to-code-org/open.blog/issues/22)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0044](0044-what-a-citation-makes-public.md),
  [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0085](0085-rights-are-the-authors-declaration-per-version.md),
  [ADR 0087](0087-attributed-interpretations-live-in-the-source-library.md),
  [ADR 0088](0088-passage-alignments-record-correspondence-never-equivalence.md),
  [ADR 0090](0090-the-comparison-workspace-reads-one-snapshot-and-identifies-every-place.md),
  [ADR 0091](0091-copying-from-a-comparison-takes-only-selected-places-with-their-rights.md)
- Amends: [ADR 0088](0088-passage-alignments-record-correspondence-never-equivalence.md) (an
  alignment may now be `approved`) and [ADR 0087](0087-attributed-interpretations-live-in-the-source-library.md)
  (a build that publishes comparisons validates the interpretations it publishes)
- Contract: [Passage alignments format](../specs/passage-alignments.md#publication)

## Context

Story #22 asks that comparisons identify exact versions and locators, attribute translators and
interpreters, and that rights warnings prevent accidental public reproduction. Issue #55 asks
for opt-in public comparisons with attributed versions and brief permitted excerpts, which
require an explicit rights status and selection, never republish a whole stored source, keep
interpretations separable from primary text, and exclude private notes. Alignments have been
private only (ADR 0088), and rights statuses are the author's declarations, never a legal
judgement (ADR 0085). The atlas (ADR 0058) and claim evidence (ADR 0075) already publish private
research through one allowlisted projection behind a site switch and per-item approval. B7.1
(#88) and B7.3 (#90) will build interpretation comparisons and explanation levels on what is
published here.

## Decision

- **Opt in per site, consent per alignment.** Publication needs `"comparisons": {"publish":
  true}` in `openblog.json` and `"visibility": "approved"` on the alignment. While the switch is
  off (the default, omitted from the written configuration) no build reads the alignments file,
  so a site that never opts in builds byte for byte as before, even with a damaged file. Approval
  is the author's selection and consent; a project that approved alignments publishes nothing
  until its author turns publication on, and clearing approval withdraws the comparison from the
  next build, whose stale-file pass deletes its page. `private` stays the default, and no other
  value is accepted.
- **The rights gate.** A place's original wording (the notebook passage's excerpt, or the
  interpretation's text) is published only when the author's rights statement for that version
  or interpretation is `permission`, `openLicense`, `publicDomain`, or `ownWork`. Under `unknown`
  (the default) or `rightsReserved`, the place is published as identification only: its version,
  makers, locators and rights statement, with a sentence saying why its wording is not shown.
  The gate follows the author's declaration and makes no copyright determination; the page says
  that rights statements are the author's own and not legal judgements. A short quotation from a
  reserved text may be lawful in some places, but deciding that is a legal judgement this
  software does not make, so the conservative reading is the only one.
- **Brief excerpts only.** Wording longer than 1,000 characters is never published, whatever its
  rights: the place is identified, and the page says the wording is longer than the excerpt
  limit. Wording is never truncated, because a shortened quotation would no longer be exact.
  Combined with the gate, a comparison cannot republish a stored text at length by default.
- **Exact, in its own language and direction.** Wording is copied exactly as stored: no Unicode
  normalization, whitespace change or markup interpretation. It carries its language tag (the
  passage's, else the version's, or the interpretation's) and a base direction derived from it
  with the Admin workspace's rules: a script subtag decides, then the language, and an unknown
  script or no tag gives `dir="auto"`. The author's normalization is published only when the
  alignment says `"publishNormalized": true` and the original is itself shown, labelled as the
  author's normalization and not the source text.
- **One projection, `PublicComparisons`, and allowlisted public types.**
  `openblog_core::comparison_publication::PublicComparisons::project` takes the validated
  alignments file, the library (with interpretations), the notebook and the contributor
  registry. Each published comparison names exactly: `id`, `label`, its `url`,
  `correspondence` and its "The author reads…" label, `recordedBy`, `confidence`, `rationale`,
  `uncertainty`, `evidence` (source and public locators only), and `versions` in the author's
  first-appearance order. A version is `source` (the edition, translation or witness, with its
  `makers`: each one's name, role and attribution certainty, and `anonymous` when the author
  records it so, read on the page as an interpreter heading reads, such as "Translator: Ibn
  Tibbon (disputed)") or `interpretation` (with the source it interprets, its kind, and its
  interpreters' public names, a contributor's registry name or the stated name, with
  attribution certainty, or `anonymous`),
  its rights `status`, `label` and an open licence's name, and its places: public locators,
  `absent`, and either `text` (`text`, `language`, `dir`), or `withheld` (`rights` or
  `length`), or neither when no wording is quoted. Sources are the citation allowlist of ADR 0044
  for exactly the sources a comparison uses. Notes on places, rights notes, attribution notes,
  notebook passage ids, interpretation uncertainty notes, unknown fields at every level, unapproved alignments, and
  normalizations the author did not choose have no place in these types.
- **Correspondence, never equivalence.** Every page and the artifact carry the alignment notice
  and the comparison's correspondence label, and interpretations are headed "Rendering by …" or
  "Reading by …" and described as an interpretation of a text, not that text.
- **Where it goes.** `/comparisons/` lists published comparisons and `/comparisons/<id>/` reads
  one as semantic HTML with no script and no new stylesheet: a section per version with its
  identification and rights statement, then an ordered list of its places, each wording a
  `blockquote` with `lang` and `dir`. The sequential layout is the no-JavaScript, phone and print
  reading. `/comparisons.json` is the same projection as data: `{"format":
  "openblog-comparison-projection", "formatVersion": 1, "notice", "comparisons", "sources"}`,
  compact, sorted by id, with root-relative URLs (prefixed with a base path) and `<`, `>` and `&`
  escaped. It has no `version` key, so it is never mistaken for private research. The pages join
  the sitemap; feeds, search, `llms.txt` and portable exports are unchanged, so no portable
  semantic check is needed. A post links to a comparison by its URL; embedding comparison blocks
  in post bodies is left to B7.3 (#90), which can render from this projection.
- **Failures refuse before writing, and never Admin saves.** A published alignments file is read
  through `alignment_store::load_for_build`: the library as every build reads it, with its
  interpretations raw (ADR 0087), the notebook, and the alignments validated against both, an
  interpretation member needing only an entry with its id. Then exactly the interpretations that
  approved alignments name are validated in full (their fields, ids and contributors), because
  those are the ones a comparison publishes; an interpretation nothing approved names, even one
  whose interpreter's contributor was removed, never stops the build. If the file, the library,
  the notebook or a published interpretation cannot be read or validated, a full build and
  `check` stop before generating anything, naming the file and ids without repeating their text,
  and the previous output stays as it was. The refusal lives in full generation only: loading content for an Admin save
  or preview never reads the file. `comparisons` is a reserved path only while comparisons are
  published.
- **Only a build that can read the file publishes it.** The alignments file is private and
  Git-ignored, so a build from a clone publishes `/comparisons/` and `comparisons.json` empty and
  `build` and `check` warn, naming the file.
- **Admin.** The alignment form gains a Publication group: "Approve this comparison for
  publication", whose description lists exactly what approval publishes, and "Also publish my
  normalizations, labelled". The alignments view carries `publication` (`publish`, `url`,
  `maxExcerptChars`, and per alignment one status per member: `shown`, `withheld-rights`,
  `withheld-length`, `unquoted`, `absent`), computed by the same projection, so before approving
  the author sees which places a public page would quote. While the site publishes comparisons,
  a saved or removed alignment rebuilds the site at once and reports the outcome as `build`.
  So does a saved or archived library source, or notebook passage, that an approved comparison
  uses (a source it identifies, cites or attributes to, or a passage it quotes), and a source
  import while any comparison is published: a version whose rights become `rightsReserved` or
  `unknown`, or a reworded passage, must not leave a public page quoting the old wording until
  some later save. An alignments file that cannot be read counts as a use, so the rebuild
  reports the problem. Changes nothing published uses do not rebuild.
- **Deterministic.** Comparisons and sources are sorted by id, versions and places keep the
  author's order, and nothing depends on time or locale.

## Consequences

- A version whose rights the author never stated is never quoted publicly, which is the honest
  default and the one most likely to be correct for modern editions and translations.
- B7.1 (#88) can link interpretations to published comparisons by id, and B7.3 (#90) can render
  comparison sections from `PublicComparisons` without reading private research.
- Turning publication on makes a build depend on the interpretations approved comparisons
  publish being valid, and on no others; the refusal names the interpretation's id, and
  `openblog check` names the problem to fix.
- The chrome is English, like the atlas pages; locators use the English citation strings.

## Domain language

**Comparison projection**, **Comparison publication switch** and **Rights gate** are defined in
[`CONTEXT.md`](../../CONTEXT.md).
