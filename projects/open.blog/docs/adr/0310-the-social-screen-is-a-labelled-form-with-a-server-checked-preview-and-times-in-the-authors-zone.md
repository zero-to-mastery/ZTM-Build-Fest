# ADR 0310: The Social screen is a labelled form with a server-checked preview and times in the author's zone

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #356 (task #369)

## Context

Scheduling needs a place in Admin where an author picks a destination and a published post, writes a caption, sees
what will be posted and when, and manages what is queued. It has to work on a phone, by keyboard and with a screen
reader, must not depend on how wide a font is, and must not put any credential or Supabase call in the browser
(ADR 0293).

## Decision

- **A native module, not a framework.** `web/admin/announcements.js` builds the screen with the shared `el()` helper and
  text nodes only (nothing from the server is ever written as markup). Its rules for the person typing (the time in
  their zone, the caption count, the words for a status or an error) are pure functions with their own tests. The
  screen is the route `#/announcements` and an **Announcements** tab that exists only when Admin says social publishing is set up
  (`GET social/status`, which answers `enabled: false` unless
  the endpoint and the key are valid). Opening the route on a site without it shows "not configured", with no form.
- **Labelled fields, one column.** Destination, post, caption and date-time are each a visible `<label>` bound to a
  control, with a hint and an error paragraph tied by `aria-describedby`; the form has `novalidate` and does its own
  checking so every message is ours and sits beside its field. Controls and buttons are at least 44px tall, text
  wraps (`overflow-wrap`), the layout is a single grid column with `min-width: 0` and no fixed widths, so the
  narrowest phone and the wider Linux CI fonts both fit; a browser test measures the region for sideways overflow.
- **Problems are said, not just marked.** Submitting with problems lists them in one `role="alert"` box that takes
  focus, each a link to its field; each field also shows its own message and `aria-invalid`. A refusal from the
  server is placed beside the field its code belongs to (`caption-*`, `time-*`, `post-*`, `destination-*`). Status is
  always a word and a symbol, never a color alone. A result is announced in one polite `role="status"` line, which
  takes focus after an action so the keyboard user lands where the news is.
- **The preview is the server's.** The preview asks `social/preview`, so the caption as it will be sent, the
  site-built link, the UTC instant and any problem come from the same rules as the schedule itself, debounced and
  guarded so a slow answer cannot replace a newer one. The caption count is local and follows the server's count
  (code points of the trimmed text). Posts that cannot be announced stay listed, disabled, with the reason.
- **Local time, stored as UTC.** The author picks a date and time in their own zone (`datetime-local`, labelled with
  the zone name). `localToInstant` turns it into the UTC instant using `Intl`, refuses a time the clocks skip
  (spring forward) with its own sentence, and uses the earlier of a time the clocks repeat (fall back), saying so in
  the preview. The zone name is sent for display only and is not stored (ADR 0308). Times are shown back in the
  viewer's zone.
- **Safe repeats.** One idempotency key is made per composed announcement and reused if the same one is sent again
  after a failure, so a retry, a double click or a slow connection cannot post twice; changing anything makes a new
  key. The submit button is disabled while a request is in flight.
- **Editing is explicit and versioned.** Only a scheduled announcement shows Edit and Cancel; any other states why it
  cannot change. Edit opens an inline form (caption and time) and sends the version it was opened at; a time-only
  change uses the reschedule route. Cancel asks first, focuses the safe choice ("Keep it"), and names the version.
  There are no browser dialogs. If a worker claimed the row or another edit landed first, the screen refreshes the
  queue and says so instead of showing a failure that cannot be acted on.
- **Nothing sensitive in the page.** The screen only ever receives the allow-listed fields of ADR 0309; a browser
  test checks the page and every social response for the admin, worker and service keys, the lease owner and the
  idempotency key.

## Considered options

- **A dialog for each action.** Rejected: nested dialogs are harder to use with a screen reader and on a phone;
  inline panels keep the place in the list.
- **A separate date field and time field.** Rejected: `datetime-local` is one labelled control with a native picker on
  phones, and its value maps directly to the conversion.
- **Showing the announcement's account name from a stored copy.** Rejected: the list joins the live destination so a
  renamed or disconnected account reads truthfully.

## Consequences

- Connecting accounts (a separate story) only needs to make destinations appear in the picker; the screen already
  handles none, and an account that needs reconnecting is not offered.
- The delivery story fills in `claimed`, `published`, `failed` and `unknown`; the screen already shows their words
  and why they are locked.
