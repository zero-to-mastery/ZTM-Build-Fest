# Reader annotations

A reader can keep highlights, private notes, saved sources and reading trails in their own browser,
with no account. This page is the contract those features share. It is implemented by
`web/components/reader-annotations.js` (dependency-free, no DOM, no storage, no network) and tested by
`tests/web/reader-annotations.test.mjs` against `tests/fixtures/reader-annotations.json`. Decisions are in
[ADR 0237](../adr/0237-reader-annotations-are-one-reader-private-local-document-that-is-never-research-notes-and-never-public.md) (separate, local, private),
[ADR 0238](../adr/0238-an-annotation-names-its-work-by-site-and-path-and-its-text-by-a-passage-target-and-staleness-is-derived-never-stored.md) (identity and stale state),
[ADR 0239](../adr/0239-an-export-states-its-privacy-scope-and-leaves-note-text-out-unless-the-reader-includes-it.md) (export privacy) and
[ADR 0240](../adr/0240-reader-annotation-validation-is-strict-scoped-to-the-record-and-never-repairs-or-repeats-reader-text.md) (validation) and
[ADR 0241](../adr/0241-highlights-and-notes-are-opt-in-per-site-keep-the-article-unchanged-and-save-only-to-bounded-local-storage.md) (highlights and notes on a page) and
[ADR 0242](../adr/0242-reading-trails-are-built-by-hand-nothing-is-recorded-as-a-reader-reads-and-a-linked-source-remembers-the-work-it-was-found-in.md) (reading trails and saved sources on a page) and
[ADR 0243](../adr/0243-export-and-import-are-explicit-previewed-and-all-or-nothing-and-the-reader-can-turn-the-feature-off-or-erase-it-and-check-that-it-is-gone.md) (export, import and privacy controls).

