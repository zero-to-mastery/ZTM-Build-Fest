# Reviewed drift fixes

Version 1.6.2 lets you turn the findings of a [drift check](drift-checks.md) into reviewed edits. Fixing is opt-in and line by line: every proposed change shows its evidence and its exact diff, nothing is approved for you, and nothing is applied until you choose **Apply**. Applying changes only your local Markdown. It never writes to GitHub; publishing stays a separate step through **Publish to GitHub**, which has its own review.

## Review fixes

1. Run a drift check (**GitHub → Drift check**, then **Run drift check**).
2. If the result has observed mismatches or uncertain findings, choose **Review fixes (N lines)**. Focus moves to the **Review drift fixes** heading.
3. Each proposal covers one line of the Markdown that was checked and lists every finding on that line with its status, the claim, the evidence message, the evidence file and, with a Baseline, whether that file changed since. Below it are the current line (read-only), the **Proposed line** (editable), the exact change as minus and plus lines, and **Approve this change to line N**.
4. Approve each change you want. **All approved changes** shows the Markdown that was checked next to the Markdown with only the approved changes, plus a unified diff, and the count of approved changes.
5. Choose **Apply N approved changes**, or **Discard proposals** to close the review without changing anything. **Download current Markdown** saves a copy first if you want one outside the browser.

After applying, the drift result and proposals are cleared because they describe the previous Markdown, and focus returns to **Run drift check** so you can check the updated text. **Undo** in the editor restores the Markdown as it was before the fixes, as one step.

Applying records the new Markdown as manual source, like editing it in the Markdown pane. A draft that is already one Custom Markdown block stays as it is. In a draft built from builder sections, components or generated content, only the sections whose lines change are detached and become Custom Markdown, so stale builder settings cannot overwrite the fixes; untouched sections keep their ownership. The review says so before **Apply**, and the status names any detached section after. **Undo** restores the previous Markdown and builder ownership.

## What is proposed

Only **observed mismatches** and **uncertain findings** become proposals. **Unknown** results (evidence that could not be read) and matches never do, so a failed, truncated or offline check offers no fixes for the claims it could not check.

A proposal starts with a suggestion only when the evidence itself supplies one:

| Finding                                                                                     | Suggestion                                                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A linked, commanded or inline path that differs from the repository's in case               | The repository's spelling, e.g. `docs/guide.md` → `docs/Guide.md`                                                  |
| An anchor that differs from a heading only in punctuation (uncertain)                       | The heading's anchor, e.g. `#set-up--the-cli` → `#set-up-the-cli`                                                  |
| A missing `package.json` script when exactly one script differs only in punctuation or case | That script, e.g. `npm run test-unit` → `npm run test:unit`                                                        |
| A Node version in prose older than `engines.node` (uncertain)                               | The whole `engines.node` minimum, e.g. `Node 18+` → `Node 20+`, or `Node.js 18.17` → `Node.js 20.11` for `>=20.11` |

Everything else (a missing file with no similar path, a missing script with no similar name, a lockfile or `.env` key finding) starts as the unchanged line with the note "No suggestion from the evidence"; edit the **Proposed line** yourself if it needs a change, or leave it. A suggestion is placed only where it matches a whole word, path or URL on its line, never inside a longer one that shares its text: `lint` is not found inside `lint:fix`, `docs/guide.md` not inside `other/docs/guide.md`, `docs/` not inside `docs/setup.md`, and `#set-up--the-cli` not inside `docs/Guide.md#set-up--the-cli`, so a fix for one claim never changes another link or path on the same line. A path inside another URL's query or after a comma in it (`https://example.com/view?file=docs/guide.md`) is part of that URL and is not changed. A link's suggestion goes on the line where the link is written: the `](…)` of an inline link, the `href` or `src` attribute, or, for a reference link, the definition line its label uses (`[guide]: docs/guide.md` for `[the guide][guide]`), never an earlier plain mention of the same path, a link written in a code span or code block, a definition inside an HTML comment, or an unused definition with the same URL. When the link's URL is not written verbatim (for example entity-encoded), no suggestion is made for it. A prose Node version is replaced in every statement on the line (`Requires Node 18+ and Node.js 18 or newer` changes both), whether it is written as `Node 18+`, `Node.js 18.17 or newer`, `Requires Node.js 18.17` or `Node.js >= 18.17`. When a statement has a link in it (`Requires [Node.js](https://nodejs.org) 18 or newer`) or wraps onto the next line, the suggestion is placed on its version number, on the line that holds it. A prose version is compared only as far as it is written: `Node 20` names the whole 20 line and matches `>=20.11`, while `Node 20.5` is older and gets `20.11`. A script suggestion, or a version suggestion for a linked or wrapped statement, that could match twice on the line is not placed, and the proposal says so. When two findings on a line carry the same suggestion (a path written as a code span and as a link), the first places it everywhere on the line and both are shown as placed.

Uncertain findings are labelled **Uncertain — may be correct as written** and are never approved by default. Line breaks you type in a proposed line are written with that line's own line ending, so a CRLF document stays CRLF.

## Approval, conflicts and your edits

- Every proposal starts unapproved. A proposal identical to the current line cannot be approved, and editing a proposed line withdraws its approval until you approve it again.
- Unapproved lines, and every line without a proposal, are kept byte for byte.
- Proposals apply only to the exact Markdown that was checked. If the Markdown changed in any way after the check, or the document or its target changed, **Apply** changes nothing, reports that the Markdown changed since the drift check, keeps your edit, clears the stale proposals and returns focus to **Run drift check**. Run the check again to review fixes for the current text.
- Starting a new check, a failed or cancelled check, or closing the dialog clears any open review. Proposals and approvals are not saved anywhere, like drift results ([ADR 0002](adr/0002-drift-checks-read-content-but-persist-nothing.md), [ADR 0003](adr/0003-drift-fixes-apply-only-to-the-checked-markdown.md)).

## Offline, failure and accessibility

Reviewing and applying needs no network: the proposals come from the result already on screen and nothing is sent anywhere. A check that cannot read GitHub reports its failure and offers no fixes; an in-document anchor check works offline as before.

All controls are native buttons, text areas and checkboxes inside one fieldset per line, labelled with the line number. Diffs are focusable text. Outcomes are announced in the dialog's polite live region. The review fits at 320px without horizontal page scrolling. Automated checks cover keyboard operation; they do not replace manual screen-reader review.

## Limits

- A proposal edits one line, as numbered by the drift check. A command continued over several lines is reported on its first line, so a suggestion for a later line is not placed; edit the proposed line yourself.
- A link's line is found in the Markdown as written. A reference definition is found only when exactly one definition line in its block matches its label and URL; otherwise, as for an entity-encoded URL, the finding has no suggestion. A link in an indented code block inside a list item is not told apart from the real one.
- Suggestions are deliberately narrow. README Studio does not invent replacement commands, paths or links when the evidence has no close match.
- Applying does not re-run the drift check. Run it again to confirm the fixes against the repository.
- Applying does not publish. Use [Publish to GitHub](github-publishing.md) to review and publish the updated README separately.
