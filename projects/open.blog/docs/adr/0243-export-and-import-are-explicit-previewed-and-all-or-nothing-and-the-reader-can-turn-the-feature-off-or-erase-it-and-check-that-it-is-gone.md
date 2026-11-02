# ADR 0243: Export and import are explicit, previewed and all-or-nothing, and the reader can turn the feature off or erase it and check that it is gone

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#87](https://github.com/journey-to-code-org/open.blog/issues/87)
- Parent story: [#30](https://github.com/journey-to-code-org/open.blog/issues/30)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0237, ADR 0239, ADR 0240, ADR 0242

## Context

Highlights, notes, saved sources and trails live in one document in the reader's browser (ADR 0237). The
reader needs to take that document elsewhere and bring one back, to see what a file would contain before
it leaves, to see what a file would change before it is kept, and to stop the feature or remove its data
and know that it worked. A file is easy to forward and easy to forge, so both directions treat it as
untrusted.

## Decision

- **Export is one deliberate download.** "Download my reading trail" makes a file in the browser (a Blob and
  a dated name, `openblog-reading-trail-YYYY-MM-DD.json`); nothing is uploaded. The reader's own words are
  left out unless "Include the text of my notes and source notes" is checked, and the sentence above the
  button says, before the file exists, how many highlights, notes, sources, trails and steps it will hold,
  its size in bytes, whether notes are included, and how many notes on a section or the whole post would be
  dropped (ADR 0239). "Show exactly what the file contains" displays the file's text. The file is the
  document and nothing else: the export function is `exportDocument` plus `serializeDocument`, so no site
  setting, page text or identifier outside the document can reach it, and a test pins its top-level keys.
- **Import is read, planned, previewed, then kept.** The file is size-checked before it is read (4 MiB, the
  contract's limit), then read by the same validator as every read (ADR 0240). A file that fails is
  refused whole with up to eight problems, each a plain sentence and the record it names (such as
  `annotations[0]`), never the reader's text. A file from a newer version is refused as such. A valid file
  is merged with what is saved by `planImport`, which changes nothing and returns what would happen.
- **Merge is deterministic and never silent.** What is saved comes first, then the file's records in the
  file's order. A record with an id already saved and the same content (apart from its dates) is left as is.
  A record whose id is saved with different content is a conflict: it is listed, what the reader has saved
  stays by default, and "Use the file's version" replaces only those records. A record that says the same
  thing under another id (the same passage and words, the same link or post) is not added twice, and the
  trail steps that named it follow the record already saved. A trail's steps are rebuilt in terms of the
  records that now exist, once each. The whole result is validated by the contract (limits, references),
  and a result that breaks a rule refuses the import. A file that leaves out notes never removes a saved
  note.
- **Stale targets are reported, not repaired.** The page knows the text of only the post being read, so
  imported highlights and notes on this post are checked against it (ADR 0077), and the preview says how
  many no longer match or would be found again in changed text. Those on other posts are said to be
  checked when those posts are opened. Nothing is moved on a guess.
- **Writing is all-or-nothing and re-checked.** Import is a `commitStore` change: it reads the freshest
  saved document, plans again, and refuses ("changed since the preview") if the result is not exactly
  what was previewed, so another tab's change cannot be lost. Unreadable saved data is never written over, and
  an import into a browser that denies storage is refused with the reason. Every failure leaves the browser's data
  as it was. After a change both panels refresh through the window event (ADR 0242). Cancelling at any
  point changes nothing and returns focus to the file chooser.
- **The reader can turn the feature off.** One more key, `openblog.reader-annotations.off`, holds the
  choice, in this browser only. Off means nothing is read, painted, offered or saved: the highlights
  region shows a notice, the trail panel shows only export, the switch and erase. Saved data is kept (it
  is exportable and can be turned back on). Turning on removes the key. A site that has turned
  `readerAnnotations` on still publishes the same static HTML; the switch is the reader's, not the site's.
- **Erase is complete and checkable.** "Clear all my local data" (ADR 0242) still removes the document key
  whatever it holds, after asking. The panel states, from the browser itself each time it draws, what is
  kept ("Kept in this browser: nothing.") and which storage keys the feature holds (`none`, or the
  names), so a reader can see an erase worked, and a test checks the keys directly. It never touches the
  keys of anything else on the site.

## Consequences

- The export is portable and lossless for a reader who includes notes: exporting then importing into an
  empty browser reproduces the document byte for byte.
- A reader who imports a file of unknown origin sees every consequence first and loses nothing; a hostile
  file cannot reach storage because it fails validation or the preview is cancelled.
- The off switch lives in `localStorage` beside the data, so clearing site data also resets it to on.
- The merge compares records as the contract defines them; it makes no claim that two passages are the
  same idea, only that they quote the same words in the same place.
