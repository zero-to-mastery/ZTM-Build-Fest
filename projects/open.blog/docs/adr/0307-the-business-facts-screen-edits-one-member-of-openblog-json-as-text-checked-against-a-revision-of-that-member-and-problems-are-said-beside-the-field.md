# ADR 0307: The Business facts screen edits one member of openblog.json as text, checked against a revision of that member, and problems are said beside the field

- Status: Accepted
- Date: 2026-10-29
- Parent story: [#482](https://github.com/journey-to-code-org/open.blog/issues/482)
- Task: [#508](https://github.com/journey-to-code-org/open.blog/issues/508)
- Parent epic: [#473](https://github.com/journey-to-code-org/open.blog/issues/473)
- Builds on: [ADR 0305](0305-business-facts-are-one-versioned-block-in-openblog-json-that-pages-the-footer-and-structured-data-all-read.md), [ADR 0248](0248-the-owner-s-look-is-a-small-versioned-set-of-typed-presets-stored-under-appearance-and-compiled-only-into-allowlisted-tokens.md), [ADR 0251](0251-the-landing-builder-is-one-column-from-320px-with-a-bar-that-stays-reachable-above-the-keyboard-and-never-covers-the-field.md)

## Context

Owners should not edit JSON to say their phone number. The existing settings routes (`appearance`, `look`) are
the pattern: session and CSRF checks, a bounded body, a revision, an atomic write, a rebuild. They write the
file by parsing it and serializing it again. That sorts every key and drops the owner's layout, so a save of
one setting rearranges the whole file, which is exactly what an owner who hand-edits `openblog.json` must not
have happen.

## Decision

- **A screen under Site, `#/business`, and two routes, `GET` and `PUT /admin/api/business`**, behind the same
  seams as every other write: the session, the CSRF token and same-origin check, the JSON content type, a body
  bounded before it is read (8 KiB), `content_transaction` and the build lock, an atomic write, a rebuild. It is
  in the route audit with the look and landing routes (deny by default, other verbs are not routes).
- **The revision is a digest of the stored `business` member alone** (as for the look), so an edit made
  elsewhere in the file neither conflicts with a save here nor is lost to it. A stale save answers 409 with the
  current block, and the screen keeps the owner's edits and offers to reload.
- **The file is edited as text.** `config_text::set_member` finds the top-level `business` member with a small
  scanner (strings and nesting aware), replaces just its value, appends it at the end when it is new, or removes
  just that member when the block is cleared. Every other byte, including key order, spacing and line endings, is
  kept. Round-tripping through a parsed value was rejected because it sorts keys; keeping an order-preserving
  map was rejected because it changes how every route reads the config. The helper is generic and tested with
  unrelated keys out of alphabetical order.
- **The core judges, the screen only helps.** The server runs the block through `BusinessConfig::from_value`
  and then the whole candidate file through `SiteConfig::from_json` (which checks the trade against the site's
  own `extraTrades`), and nothing is written unless both pass. A typed phone is converted to E.164 by the same
  function the core exports (`normalize_phone_input`), fields left empty are "not stated", and fields a newer
  release wrote are carried over. The screen runs the same rules before it sends (`validateForm`) so a mistake
  is caught without a round trip, and shows the server's problems the same way if one still gets through.
- **Problems are said beside the field, in plain words.** A problem is `{ field, day?, message }`: the message
  names what to do ("Add the country code and the digits, like +1 360 555 0142"), appears in a paragraph tied to
  its control with `aria-describedby`, marks the control `aria-invalid`, and sends focus to the first problem.
  A trade the site does not know is refused without repeating what was sent. Nothing is shown as markup.
- **The hours editor is a list of small groups, not a table.** Each weekday is a fieldset with one native select
  (Not shown, Open, Open 24 hours, Closed) and, when open, two native time inputs. One column at any width, 44px
  controls, labels that wrap, and "Copy Monday to Tuesday through Friday" to avoid typing five rows. It is
  verified at 400px in a real browser (`tests/browser/business-facts.spec.mjs`), with a small overflow
  tolerance rather than thresholds tuned to one platform's fonts.
- **Leaving with unsaved changes** uses the Admin's existing view hooks (`viewDirty`, `viewBusy`): the screen
  states "You have unsaved changes", and the shell's own unsaved-change guard applies. No draft copy is kept on
  the device: these are a dozen short facts, and a draft copy of a published phone number is more than needed.
- **The Landing builder only places it.** The Business facts section (ADR 0306) edits a heading; the facts are
  edited here, once. The section's hint says so.

## Considered options

- **Reuse the `appearance` route.** Rejected: unrelated meaning, and its save sorts the file.
- **A settings page that saves the whole config.** Rejected: it would own every key and conflict with any
  other edit.
- **A table for the hours.** Rejected: seven rows of three columns do not fit at 320px without scrolling.
- **Keeping a local draft like the Landing page and the look.** Deferred: not needed for a short form.

## Consequences

- Other settings that want to keep the owner's layout can use `config_text::set_member`; the existing routes
  are not changed here.
- The block's version rule (ADR 0305) holds on both sides of the screen: a newer block is refused with a message
  and never rewritten.
