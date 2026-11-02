# Voice samples

Status: built across epics VS1 to VS5 (#406 to #410), 2026-10-28

## Problem

The Assistant can review a draft, but it only knows how an author writes from whatever the author remembers
to tell it. A description of a voice written from memory is usually generic. The author's own unedited
writing is the better evidence, but collecting it is awkward, and writing that was never meant to be shown
(a rough, typo-ridden answer to a prompt) is exactly the kind of text an author does not want to leak or see
"corrected" by a tool.

## Solution

Voice samples are short pieces of the author's own writing, kept as Assistant context and never as posts:

1. **Capture.** A timed session draws three prompts from a catalog of ten genre packs, lets the author pick
   one, and gives them three minutes. The result is a **rough draft**: immutable once the session ends, typos
   included. The author may then make a **polished draft**, their own revision of that one rough draft.
2. **Keep.** Samples are flat Markdown files, private by default
   (`.openblog/private/context/voice/`), or portable (`assistant/context/voice/`) when the author chooses.
   Nothing publishes, builds, feeds or exports them as content.
3. **Use.** The author may select samples as Assistant context. The Assistant can propose a **voice guide**
   made only of quotations from the samples, review a draft against the guide and samples, and suggest
   replacements anchored to exact passages. It proposes; the author applies.
4. **Control.** Samples and the guide round-trip through a previewed, all-or-nothing export and import, and
   deletion is explicit and verifiable.

The feature is opt-in everywhere: with no samples, `openblog init`, builds, publishing and every existing
Assistant workflow behave as they did.

## User stories

1. As an author, I want a short timed prompt, so that I produce writing without overthinking it.
2. As an author, I want the rough draft locked exactly as I wrote it, so that it stays honest evidence of my
   voice.
3. As an author, I want spell-check, autocorrect and suggestions off while I write the rough draft, so that
   nothing changes my words.
4. As an author, I want to resume an interrupted session with its original deadline, so that a crash costs
   nothing and gives no extra time.
5. As an author, I want to polish a copy of a rough draft, see the difference, and turn the polished draft
   into a post draft, so that a good answer can become a post without touching the sample.
6. As an author, I want samples private unless I say otherwise, and to move a pair between private and
   portable on purpose.
7. As an author, I want a library view grouped by prompt pack with coverage, so that I can see what I have
   not yet written.
8. As an author, I want to select samples as context with a disclosed total against a limit, so that I know
   what is sent before anything is sent.
9. As an author, I want a voice guide in which every line quotes my own words and names its sample, so that I
   can check it and trust it.
10. As an author, I want a review against my guide that marks advice without evidence as unverified, so that
    "this does not sound like you" is never presented as fact.
11. As an author, I want replacements anchored to exact passages, shown as advice and never applied when they
    do not anchor.
12. As an author, I want to export my voice library and import it elsewhere, previewed first and all or
    nothing, so that I can take it with me.
13. As a site owner, I want an import never to make private text portable, never to replace a rough draft and
    never to let a guide quoting private samples into Git, so that moving data cannot leak it.
14. As a site owner, I want publish staging to exclude private samples and every AI use to pass through the
    authenticated, credential-safe provider boundary, so that collecting personal writing is not a liability.

## Implementation decisions

### Data and rules (VS1, epic #406)

- A sample is Assistant context, not a Post. Two stages: rough (immutable) and polished (author-owned,
  revision-checked, one per rough draft). The rule is enforced where bytes are written, in the store, not in
  any surface. See [ADR 0266](../adr/0266-voice-samples-are-assistant-context-and-a-rough-draft-is-immutable.md).
- The file is flat front matter (`voice.format`, `voice.catalog`, `voice.pack`, `voice.prompt`,
  `voice.stage`, `voice.timeLimitSeconds`, `voice.words`, `voice.roughOf`, plus `title`, `slug`, `date` and
  others), a blank line and the text; named `<YYYY-MM-DD>-<prompt-id>-<stage>.md`; at most 64 KiB; serialized
  deterministically, with unknown keys kept; a newer format is refused and never rewritten. The session
  record is `.openblog/private/voice/session.json`. See
  [ADR 0267](../adr/0267-the-voice-sample-file-format-and-session-record-are-versioned-flat-markdown-and-json.md).
- The prompt catalog is a bundled, versioned Markdown file (ten packs, forty-two prompts, ids forever) that a
  site can extend with `assistant/voice/catalog.md`; drawing three prompts is seeded and spreads across packs.
  See [ADR 0268](../adr/0268-the-voice-prompt-catalog-is-a-bundled-versioned-markdown-file-that-a-site-can-extend-and-the-draw-is-seeded.md).

### Command line (VS2, epic #407)

- `openblog voice` takes its clock from the session record and captures through `$VISUAL`/`$EDITOR` or a
  non-blocking stdin reader; the editor is polled, never waited for, and text after the deadline is not
  saved. `--resume`, `--list`, `--scrap`, `polish`, `diff` and `promote` complete the loop. See
  [ADR 0269](../adr/0269-the-cli-voice-session-takes-its-clock-from-the-session-record-and-captures-through-an-editor-or-a-non-blocking-stdin-reader.md).
- Promotion of a polished draft to a post draft is one store function that every surface calls; it refuses a
  taken slug and never touches the sample. See
  [ADR 0270](../adr/0270-promoting-a-polished-voice-sample-to-a-post-draft-is-one-store-function-that-every-surface-calls.md).

### Admin (VS3, epic #408)

- Routes under `/admin/api/voice/` are thin calls to the session and the store, and the server owns the
  deadline (late saves are refused, a lock has a 10 second grace). See
  [ADR 0271](../adr/0271-admin-voice-routes-are-thin-calls-to-the-session-and-the-store-and-the-server-owns-the-deadline.md).
- The Voice view is three steps on the server's clock; the rough box turns every correction off. See
  [ADR 0272](../adr/0272-the-voice-session-is-three-steps-on-the-servers-clock-and-the-rough-box-turns-every-correction-off.md).
- A timed draft survives a reload: the server keeps it, a bounded copy stays on the device, and the longer
  wins on load; the polished editor guards its unsaved work. See
  [ADR 0273](../adr/0273-a-timed-draft-is-kept-on-the-server-and-on-the-device-and-reconciled-on-load-and-the-polished-editor-guards-its-own-unsaved-work.md).
- The library groups samples by pack in catalog order and opens a rough sample read-only. See
  [ADR 0274](../adr/0274-the-voice-library-groups-samples-by-pack-in-catalog-order-and-a-rough-sample-opens-read-only.md).
- The timer is not a live region; the view speaks only its marks and the lock. See
  [ADR 0275](../adr/0275-the-voice-timer-is-not-live-and-the-view-speaks-only-its-marks-and-the-lock.md).
- The view is phone first and its layout is checked in a real browser. See
  [ADR 0276](../adr/0276-the-voice-view-is-phone-first-and-its-layout-is-checked-in-a-real-browser-without-font-metrics.md).
- The invitation appears once on the Admin home, and a dismissal is an Admin preference. See
  [ADR 0277](../adr/0277-the-voice-invitation-is-shown-once-on-the-admin-home-and-a-dismissal-is-an-admin-preference.md).

### Assistant (VS4, epic #409)

- A sample is context by id (`voice:<portable|private>:<file>`) and is reloaded on the server for every
  request; the browser can only name it. At most 8 samples and 120,000 characters per request, refused
  before anything is sent. The guide is an ordinary context file, `assistant/context/voice.md` or its
  private mirror. See
  [ADR 0278](../adr/0278-voice-samples-and-the-voice-guide-are-selected-as-assistant-context-by-id-and-reloaded-on-the-server.md).
- A proposal is folded into the saved guide on the server: traits it does not address and free text are kept,
  each changed trait is shown with both texts for the author to choose, and kept quotes are checked again and
  flagged when their sample is gone. See
  [ADR 0288](../adr/0288-a-proposed-voice-guide-is-folded-into-the-saved-guide-on-the-server-and-the-author-decides-each-change.md).
- The `voice-guide` task returns strict JSON in which every trait quotes a selected sample word for word; the
  guide is rendered deterministically and saved only on approval, with a revision check and a provenance
  comment recording which folders it quotes. A guide that quotes private samples cannot be saved as
  portable. See
  [ADR 0279](../adr/0279-the-voice-guide-task-has-a-strict-validated-result-that-is-rendered-deterministically-and-saved-only-on-approval.md).
- `voice-match` reviews a passage only, a selection or the current section, and its findings must lie inside it;
  see [ADR 0290](../adr/0290-a-review-can-cover-a-selection-or-a-section-and-voice-match-reviews-only-a-passage.md).
- `voice-review` marks a finding unverified unless it names a sample or guide section; `voice-match` suggests
  replacements anchored to exact passages, applied only through the existing Apply and Undo path. See
  [ADR 0280](../adr/0280-voice-review-and-voice-match-compare-with-the-guide-and-samples-and-only-ever-propose.md).
- The engine guide teaches what samples, stages and the guide are, and gaps (unanswered packs and prompts,
  rough-only prompts, traits resting on one sample) are computed by the core. See
  [ADR 0281](../adr/0281-the-engine-guide-teaches-voice-samples-and-gaps-are-computed-by-the-core.md).

### Privacy, portability and release (VS5, epic #410)

- Visibility defaults to private; promotion to portable is explicit and reversible; publish staging never
  includes private samples (the privacy proof, #463).
- The library travels as one previewed, all-or-nothing export that keeps each item's folder: `openblog voice
  export` and `import`, deterministic and byte-identical for valid files, private material only on request,
  never replacing a rough draft, never moving a sample between folders, refusing newer formats and a
  portable guide that quotes private samples. See
  [ADR 0284](../adr/0284-the-voice-library-travels-as-one-previewed-all-or-nothing-export-that-keeps-each-items-folder.md).
- The voice guide moves between the folders in one locked copy, verify and remove step. The move is previewed
  first (`openblog voice guide --move portable|private [--yes]`, or Make private / Make portable in Admin),
  refuses links, and never moves a guide that quotes private samples to portable. See
  [ADR 0289](../adr/0289-the-voice-guide-moves-between-portable-and-private-in-one-locked-copy-verify-remove-step.md).
- Erasing the library is listed, confirmed (`openblog voice erase --yes`, or typing `erase` in Admin), all or
  nothing, and checked again afterwards; it refuses linked folders. See
  [ADR 0282](../adr/0282-voice-samples-are-private-until-the-author-chooses-portable-and-a-move-between-the-folders-is-reversible.md)
  and
  [ADR 0283](../adr/0283-erasing-voice-data-is-listed-confirmed-staged-in-a-trash-folder-and-checked-again.md).

## Testing decisions

- The core is tested without I/O: parse/serialize round trips and refusals, catalog parsing and draw, guide
  validation and rendering, gaps, and the export format.
- The store is tested for the rule that matters most: a rough draft is created once and every later write is
  refused, byte for byte; moves copy and verify; polished saves are revision-checked.
- The CLI session is tested with an injected clock and editor behaviour, including deadline, resume and
  crash cases; the export and import are tested end to end in temporary projects (round trip, dry run,
  invalid file, newer format, conflicts, folder rules, provenance rule).
- Admin routes are tested for denial by default, CSRF, bounds, the server-owned deadline and the absence of a
  rough write route; the browser views through the Admin DOM harness and Playwright (phone layout measured on
  the region under test).
- Assistant requests are tested for server-side reload, the budget, labelling as untrusted data, strict guide
  validation, the unverified-advice rule and the unchanged behaviour of requests with no sample.
- Full Rust, web, clippy, formatting, isolated release-build and accessibility gates run at each stable
  commit.

## Delivery slices

1. VS1: format, store, catalog, session record (ADRs 0266 to 0268).
2. VS2: command-line session, polish, diff and promote (ADRs 0269 and 0270).
3. VS3: Admin routes, session view, library, invitation (ADRs 0271 to 0277).
4. VS4: Assistant context, guide, review and match, engine guide (ADRs 0278 to 0281).
5. VS5: privacy proof, export and import (ADR 0284), privacy and erase (ADRs 0282 and 0283), this spec, documentation and release.

## Out of scope

- Editing, correcting or re-saving a rough draft by any means, including AI.
- Applying an AI change to a polished draft automatically.
- Publishing, building, feeding or syndicating a sample, or sending samples anywhere without the explicit
  context selection and disclosure.
- Hosted storage, sync between machines other than the export file, or team-shared libraries.
- Scoring, ranking or "voice similarity" metrics.
