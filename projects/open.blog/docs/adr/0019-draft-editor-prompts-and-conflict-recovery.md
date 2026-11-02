# ADR 0019: The Shared reflections draft editor, optional prompts, and conflict recovery

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#165](https://github.com/journey-to-code-org/open.blog/issues/165)
- Parent story: [#146](https://github.com/journey-to-code-org/open.blog/issues/146)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0017](0017-own-draft-routes-and-private-draft-storage.md) and
[ADR 0018](0018-reveal-policy-readiness-and-comparison.md) shipped the draft and reveal routes with
no browser panel. Writers need to write, see what is saved, recover from a conflict, and take part
in sharing, without any layout or length being imposed on them.

## Decision

- The Shared reflections view gets a "Your draft" panel on each reflection, for Contributors,
  Editors, Coordinators and Site owners. It requests nothing until opened and calls only the
  existing own-draft and reveal routes, so every request still goes through
  `SharedPublication::authorize`. The panel adds no route and no way to name another participant's
  draft. A refusal shows a plain "you cannot write a draft here" notice.
- Prompts are client-side suggestions only. Adding one inserts a plain Markdown quote at the caret;
  from then on it is the writer's text to change or delete. Prompts can be hidden, are never sent
  or stored on their own, and never affect saving: an empty or unstructured draft saves.
- The save state is words, not color: "Unsaved changes" or "Saved as revision N", with a character
  count and no limit enforced by the client. Saves and failures are announced in a polite live
  region and failures take focus in an alert.
- A stale save (another tab or device) never changes the editor. Focus moves to a recovery heading
  that shows the writer's untouched text beside the newer saved copy, read only. The writer chooses
  to save their text as a new revision on top of the newer one (revisions are append-only, so
  nothing is lost), to switch to the newer copy with an undo that restores their earlier text
  unsaved, or to decide later. Each choice returns focus to the editor. A 409 without the newer
  copy fetches it. Offline errors keep the text and say it is unsaved.
- Offering a revision names the exact saved revision, explains that a copy that has been read
  cannot be recalled, and needs confirmation; Escape or Cancel changes nothing. Taking an offer back
  and changing the policy (coordinators) need no confirmation because neither reveals anything.
- Revealed prose and names render as text nodes, never markup. Private slots show only whether the
  participant has offered a revision.
- Preview, the rich editor's visual mode and autosave are not wired to drafts yet: a draft is plain
  Markdown source, so it can never reach the preview, build, feed or export paths.
- The offer confirmation captures the revision when Offer is pressed and the box is replaced whenever
  the saved revision changes, so the revision a writer confirms is the one sent. After a successful
  sharing action focus moves to the Sharing heading, because the pressed control is replaced.
- Browser tests (`tests/browser/shared-drafts.spec.mjs`) cover keyboard-only use, a phone width,
  offline saving, two tabs and large drafts against a stand-in API. Source and visual modes are not
  covered because the draft has no visual mode yet; wiring it to the rich editor is a separate change.

## Consequences

- Nothing here approves, publishes or changes canonical content; a failed request leaves the stored
  draft, the contract and public output untouched.
- A richer editor can replace the textarea without changing the routes or the recovery behaviour.
