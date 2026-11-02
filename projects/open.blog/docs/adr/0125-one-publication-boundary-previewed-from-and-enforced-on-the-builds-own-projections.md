# ADR 0125: One publication boundary, previewed from and enforced on the build's own projections

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#63](https://github.com/journey-to-code-org/open.blog/issues/63)
- Parent story: [#24](https://github.com/journey-to-code-org/open.blog/issues/24)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0044](0044-what-a-citation-makes-public.md),
  [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md),
  [ADR 0056](0056-one-lock-order-and-cross-store-research-guards.md),
  [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0075](0075-publish-approved-claim-evidence-in-the-post-with-public-revision-notes.md),
  [ADR 0092](0092-publish-approved-comparisons-as-one-rights-gated-projection.md),
  [ADR 0099](0099-approved-datings-publish-through-the-atlas-projection.md),
  [ADR 0120](0120-the-research-workspace-is-one-admin-destination-with-one-route-namespace.md),
  [ADR 0122](0122-the-draft-side-research-panel-inserts-only-checked-and-published-research.md),
  [ADR 0124](0124-review-acknowledgements-are-a-private-revisioned-file-of-keys-and-fingerprints.md)

## Context

Research reaches the public site through four projections, each with its own opt-in switch and
its own allowlist: citations publish the public description of the sources a published post cites
(per post, `citations:` front matter), the Knowledge Atlas its approved entries and relationships
and their approved datings (`knowledgeAtlas.publish`), claim evidence the approved claims and links
of published posts (`claimEvidence.publish`), and comparisons the approved alignments
(`comparisons.publish`). Each projection already withholds what it must, and structural guards
refuse a copy of a private file in a public folder or in generated output. What was missing was
one place that says, before a build, exactly what each projection will publish and why everything
else stays private; a guard that does not depend on each projection being right; and an answer
for approvals that no longer hold, dependencies that are not published and web addresses that
should never reach readers. #63 asks for all of it, with preview and production consuming the same
projection.

## Decision

- **One manifest from the build's own values.** `openblog_core::publication_boundary::BoundaryManifest`
  lists, per projection, every item it publishes (kind, id, label, the posts it belongs to, its
  public address, the fields it copies and the fields of it that stay private) and every item it
  withholds with one reason and one sentence naming ids and fields only. It is built from the very
  values a build renders (the `PublicAtlas` and `PublicComparisons` attached to the site, and the
  citations and claim evidence each published post carries), never from a second reading of the
  rules. The private files are read only to say what is withheld and why. A manifest covers the
  whole site (citations, claim evidence, atlas, datings, comparisons) or one post (its citations,
  its claim evidence, and the atlas and comparison pages it links to), and ends with what is never
  published, per file.
- **Preview and production consume the same projection.** `boundary::project` attaches the
  projections to a loaded site exactly as `generate_site` does, and `boundary::manifest` builds the
  manifest from them. The build calls both, then checks its output against that manifest and
  returns it in its report; Admin's `GET /admin/api/research/boundary` loads the saved site the way
  a build does (including drafts and scheduled posts when the server was started to build them)
  and calls the same two functions, reporting a projection that cannot be built as `blocked`
  instead of refusing. The source library and notebook, and the atlas and alignments read against
  them, are read once (`boundary::Shared`) and shared by the projections, the manifest and the
  preview, instead of once by each; the preview holds the content lock only while it reads the
  content, not while it projects. On a 300-post site with 6,500 notebook passages, 400
  alignments and every projection on, `openblog build` took a median of 8.5 s before and 6.1 s
  after (seven runs each, debug builds, a machine shared with other work; indicative, not a
  benchmark). `POST /admin/api/research/boundary` reads one post's unsaved fields
  and body through the preview loader, as the research review does (ADR 0123). Both are read-only,
  Admin-only, behind the session and CSRF seams, and change no file.
- **Withheld reasons are the projections' rules, never judgements.** `projection-off`,
  `not-approved`, `unsourced`, `notebook-passage`, `private-dependency`, `contradiction-withheld`,
  `post-not-published`, `stale-approval`, `page-not-published`; and for one field of a published
  item, `unsafe-url`, `private-identifier`, `rights`, `length` and `stale-anchor`.
- **Stale approvals, missing dependencies and unsafe addresses block only what they affect.**
  - An approved comparison is withheld as stale only when the alignments file *recorded* what it
    was approved against and that no longer holds. Saving an alignment approved (through Admin or
    the store) records, under the additive optional `approvedPassages` field, a fingerprint of the
    locators of each notebook passage it aligns, as the author saw them. If a passage's locators
    differ from the recorded fingerprint, the comparison is withheld from `/comparisons/` and
    `comparisons.json`, alone, and the file's `stale-approval` notice says which passage. The notice
    has its own withholding gate: it does not stop a post, and it cannot be acknowledged, because
    acknowledging would not publish the comparison. The author checks the place and chooses
    **Checked - approve again** in Compare, which records the passage as it now is
    (`reapprove: true` on the save). Saving an approved alignment any other way never re-approves:
    the stored fingerprints are kept, so an edit to its rationale does not make a moved place look
    checked. They are recorded afresh only for a new alignment, when the visibility changes to
    approved, or on `reapprove` (a member added since is recorded as it stands); saving it private
    clears the record. The alignments view lists `staleApprovals` so Compare can offer the control.
    An approval with no record, made before the field existed, is never withheld; neither is one
    whose record cannot be read (a record that is not an object of strings is ignored, not an
    error). The older `stale-locator` notice (a member's own locators differ from its passage's)
    stays an advisory, acknowledgeable notice that withholds nothing. Archiving is not staleness: an
    archived record still resolves by design. The fingerprint covers kinds, values and ends of the
    locators only; any other change to a passage (its wording) is not detected here.
  - An approved item whose dependency is not published stays withheld by its projection's
    existing rule (a relationship to a private entry, a dating relative to one, a link on a private
    claim, support while contradiction is private) and the manifest names the dependency. A claim
    whose anchored words moved keeps publishing its statement without the quote (ADR 0075).
  - A web address in a source's identifiers is published only when `public_url_problem` accepts
    it: `http` or `https`, no credentials, a public host and no secret-named parameter. A host is
    not public when it is `localhost`, `localhost.localdomain`, a single-label host, or ends in
    `.localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`, `.intranet`, `.corp`, `.test`,
    `.home` or `.localdomain`; or when it is a loopback, private, link-local, carrier-grade
    (`100.64.0.0/10`), benchmarking (`198.18.0.0/15`), multicast (`224.0.0.0/4`), reserved
    (`240.0.0.0/4`), unspecified, site-local (`fec0::/10`), IPv6 multicast or NAT64
    (`64:ff9b::/96`) address. An IPv4 address written in decimal, octal or hex is the same address
    the URL parser reads; an IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`) or
    6to4 (`2002::/16`) IPv6 address is checked as the IPv4 address it embeds. A query parameter,
    and a fragment that holds `name=value` pairs (a fragment with no `=` is a heading anchor, not
    a pair), is secret-named when its name, split into words at `_`, `-`, other punctuation and
    camelCase (`X-Amz-Signature`, `access_token`, `apiKey`), has a word `token`, `secret`,
    `password`, `passwd`, `pass`, `pwd`, `sig`, `signature`, `credential`, `auth`,
    `authorization`, `session`, `jwt` or `bearer`, or `key` alone or after `api`, `access`,
    `secret`, `private`, `client` and the like, or is one of a few exact compounds (`apikey`,
    `accesstoken`, `xamzsignature`, ...). Words are matched whole, so `author`, `authors`,
    `siglum`, `sigla`, `sortKey`, `monkey`, `design`, `passage` and `keyword` publish, and
    `#Authorship` and `#KeyConcepts` are not parameters; Google Books' `sig=` stays withheld, and
    the warning says "fragment" when the hit is in the fragment. `sid`, which OpenURL uses to name
    the referring database, is published. Only the address is withheld, from every projection at
    once through `public_reference`; the rest of the reference is published, and the citation
    review lists it as `citation-identifier-unpublished` (advisory). Host names are not resolved,
    so a public name that points at a private address is not detected. An address with an IPv6
    literal host is published and links correctly: the HTML writer percent-encodes its brackets,
    so the authority's brackets are written back, and the portable-html link check compares an
    escaped bracket and a plain one alike (before, any such source failed the whole build with a
    missing-link diagnostic).
  - The build prints each newly withheld item as a `boundary:` warning naming its projection,
    object and field; none fails the build.
- **The structure of the output is checked against the boundary before anything is written.**
  After generating, the build refuses when a page exists for an atlas entry or comparison the
  manifest does not publish, or when `atlas.json`, `comparisons.json` or `claim-evidence.json`
  names an item it does not publish. These structural checks, with the manifest enforcement
  (nothing is public merely because it exists in the workspace), a damaged private file and the
  public-folder guard (`refuse_private_research_in_public_inputs`), refuse a build.
- **A text guard for private research text: it refuses only in machine data, and warns
  everywhere else.** `PrivateText` holds every string of every private research file (library,
  notebook, atlas, claims, alignments, acknowledgements; a file that is not JSON is held whole)
  as *word shingles*: the hashes of every run of six consecutive normalised words. A heuristic
  match must not refuse an ordinary build, so the guard has two outcomes. A hit inside the
  machine-data outputs the build generates from the projections (`atlas.json`, `comparisons.json`,
  `claim-evidence.json`, and a page's reader reference data, `<script id="ob-references">`) is a
  **refusal**: those carry only what a projection approved, so private text in them is a bug in
  the projection or in a record. They are scanned field by field, so no shingle spans two fields.
  A hit anywhere else (HTML pages, feeds, the search index, `llms.txt`, the static, theme and
  front-end files a build copies, a portable Markdown export) is a **warning**, not a refusal: the
  text is in a public file the author placed or wrote, which only the author can judge. It is
  printed by build and check as `boundary: ...`, shown in Admin's **What will be public** (as
  `textMatches`, and in the build's manifest), and names the output, the private file, the record
  id and the field as a JSON path, never the text. Its advice is that the text is in a public file
  the author placed or wrote, so they should remove it there, or keep it if it is meant to be
  public; nothing was blocked. A site with no private research files reads nothing and produces
  the same output and messages as before.
  - **One normalisation for both sides.** Private text and every output are normalised the same
    way: markup is removed (tag and attribute names vanish and the words around a tag stay
    adjacent; the values of `content`, `alt`, `title` and similar attributes are runs of their own,
    so a meta description is guarded), HTML entities are decoded (a feed's escaped `&lt;p&gt;` is
    removed once more), then every non-alphanumeric run (punctuation, markup remnants, newlines)
    separates words, letters are lower-cased, full-width forms and ligatures are mapped to plain
    letters and zero-width characters are dropped. A private note written with `<i>` tags
    therefore matches the same words in a page that dropped the tags. JSON escapes are decoded
    only where JSON is meant: a file that parses as JSON is read string by string, and any other
    generated text is read as written and, when it holds a backslash, once more with its JSON
    escapes decoded (a JSON string literal in a page or script), so `\theta` and `C:\new` are not
    turned into a letter and a newline. Hard-wrapped quotes, emphasis or a link in the middle of a
    sentence, a search index or `llms.txt` that joins lines, and a note with parentheses, colons,
    semicolons or an apostrophe all match.
  - **Six words.** Fewer would match common clauses of ordinary prose and of the generator's own
    fixed text; more would miss a short note's echo. Hashes (64 bit) are kept in a hash map, so the
    guard scales with the text, not with the number of outputs times notes.
  - **Output is cut at known public short strings.** The theme sets published titles, headings,
    tag and series names and navigation labels next to each other (table of contents, series
    navigation, related posts), so a note that merely lists them would otherwise match a window
    that no allowed input holds. The generated text is cut at the edges of those strings (post and
    page titles and subtitles, headings, tag and series names, navigation and social labels, as
    whole word sequences; a one-word string only where it fills its element), so no shingle spans
    two of them. The address of every generated page (atlas, comparisons, archive, feeds,
    pagination, each with and without `index.html`) is allowed with the site's address, as the
    addresses of posts, pages, tags and series already are.
  - **What is allowed is what this build publishes**, not what is on disk: the title, description,
    cover text, text, rendered HTML, Markdown and tags of each published post, the same of each
    published page and series, the body and the rendered front-matter fields (title, subtitle,
    description, cover text, tags, series, canonical and source addresses and their aliases) of
    the source files of those posts, pages and series, `content/reader-feedback.json` when
    present, `openblog.json`, the addresses above, the approved atlas, comparison and claim
    evidence artifacts, and the public description of each source a published post cites. A
    front-matter field the build does not render (an author's memo kept there) is not public input,
    and a field the build renders under a name not listed would give a warning at worst. Drafts,
    scheduled and held-back posts, any other content file and every source not published are not
    allowed: a draft that quotes a note does not make the note public.
  - **Every copied file is scanned.** The static and theme files a build copies, and the
    front-end assets of `paths.web` that it writes under `assets/`, are scanned when their first
    8 KiB are valid UTF-8 with no NUL byte, whatever the extension (`.bib`, `.ris`, `.vtt`,
    `.tex`, `custom.js`, `CNAME`). A text file over 8 MiB is named in a `boundary:` warning as
    not scanned, instead of skipped in silence. The embedded assets are the product's own and are
    not scanned.
  - **Gaps, stated.** Private text of fewer than six words (an id, a date, "ask Dana before
    publishing") is not guarded by text; the projections' allowlists and the structural guards
    keep it out. A paraphrase is not a match. No Unicode normalisation tables are bundled (no new
    dependency), so a decomposed accent does not equal its precomposed form. Entities beyond the
    common Latin-1 letters decode to nothing, which can only hide a window, never invent one.
    Generated text that no published post holds (fixed interface text, the sitemap's structure) is
    not allowed, so a private note repeating six or more consecutive words of it gives a warning
    that names the note. Because the output is cut at a known string wherever it stands, a private
    sentence made of nothing but such strings is not found by text. A note that only pastes the
    address of a public page is not a match.
  `openblog export` applies the same guard: private text in a CSL JSON or BibTeX export, which is
  reference data, refuses; in portable Markdown it warns on standard error. It is defence in
  depth: an export is built from the post's own text, which the guard allows.
- **A cross-projection leak corpus.** One fixture seeds a distinct sentinel in every private store
  and field (rights and private notes, unknown fields, private identifier schemes, an unsafe
  address, unapproved passages, notes, entries, relationships, datings, claims, links and
  alignments, a stale approved alignment, an acknowledgement) and in every approved projected
  field, builds with every projection on, and proves that no private sentinel appears in the built
  site (pages, feeds, search index, `llms.txt`, JSON artifacts) or in any post's portable Markdown,
  portable HTML, CSL JSON or BibTeX, while every approved sentinel does.
- **Deterministic and backward compatible.** The manifest is ordered by the projections' own
  orders and is the same for the same files; the Admin preview equals the build's report. A site
  with private research but no projection switched on builds byte for byte as before; a site
  without research prints exactly what it printed. Only an unsafe address or a stale approved
  comparison changes what a research site publishes, and both are named.
- **Admin.** The Research workspace gains **What will be public** (`#/research/public`, listed
  with the private panels because the preview itself is Admin-only), and Evidence Studio gains
  **What this post makes public**. Each projection is a labelled section with its switch, then
  "Published (n)" and "Withheld (n)" lists; each item says Published or Withheld in words (the
  visibility labels of ADR 0120), with the fields it copies or the reason, and a withheld item links
  to where it is changed by its own address (an atlas relationship by
  `#/research/atlas/relationships/<id>`, a dating by the entry or relationship it dates, a claim
  or an evidence link by its post's Evidence Studio when the post is saved and known; an
  unlocated post has no link). The site preview's projections are h3 under the panel's h2; the
  post preview's button names its region and says whether it is expanded, and the read is marked
  out of date when the draft is edited after it. The draft-side research panel takes which
  comparisons are published from the same `PublicComparisons` projection the build writes. Refresh is announced in a polite status region; the lists
  wrap at 320 pixels and add no motion.

## Consequences

- An author sees, before publishing, exactly what the next build publishes of their research and
  why everything else stays private, from the same values the build writes.
- A bug in a projection that would carry private research text into its machine data stops the
  build instead of publishing, with a message that says where the text came from; the same words
  anywhere else are named in a warning and the build goes on.
- A build reads every stored private research file once more, as raw JSON, for the guard; a site
  without research reads nothing new.
- Text a private note shares, word for word for six words, with a public file the author wrote
  or placed is named in a warning, in the build and in Admin, with the record and field. Notes of
  fewer than six words are a gap the guard does not close.
- An approved comparison made before this change has no record and keeps publishing if its
  passage is re-located; saving the alignment again records it, and from then on a change is
  caught. Once recorded, an edit never re-approves: only Checked - approve again does.

## Domain language

**Publication boundary**, **What will be public**, **Withheld reason**, **Stale approval**,
**Unsafe web address** and **Private text guard** are defined in [`CONTEXT.md`](../../CONTEXT.md).
