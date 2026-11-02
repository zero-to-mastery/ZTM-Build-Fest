# ADR 0250: The landing preview is the production home page built in memory from unsaved sections, in a script-free sandboxed frame

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#327](https://github.com/journey-to-code-org/open.blog/issues/327)
- Parent story: [#316](https://github.com/journey-to-code-org/open.blog/issues/316)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0247, ADR 0249
- Serves: the Customize look screen (LB8.7), which reuses the frame

## Context

"What will my visitors see?" must be answered before anything is saved or published, and the answer must be
the page the build would make, not an approximation drawn by the editor.

## Decision

- **Route: `POST /admin/api/landing/preview`** with `{ page }`. It checks the page exactly as a save does (a
  refused page is the same `422` with the same per-section problems), loads the site with that page in place
  of the stored file, and renders the first home page with the production renderer (`generate_home`, the same
  shell and code as `generate`). The result is a short-lived preview document, served from the
  authenticated `GET /admin/api/preview/<token>` under the same content security policy as the document
  preview (now one shared function). Behind the session and the CSRF seam like every Admin write route.
- **Never writes.** A preview reads the content folder under the build lock and writes no file: not the
  landing file, not the output folder, not a draft. It does not publish. Owner scripts, analytics and
  engagement are switched off in it, as in the document preview. Only the newest sixteen previews are kept in
  memory.
- **Unsaved and incomplete.** The client sends the page as it is in the form. A section that still has
  problems (an image with no description yet) is left out of the preview and the preview says how many were,
  in words, so the owner sees the rest instead of a refusal. A page with no visible section previews the
  current home page, and says so.
- **Fresh within a second or two.** Edits, moves, hides, deletions and undo schedule a refresh after a half
  second pause; only the newest answer is shown.
- **One reusable frame, `previewFrame()`.** A group of Phone (375px), Tablet (768px) and Desktop (1280px)
  buttons with `aria-pressed`, a polite status that announces the active size ("Tablet view, 768 pixels
  wide."), and a frame titled with the size. The frame is shown at the visitor's width and scaled down to the
  space it has, so it never makes the page scroll sideways. It is a pure view: it takes an address and shows
  it.
- **The frame runs nothing.** The iframe is `sandbox=""` (no scripts, no same-origin access) and is not in
  the tab order, so keyboard focus can never be trapped inside it and Escape always reaches the sheet. Links in
  the preview lead nowhere (`<base target="_blank">` in a sandbox that allows no popups): they would only
  load the live site inside the frame. The preview shell needs no network beyond this site.
- **A sheet on a phone, a column on a wide screen.** Below 64rem Preview opens a native modal `<dialog>`
  filling the screen with a "Back to editing" button first in the order, focus on it, Escape and Back both
  closing it and returning focus to Preview. From 64rem it opens beside the builder.
- **Saving rebuilds the served site.** `PUT /admin/api/landing` now rebuilds the site that `serve --admin`
  shows, as saving a post does, and reports `build: { ok, error }`; a failed build does not undo the save.
  (Publishing to the remote stays a separate act.)

## Considered options

- **Rendering a client-side approximation.** Rejected: it would drift from the build.
- **Letting preview scripts run (`allow-scripts`).** Rejected: the home page needs none to be judged, and a
  script-free frame cannot reach the Admin page.
- **Writing a temporary file and building it.** Rejected: "never alters stored files" is easiest to keep when
  nothing is written.

## Consequences

- The preview is the build's own output, so it cannot disagree with the published page (a test compares the
  two section by section).
- The Customize look screen can mount the same frame and server preview path.
