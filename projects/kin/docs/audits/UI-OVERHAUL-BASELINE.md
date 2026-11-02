# Kin household usability baseline — Epic #261 / Story #262

**Status:** Field study prepared; participant observations not yet collected.  
**Design reference:** [MagicPath approachable household concept](https://www.magicpath.ai/files/462705422168641536). This prototype is not an implementation contract, and its simulated state is not production evidence.  
**Scope:** Usability research for the existing native Web Components application. No application behavior, security contract, Rust/WASM ABI, storage version, or dependencies change.

## Research question

Can somebody who did not build Kin join their household, complete one everyday task, and return without a walkthrough? Which steps cause hesitation, incorrect decisions, or uncertainty about what saved?

The repository's [workspace UX contract](../WORKSPACE-UX.md) and [product boundaries](../planning/PRODUCT-BOUNDARIES.md) remain authoritative unless subsequent approved issues intentionally revise presentation. No user is required to become a tester.

## Consent and study setup

- Recruit **at least three consenting non-technical participants**, ideally including a person who might use Kin daily. Participation is voluntary; stop immediately if uncomfortable.
- Do not record passkeys, recovery secrets, invitation tokens, household messages, account IDs, biometric prompts, or real private household data. Use a demo household with synthetic names and content.
- Ask participants to think aloud, but **do not coach**, point to controls, or explain domain terms during a timed scenario. Mark assistance if it becomes necessary. Avoid making the participant feel tested: this evaluates the interface.
- Record device class, browser, approximate viewport, and whether the participant has previously used Kin. Keep participant labels anonymous (P1, P2, ...).
- Test **the existing Kin implementation first**. Show MagicPath afterward only to compare comprehension and perceived usefulness; never count simulated interactions as successful product tasks.

## Unassisted task script

Run tasks in the stated order. Read only the task prompt aloud and observe the chosen path.

| ID | Scenario prompt | Observable success | Special evidence |
| --- | --- | --- | --- |
| T1 | “You've been invited to join this household. Get started.” | Correctly distinguishes *joining as a person* from *adding their own device*; completes authorized flow, or correctly explains who must approve it. | Wrong branch chosen, security checks misunderstood, pending state |
| T2 | “Add milk to the family's shopping list.” | Item appears in the correct shared list; participant can explain whether it is saved locally or synced. | Location of Add, category selection, confirmation |
| T3 | “Mark a household task done. Now reopen it.” | Both state changes persist through the normal Rust command path. | Checkbox affordance, undo discoverability, focus |
| T4 | “Find something another member left for you to read.” | Opens Updates and identifies relevant handoff or Talk entry. | Navigation labels, handoff vs Talk vocabulary |
| T5 | “Set up a daily reminder or routine for a household activity.” | Finds the appropriate routine workflow and creates only what the current product actually supports. | Confusion about routines versus task reminders; don't imply unsupported capabilities |
| T6 | “Tell me whether the thing you added is shared with other people, and what happens without internet.” | Correctly interprets live local-save, pending-sync, synced/offline indicators in presented conditions. | Misleading labels, false delivery assumptions |

### Return visit

After a break, ask the participant to open Kin again, locate the shopping list, and complete a task **without repeating a tutorial**. Record any confusion caused by lock/unlock or navigation state. This is a separate returning-user observation.

## Observation template

For each task and participant:

| Field | Allowed record |
| --- | --- |
| Participant | P1 / P2 / P3 ... |
| Scenario | T1–T6 or return visit |
| Device / browser | Non-identifying platform/version |
| Completion | Unaided / assisted / failed / blocked by test setup |
| Elapsed time | Approximate seconds |
| Wrong turns | Count and brief anonymized navigation notes |
| Assistance | None / hint / direct intervention (record reason) |
| Own words | Non-identifying paraphrase of what was confusing |
| Severity | Critical: cannot complete or security misunderstanding; High: assisted; Moderate: unnecessary detour; Low: polish |
| Evidence | Synthetic-data screenshot, route, or repro description |
| Outcome understanding | Can / cannot correctly explain saved locally vs synced |

**Do not invent results or benchmark values.** Calculate per-scenario completion and assistance rates and median elapsed time only after observing real users. Keep raw notes outside the public repo when they contain personal details; publish only aggregated, anonymized findings.

## Comparison against the MagicPath concept

Following current-app testing, show the concept and ask—not tell—what a participant expects:
- Does “What would you like to remember?” indicate a task, shopping entry, or something else? Where would the new item go?
- What does the “Welcome home” card explain, and can it be dismissed?
- Can they find To do, Shopping, Updates and household settings using the five familiar destinations?
- Is Today comprehensible on mobile as well as desktop?
- Does the design suggest something is saved or synced when the prototype cannot verify it?
- Do visual progress counts feel helpful or pressuring? Kin's product boundaries disallow scoring and gamification.

Record preferences as **hypotheses**, not feature requirements. Keep the five-route architecture, real permissions, actual data, and personalization intact.

## Baseline report and prioritization

Create a short follow-up report with (1) anonymized scenario outcomes, (2) ranked problems and exact relevant routes/components, (3) proposed smallest UI change, (4) affected issue #263–#268, and (5) repeat-test method. Seek participant confirmation that the proposed wording makes sense. Record decisions in this directory or in the relevant epic issue.

A story is not “done” because this script exists. **#262 cannot be closed until the consenting observations and ranked findings are recorded.** The end-to-end usability release gate is #269.

## Implementation/release constraints

- Native HTML/CSS/Custom Elements and vanilla JS; manual Rust/WASM ABI; no React, JSX, Tailwind, wasm-bindgen or runtime framework.
- Preserve local-first encryption, member/device authorization, export/recovery and version-1 compatibility. Do not add telemetry.
- All proposed UX changes must have testable observable behavior, truthful save/sync messaging, mobile/desktop and accessibility checks.
- Working branch for the epic: `kin-ui-overhaul`. Keep each change on a short-lived branch and PR into that branch; integration/release into `kin-development`, and later promotion to `kin-testing`, happen only at the user's stated gates.
- Release semantics follow [RELEASE-LINE-PROTOCOL.md](../planning/RELEASE-LINE-PROTOCOL.md): tags record completed releases, **not** unmerged work. Patch candidates can mark incremental tasks; a finished user story can justify a minor capability bump after review, but final version/tag belongs at the integration gate.
