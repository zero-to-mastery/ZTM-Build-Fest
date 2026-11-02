# ADR 0071: Store claims privately and check every new anchor against the saved draft

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#45](https://github.com/journey-to-code-org/open.blog/issues/45)
- Parent story: [#20](https://github.com/journey-to-code-org/open.blog/issues/20)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0055](0055-private-knowledge-atlas-storage.md),
  [ADR 0057](0057-accessible-atlas-authoring-and-a-text-first-explorer.md),
  [ADR 0068](0068-claims-and-evidence-links-record-the-authors-reading.md),
  [ADR 0069](0069-contradicting-evidence-is-never-hidden-or-published-alone.md),
  [ADR 0070](0070-claim-anchors-are-verified-utf8-byte-spans.md)
- Contract: [Claims and evidence links format](../specs/claims-evidence.md)

## Context

ADR 0070 defined claims, links and anchors but deferred storage. Authors now select words in a
draft and attach saved passages to them. The words an author selected must be the words the
evidence attaches to: a selection made in older or unsaved text, or a range that has since gone
stale or become ambiguous, must not reach the evidence store, and a refused save must leave both
the draft and the store as they were.

## Decision

- **One private file, the atlas's store.** Claims and links live in
  `.openblog/private/research/claims.json`, owned by `claims_store`, which repeats the atlas
  store's rules: an absent file reads as empty and reading creates nothing; every change names
  the revision (SHA-256 of the stored bytes) it was based on and a stale one is a conflict; the
  edited set is validated by `openblog_core::claims` against the stored library and notebook and
  written by temporary file and `fsutil::replace_file`, under locks (ADR 0072); a refused, failed
  or interrupted write leaves the file byte for byte. Symlinks, directories, non-UTF-8 and
  oversized files are reported, never replaced, and messages name the claims file.
- **Anchors are checked against the saved post, never the editor.** `claims_store::read_saved_posts`
  reads every saved post by the build's own rules: the build's walk of the configured content
  folder (`site::content_files`), the files `openblog_core::classify_source` calls posts, minus a
  README and anything under a `_`-prefixed name (`site::not_content`, so a `posts/_drafts/` copy
  never shadows the post). It keeps each post's anchor text (`claims::anchor_text`) by slug,
  decided as the build decides it (`claims::post_slug`). A build reuses the posts it has already
  read (`claims_store::drafts_from_sources`) instead of reading them again. A post that cannot be
  read, a symlink, an oversized post, and a slug two posts share are left out, so nothing in them
  can be verified. Admin reads the drafts and writes the file while holding the content lock that
  post saves hold, so a post save cannot slip between the check and the write.
- **A new or changed anchor must be verified.** `claims::check_claim_anchor` accepts a claim's
  anchor only if the exact words are at the exact offsets of the saved draft. Moved
  (`anchor-mismatch`), stale (`stale-anchor`), ambiguous (`ambiguous-anchor`) and an unknown
  post (`unknown-post`) are refused with nothing written. An unchanged anchor is not re-checked,
  so an author can still reword, withdraw or remove a claim whose draft has moved on.
- **Evidence never attaches to words that cannot be found.** `claims::check_link_anchor` refuses
  creating a link, or changing one, while its claim's anchor is stale or ambiguous. A moved
  anchor (its words occur once, elsewhere) is allowed and reported so the author can re-anchor.
  Removing a link, and withdrawing a link's approval with no other change, are always allowed:
  consent can always be withdrawn (ADR 0069).
- **Selections are checked in the text they were made in.** `POST
  /admin/api/research/claims/anchor` takes the post path, the revision (etag) the editor loaded,
  UTF-8 byte offsets and the exact words, and answers `verified`, `moved`, `stale` or
  `ambiguous` without writing. A post saved elsewhere since it was opened is `409`, so a
  selection in older text is never checked against newer text. Unsaved editor text is never
  sent as the draft; the author saves the post first.
- **Routes mirror the atlas's.** `GET /admin/api/research/claims` (the file, each anchored
  claim's status, per-relation counts, projection notices, which links a projection could copy,
  library sources and passage previews), `POST` / `PUT` / `DELETE
  /admin/api/research/claims/claims` and `.../links`. They sit behind the session, CSRF token and
  deny-by-default router, are `no-store`, cap a change at 256 KiB, need the revision, answer a
  conflict with `409`, the latest revision and the stored `current` copy, and invalid input with
  `422` and scoped diagnostics that never repeat authored text. An id in a removal is checked
  before any message names it.
- **Checked offline and synced like the other research files.** `openblog check` validates a
  stored file, prints projection notices as `notice:` lines naming ids, reports anchors that are
  moved, stale or ambiguous as evidence findings (ADR 0074), and summarises counts per relation,
  never combined. A
  missing file is not mentioned. The hosted workspace allow-list carries the exact path at the
  library's 4 MiB limit and nothing beside it (no lock, temporary file or child path).
- **Never public.** No feed, search index, export, generated page or public route reads the
  file (a build reads it only to print the author's evidence findings, ADR 0074); the public
  server refuses it under every spelling; and a copy in `content/`, `static/` or a theme, or a
  generated file shaped like it, stops the build naming only the path (ADR 0069's structural
  guard).

## Consequences

- An author saves the post before anchoring a claim in new words. The editor says so instead of
  checking unsaved text.
- After rewriting a passage, its claims show as stale or ambiguous until re-anchored, and new
  evidence waits for that; nothing is relocated automatically.
- #46 can derive gaps from the same statuses and counts, and #47 can project approved links.
