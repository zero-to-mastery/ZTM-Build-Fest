# ADR 0160: Editors read suggestions in the one inbox, and copying one into a research note is an explicit, unverified export

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#227](https://github.com/journey-to-code-org/open.blog/issues/227)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0105](0105-one-moderation-inbox-decided-per-item-by-the-one-policy.md), [ADR 0154](0154-a-suggestion-is-one-feedback-row-with-no-passage-target-and-one-loosened-check.md), [ADR 0155](0155-attribution-and-contact-are-optional-consented-and-contact-stays-private-to-the-site-admin.md), [ADR 0157](0157-converting-a-suggestion-is-an-explicit-author-action-that-records-an-id-and-never-enters-the-source-library.md)

## Context

An editor needs to read what readers sent, decide it by the familiar moderation tools, notice that
the same source came in twice, and, when an idea is worth working on, carry it into their private
research without it becoming a claim, a citation or anything public. Everything a reader typed stays
untrusted until an author makes it theirs.

## Decision

- **The one inbox lists suggestions** (`kind=future-suggestion`, in the kind filter). The hosted
  function lists them as feedback items; the build reads each through `Suggestion::from_stored` and
  refuses one that breaks any rule, counted but not shown. The one view rule decides what an editor
  sees: an account with no role on the work sees nothing, a coordinator sees the suggestion but never
  the contact or a name the reader did not agree to show, and the site Admin sees both. Reader text is
  plain text everywhere; the link is an anchor with `rel="noopener noreferrer nofollow"` whose
  caption says nothing fetched it for the editor; each statement about the source is labelled as the
  reader's own words or "not checked"; what is still missing is listed; the card carries the words of
  acceptance (ADR 0156).
- **Decisions are the one state machine's.** Accepting admits the suggestion to the editors' list and
  its guidance says nothing is published; a decline needs a reason and reads "Not taken forward"; a
  closed one reads "Closed". Nothing is published to any file: accepting, closing and deleting never
  touch `reader-feedback.json`, and the card never offers to publish or unpublish.
- **Possible duplicates are a cue, not a count.** Suggestions that share any source key are pointed
  out to each other across pages, each still decided on its own, with no number.
- **Retention clears identity, not ideas.** The hosted retention run's `scrub-identity` step and the
  Admin retention panel say what it does: clears the private contact and unshown name of accepted
  suggestions past `closedDays`, nothing else
  ([ADR 0155](0155-attribution-and-contact-are-optional-consented-and-contact-stays-private-to-the-site-admin.md)).
- **Export to a research note is the author's explicit act.** The site Admin or a coordinator of the
  work sees "Copy into a private research note" on an accepted suggestion. Pressing it sends only the
  item's id and the version they saw. The server reads the item again, applies the grant and the
  accepted-and-kept rule, builds the note from `research_draft`, and saves it to the private notebook
  by the notebook store's own revision check. The note is a question (for a question) or an
  observation, labelled "unverified reader text: nothing in it has been checked, nothing was fetched,
  and the editors have only said they are interested", says which page it was sent from and as what,
  keeps the reader's words and what they said about the source as quoted, labelled statements (a link
  "not opened or checked"), and carries no name, no contact and no time. It never creates a
  passage, a source, a draft or a link, and never changes the hosted suggestion, so a stale view, a
  refused grant, a note id already in use or a failed write leaves both exactly as they were. The
  note id defaults to `suggestion-` and the start of the item's id, which names no reader.
- **Auto-publishing and auto-downloading are not possible by construction.** No code path reads a
  suggestion's link, writes a published file for the kind, or sends a message.

## Consequences

`Inbox::research_draft` is the one place the export is decided, so a later conversion screen (#228)
can offer the same actors the same action. The export is tested for its refusals before any write,
for determinism and for leaking nothing of the reader, and in the browser for its keyboard use and
its status messages.
