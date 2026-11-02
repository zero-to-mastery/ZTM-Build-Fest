# ADR 0231: Comparisons are edited in Admin, and only the Approve action gives an approval

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#89](https://github.com/journey-to-code-org/open.blog/issues/89)
- Parent story: [#31](https://github.com/journey-to-code-org/open.blog/issues/31)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0226](0226-a-comparison-is-its-own-public-content-type-and-one-versioned-file.md), [ADR 0229](0229-ai-drafts-are-labelled-by-origin-and-publish-only-with-a-persons-approval-of-the-exact-text.md), [ADR 0230](0230-the-public-comparison-is-one-allowlisted-projection-of-approved-text-and-public-evidence.md)

## Decision

- **Same storage idiom as reading paths.** Admin reads and writes `content/comparisons/<slug>.json`
  through one store: revision-checked (SHA-256 of the bytes), content-locked, atomic by rename, always
  the canonical form, unknown fields kept, delete moves the file to `.openblog/trash`. A stale,
  refused or failed save leaves the file as it was. Every route sits behind the session and CSRF and
  an unknown name is a 404.
- **An approval is made by one action and no other.** `POST comparisons/approve` names the revision
  read, the item, and the digest of the text the author was shown. It is refused unless the item is
  an AI draft and the digest is the saved text's digest; it stamps the signed-in user as `by`, the
  server time as `at`, and the digest. A form or source-mode save may keep an approval the stored
  file already has for that item, byte for byte, and may never add or change one: that is a 422 naming
  the item. So no browser script or pasted source can approve on a person's behalf through Admin.
- **Editing withdraws.** A save in which an item's approved content (the text; for an interpretation
  also its attribution, uncertainty note, language and translation link) no longer matches its approval's digest drops
  that approval and reports which, so the author sees the loss and Admin never stores a stale
  approval. Marking an item as the author's own words removes its approval, since none is needed.
- **Revoking is explicit about publishing.** `POST comparisons/revoke` removes one approval. A published
  comparison cannot hold unapproved AI text (ADR 0229), so revoking in one needs `unpublish: true`,
  which sets the whole comparison back to `draft` in the same atomic write; without it the request is
  refused and nothing changes. Admin asks the author to confirm.
- **Evidence is shown, not enforced.** Each evidence reference has a state for the author: `public`
  (the build publishes it), `private` (it exists in the research library but is not published),
  `missing` (not in the library) or `unchecked` (the research files could not be read). Missing and
  private evidence produce notes and never refuse a save, so honest uncertainty can be published
  without evidence. An interpretation with no evidence is flagged in words.
- **Public means what claim-evidence publication publishes.** For the preview, an evidence link is
  public when it is an approved link of an approved claim and `claimEvidence.publish` is on, and a
  source is public when such a link cites it. This is deliberately conservative: it can hide a source
  that #90 later chooses to publish, and cannot publish one that is private. The preview is the one
  core projection of ADR 0230 computed as if the comparison were published, with an author-only
  `leftOut` list; it never tells a reader that something was left out.
- **AI-off works.** Nothing here calls a model. Without any AI draft there is no approval step at all.

## Consequences

- The approval is auditable in the file and cannot be produced by an Admin client.
- Hand-editing the file can still add an approval (the file is the author's own); Admin saves refuse
  it so the Studio never launders one.
- Editing a published, approved AI item leaves the comparison unsaveable as published until the new
  text is approved, which is the contract working as designed: set it to draft, approve the new text,
  and publish.
