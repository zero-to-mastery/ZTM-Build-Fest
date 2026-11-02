# ADR 0304: A draft is applied as editable, unsaved fields in Capture with one undo, and the author's save is the only save

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#480](https://github.com/journey-to-code-org/open.blog/issues/480)
- Task: [#504](https://github.com/journey-to-code-org/open.blog/issues/504)
- Builds on: [ADR 0302](0302-transcription-is-a-separate-confirmed-call-through-the-provider-boundary-that-sends-only-the-recording-and-returns-untrusted-text.md), [ADR 0303](0303-the-job-draft-task-returns-a-strict-plain-text-draft-that-can-never-fill-a-job-field-and-the-core-checks-it.md), [ADR 0296](0296-a-capture-is-a-job-draft-started-from-a-phone-built-from-the-job-forms-own-keys.md), [ADR 0297](0297-a-capture-waits-in-a-bounded-versioned-queue-on-the-phone-and-is-sent-with-its-id-as-an-idempotency-key.md)

## Context

The draft route returns a proposal (ADR 0303). The author is on a phone, on site, with notes (typed or from a
transcript) and perhaps a voice guide. Applying a proposal must feel like help, not like something that happened
to their post: they see what is sent first, they can change every word, they can take it back, and nothing is
saved or published until they save.

## Decision

- **Where: the Capture view.** The Capture view has the notes, the voice note, the trade, service and town and the
  capture's id, so **Draft with AI** lives there, under the voice note. (The Write editor already has the
  Assistant's review panel; a job draft is made before the post exists, which is Capture's moment.)
- **Disclosure first, every time.** The control is offered only when the site has a configured Assistant provider
  (`assistant/status`) and there are notes to draft from. Tapping it shows **Before anything is sent**: the
  provider's destination and model, the number of characters of notes (including any transcript the author added
  and edited), the job words, whether any photo description goes (none does today), whether the voice guide goes,
  and that the voice note's audio never goes with a draft. Nothing is requested until **Send to the Assistant**;
  **Cancel** sends nothing.
- **The voice guide is a visible choice.** If the site has a usable voice guide, the disclosure offers **Write it
  in my voice (send my private voice guide)**, ticked by default and named by its visibility, and the request names
  it by id only (ADR 0278); the server reads it again. Unticking sends no context. The guide is found through the
  existing context catalog, preferring the private one; this view adds no new voice code.
- **Applied as unsaved, editable fields.** The reply fills a **Title**, a **Description** and four section boxes
  (Problem, What we found, What we did, Result) under the button, labelled "not saved yet". Everything is an
  ordinary text field. The notes box is not touched. **Undo the draft** removes the fields in one step and
  restores the previous draft if the author had asked twice (**Draft again with AI**); the notes were never
  changed, so there is nothing else to restore. A refused or failed draft says why in a sentence and changes
  nothing.
- **Saved only by the author's own save.** The draft is part of the capture only at **Save draft**: the saved
  post takes the draft's title and description, its sections under the scaffold's own headings, and the photos
  after them, and it replaces the notes in the body (the notes stay in the box until the save, and a transcript
  stays private beside the voice note). Everything else about the save is unchanged: the same `document` call,
  draft `true`, the capture's own keys, no new `job.*` field. Nothing about a draft saves, publishes or
  schedules.
- **A waiting capture keeps its draft.** The capture queue's version 1 record gains one optional, additive key,
  `fields.draft` (`{ title, description, sections }`), bounded to the core's limits when stored and when read. A
  build that does not know it ignores it and sends the notes; a record without it is unchanged.
- **Without a provider nothing is lost.** The control says drafting is not set up and that the notes are saved as
  they are; the typed notes become the body under the first heading exactly as before.
- **Escaping.** Draft text only ever enters text fields (`value`, never markup) and, after the author's save, the
  post's Markdown, where the core has already refused HTML, fences, images, headings and front matter.

## Considered options

- **Filling the Write editor's body.** Rejected for this story: the post does not exist yet when the author has
  just talked, and the Write editor's undo is per edit, not per proposal. Capture's undo is the whole proposal.
- **Keeping the notes in the saved post under the draft.** Rejected: it would duplicate the draft's content and
  publish raw, unedited notes. The author sees the notes until they save, and can undo to keep writing them.
- **Auto-ticking nothing about the voice guide.** Rejected: the point of the story is a draft that sounds like the
  author. The disclosure names the guide and a tick is one tap to remove.

## Consequences

- A capture is saved by one call whether or not it was drafted, so offline sending and idempotency are unchanged.
- Photo descriptions are not sent yet, because Capture has no field for them; the request and the disclosure
  already carry the list for when it does.
- Re-asking is allowed and cheap to undo; each ask goes through the same concurrency permit and disclosure.
