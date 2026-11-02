# The admin editor: log in, edit, create, schedule

`openblog serve --admin` adds a login-protected editor at `/admin` to the same server that
serves your blog. The editor reads and writes the same Markdown files you would edit by
hand, so your content stays plain files you own. No database is required by default.
Ephemeral hosts can opt into [durable Supabase workspace storage](deploy.md#durable-editorial-workspace-on-ephemeral-hosts).

```sh
openblog user add you              # create a login (prompts for a password)
openblog serve --admin             # http://localhost:8080/admin
```

Passwords need at least 12 characters. To avoid typing one where it is echoed, use
`echo "your passphrase" | openblog user add you --password-stdin` or set
`OPENBLOG_PASSWORD`. Other commands: `user passwd <name>`, `user remove <name>`,
`user list`. Changing a password or removing a user ends that person's open sessions
immediately.

## What you can do

| | |
| --- | --- |
| **Edit** | Every post, page, and series. Front matter fields become a form; unknown fields you added by hand are kept. |
| **Create** | New posts, pages, and series. The file is named from the date and slug. |
| **Preview** | A full-page site preview plus portable HTML and Markdown projections for posts, all generated from the current unsaved source. Portable warnings identify transformed or canonical-only behavior; front matter stays in Settings and is never printed into a preview. |
| **Social preview** | A card built from the generated OpenGraph title, description, canonical URL, type, image, and X card mode—not a separate browser-side approximation. |
| **SEO & answer readiness** | A transparent, local checklist for search metadata, direct-answer structure, supporting sources, authorship, links, and image accessibility. Its readiness score is guidance, not a ranking guarantee. |
| **Accessibility Studio** | Production-backed source findings grouped as detected, potential, or needs review, with exact locations and repair guidance. It also keeps rendered-site checks visible without claiming WCAG conformance. |
| **Evidence Studio** | Research-profile structure and metadata findings from the publishing engine, plus authored DOI (normalized to a resolver URL when valid), valid absolute license URL, and linked-reference inspection without truth or authority scoring. |
| **Images** | Insert by button, drag and drop, or paste. Saved under `static/images/uploads/<year>/`. |
| **Formatting** | Write in a word-processor-style Visual mode or switch to Markdown. Choose Paragraph or Heading 2–6, then apply bold, italic, links, quotes, numbered or bulleted lists, images, and code. `Ctrl+B`/`Command+B` and `Ctrl+I`/`Command+I` work in either mode. |
| **Personal workspace** | Start with a calm writing-focused workspace, choose Guided or Advanced, or customize optional tools, their order, spacing, and default writing mode. |
| **Content profiles** | Choose field-specific authoring and rendering behavior for a post. Legacy recipes are recognized without silently rewriting their front matter, and unknown profile ids remain intact with visible fallback guidance. |
| **Video release kit** | Validate authored YouTube chapters and copy a description assembled from the current summary, chapters, and AI-assistance disclosure. |
| **Field Review** | Analyze GPX locally, derive route facts, and choose hidden, trimmed, approximate, or exact location publication. |
| **Assistant** | Inspect the configured author-time provider, manage portable or private author/site context, and preview exactly which context is selected. Provider credentials remain on the server. |
| **Knowledge checks** | Insert one to three multiple-choice questions through a form, with optional author-time generation. Reader attempts stay in the reader's browser. |
| **Shared reflections** | Start a private shared reflection from a video, article, podcast, book, or other source, with a working title or guiding question. Nothing is published and no post is created. |
| **Delete** | Moves the file to `.openblog/trash/`; nothing is destroyed. |
| **Schedule** | See below. |
| **Analytics** | Views, unique visitors, a per-day chart, top pages and referrers from the built-in counter. See [features.md](features.md). |
| **Appearance** | Choose whether the public light/dark button is shown, hidden (system preference only), or inherited from each page's theme. Settings are saved in `openblog.json` and rebuilt locally; Publish to update a separately hosted static site. The Admin's own theme is unchanged. Business facts have their own screen. The site look (palette, accent, font style, sizes) is read and saved at `GET`/`PUT /admin/api/look`; a save changes only the `appearance` key, is checked against the revision you loaded, and is bounded to 4 KiB. |
| **Publish** | A button in the header commits changed content with git and pushes it, so a Pages workflow deploys. Drafts stay local. See [publishing.md](publishing.md). |

## Workspace layout

The admin is organized like a writing studio. New accounts start in **Simple**, which keeps
the main navigation focused on content and the essential **Write**, **Site preview**, and
**Settings** views. Every other document view sits under **More tools** in the editor bar,
and the header's **Advanced tools** dialog groups every optional tool by goal: getting
writing help (the optional AI Assistant, including knowledge checks and runnable-code
proposals), checking quality and research, sharing and distribution, and collaboration and
readership. **Guided** adds Accessibility, Evidence Studio, and Assistant to the editor bar
and the Research workspace to the main navigation, **Advanced** shows everything, and **Custom** lets you show or hide each optional tool. In
every preset you can reorder optional tools with the up and down buttons, choose comfortable
or compact spacing, pick a default Visual or Markdown writing mode, and **Restore defaults**.
Open **Personalize** from the header, from Advanced tools, or by searching for
"Personalize workspace" with `Ctrl+K`.

Workspace preferences are private presentation choices for one admin login, not site
configuration: they never change a post, `openblog.json`, the generated site, feeds, or
exports. They are stored under `.openblog/private/admin-preferences/` (ignored by Git in new
projects), limited to a small schema-versioned file per login, and protected by the same
login and CSRF checks as content editing. Each save names the revision it replaces, so a
change made in another tab or session is reloaded instead of silently overwritten. Write,
preview, settings, save state, publish status, conflicts, privacy notices, approvals, and
blockers cannot be hidden or reordered. If private preference storage is unavailable,
authoring falls back to the Simple workspace with a notice and remains usable. Only saving
from **Personalize** replaces stored preferences that can no longer be read; switching
between Visual and Markdown then lasts for the session without touching the stored file.
The server allows that replacement only when the stored file is malformed or too large,
never when it could not be read at all.

Admins who used the workspace before personalization existed keep the full layout: on their
first sign-in after upgrading, a browser that remembered a writing mode from an earlier
release starts in **Advanced** with that writing mode, and the choice is then stored privately
for the login. The browser then forgets the old writing mode, so the migration happens once
and another login in the same browser starts in **Simple**. A remembered preview width does
not count, because this release still remembers it.

Inside the editor, Social, Release kit, Field Review, Optimize, Accessibility, Evidence, and
Assistant are separate full-width views, so writing is not squeezed beside a permanent preview.
Switching views never loses edits, and opening Site preview refreshes it from the current draft.

Portable preview findings are grouped by capability, representation, and destination, with
**Fully portable**, **Gracefully transformed**, or **Canonical-only interaction** labels
rather than a score. Findings explain what the copy preserves and which interactions stay
on the canonical article. **Edit source at line …** opens Markdown, focuses and selects the
relevant source, and announces the navigation without saving or changing unsaved content.
Findings without an exact source location remain visible without a navigation button.
Warning acknowledgements remain revision- and destination-scoped. A failed preview shows
the validation error and disables copy/download until a current preview succeeds.

Destination views also show shared content-policy findings: retained image references
have not been inspected or uploaded, Ghost's HTML-to-Lexical conversion is lossy, and
WordPress's external canonical needs separate configuration. Unmapped destination tags
are disclosed, not silently discarded. These are draft-review requirements, not claims
that a browser preview certifies provider rendering or media type/size acceptance.

Press `Ctrl+K` on Windows or Linux, or `Command+K` on macOS, to search workspace
commands. The palette opens content lists, creates documents, switches editor panes,
saves the current document, changes the color scheme, and reaches account actions. Use
the arrow keys and Enter to choose a result, or Escape to close it.

The editor footer shows whether the document is saved plus its line, word, and character
counts. Press `Alt+1` through `Alt+9` to focus Write, Site preview, Social, Release kit,
Field Review, Optimize, Settings, Accessibility, or Evidence, whether or not that view is
shown in the editor bar. The preview
toolbar can constrain the canvas to wide, tablet, or mobile width; this preference is stored
in the browser and does not change the published theme.

For posts, press `Alt+0` to open **Assistant**. Its provider card reports the provider type,
model, configured state, and supported capabilities without returning the credential or
configured endpoint path, query, or user information to the browser. The provider card and Review
disclosure show only the safe destination origin so authors know which service receives selected
material. Review, Interactions, and Context are labelled work areas. Interactions creates editable
knowledge-check, runnable-example, and coding-challenge proposals, while Context manages author,
site, and post notes plus selected sources. Provider failures do not disable ordinary non-AI
authoring.

### Review an unsaved document

Open **Assistant → Review** to review the current unsaved title, metadata, and Markdown without
saving first. Under **What to review**, keep **Complete document** or choose **Selected text** (the text
selected in the draft) or **Current section** (from the heading before the cursor to the next heading; a `#` line inside fenced code is code, not a heading).
Findings then stay inside that passage, and a skill that cannot review it is shown as unavailable
([ADR 0290](adr/0290-a-review-can-cover-a-selection-or-a-section-and-voice-match-reviews-only-a-passage.md)).
Select one or more review skills and any context the provider should receive, then
inspect the disclosure: it lists the scope, approximate source size, every skill
and context item, provider model and safe destination origin, and confirms external research is off.
Nothing is sent until **Run document review** (or **Review selected text**, **Review current section**) is
pressed.

Validated findings are grouped under their originating skill and visibly labelled **AI-generated
advice**. Each finding shows its severity, category, exact source evidence, explanation, optional
suggested replacement, and whether it is unverified advice or based on supplied context. Choose
**Apply suggestion** to replace its exact reviewed passage in the unsaved draft. The editor refuses
ambiguous, stale, repeated, or overlapping replacements and offers one-step undo. Applying or undoing
never saves or publishes. Provider errors, invalid results, and edits made while a review is running
leave the draft unchanged.

### Use AI autocomplete while writing

In **Write**, turn on **AI autocomplete** for the current editor session. It is off by default and is
not remembered. The disclosure explains that after an 850 ms typing pause the current unsaved title,
metadata, Markdown, nearby caret text, and explicitly selected Assistant context are sent to the
configured provider. Only one request runs at a time. Navigating away aborts pending work.

A returned continuation remains a visible proposal. Press `Tab` or choose **Accept** to insert it,
or press `Escape` or choose **Dismiss**. Moving the caret or changing the title, metadata, context,
writing mode, or draft makes the proposal stale and prevents insertion. Accepted text follows the
normal unsaved-change path in Visual and Markdown modes; it is never saved or published automatically.

### Draft a knowledge check

Open **Assistant → Interactions** and choose **Create knowledge-check proposal**. The same proposal
dialog available from the Write toolbar uses selected text when present, otherwise the current post.
Generated questions are reviewed in the dialog and enter the unsaved Markdown only after explicit
insertion. Non-AI quiz authoring remains available.

### Draft a runnable example or coding challenge

Open **Assistant → Interactions** and choose **Create runnable-code proposal**. Choose a complete
example when readers should run, change, and observe working code, or a coding challenge when they
should complete a small bounded task. With a provider configured, **Generate draft** uses selected
text, then the current section, then the post as context. Without a provider, fill in the same form
manually.

Choose Rust, Web (HTML/CSS/JavaScript), or a language explicitly enabled by the site's external
runner. The title, instructions, source, expected result, hint, and explanation remain editable in
the dialog. A challenge must include a visible TODO comment and expected result. Nothing enters the
unsaved post until **Insert into draft** is chosen. The inserted content uses portable Markdown prose
and one native runnable fence, so it works in both Visual and Markdown authoring modes. Web results
must preserve `---html`, `---css`, and `---js` markers. The provider must return the requested
language; multi-file projects, hidden tests, automatic grading, and shell commands are not offered.

### What the Assistant knows about open.blog

Every review, interaction-generation, and autocomplete request includes a versioned engine guide generated
from open.blog's deterministic core. It describes native quiz and Rust/web runnable fences, configured
runner allowlists, code options,
supported embeds, content-profile IDs, scheduling, source ownership, and the limits of evidence checks.
These are renderer facts, not instructions found in the draft. Draft and context text remain untrusted
data. The guide prevents an AI from treating supported engine syntax as an error, but it does not let
the provider save, publish, certify claims, perform external research, or add unsupported syntax.

### Manage Assistant context

Open **Assistant → Context** to create or edit Markdown notes about the author or the site's
audience and goals. **Portable** notes live at `assistant/context/author.md` and
`assistant/context/site.md`; they can be reviewed and deliberately included in normal Git
publishing paths. **Private** mirrors live below `.openblog/private/context/`, are visually
distinguished, and are always excluded from open.blog publish staging.

Each file is limited to 64 KiB of UTF-8 text. Invalid or oversized files remain visible with
repair guidance instead of being silently selected. Saves and removals use revision checks, so
an edit made elsewhere is not overwritten. The Context view warns if Git does not ignore the
private directory or if a private file is already tracked. `openblog init` adds
`/.openblog/private/` to `.gitignore` for Git projects while preserving existing rules.

Select context explicitly with the checkbox on each valid file. The **Context disclosure**
preview lists every selected filename, whether it is Portable or Private, its character count,
and the total size. Selection alone does not contact a provider; a later explicit Assistant
request will use this disclosure before anything is sent.

Saved posts also offer **Post brief** context in portable and private forms. The brief has separate
fields for the post's goal, audience, learning outcomes, sources, and free-form constraints; it is
stored at `assistant/context/posts/<post-filename>.md` or the matching private path. Renaming or
moving a post to trash moves its brief in the same filesystem transaction, and restores the whole
bundle if any move fails.

The **Text references** area accepts only `.md` and `.txt` UTF-8 sources up to 64 KiB. It shows the
stored text before selection and rejects unsupported filenames, binary text, duplicates, and
oversized input without a partial file. **Existing post snapshots** shows only Markdown posts from
the configured content directory. Selecting one uses the exact bounded source currently on disk;
it does not copy images, sidecars, or other repository files. Invalid or oversized snapshots remain
unselectable with guidance.

The disclosure preview includes every selected post brief, reference, and existing-post snapshot,
with its visibility and character count. These selections remain local until a later explicit
Assistant request.
To capture a web reference, use **Add URL snapshot** and confirm the retrieval. Admin accepts
only public HTTP(S) destinations, rechecks every bounded redirect, rejects credentials and
local or private network addresses, and applies one total deadline plus strict response and
extracted-text limits. Supported responses are UTF-8 HTML, Markdown, and plain text. Compressed
responses are rejected, so an encoded body cannot expand past the extraction limit.

Retrieval does not save anything. Inspect the source and final canonical URLs, retrieval time,
content type, and extracted text, then choose portable or private storage and explicitly save.
Saved references live under `assistant/context/references/` or the matching
`.openblog/private/context/references/` directory. They are labelled untrusted reference data;
selecting one uses the saved Markdown snapshot and never silently contacts the URL again.

### Where voice samples are kept

Voice samples are the author's own writing, captured so Assistant tools can learn how you sound
(see [ADR 0266](adr/0266-voice-samples-are-assistant-context-and-a-rough-draft-is-immutable.md)).
They are Assistant context, not posts: they are never published, built into the site, added to a
feed, or exported as content. You write them from the terminal
([`openblog voice`](#write-a-voice-sample-from-the-terminal)) or in Admin
([Voice](#write-a-voice-sample-in-admin)), and you can take them with you
([export and import](#move-your-voice-library-between-projects)).

| What | Portable | Private |
| --- | --- | --- |
| Rough and polished drafts | `assistant/context/voice/<YYYY-MM-DD>-<prompt-id>-<stage>.md` | `.openblog/private/context/voice/` (same names) |
| The open writing session | | `.openblog/private/voice/session.json` (always private) |
| Your own prompts and hidden packs | `assistant/voice/catalog.md` | |

- **Private is the default.** Everything under `.openblog/private/` is ignored by Git
  (`openblog init` adds `/.openblog/private/` to `.gitignore`) and excluded from publish staging.
  The Context view warns, and names the file, if a private voice sample is tracked by Git.
- **A rough draft never changes.** Once its session ends the store refuses any later write to it;
  to fix typos, make a polished draft, which is yours to edit. You can move a pair between
  portable and private, or erase it.
- **Add prompts or hide packs** with `assistant/voice/catalog.md`: `## pack-id: Title` and
  `### prompt-id: Title` sections (see the bundled catalog in the open.blog source), and
  `disabled: [pack-id]` in its front matter to hide a pack. A prompt id the bundled catalog
  already uses is rejected.
- A project that has never written a sample has none of these folders, and its builds are
  identical to before.

### Write a voice sample from the terminal

`openblog voice` is a three-minute writing session. It draws three prompts, you pick one, you write,
and the clock locks your **rough draft** exactly as typed (typos included). `openblog init` offers one
session when you run it at a terminal; answer anything but `y` to skip, or pass `--no-voice`. Scripts
and pipes are never asked.

```text
openblog voice                     # draw three prompts: pick 1-3, r to draw again, q to quit
openblog voice a-mistake-i-made    # skip the draw
openblog voice --list              # packs, how many you have answered, and each prompt's stage
openblog voice --resume            # carry on with an interrupted session (deadline unchanged)
openblog voice --scrap --yes       # give up the open session and save nothing
openblog voice erase [--yes]       # list, then erase ALL voice data (see below)
```

- **Where you write.** If `$VISUAL` or `$EDITOR` is set, your editor opens a file with the prompt and a
  marker line; only the text below the marker is saved. The editor command must wait until you close its
  window: use `code --wait` or `subl -w`, not plain `code` or `subl`. An editor that returns at once without a
  change locks and discards nothing; the session stays open for `--resume`. Otherwise (or with `--stdin`) you
  type in the terminal and finish with a line holding only `.`, or Ctrl-D. To pipe text in, name the prompt
  (`openblog voice <prompt-id> --stdin`); piped text without one starts nothing and exits with an error. The
  deadline time is shown first.
- **One window at a time.** A session is written in one terminal. `--resume` in a second window while the
  first is still writing is refused, and nothing is changed.
- **The clock.** The deadline is stored when the session starts. Text written after it is not saved, and
  if you come back after it the saved text is locked. An empty draft saves nothing.
- **Options.** `--portable` keeps the sample beside shared Assistant context (the default is private),
  and `--seconds <n>` sets the window (30 to 3600, default 180).
- **Refine a copy.** `openblog voice polish <sample>` opens a copy of the rough draft in your editor and
  saves it as the **polished draft** (`--title`, `--slug`, `--description` and `--tags a,b` set its
  details). Run it again to edit the polished draft. The rough file never changes; `openblog voice diff
  <sample>` shows what you changed.
- **Make a post.** `openblog voice promote <sample>` creates a post draft (`draft: true`) in
  `content/posts/` from the polished draft, refuses a slug a post already uses, and leaves your samples
  alone. `--dir posts/2026` picks a folder inside `posts`.

`<sample>` is a file name from `voice --list` or a prompt id. Output is plain text.

### Write a voice sample in Admin

The **Voice** view (`#/voice`) does the same job as `openblog voice`, with the same files and the same rules
(see [ADR 0271](adr/0271-admin-voice-routes-are-thin-calls-to-the-session-and-the-store-and-the-server-owns-the-deadline.md)
to [0277](adr/0277-the-voice-invitation-is-shown-once-on-the-admin-home-and-a-dismissal-is-an-admin-preference.md)).
The Admin home offers it once, in a **Gather your voice** card, while you have no samples; **Dismiss** keeps
it away for good.

1. **Choose what to write about.** **Draw from every pack** shows three prompts; choose one, or
   **Draw three more**, or **Draw from this pack** in the library.
2. **Write.** **Start the 3:00 timer**, then write. Spell-check, autocorrect and writing suggestions are off
   in this box on purpose. The server owns the clock: it is a display, a reload or a lost connection carries on
   with the original deadline, and text sent after the deadline is refused. Your draft is saved to the server a
   moment after you stop typing, and a bounded copy stays on the device (cleared after a day, and when you sign
   out; if your sign-in ends without signing out, signing in again as the same author gets it back). **Finish
   early** locks it at once. If the time runs out while another window or the terminal is still handing over
   its last words, this view waits a few seconds instead of locking older text.
3. **Polish (optional).** The locked rough draft is shown read-only, exactly as written. Below it is a copy
   to edit: **Reset to rough** starts the copy over and **Save polished draft** saves it, checking that nobody
   changed it meanwhile. Leaving with unsaved polished edits asks first, and unsaved edits are kept on this
   device for up to 30 days (cleared on sign-out and by an erase) and offered back after a reload with
   **Restore** or **Discard**. **Make portable** or **Make private**
   moves the pair together (the default is private), and **Make a post draft** creates a draft post from the
   polished draft.

The **Sample library** (`#/voice/library`) groups your samples by prompt pack, newest first (a prompt you
answered on several days has a row per answer), with Rough and
Polished badges, length, visibility and date, a coverage line per pack, and a note for any file that cannot
be read and what to do about it. A rough sample opens read-only. The view works on a phone and from the
keyboard; the timer is not announced every second, only at its marks and when it locks.

### Erase your voice data

Samples are private unless you choose portable (`--portable`, or "Portable" when you start a session in
Admin); "Make private" and "Make portable" on a sample move it, with its partner, and moving it back
restores the same bytes. The voice guide moves the same way. Use **Make private** or **Make portable** on its
card in the Assistant Context view, or run `openblog voice guide --move private` (it shows what would move;
add `--yes` to move it). The file is copied, checked and only then removed, so a failed move never loses the
guide. A guide that quotes private samples, or cannot be read, stays private
([ADR 0289](adr/0289-the-voice-guide-moves-between-portable-and-private-in-one-locked-copy-verify-remove-step.md)). Private samples are never published, built, fed or exported as content (a voice
export carries them only with `--include-private`; see below).

`openblog voice erase` lists everything the voice feature stored: samples in both folders, the session
record, the voice guide and leftover editor files. It stops there; add `--yes` to erase. In Admin, **Your
voice samples** has **Erase all voice data…**: it shows the same list and enables **Erase everything**
only after you type `erase`. The erase is all or nothing (if one file cannot be removed, everything is put
back) and ends with a second look that says "nothing is left" or names what is. Admin also clears the
copies of drafts kept on that device. Copies in Git history or backups are not touched, and neither are voice
export files you wrote yourself (for example `.openblog/private/voice-library.json`): delete those by hand.

### Use voice samples and a voice guide with the Assistant

Your samples and a **voice guide** can be chosen as Assistant context, so reviews and suggestions
sound like you and not like a model (ADRs [0278](adr/0278-voice-samples-and-the-voice-guide-are-selected-as-assistant-context-by-id-and-reloaded-on-the-server.md)
to [0281](adr/0281-the-engine-guide-teaches-voice-samples-and-gaps-are-computed-by-the-core.md)).
Nothing is sent unless you select it and run a request, and nothing here changes a project that has no samples.

- **Choose samples.** In the Assistant's Context view a **Voice samples** section lists each sample with its
  stage, pack, prompt, visibility and size. Tick the ones to send. The disclosure lists them with a running
  total against the limit of 8 samples and 120,000 characters per request; a selection over it is refused
  before anything is sent. The server reads the chosen files again for every request, so the browser only ever
  names a sample. Sample text is sent as data to compare against, never as instructions.
- **Propose a guide.** Select samples and choose **Propose a voice guide from selected samples**. The provider
  returns a guide in which every line quotes your own words word for word and names its sample (a result with
  a quote that is not in the sample is rejected, and nothing is shown). A line that rests on one sample is
  marked `(one sample)`, and the guide always ends with *What is not yet known*. The proposal is folded into
  your saved guide ([ADR 0288](adr/0288-a-proposed-voice-guide-is-folded-into-the-saved-guide-on-the-server-and-the-author-decides-each-change.md)).
  Traits it does not address are kept word for word and labelled **Kept from your current guide**. Your own
  text outside the traits, such as an introduction, notes or sections under your own headings, stays where it
  is. A trait the proposal changes is shown with both texts, and you choose **Keep current** or **Take proposed**
  for each one before you can save. A kept quote is checked again against its sample and flagged, not dropped,
  when that sample no longer exists or no longer contains it. You see the proposal as
  changes against your saved guide, can edit it, and it is written only when you choose **Save as portable**
  (`assistant/context/voice.md`) or **Save as private** (`.openblog/private/context/voice.md`, the default).
  **Discard** leaves your files as they were. A guide changed elsewhere since you opened it is a conflict, not
  an overwrite. A guide built from any private sample, from a saved guide that is private, or from a saved guide
  whose traits quote a sample that is private now, records that on a
  provenance line under its title (`<!-- openblog:voice-provenance sources=... -->`) and can only be saved as
  private: **Save as portable** is disabled with the reason. Keep that line if you edit the guide; the
  portable rule relies on it.
- **Use the guide.** Select the guide like any context. The `voice-review` skill compares your draft with it and
  with your samples, and names the sample or guide section behind each finding (a finding that names none is
  marked unverified advice). The `voice-match` skill works on a passage: select text or put the cursor in a
  section, choose **Selected text** or **Current section** in Review, and it suggests small replacements inside
  that passage only. A suggestion that cannot be found exactly in the passage is shown as advice and never
  applied, and any applied suggestion can be undone. With AI autocomplete on and the guide selected, suggestions lean toward your voice, and turning
  autocomplete on names the selected context first.
- **Never your rough text.** The Assistant never edits a rough draft and never applies a change to a polished
  draft: it proposes, you decide.
- **What is missing.** `openblog voice --list` also shows packs with no sample yet, prompts with a rough draft and
  no polished draft, and guide traits that still rest on one sample; the Sample library shows the same list under
  **What is missing**, and the guide request carries it.

### Move your voice library between projects

`openblog voice export` puts your voice samples and your voice guide in one JSON file; `openblog voice import`
reads such a file ([ADR 0284](adr/0284-the-voice-library-travels-as-one-previewed-all-or-nothing-export-that-keeps-each-items-folder.md)).
Neither needs a hosted service.

```text
openblog voice export                                  # print the portable samples and guide
openblog voice export --out voice-library.json --write # create the file (never replaces one)
openblog voice export --include-private --out .openblog/private/voice-library.json --write
openblog voice import voice-library.json               # preview: what would be created or replaced
openblog voice import voice-library.json --write       # apply, all or nothing
```

- **Private stays private.** An export holds only the portable folder unless you pass `--include-private`, and
  a file with private material is refused inside the project except under `.openblog/private/`.
- **Limits.** One guide travels: with both a portable and a private guide, the portable one is exported and
  the export warns that the private one was left out. One export holds at most 100 samples and 8 MiB; a larger
  library is refused whole, and nothing is written.
- **Previewed.** Import is a dry run unless `--write`. It lists `create`, `replace` or `unchanged` for each file
  and the folder it goes to, and it writes nothing at all if any item is invalid, too large, in a newer format
  or in conflict.
- **Folders are kept.** An item lands in the folder it came from; an import never moves private text to the
  portable folder, and `--as private` puts everything in the private folder. When files would go to the
  portable folder (which Git tracks) the preview says so.
- **Rough drafts are safe.** A rough draft that differs from the one already saved is a conflict, with or
  without `--overwrite`. A differing polished draft or guide is replaced only with `--overwrite`.
- **The guide follows its provenance.** A guide whose provenance line lists private samples is only accepted
  into the private folder, and is left out of a portable export.
- A valid file round-trips byte for byte. A library with no samples exports an empty file, and Admin has no
  import screen: the file moves between projects, and the command line is the place for it.

To remove the whole voice library from a project, see [Erase your voice data](#erase-your-voice-data):
`openblog voice erase [--yes]`, or **Erase all voice data…** in Admin with the typed confirmation. It is all or
nothing, checks again afterwards, and refuses a linked folder (see
[ADR 0282](adr/0282-voice-samples-are-private-until-the-author-chooses-portable-and-a-move-between-the-folders-is-reversible.md)
and [ADR 0283](adr/0283-erasing-voice-data-is-listed-confirmed-staged-in-a-trash-folder-and-checked-again.md)).

### Write your own prompt packs

Add prompts, or hide whole packs, with `assistant/voice/catalog.md`. It has the same shape as the bundled
catalog: optional front matter with `disabled: [pack-id]`, then `## pack-id: Title` sections (with an optional
one-line summary) holding `### prompt-id: Title` sections that begin with `words: low-high` and then the
invitation. Ids are lowercase kebab-case and are never renamed or reused, because a sample records its prompt
id; a prompt id the bundled catalog already uses is rejected. Write prompts the way you would ask a friend
("Tell me about a mistake you made and what it taught you"), keep each to a sentence or two, and give a pack
at least three so a draw has something to choose from. `openblog voice --list` shows your packs and a warning
for any section that could not be read.

### Write visually or in Markdown

The Write view defaults to **Visual**, which behaves like a word processor while keeping
Markdown as the saved file format. Switch to **Markdown** whenever you want to inspect or
edit the underlying text. The browser remembers the last mode selected on that device.

Visual mode directly edits paragraphs, Heading 2–6, emphasis, links, quotes, simple lists,
images, and code. Advanced constructs such as callouts, knowledge checks, embeds, task or
nested lists, tables, footnotes, and raw HTML appear as protected blocks. Move or remove a
protected block visually, or choose **Edit in Markdown** to change its exact source. This
boundary prevents an ordinary visual edit from flattening syntax the visual editor cannot
represent safely.

Callouts, tables, flat task lists, embedded videos and pens, and pieces also have an **Edit**
button that opens a form inside the block: a callout's kind and text, a table's rows and columns,
a task list's items and checkboxes, an embed's provider and address, or a piece's details. Apply
writes the same Markdown the block uses today; Cancel (or Escape) leaves it untouched, and a block
you do not edit is saved byte for byte. A block the form could not write back exactly stays
protected.

### Add something

Choose **Add something** in the Write toolbar (in Visual or Markdown mode) to add a button, image
with caption, video, map, opening hours, contact details, social links, questions and answers, or
a call-out at the caret. Pick what you want, fill in the labelled fields, and choose **Insert**:
the details are checked by the same rules as the build, a problem is explained next to the form
and nothing is inserted until it is fixed. In Visual mode the piece appears as an editable block;
in Markdown mode its text is written at the caret. Ctrl+Z or **Undo piece** takes it back out.
There is no option to write your own HTML. See [Pieces](content.md#pieces-buttons-videos-maps-and-more).

**Before and after** is in the same list. It asks for two pictures and a description of each (required, for
people who cannot see them), and optionally a caption and a label for each side. For each picture you can type
an address or choose a file; a chosen file is uploaded the same way as any image and its address is filled in.
**Insert** checks the pair with the build's rules and says what is missing inside the dialog, for example that the
after picture needs a description. In Visual mode the pair is an editable block (**Edit before and after**); in
Markdown mode the `compare` fence is written at the caret. See [Before and after](content.md#before-and-after).

### Cite a source while writing

In a post, choose **Cite** in the Write toolbar to insert a citation at the caret in either mode.
Search the source library by title, creator, identifier or key, choose a source, and add
optional locators one per line (`page: 514`, `canonical: 514a to 520a`). **Start from a notebook
passage** copies a passage's source and locators, never its quotation or notes. Insert asks the
server to check the citation with the same parser and resolver a build uses, then writes
`[@key, page 514]` into the Markdown. If the library changed since the dialog opened, nothing is
inserted and the refreshed sources are shown with your choices kept.

In Visual mode each citation, generated or hand-written, is a chip that keeps its exact Markdown.
Click a chip, or focus it and press Enter, to edit it; in Markdown mode, place the caret inside a
citation and choose **Cite**. Press Ctrl+Z or **Undo citation** right after inserting to restore
the draft and caret exactly. Escape closes the dialog without changing anything. See
[Citation format](specs/citations.md).

### Insert research from beside the draft

In a post, choose **Research** in the Write toolbar to open your research beside the draft (below
it on narrow screens). The draft stays editable. Search passages, sources, Knowledge Atlas entries,
comparisons and interpretations; choose **Show → My private notes** to see your notes, which are
never listed otherwise. Choose an item to see what it would insert:

- **Insert quotation with citation** puts the passage's wording, exactly as stored, in a block
  quote after the paragraph you are in, followed by its citation, checked by the server like the
  Cite dialog. Notes linked to the passage are never inserted. If you have not stated the
  version's rights, or state that it is under copyright, confirm that you have read the rights
  statement first; the statement is yours and is not permission.
- **Insert citation** on a source writes only its key and the locators you enter.
- **Insert link to this entry** (or to a comparison, or a published dating's words) appears only
  once the next build publishes that page: the entry or comparison is approved and the site
  publishes its atlas (`knowledgeAtlas.publish`) or comparisons (`comparisons.publish`).
  Otherwise the item says what is missing. Interpretations are never inserted; link the published
  comparison that shows one, or cite the source it interprets.
- A private note goes in only through **Convert to draft text…** and a confirmation that it
  becomes part of the post, as your own words.

Insertions work in Visual and Markdown modes and never land inside code, HTML or a link. Press
Ctrl+Z, or the **Undo** button named for what you inserted, to restore the draft exactly. If
something cannot be inserted, the item says why and the draft is unchanged; nothing is written to
your research files. Escape closes the panel. Each item links to its full panel in the research
workspace, which keeps your unsaved draft. See
[ADR 0122](adr/0122-the-draft-side-research-panel-inserts-only-checked-and-published-research.md).

### Choose what readers are given beside a post

The Research panel's **Selected for readers** section is where you choose which already-public
research context readers are given beside this post, and see exactly what they will get. Choose
**Select for readers** on a source, an atlas entry, one of its datings or relationships, or a
comparison; the button is offered only when the build already publishes that item, and otherwise the
item says it is not selectable (selecting never approves research). Pick the fields you want beyond
the ones that always travel with it (who asserts a relationship, how firmly, on what evidence, who
disputes it), say whether it is for this post only or the whole site, and, for a source, where its
metadata came from. You can also write a comment on a source or an explanation of an entry, attributed
to a name you give; it is plain text of up to 1,000 characters.

The section lists what readers of the post get, in your order, and what is withheld and why (withdrawn,
changed since you selected it, no longer there, not published). Move an item up or down, withdraw it
with an optional private reason, select it again after you have checked what changed, offer it to this
post only or the whole site, or unselect it; none of this touches your research. **What readers of this
post get** shows the public data exactly as pages are built from it, with the caveats that travel with
it (a competing dating you did not select, a detail the source lacks, metadata whose origin is not
recorded). Every change names the revision it was based on, so a change made elsewhere reloads the
section and changes nothing. Everything is reachable from the keyboard, each button names the item it
acts on, and the section reflows at 320 pixels. Readers see none of it until the site publishes
curated context (`curatedContext.publish`); then it is a data file and a section on the post's page (the
[curated context format](specs/curated-context.md)), and a change you make here rebuilds the site you are
previewing. See
[ADR 0196](adr/0196-selected-for-readers-lives-in-the-draft-side-research-panel-and-previews-the-public-value.md).

### Move between research and your draft

Sources, the research notebook, the Knowledge Atlas, Compare, and claims form one **Research
workspace** (`#/research/`). Open it from **Research workspace** in the main navigation (shown in
Guided and Advanced, and in Custom when you choose it), from **Advanced tools** in any layout, or
by searching with `Ctrl+K`. Its first panel, **Workflow**, lists the steps from a first source to
a cited draft and says how far each has come: add a source, capture a passage, relate and compare
if that helps, then cite it from the draft with **Cite a source**. If the library or notebook
cannot be read, only its own step says so, with the file to repair; nothing is changed.

The workspace's navigation sits under the page title. It lists the research panels under
**Private research** and the draft under **Publishable**, and screen readers hear the same label
with each link. Private research is never public because it exists: a post shows a source's
reference only when it cites it, and atlas relationships, claim evidence, and comparisons only
when you approve them. **Claims** opens the draft's Evidence Studio, and **Draft** returns to the
document you were writing (`Ctrl+K` → **Back to draft** works too).

Switching between the draft and research panels never loses unsaved changes. A panel you leave
with unsaved changes is kept as it was, marked **Unsaved changes kept**, and reopens exactly as you
left it, with a short announcement. Panels without unsaved changes reload, so they always show the
latest files. Admin still asks first, naming where the unsaved work is, before you leave the
workspace for another page, open a different document while a draft is kept, sign out, or close
or reload the page. Kept work stays only in this page's memory: it is never saved, stored in the
browser, or sent anywhere, and signing out discards it. If your session expires instead, the
unsaved panels wait in the page until you sign in again as the same user; signing in as anyone
else discards them. A panel that is saving is not kept; Admin asks first. A kept panel saves against the revision
it read, so if the file changed elsewhere meanwhile you get the usual conflict choice instead of
an overwrite. The earlier addresses `#/sources`, `#/research`, `#/atlas/<id>`, and
`#/compare/<id>` open the same panels. See
[ADR 0120](adr/0120-the-research-workspace-is-one-admin-destination-with-one-route-namespace.md)
and [ADR 0121](adr/0121-workspace-panels-keep-unsaved-changes-while-another-panel-opens.md).

Every Admin page starts with a **Skip to main content** link, and after you move to another page
keyboard focus starts at its heading.

### See what will be public

**Research workspace → What will be public** (`#/research/public`) shows exactly what the next
build publishes of your research, from the same projection the build writes: per projection
(citations, claims and evidence, the Knowledge Atlas, datings, comparisons), whether its switch is
on, every item it publishes with the fields it copies, and every item it withholds with the reason
in words (not approved, an unsourced draft, depends on something private, its post is not
published, approved before what it rests on changed, and so on). A field of a published item that
stays private is listed under it, such as a web address on a private network. Each withheld item
links to where you change it, and **Never published** lists what no projection ever copies.
**Evidence Studio → What this post makes public** shows the same for the post you are editing,
unsaved changes included: its cited sources, its claims and evidence links, and the atlas and
comparison pages it links to. Neither changes any file.

Builds check their output against the same boundary before writing. A page for an item no
projection publishes, a damaged private file, or text from a private research file inside the
data generated from your approved research (the atlas, comparisons and claim-evidence JSON, a
post's citation data) refuses the build, with the file, record and field it came from. The same
words in any other public file (a page, a feed, the search index, a static, theme or front-end
file, a portable Markdown export) are only a `boundary:` warning, also shown here, that names the
output, the private file, the record and the field: the text is in a file you placed or wrote, so
remove it there or keep it. Saving a comparison does not approve it again when a place moved;
open it in Compare and choose **Checked - approve again** once you have checked the place. See
[ADR 0125](adr/0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md).

### Compare versions of a passage

**Research workspace → Compare** lists your private passage alignments. Open one to read its places in
each edition, translation, manuscript, or interpretation, side by side or, with **Layout → Single
column**, one version after another (narrow screens use the same order). Every place shows its
version, its editor, translator, scribe or interpreters, and its locator. Original wording is
shown exactly as quoted, in its own language and direction; **Show the author's normalizations**
adds your normalized form under it, labelled. A version that lacks the passage says **Absent**.

**New alignment** and **Edit alignment** open a form for the label, how the places correspond
(always phrased as your reading, never "the same"), and the places: a version with a notebook
passage or locators, a version marked absent, or an interpretation. Reorder places with **Move
up** and **Move down**. If the alignment changed elsewhere, nothing is saved until you choose
**Use the stored copy** or **Keep my draft**.

To copy, tick the places you want and choose **Copy selected places** or **Download selected
places**. Each copied place carries its version, maker, locator, and rights statement. When a
selected version's rights are not checked or are reserved, confirm that you have read the rights
statements first; open.blog never decides what you may copy. See
[Passage alignments format](specs/passage-alignments.md).

### Test a theme before publishing

The Site preview reports the theme it resolved and renders through the same site model,
theme compiler, document renderer, and components as a public build. Theme precedence is
the same in both places:

1. A post or page theme selected in **Settings** is an explicit override.
2. A post without an override inherits the theme selected by its series.
3. Content without either override uses the site theme from `openblog.json`.

To test a series design, set the theme on the series document, leave the post's theme
unset, and open **Site preview** on a post in that series. To compare a one-off design,
select a theme on the post instead. The preview includes unsaved changes to the document
you are editing but does not expose unrelated drafts or scheduled posts. Front matter
remains in **Settings** and is never printed into the preview.

For posts, use the **Preview representation or destination** selector to compare the themed site
output, portable HTML, Markdown, and plain text, or a DEV, Hashnode, Ghost, WordPress, or Medium policy view.
These projections run through the same conversion used by feeds, export, and syndication;
warnings include the source, transformation, and recommended action.
**Copy portable output** and **Download portable output** use the exact selected artifact
without saving or changing the post. Downloaded previews may contain unsaved draft content;
review them before sharing. Actions are disabled for the native site view, unavailable policies,
failed previews, and while edits await a fresh preview. Text and Markdown are displayed as literal
source, never executed in the Admin shell. The authenticated API also returns capability
portability levels alongside all three representations.
DEV and Hashnode views also show the selected and omitted tags, slug transformations,
and blocking tag errors from the same core plan used by the CLI. These are payload metadata
checks; copying a portable body does not validate or include its destination tags.

Warnings can be acknowledged for a specific source revision, capability, representation, and
destination. Acknowledgements are stored in a tracked sibling `*.portability.json` sidecar and
remain visible beside the warning; they never bypass unsafe-markup errors, private-state rules, or
canonical-identity requirements. Editing the post makes older acknowledgements visibly stale.
The portable views are computed from the authenticated, unsaved preview request and are not saved
to the document or exposed at a public URL. Acknowledging is allowed only when the preview matches
the saved source revision.

### Review accessibility while writing

Open **Accessibility** to run the publishing engine's source audit against the current
unsaved document. The view includes site-wide configuration findings, such as a missing
default language, but excludes findings that belong only to other documents. It reports
what was located, the canonical file/line or field, and what to do next.

The outcome labels have deliberately different meanings: **Detected** is a source condition
the engine can establish, **Potential** is a useful heuristic that still needs context, and
**Needs review** is a decision only an author can make. The pane never turns an empty result
into a score or conformance claim. See [Accessibility checks and manual review](accessibility.md)
for every check, the CLI workflow, and the rendered-page checklist.

### Review research evidence while writing

Choose the Research content profile, then open **Evidence**. The preview API runs the same
core audit used by `openblog check` and builds, scoped to the current unsaved document. It
shows the authored DOI (normalized to a resolver URL when valid), valid absolute license
URL, number of linked references, and findings for missing
visible Abstract or References/Bibliography sections, malformed work metadata, unresolved
footnotes, references without resolvable links, and non-preferred DOI links.

The **Abstract** and **References** toolbar actions ask the publishing engine whether the
section already exists before changing Markdown. This keeps formatted headings, code
examples, containers, and HTML blocks consistent with the actual build parser. Profile
metadata drafts survive profile switches and are included when the document is saved.

Evidence Studio does not score truth, source authority, peer review, methodology, or
whether a citation supports a claim. For a post that publishes citations it also lists, as
separate findings, citations it cannot read or resolve, cited references missing a detail
readers need (title, creator, date, container, publisher or web address), identifiers left out
of the notes, and the cited locations only you can check against the source. These checks run
offline from your source library. **Download cited references** saves the post's references
as CSL JSON or BibTeX, holding only what its notes show and stating what the format cannot
carry. Outside the Research profile, a post without citations reports that the checks are
inactive. See [Research posts and Evidence Studio](research-profile.md).

The **Overview** is the admin home. It summarizes the publishing pipeline, links to quick
creation flows, shows the size of the content library and recent posts, and surfaces the
next scheduled post or last build error without requiring a trip through each content list.

Markdown remains the source of truth. Visual mode converts only the ordinary blocks it can
represent and carries advanced blocks through unchanged. Front matter remains in Settings,
outside both body editors. Saving, conflict detection, preview sandboxing, and publishing
use the same file-based workflow and security checks.

In a post's **Settings** view, **Content profile** defaults to Article. Recipe posts select
Recipe and continue through the existing recipe renderer and structured-data path. Files
using `recipe: true` or another legacy recipe alias appear as Recipe but keep that original
field unless you explicitly change the selector. An unknown `profile` value appears as its
own option with a warning; saving without changing it preserves the value.
Research posts select Research and expose DOI and license fields. Values entered there are
preserved when switching profiles and saved without discarding explicit clears.
Video posts select Video production and expose YouTube URL, duration, thumbnail, and
AI-assistance disclosure fields. The Release kit view remains inactive for other profiles.
Field-journal posts expose activity, area, privacy, distance, elevation, duration, and
conditions. Field Review analyzes GPX in the browser and privately stages the source track
only in Exact mode; it becomes public as part of a successful post save. Other modes save
privacy-filtered derived data. Downgrading a saved Exact route moves its managed GPX to
`.openblog/trash/tracks/` so the next build retracts it without destroying the source.
Choosing **Job** shows an **About this job** form in Settings: trade, service, town, region,
started, finished, price range, and before and after photos (uploaded the same way as any
image). On an empty body it also writes the four headings `Problem`, `What we found`,
`What we did` and `Result` as ordinary Markdown, in Visual or Markdown mode; they are never
locked, never written over words you already have, and switching to another profile leaves the
Markdown as it is. **Check this job** lists what the build would still ask for. See
[Jobs](jobs.md).

Every save is checked against the whole site before anything is written (duplicate slugs,
unknown themes, bad dates), then the site is rebuilt. A save that would break the build is
refused with the reason. If the file changed on disk since you opened it (for example you
edited it in your text editor), the save is refused instead of overwriting your changes.

Posts with an adjacent `<stem>.credits.json` file keep that contributor data throughout the
Admin lifecycle. The server validates the Markdown and credits together, preserves the
sidecar when an older editor does not send credit fields, checks it independently for
concurrent edits, and moves it to `.openblog/trash/` with the post. Preview requests can
include unsaved credits and are rendered through the same contributor rules as a build.
An explicit empty credits list remains distinct from having no sidecar and inheriting the
site author. A malformed sidecar does not hide the Markdown document: Admin reports the
credit error and keeps a separate revision token so a credits-aware client can safely repair
or remove it. Editing the JSON files by hand remains supported.

### Credit contributors and roles

For posts, open **Settings → Contributors** to choose between inheriting the site author
and an explicit ordered credit list. Add people from the contributor registry, arrange the
public byline order with the arrow buttons, and choose publishing roles or CRediT taxonomy
roles for each person. Every selected person needs at least one role. An explicit list with
no people intentionally suppresses inherited authorship; the editor labels this state so it
cannot be confused with inheritance.

The people available in the picker come from the site contributor registry. Open
**Site → Contributors** to add or update a public name, stable ID, profile URL, same-as
profiles, and optional ORCID iD. Existing IDs cannot be renamed in Admin because post
sidecars refer to them; a contributor cannot be removed while any sidecar still uses that
ID. If the registry is empty, **Prefill legacy author** copies the existing site author into
an unsaved draft for review—it does not change configuration or post credits until you save.

Registry saves use their own `openblog.json` revision token. If configuration changed on
disk after the workspace opened, Admin refuses the stale save and asks you to reload. It
updates only the `contributors` member of the parsed JSON object, preserving unrelated and
future configuration members, validates the complete candidate with the publishing engine,
then rebuilds the preview. ORCID iDs entered here are manual and unauthenticated: format and
checksum validation does not verify the person or ownership of the record.

If a sidecar is malformed, Settings shows the error without hiding
the Markdown and requires an explicit repair choice: inherit to remove the broken sidecar,
or set new explicit credits to replace it. Credit-only changes participate in unsaved-change
warnings, production preview, conflict detection, and the normal save validation.

### Curate a reading path

A reading path is your own ordered route through published posts and public Knowledge Atlas entries.
Open **Content → Reading paths** and choose **New reading path**. Give it a title and an address name (the
file name, `content/paths/<name>.json`, which cannot change later), then add steps from the list of
published posts and public atlas entries. Draft and scheduled posts and private atlas entries are not
offered. Every step after the first needs a relationship, chosen from a closed list with no default, and a
reason in your own words; a step after an optional one follows the last required step. Use **Move up** and
**Move down** to reorder; nothing needs a mouse. A step whose post was later unpublished is marked, in words,
as one readers will not see, and the preview, which is the same projection a published path would have,
says when the path would not be published as it stands and why. Saving is refused when the file changed
elsewhere, offering the newer copy, and **Edit as source** shows the file itself, in its canonical form,
keeping any field this release does not know.

### Author an interpretation comparison

A comparison sets several attributed readings of one subject side by side, without ruling between them.
Open **Content → Comparisons** and choose **New comparison**. Give it a title, an address name (the file
name, `content/comparisons/<name>.json`, which cannot change later) and a neutral description of the
subject. Add each interpretation with who held it: a named person, school or tradition, a source from your
library, or **Unknown author** with a description. Write what the reading holds, an optional uncertainty
note, and link evidence from your evidence links and sources; each reference says in words whether readers
can see it, whether it is private, or whether it is not in your library. Missing evidence is shown and
never stops a save. Relations (differs from, agrees with, builds on, responds to) never say which reading
is right. Explanations are written for a beginner, student or scholarly audience, about the whole
comparison or one reading, and supplement your prose.

If an AI tool drafted a reading or an explanation, tick **An AI tool drafted this text** and name the
tool. It stays a draft: readers do not see it until you save the comparison and press **Approve this exact
text**, which records you and the time against those exact words. Editing the text withdraws the approval
when you save. **Withdraw approval** on a published comparison asks before returning the whole comparison
to draft. The preview is what readers would see, and a list for you alone says what they would not. Saving
is refused when the file changed elsewhere, offering the newer copy, and **Edit as source** shows the file
itself, keeping any field this release does not know (an approval can be kept there but not added).

### Start a shared reflection

A shared reflection is a private draft that several writers answer from the same source. Open
**Content → Shared reflections** and choose **Start a shared reflection** (or search the
workspace for it). The form asks, in plain words:

1. **What prompted it.** Choose the type of source, then enter its title. Paste the original
   link if there is one; a book, a talk you attended, or a conversation can be left without a
   link. You can add who made it, the publisher, a year or date, and an ISBN for a book. Use
   **Add another source** to list up to 20 sources in the order you want; at 20 the button is
   turned off and the form says why. With a YouTube or CodePen link, **Suggest details from
   link** can fill in a title, who made it, and the publisher. It only fills fields you left
   empty, says what it filled so you can check it, and never asks for a transcript. If the
   provider is slow, refuses, or has nothing, or the link is from another site, the form tells
   you and nothing changes; type the details yourself.
2. **Your reflection.** Give a working title, a guiding question that each writer answers in
   their own words, or both.
3. **You will appear as.** Choose your entry from the contributor registry. If you are not in
   it yet, add yourself under **Site → Contributors** first. Admin Studio does not yet check that
   the entry you pick is yours, so choose your own.

You don’t need Markdown anywhere in this form. Links must be complete web addresses starting with
`https://` or `http://` and cannot contain a username or password; a pasted link with non-English
characters is stored in its standard encoded form. If something needs fixing, the message names
the field and moves focus to it; a problem that is not about one field, such as a save that
fails on the server, moves focus to the message itself. What you entered is kept so you can try
again.

Creating a shared reflection publishes nothing and changes no post, credit, or setting. It is
saved as a private file under `.openblog/private/collaboration/publications/`, which Git
ignores, so back up that folder with your other private files. Only the people taking part see
it under **Shared reflections**; signing in to Admin Studio or being in the contributor registry
is not enough. You are its site owner. Removing your account with `openblog user remove` removes
you from every shared reflection, and so does adding a new account under a name that was used
before. A contributor who takes part in one cannot be removed from the registry; the Contributors
message names each entry that is in use. Writing contributions and publishing the result arrive in later releases. The design is recorded in
[ADR 0007](adr/0007-private-shared-publication-records.md) and the
[collaboration contract](specs/shared-perspectives-collaboration.md#shared-publication-record).

### Inviting other writers

Site owners and coordinators see an **Invitations** section on each shared reflection. Enter the
sign-in name of an existing Admin account, choose the contributor profile they will appear as, pick
their roles, and choose how long the link lasts (1 to 30 days, 7 by default). Admin Studio shows a
private link once. Copy it and pass it on yourself: open.blog never sends email or contacts
anyone. The link works once, only for the account you named, and only after that person signs in
and chooses **Accept and join** or **Decline**. A lost link cannot be shown again; use **Issue a
new link**, which also stops the old one working. **Revoke** withdraws a link at once.
Invitations are kept inside the shared reflection's private file as hashes, never the link
itself, and only a site owner can invite another site owner. Add the person's Admin account first
with `openblog user add`. The design is recorded in
[ADR 0013](adr/0013-publication-scoped-invitations.md).

### Managing members

The same **Members and invitations** section lists everyone who can sign in to the reflection,
with their sign-in account, the contributor profile they are credited as, and their roles written
out. These are separate: *sign-in access* decides who can open the reflection and what they can
do, while *credit* names who is shown for what they wrote. **Change roles** previews what is added
and removed before it applies. **Remove access** asks first, and ends only sign-in access: the
person's name stays credited for what they wrote and approved, and you can invite them again
later. The last site owner cannot be removed or demoted, and a coordinator cannot change a site
owner. If someone else changed the members while you were looking, the change is refused, the list
reloads, and you can try again. A member whose account or profile has been deleted is flagged with
a warning. If your browser cannot copy to the clipboard, select the link and copy it yourself.
Everything is reachable by keyboard: **Escape** cancels a confirmation, and results are announced
to screen readers. The design is recorded in
[ADR 0015](adr/0015-member-management-separates-access-from-credit.md).

### Putting a shared reflection in a series

Each shared reflection has a **Series** section. Everyone taking part sees which series it will
join, its position, and the reading order it would have among the parts already published.
Site owners and coordinators choose an existing series or type a new title, set a position (or
leave it empty to follow the numbered parts, by date), use **Preview order**, and **Save
placement**. Choose **Not in a series** and save to remove it. The series and position are shown in
the combined preview and are part of what every author approves, so saving a change means each
author approves again. If someone else changed the placement first, your choice stays in the form
next to the current one and you can save again. Site owners can also **Add a new series** with a
name and a one-line recurring premise; it is an ordinary series file, not shown to readers until a
part is published, and other details stay in the Series editor. Once the reflection is published,
its series is changed in the post like any other. The design is recorded in
[ADR 0039](adr/0039-arranging-a-shared-reflections-series-in-admin.md).

## Change your home page and your look

Two screens in Admin change how the site looks without any code. Neither has a box that takes HTML or CSS, and
nothing changes on the public site until you save and make it live.

### The Landing page

Open **Landing page** (`#/landing`) to arrange the home page. A first visit offers four ready-made layouts
(Welcome, Small business, Portfolio, Newsletter) with clearly marked sample words, or **Start from scratch**;
**Choose a ready-made layout** and **Reset to default** are always there, and nothing you already have is
replaced without a yes. A site that has never built a landing page starts from what visitors see today, and
nothing is written until you save.

- **Sections** are cards: a welcome banner, text, latest posts, series, a featured post, buttons, a picture, a
  video, a map, opening hours, contact details, social links, questions and answers, or a call-out. **Add a
  section** lists them in plain words with a sample. Each card has **Edit**, **Move up**, **Move down**,
  **Hide** or **Show**, and **Delete**; a deletion can be undone, and Alt with the up or down arrow moves the
  focused card from the keyboard. Videos, maps and the other pieces are the same ones the post editor's
  [Add something](#add-something) inserts.
- **Text** sections are written like a word-processor document with a toolbar of words (Paragraph, Heading,
  Bold, Italic, Link, Lists, Quote, Picture, Undo, Redo) and saved as Markdown. Pasting from Word, Google Docs
  or a web page keeps headings, emphasis, links and lists and drops everything else; **Ctrl+Shift+V** pastes
  plain text. Markup you type stays words.
- **Suggestions** under a text section explain a problem in a sentence (a picture with no description, a link
  that says "click here", a skipped heading) and **Fix it** changes only that place. They never stop you saving.
- **Preview** shows the home page as the build would make it from your unsaved sections, at Phone, Tablet and
  Desktop sizes, in a frame that runs no scripts. On a phone it opens full screen with a **Back to editing**
  button.
- **Save** writes `content/landing.json`. If someone saved a newer page meanwhile, you choose **Keep mine**,
  **Use the newer version** or **Compare**; nothing is overwritten silently. **Publish** (the bar calls it
  "make it live") saves first and then publishes, and stops with the reason if the site does not build.
- **History** under the sections keeps your last twenty saves in private storage (never in the content folder,
  the build, a feed or an export). Preview an earlier one and **Restore** it; restoring is an ordinary save, so
  the page it replaces stays in the list.
- Unsaved changes are kept on your device, offered back after a reload and warned about when you leave. A short
  three-step tour appears once, can be skipped and never comes back, and **Help** explains the words.

The file format is described in [Landing page sections](content.md#landing-page-sections).

### Customize look

Open **Customize look** (`#/look`, also a button on **Appearance**) to choose how the site feels by tapping
choices: eight ready-made looks (Calm, Warm, Bold, Night, Garden, Paper, Ocean, Sunset), a main (accent) color
from swatches or the color picker, a font style (Modern, Classic, Friendly, Techie), text size, corner
roundness, spacing, page width and heading weight. The preview is the real home page built from your unsaved
choices, in light or dark. A color that would be hard to read is adjusted just enough, and the screen says so
in words. **Back to theme default** undoes one control, **Reset everything** clears the look, and **Undo**
takes back the last change. Only the controls your theme honors are shown, with a kind note about the rest
([Look controls](themes.md#look-controls)). The choices are saved under `appearance` in `openblog.json`
([configuration](configuration.md#site)).

### Business facts

Open **Business facts** (`#/business`) to state your name, trade, phone, email, opening hours, license, insurance,
accepted payments and the year you started, once. The footer of every page, the home page's **Business facts**
section and the `LocalBusiness` search data all read it ([configuration](configuration.md#business-facts)).
Type a phone number the way you say it; it is saved with its country code. Each day of the week has its own
choice (Not shown, Open with an opening and closing time, Open 24 hours, or Closed), and **Copy Monday to
Tuesday through Friday** saves typing. A problem is said in words beside the field it is about, and a save that
finds a mistake changes nothing. The screen is one column from 320px with 44px controls.

The screen reads and saves `GET`/`PUT /admin/api/business` (session and CSRF as for every write, bounded to
8 KiB). A save is checked against the revision of the block you loaded, so an edit made elsewhere in the file
does not conflict with it, and it changes only the `business` key of `openblog.json`: every other key keeps its
place and spelling (the file is edited as text, not re-written from a sorted copy). Fields a newer release added
to the block are kept. See [ADR 0307](adr/0307-the-business-facts-screen-edits-one-member-of-openblog-json-as-text-checked-against-a-revision-of-that-member-and-problems-are-said-beside-the-field.md).

### Services

Open **Services** (`#/services`) to describe each thing you sell once, with what it includes, a price band, a
typical timeline and the questions customers ask. The screen edits the `services/` files through the same
document routes as posts, pages and series, so sessions, CSRF, the 2 MiB bound, revision checks and the trash all
apply as they do there. See [Services](services.md).

### A short phone walkthrough

On a 375px phone: open Admin and choose **Landing page**; tap **Edit** on the welcome banner, change the
heading and tap **Add a button**; tap **Done**, then **Preview** to see the page full screen and **Back to
editing**; tap **Save**. Open **Customize look**, tap a color and a font style, tap **Preview** to check,
**Back to choosing**, then **Save**. Tap **Publish** to make it live. The bar stays at the bottom of the
screen, every control is at least 44px tall, and nothing scrolls sideways down to 320px wide.

## Scheduling

A post's status is one of:

- **Draft**: never public (`draft: true`).
- **Published**: the date is now or in the past.
- **Scheduled**: the date is in the future.

Pick *Scheduled* and a date and time (your local time; it is stored as UTC) and save. The
post is held back from the pages, feeds, sitemap, search index, tags, series, and the
latest-posts JSON. The server checks every few seconds and rebuilds at the moment the post
comes due, so it appears by itself.

This works in plain files too: any post with a future `date:` stays hidden until a build
runs after that time. So a scheduled post also goes live on a static host if something runs
`openblog build` periodically, such as a cron job or a scheduled GitHub Action.

```yaml
date: 2026-12-25T09:00:00Z      # offsets work too: 2026-12-25T09:00:00-05:00
```

`openblog build --drafts` and `serve --drafts` include drafts and scheduled posts, for
previewing.

## Announce a post on social media (optional)

If your site has [scheduled social publishing](social-publishing.md) set up, Admin shows an **Announcements** tab; without it
there is no tab and nothing changes. The screen has two parts.

**Announce a post.** Choose a **Destination** (a connected LinkedIn profile or Facebook Page), a **Post to announce**,
write a **Caption** and pick a **Date and time**. Only published posts can be chosen; a draft, or a post dated in the
future, is listed as not available with the reason. The count under the caption shows how many characters are left,
and the **Preview** shows the caption, the link to your post and when it will go out, before you tap **Schedule
announcement**. Times are in your own time zone and stored in UTC; on the day the clocks change, a time that does not
exist is refused, and a time that happens twice uses the earlier one (the preview says so). If something is wrong, the
form lists what to fix, each a link to its field, and says it beside the field too. Tapping the button twice, or again
after a slow connection, schedules it once.

**Announcements.** Every announcement shows its status in words (Scheduled, Sending, Published, Failed, Needs checking,
Canceled), its time in your zone, its destination and caption. While it is **Scheduled**, **Edit** changes the caption
or time and **Cancel announcement** asks "Yes, cancel it / Keep it" before it cancels. Once a sender has picked it up it
cannot be changed, and the row says why. If it was picked up while you were looking at it, the screen refreshes and
tells you instead of failing. Use **Show** to filter by status.

It works with a keyboard alone (Tab through the fields, Enter on **Schedule announcement**), every field has a visible
label, and on a phone it is one column with buttons at least 44px tall. This screen only schedules; the delivery worker
and the provider adapters do the posting (see [social publishing](social-publishing.md#the-delivery-worker)).

**When a post does not go out.** A **Failed** announcement says why in plain words, with the short code beside it.
**Try again** asks first, then puts it back in the queue with a fresh allowance of attempts. A **Needs checking**
announcement is one where the provider did not say whether the post went out. It is never sent again by itself: look
at the LinkedIn or Facebook account, then choose **Check the result** and say it was posted (with the post id the
provider shows) or was not (it then becomes Failed, and you can try it again). A **Scheduled** announcement that is
waiting to try again says when. **What was tried** under each announcement lists every attempt with its result.

## Running it for real

By default the server listens on `127.0.0.1` only. To use the admin from anywhere, run it on
a machine you control and put it behind HTTPS (a reverse proxy such as Caddy or nginx), then:

```jsonc
// openblog.json
"admin": {
  "secureCookies": true,      // mark the session cookie Secure (required over HTTPS)
  "sessionHours": 12,
  "maxUploadMb": 10,
  "usersFile": ".openblog/users.json",
  "trustedProxies": ["127.0.0.1"]   // the proxy's address, so login limits see real clients
}
```

Entries in `trustedProxies` are exact IP addresses, not ranges, or the single entry `"*"`
to trust every connection's `X-Forwarded-For` (only right when nothing can reach the
server except through the proxy, as in a container on a PaaS; the
`OPENBLOG_BEHIND_PROXY=1` environment variable sets this and `secureCookies` together). A connection from one of
them takes the client address from the last `X-Forwarded-For` entry, the one that proxy
appended; if the header is missing, the proxy's own address is used and every visitor
shares one login limit. Connections from a trusted proxy are also exempt from the
per-address connection cap, so the whole readership is not squeezed through one slot.

```sh
openblog serve --admin --port 8080
```

Keep the default `--host 127.0.0.1` when the proxy runs on the same machine, so only the
proxy can reach the plain-HTTP port; use `--host 0.0.0.0` only when the proxy is elsewhere,
and firewall the port. The proxy must pass the original `Host` header through and add
`X-Forwarded-For` (Caddy does both by default; nginx needs `proxy_set_header Host $host;`
and `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). Without the `Host`
header every login and save is refused as cross-origin; without `X-Forwarded-For` all
visitors share one login limit. [Deploying](deploy.md) has a complete nginx example.

Without HTTPS, passwords and sessions cross the network in clear text; the server prints a
warning if you expose it that way with `secureCookies` off. Keep `.openblog/` (users file and
trash) out of version control; `openblog init` adds it to `.gitignore`.

The public site and the admin share one process, so the blog is served by this server too.
If you would rather host the static output elsewhere, run the admin where the content lives
and publish `dist/` onward (for example with a git push or rsync after each build).

### Troubleshooting local styles and sessions

If the browser refuses `/assets/base.css` or `/themes/.../tokens.css` because the response
has the `text/html` MIME type, first restart `openblog serve --admin` after upgrading. Sites
whose configured URL includes a base path, such as `https://example.github.io/project/`,
still open the private editor at `/admin`; in admin mode the server maps its root-relative
asset requests to the same built styles used by the public site. A stale pre-0.6.1 server
does not provide that mapping. If restarting does not help, run `openblog build` and confirm
the corresponding files exist under `dist/assets/` and `dist/themes/`.

An initial `GET /admin/api/session` response of `401 Unauthorized` is expected when no valid
admin cookie exists: it is how the editor decides to show the sign-in form. A `401` after
you have signed in means the session expired, the user was removed, or the password changed;
sign in again. It is unrelated to stylesheet MIME errors.

## Optional question generation

Knowledge checks work without an AI service. To add **Generate draft** and document review,
site owners can configure the provider from the Assistant panel. The endpoint and model are saved
in `openblog.json`:

```jsonc
// openblog.json
"knowledgeChecks": {
  "provider": "anthropic",
  "generationEndpoint": "",
  "model": "claude-sonnet-5-5"
}
```

Choose a native provider to use its official API directly. open.blog fixes the destination for
native providers; only **Custom HTTPS** accepts an endpoint entered by the author.

| Provider | Suggested model | Environment credential |
|---|---|---|
| Anthropic Claude | `claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-6-luna` | `OPENAI_API_KEY` |
| Google Gemini | `gemini-3.8-flash` | `GEMINI_API_KEY` |
| xAI Grok | `grok-4.7` | `XAI_API_KEY` |
| DeepSeek | `deepseek-flash` | `DEEPSEEK_API_KEY` |
| Mistral AI | `mistral-small-latest` | `MISTRAL_API_KEY` |
| OpenRouter | enter a supported routed model ID | `OPENROUTER_API_KEY` |

The model field remains editable because provider model catalogs change. OpenRouter restricts
routing to upstream endpoints that accept the requested structured-output parameters, but the
upstream service still determines exact schema support.

### Transcribing a voice note

The Capture view can turn a recorded voice note into words, only when you ask and only after it shows what is
sent and where ([ADR 0302](adr/0302-transcription-is-a-separate-confirmed-call-through-the-provider-boundary-that-sends-only-the-recording-and-returns-untrusted-text.md)).
Only the recording is sent: no notes, photos, title or voice guide. Two providers take audio: OpenAI
(transcribed with `gpt-4o-mini-transcribe`) and Google Gemini (your configured model). Any other provider is
never sent audio, and Capture says to type your notes instead.

To keep audio on your own machine, set `OPENBLOG_TRANSCRIBE_COMMAND` in the server's environment to a JSON array:
the program and its fixed arguments. Admin appends the voice note's file path and reads the transcript from the
program's output.

```sh
export OPENBLOG_TRANSCRIBE_COMMAND='["whisper-cli", "--model", "/models/base.bin", "--no-timestamps", "--file"]'
```

It runs without a shell, with a stripped environment (your API keys are not passed), no input, a time limit and a
bounded output. It is an environment setting, not part of `openblog.json`, so shared site files cannot name a
program to run. When it is set it is used instead of a provider. The transcript is kept privately beside the
note (`.openblog/captures/`) and is untrusted text: it goes into the Notes box, made plain, for you to edit.

```sh
export ANTHROPIC_API_KEY="your Anthropic key"
openblog serve --admin
```

An OpenAI integration uses an OpenAI API key and API billing; a ChatGPT or Codex product
subscription is not itself an API credential. GitHub Copilot is not listed because its supported
programmatic integration is an authenticated agent/CLI SDK rather than this API-key provider
contract, and the separate GitHub Models inference API has been retired.

For an existing compatible service, choose **Custom HTTPS** instead:

```jsonc
"knowledgeChecks": {
  "provider": "custom-https",
  "generationEndpoint": "https://lessons.example.com/generate",
  "model": "your-model-name"
}
```

```sh
export OPENBLOG_LESSONS_API_KEY="your secret"
openblog serve --admin
```

The credential can instead be added, replaced, or cleared in the Assistant provider panel. It is
write-only and stored under `.openblog/private/assistant/`, never in `openblog.json`. An environment
credential takes precedence when present. Admin reports only whether a credential exists and where
it comes from; it never returns the saved value. Saved private credentials are bound to the provider
and destination active when they are entered. If you switch providers or change a Custom HTTPS
endpoint, enter the appropriate key for the new destination rather than reusing the hidden value.
Credentials saved by an older open.blog version have no destination binding and are not reused;
enter them once in the current panel to bind them safely.

Custom HTTPS endpoints receive JSON with `context`, `count`, `model`, task instructions, and the
expected response shape. They return one to three questions:

```json
{
  "questions": [{
    "prompt": "What stays in the reader's browser?",
    "choices": ["Quiz attempts", "Published posts"],
    "correctIndex": 0,
    "explanation": "Attempts are private local progress."
  }]
}
```

The key and endpoint are used only by the admin server. The browser calls the authenticated
same-origin admin API, public builds contain only the reviewed Markdown, and readers never
contact the generation service.

Open a post's **Assistant** view to confirm whether this provider is ready. If configuration
is incomplete, the status message identifies the server-side setting or environment variable
to add. It never displays the endpoint or credential value.

## Security design

- Passwords are hashed with Argon2id. Session and CSRF tokens are 256 random bits from the
  operating system.
- The session cookie is `HttpOnly` and `SameSite=Strict`, scoped to `/admin`. Every API route
  except login checks it **before any request body is read**, so anonymous clients cannot make
  the server buffer uploads.
- Every state-changing request needs the CSRF token header and, when the browser sends one, a
  same-origin `Origin`. JSON endpoints require `Content-Type: application/json`.
- Failed logins are limited two ways. A client address is locked for five minutes after five
  failures (the attempt is counted before the password is checked, so parallel guesses do not
  slip past). A username is never locked, only slowed down with a growing delay, so someone who
  knows your username cannot shut you out. Unknown usernames take as long as wrong passwords.
- File paths from the browser are matched against a strict allow-list (`posts/`, `series/`,
  `pages/`, `.md` only) and resolved inside the content directory, including through symlinks.
- Uploads are accepted by their bytes, not their names: PNG, JPEG, GIF, WebP, and AVIF only.
  SVG is refused because it can carry scripts.
- The admin page is served with a strict Content-Security-Policy (no inline scripts). Full-page
  previews are kept in a small in-memory cache behind an authenticated random URL and rendered in
  an opaque-origin sandbox. Built-in components and the selected theme's local or configured-CDN
  assets can run, while owner-supplied analytics, comments, and other raw HTML snippets are removed
  from unpublished previews. The preview cannot submit forms or access the admin document.
- Front matter values are always quoted so a value containing a newline cannot add fields.
- Limits: 64 concurrent connections (16 per address, not applied to trusted proxies),
  header and body size caps, deadlines for slow senders and slow readers, and no chunked
  bodies.

What it does not do: multi-factor login or per-user roles (every user can edit everything).