The contract comes first. Local highlights and notes (#85, below), the trail and saved-source organizer
(#86, below) and import, export and privacy controls (#87, below) build on it. A site and its posts are unchanged
until those features are used; nothing here is in the build, Admin or any feed.

## Document

```json
{
  "format": "openblog.reader-annotations",
  "version": 1,
  "privacy": { "scope": "reader-private", "notes": "included" },
  "annotations": [
    { "id": "steep", "kind": "highlight",
      "work": { "site": "https://example.com", "path": "/posts/tea/" },
      "revision": "p1:0123456789abcdef0123456789abcdef",
      "target": { "version": 1, "kind": "quote", "section": "brewing",
                  "exact": "three minutes", "prefix": "Steep the tea for ", "suffix": ". Then taste", "start": 26 },
      "createdAt": "2026-10-27T09:30:00Z", "updatedAt": "2026-10-27T09:30:00Z" },
    { "id": "whole-post", "kind": "note", "work": { "site": "https://example.com", "path": "/posts/tea/" },
      "revision": "p1:0123456789abcdef0123456789abcdef", "target": { "version": 1, "kind": "work" },
      "text": "Return to this.", "createdAt": "2026-10-27T09:30:00Z", "updatedAt": "2026-10-27T09:30:00Z" }
  ],
  "sources": [
    { "id": "kettle-guide", "kind": "source", "title": "Kettle guide", "url": "https://example.org/kettles",
      "from": { "site": "https://example.com", "path": "/posts/tea/" },
      "text": "Check the boiling point.", "createdAt": "2026-10-27T09:30:00Z", "updatedAt": "2026-10-27T09:30:00Z" }
  ],
  "trails": [
    { "id": "tea-trail", "kind": "trail", "title": "Learning tea",
      "steps": [{ "ref": "steep" }, { "ref": "kettle-guide" }],
      "createdAt": "2026-10-27T09:30:00Z", "updatedAt": "2026-10-27T10:00:00Z" }
  ]
}
```

- **Highlight**: a quoted passage, with no text of the reader's own. **Note**: the reader's text attached to
  a quote, a section or the whole work. **Saved source**: a title and either an http(s) `url` or a `work`
  on a site, with an optional note. A source with a `url` may also say which work it was found in (`from`). **Trail**: an ordered line of up to 200 steps, each naming one
  annotation or saved source by id, once.
- **Identity.** A work is its site origin plus its canonical path. The target is a passage target
  ([ADR 0076](../adr/0076-passage-targets-are-section-anchors-with-quoted-context.md)): exact text with
  prefix and suffix context and a position hint. `revision` is the passage revision the page published when
  the reader made the annotation; this contract never computes it.
- **Stale state** is derived, not stored. `assessAnnotations(document, works)` returns `current`,
  `reanchored` or `stale` with a reason for each annotation, as passage targets resolve
  ([ADR 0077](../adr/0077-targets-resolve-as-current-reanchored-or-stale.md)), or `stale` with
  `workUnavailable` when the work cannot be loaded. A stale annotation keeps its record.
- **Separate from research notes.** The format name, ids and file are the reader's own. A research
  notebook, a reading path or any other JSON is refused as `wrongFormat`.

## Privacy

`privacy.scope` is always `reader-private`. `privacy.notes` is `included` or `omitted`: the default
`exportDocument(document)` leaves out the reader's own words (note text, a saved source's note, a trail's
note) and says so; `{ notes: true }` keeps them. A file that says `omitted` but holds note text is refused.
An export always holds the text of the highlights. Nothing is uploaded and nothing is published.

## Validation

`readDocument(value)` and `readDocumentJson(text)` return a new frozen document or every problem as
`{ code, object, message }`, where `object` names the record (`annotations[2] (steep)`). Nothing is
repaired and the caller keeps what it had. Messages never repeat reader text.

| Rule | Code |
| --- | --- |
| Not this format, or JSON that is not an object | `wrongFormat`, `malformed` |
| Version missing, fractional or newer | `malformed`, `unsupportedVersion` |
| Unknown field or kind | `unknownField`, `unknownKind` |
| Id not a lowercase slug of 1 to 64 characters, or reused | `invalidId`, `duplicateId` |
| Site not a plain http(s) origin; path not canonical, or holds traversal | `invalidSite`, `invalidPath` |
| URL not http(s), with credentials, or not canonical | `unsafeScheme`, `invalidUrl` |
| Source with both or neither of `url` and `work`, or `from` on a source with no `url` | `invalidSource` |
| Highlight not a quote, or with text; note without text | `wrongTarget`, `unexpectedText`, `emptyText` |
| Target invalid | the passage-target code (`splitCharacter`, `unsupportedVersion`, ...) |
| Control, bidirectional or lone-surrogate characters | `forbiddenCharacter` |
| Limits: 4 MiB, 2,000 annotations, 500 sources, 50 trails, 200 steps, note 10,000, title 200, URL 2,048, path 512 | `tooLarge`, `tooMany`, `textTooLong` |
| Timestamp not UTC to the second, or updated before created | `invalidTimestamp`, `timeOrder` |
| Trail step missing, repeated, or naming a trail | `danglingRef`, `duplicateStep` |
| Scope not `reader-private`; notes statement wrong | `invalidPrivacy`, `privacyMismatch` |

`serializeDocument` writes the canonical form: fixed field order, two-space indent, LF, trailing newline.
Automated behaviour here never claims a passage is true, authoritative or licensed to copy; an annotation
records only what a reader chose to keep.

## Highlights and notes on a page

A site opts in with `readerAnnotations.enabled`. Each post then has a "Your highlights and notes" region
(`<ob-annotations>`, `web/components/ob-annotations.js`). Without JavaScript it is one paragraph saying what it
needs. With it:

- **Make.** Select words in the post, then "Highlight the selected words", or write a note and attach it to the
  selected words, a section or the whole post. The buttons keep the last valid selection, so a keyboard reader
  can select with the arrow keys, tab to a button and press it. A selection that cannot be quoted is explained.
- **Find.** Saved passages are painted over the post (CSS Custom Highlight API, where available) without
  changing its markup, and every annotation is a list item: "Show in the post" selects it, "Add a note" or
  "Edit note" edits it, "Delete" asks first. Each button names its passage, changes are announced in a status
  region, and focus returns to the control that made the change.
- **Revisions.** Each visit looks every annotation up again against the published text: found where it was
  saved, moved (the same words found in changed text), or not found with the reason. A not-found annotation stays
  in the list with its quoted words and is never moved on a guess.
- **Storage.** One key, `openblog.reader-annotations`, holds the whole document. If the browser denies storage
  or is full, the reader is told and changes last until the page closes. Data under the key that this version
  cannot read is never overwritten.
- **Safety.** Everything a reader wrote is set as text. The page holds no annotation and makes no request.

## Reading trails and saved sources on a page

The same sites get a second region, "Your reading trails and saved sources" (`<ob-reading-trail>`,
`web/components/ob-reading-trail.js`), beside the highlights. **Nothing is recorded as a reader reads.** The
panel holds only what the reader adds, says so at the top, and keeps it in this browser. Without JavaScript it
is one paragraph saying what it needs. With it:

- **Saved sources.** "Save this post as a source" keeps the post by its work. "A reference this post cites" lists the
  references the page publishes: one with an outside link is saved by that link, one without as a link to its note in
  the post, each with the post it was found in (`from`) and its formatted text as the title. The same link or post
  is never saved twice. Outside links open with `rel="noopener noreferrer"`.
- **Posts you have marked.** Every post with a saved highlight or note, most recent first, with counts and a link.
- **Trails.** Name a trail, then add a saved source, highlight or note to it from a list that leaves out what
  is already in it. A step appears once. "Move earlier" and "Move later" reorder one place at a time and keep focus
  on the moved step; "Remove from the trail" keeps the record. Trails are listed most recently changed first.
- **Clearing.** Removing a source, deleting a trail, removing one post's highlights and notes, and "Clear all my
  local data" each ask first and change only what they name. Clearing all removes the whole key, even data this
  version cannot read; it is the only action that ever touches such data.
- **Storage.** Unlike highlights, nothing here is kept in memory only. A change that cannot be saved (storage denied,
  full, unreadable, or a limit of 500 sources, 50 trails or 200 steps) is refused with the reason beside the control
  and nothing changes. The panel and the highlights refresh each other, and other tabs, when the document changes.
- **Safety.** Titles, names and notes are set as text; links come from validated data (http or https, no credentials).


## Export, import and privacy controls

The trail panel ends with "Export, import and privacy" (`web/components/reader-annotations-transfer.js` holds
the logic, `ob-reading-trail.js` the controls). Nothing here is uploaded or sent.

- **What is kept.** The panel states, read from the browser each time it draws, what is saved ("Kept in this
  browser: 2 notes, 1 saved source.") and which storage keys the feature holds
  (`openblog.reader-annotations`, and `openblog.reader-annotations.off` while the feature is off, or `none`).
- **Export.** "Download my reading trail" makes `openblog-reading-trail-YYYY-MM-DD.json`. Before the file
  exists a sentence says how many highlights, notes, sources, trails and steps it will hold, its size, whether
  your notes are included (they are not unless "Include the text of my notes and source notes" is checked)
  and how many notes on a section or the whole post would be dropped. "Show exactly what the file contains"
  shows its text. The file is the document and nothing else (see Privacy above).
- **Import.** Choose a file; it is read in the browser, never uploaded. A preview shows what it would add,
  what is already saved, records saved under another id, records that have the same id but different
  content (keep yours, the default, or use the file's), imported highlights and notes on this post that no
  longer match its text, and whether the file leaves out notes. Nothing is saved until "Import". Cancel
  changes nothing. A file that is not valid, is from a newer version (`unsupportedVersion`), holds an
  unsafe link or path, breaks a limit, or is over 4 MiB is refused whole with up to eight plain problems
  that name the record and never repeat its text. The merge is deterministic: what is saved, then the file's
  records in file order; a file that leaves out notes never removes a saved note.
- **Writing.** Import re-reads the saved document, plans again and refuses if the result is not what was
  previewed. Unreadable saved data and storage that is denied or full are reported, and the browser's data stays exactly as
  it was. Both panels refresh afterwards.
- **Turn off.** "Turn highlights, notes and trails off" keeps the data and stops the feature on this site in this
  browser: nothing is marked, shown or saved, and the highlights region says so. The trail panel keeps
  export, the switch and erase. "Turn ... back on" restores it.
- **Erase.** "Clear all my local data" (above) removes the saved document, readable or not, after asking; the
  panel then shows "Kept in this browser: nothing." and the keys it still holds.

## Interpretation history

[ADR 0244](../adr/0244-a-reflection-is-a-private-immutable-snapshot-in-the-reader-annotation-document-and-a-submitted-copy-is-a-separate-explicit-bounded-act.md)
extends the document to version 2 with `reflections`: snapshots of how the reader read a work, kept
beside highlights and notes in the same key. `web/components/reader-reflections.js` holds the pure
functions; tests are `tests/web/reader-reflections.test.mjs`. The comparison view is described below; the
export, delete and submit controls are a separate task.

```json
{ "id": "refl-2", "kind": "reflection", "work": { "site": "https://example.com", "path": "/posts/tea/" },
  "revision": "p1:fedcba9876543210fedcba9876543210", "target": { "version": 1, "kind": "work" },
  "label": "After the rewrite", "text": "Tea is about attention, not patience.", "provenance": "written",
  "revises": "refl-1", "submissions": [{ "at": "2026-10-27T11:00:00Z", "channel": "hosted" }],
  "createdAt": "2026-10-27T10:00:00Z", "updatedAt": "2026-10-27T11:00:00Z" }
```

- **Versions.** Version 1 documents are read as version 2 with no reflections and written back as version 2.
  A version 1 file with `reflections`, or a version above 2, is refused whole.
- **Snapshots.** Text, target and revision never change; `label` and `submissions` may. `addReflection`,
  `reviseReflection` (a later reading that follows an earlier one, once), `relabelReflection`,
  `deleteReflection` (the line reconnects), `deleteWorkReflections`, `reflectionsOf`, `reflectionHistories`.
- **Validation** adds `invalidProvenance`, `invalidRevises`, `branchedHistory`, `invalidChannel`, `danglingRef` and
  `timeOrder` for histories, and limits of 500 reflections and 20 submission records each.
- **Stale and changed.** `assessReflections(document, works)` is `assessAnnotations` plus `articleChanged`. Derived, never stored.
- **Privacy.** The default export leaves reflections out and counts them (`omittedReflections`); "include notes"
  includes them. A reflection never reaches a page, feed, search, build or hosted service by being kept.
- **Submitting.** `prepareSubmissionCopy(document, id, { site, consent: { publish: true }, category?, name?, publishName? })`
  returns a bounded Third Perspective submission (ADR 0113) or the submission reader's refusal; it changes and saves
  nothing, and the copy carries no id, label, history, dates or other snapshot. `markSubmitted` records a send the
  reader made. The local snapshot stays private and is never converted.

### Comparing readings on-device

`web/components/ob-reflection-history.js` (`<ob-reflection-history>`, the "Your readings over time" region, after the
highlights and notes and before the reading trails) is the comparison view. It is local only: it requests nothing.

- **Without JavaScript** the region is one paragraph saying that keeping and comparing readings needs JavaScript, that
  readings stay in the browser and are never judged, and that the post reads as usual.
- **Saving a reading.** A form (whole post or one section, an optional label, which reading it follows, the words) calls
  `addReflection` or `reviseReflection`. A new reading follows the latest one by default, and "a new line of thought" starts
  another history. Quotation targets are not offered.
- **Timeline.** Each history is an ordered list, earliest first, so the sequence reads the same by keyboard and screen
  reader. Labels are edited in place (Enter saves, Escape cancels); the words never are.
- **Comparison.** Two selects choose any two readings; they appear as two articles, written first then written later, side
  by side where there is room and stacked in the same order where there is not. Nothing is scored, ranked, diffed or
  summarised, and no text says which reading is better or right.
- **Stale context.** Beside every reading, in both the list and the comparison, the page says whether the post has changed
  since it was written (`articleChanged`) and whether the part it was about was found, moved or is gone. The reading is
  never rewritten.
- **Storage.** Denied, full or unreadable storage is announced and readings are kept for the visit only, as for highlights.
  Turning the feature off hides the region's form and list and leaves the saved data alone.

### Export, deleting and sending a copy

All three live in the same region and the trail panel; none needs a hosted service.

- **Export.** The trail panel's file declares every field of the document. Readings are in it only when "Include the text of
  my notes and source notes, and my private readings" is ticked; otherwise the description says "N reflections left out"
  (`omittedReflections`), and the "Kept in this browser" line counts them.
- **Deleting.** "Delete this reading" asks first (Escape keeps it), reconnects the line, saves, then reads the store again and
  tells the reader whether the reading is gone ("Checked: it is no longer saved in this browser."). Where the browser is not
  saving, it says the removal is for this visit only. "Remove all my readings of this post" does the same for the post's
  readings and leaves other posts alone. Copies already sent are not in this document and are not touched.
- **Sending a copy.** "Send a copy for review" opens a form: an optional prompt, an optional name and whether to show it,
  an unticked agreement to publication (required), and an optional clarification consent. "Preview the copy" calls
  `prepareSubmissionCopy` and shows exactly the JSON that would be sent; changing any field removes the preview, so only a
  copy the reader has seen can be sent. Where the page has a hosted Third Perspective form (`receipts` and an `https`
  `endpoint`), "Send for review" posts that text to the existing `/feedback` route; only a `202` calls `markSubmitted`
  (`hosted`) and the one-time receipt is shown. A failure, offline state or refusal says so, records nothing and keeps the
  reading. Without a hosted form the reader copies the text and sends it themselves, then chooses "I sent it myself"
  (`copy-and-send`). Sent copies are listed on the reading by date and channel; later label edits or deletion never change a
  sent copy.
