# Usability scripts

These scripts measure how hard README Studio's main tasks are to complete, so decisions about navigation rest on evidence. There are two kinds of evidence, and they are always kept apart ([ADR 0006](adr/0006-usability-evidence-comes-from-scripted-runs-and-facilitated-sessions-not-analytics.md)):

- A **Scripted run** is an automated Playwright execution of a Usability scenario's intended path, with GitHub and remote images mocked. It records whether the scenario completes and its **Step count**. It measures navigation cost, not people.
- A **Participant session** is one real person attempting a Usability scenario while a facilitator takes notes. Its results exist only when such a session actually happened.

README Studio gains no analytics, telemetry, session recorder or storage for this work. Local activity keeps its fixed scope. Findings from either kind of run go in the Friction tracker, [usability-findings.md](usability-findings.md).

## Step count

One step is one author action:

- a click or tap;
- a key press, including each Tab press and each shortcut such as Ctrl+K;
- one field entry: typing a value, choosing an option, choosing a file or ticking a checkbox.

Waiting, reading and scrolling are not steps. The Step budget in the table below is the Scripted run baseline for each scenario's intended path. `tests/browser/usability-scenarios.spec.js` reads the budgets from this table and fails when a scenario stops completing or takes more steps than its budget. Change a budget only on purpose, in the same commit as the change that moves it, and say why in the Friction tracker.

## Scenarios

**Novice** scenarios start on a first visit, with no saved workspace, so Guided start opens. **Experienced** scenarios start with a workspace saved by an earlier visit, and the author uses Search workspace, tools and shortcuts.

| ID  | Audience    | Start state                                                                                                                | Success criterion                                                                                           | Step budget |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------- |
| N1  | Novice      | First visit; Guided start is open.                                                                                         | An exported README.md contains the author's name and not the template's "Your Name".                        | 8           |
| N2  | Novice      | First visit; a synthetic README.md with an image that has empty alt text is on the device.                                 | The imported README is split into sections and the empty alt text finding is gone after the author's edit.  | 11          |
| N3  | Novice      | First visit; GitHub returns one synthetic public repository, example/notes, with a short README (mocked in Scripted runs). | A new local draft holds the audited README exactly, with Next steps from the audit.                         | 8           |
| N4  | Novice      | First visit; the author has written their own Markdown. Then a fresh browser with no saved workspace.                      | In the fresh browser, the restored draft is open with the backed-up Markdown.                               | 5           |
| E1  | Experienced | Saved workspace with the sample profile. Keyboard only.                                                                    | An exported README.md contains a React badge, and no pointer was used.                                      | 33          |
| E2  | Experienced | Saved workspace whose README runs `npm run test-unit`; the repository has a `test:unit` script and is read-only (mocked).  | Only the approved line changed in the Markdown, and nothing was written to GitHub.                          | 15          |
| E3  | Experienced | Saved workspace with a profile draft and a blank repository README; the saved Goal is a repository README.                 | The author switched drafts, used and hid Next steps, and reopened Guided start with the saved Goal focused. | 10          |

### Intended paths

The Scripted runs follow these paths. In a Participant session, read only the task prompt aloud. Do not show or describe the path.

**N1 — First profile README to export.** Prompt: "You want a README for your GitHub profile. Make one that shows your name, and save the README.md file to this computer."

1. Write my profile README.
2. Start from a profile template.
3. Minimal.
4. Next steps → Edit your sections.
5. Open the Hero section.
6. Type a name.
7. Workspace tools → Save → Export README.
8. Save section and export.

**N2 — Import, split and act on a Health finding.** Prompt: "Here is the README of one of your projects. Bring it into README Studio, break it into sections, and fix one thing README Health points out."

1. Write a repository README.
2. Import existing README.
3. Local file.
4. Choose the README.md file.
5. Import as new draft.
6. Next steps → Split into sections.
7. Split into sections (apply).
8. Next steps → README Health.
9. Go to line 3 on "Image has empty alt text".
10. Type `![Widget logo](docs/logo.png)` over the selected image.
11. Next steps → README Health, to confirm the finding is gone.

**N3 — Audit public READMEs and open one to improve.** Prompt: "Check the READMEs of your public repositories for the account the facilitator gives you, and open one to work on."

1. Audit my repository READMEs.
2. Open README audit.
3. Type the GitHub username.
4. Load repositories.
5. Select all filtered repositories.
6. Audit selected.
7. Improve README.
8. Open existing README unchanged.

**N4 — Back up the workspace and recover it.** Prompt: "Keep a copy of your work. Then imagine your browser data was cleared: get your work back in this new browser window."

1. Workspace tools → Save → Settings.
2. Download all drafts backup.
3. In the fresh browser, Guided start → Restore a backup.
4. Choose the backup file.
5. Restore backup (Merge, the default).

**E1 — Keyboard only: Search workspace to Badge Studio, add a badge, export.** Prompt: "Without the mouse, add a React badge to your README and export it."

1. Ctrl+K.
2. Type "badge studio".
3. Enter.
4. Tab 4 times to Search logos.
5. Type "react".
6. Tab once to React.
7. Enter.
8. Tab 21 times to Add to README.
9. Enter.
10. Ctrl+Shift+E.

**E2 — Set a target, run a drift check, review a fix.** Prompt: "Check whether this README still matches its repository, ada/widget on main, and fix what is wrong."

1. Ctrl+K.
2. Type "drift check".
3. Enter.
4. Set document target.
5. Document group: Repository.
6. Type the repository.
7. Type the branch.
8. Save document settings.
9. Ctrl+K.
10. Type "drift check".
11. Enter.
12. Run drift check.
13. Review fixes.
14. Approve the proposed line.
15. Apply the approved change.

**E3 — Switch documents, use and hide Next steps, reopen Guided start.** Prompt: "Go back to your profile draft, start a new one from a template, look at its preview, put the suggestions away, then find the screen that asked what you wanted to do first."

1. Current draft → the profile draft.
2. Ctrl+K.
3. Type "templates".
4. Enter.
5. Minimal.
6. Next steps → Preview README.
7. Hide.
8. Ctrl+K.
9. Type "guided start".
10. Enter.

## Running Scripted runs

```sh
README_STUDIO_TEST_PORT=4317 npx playwright test tests/browser/usability-scenarios.spec.js
```

Each run attaches `usability-<ID>.json` with `{ scenario, audience, completed, steps, budget, keyboardOnly }`. Attachments stay in the local or CI test report and are never sent anywhere. The same paths give the same Step count in Chromium, Firefox and WebKit.

## Facilitating a Participant session

Run these sessions by hand. Nothing in the app records them.

1. Prepare a browser profile with no saved README Studio data. For Experienced scenarios, set up the start state beforehand, without the participant.
2. Use only synthetic material: the README files and GitHub account named in the start state, or ones like them. Never use the participant's own repositories, tokens or private Markdown.
3. Read the consent statement and the privacy statement aloud. Continue only after the participant agrees.
4. Read each task prompt aloud. Do not demonstrate or name controls. If the participant asks for help, say "What would you try?" once. If they are still stuck, give help and note it, which makes the Friction severity 2 or higher.
5. Note each obstacle as it happens: the scenario ID, the step where it happened, what the participant tried, wrong turns, hesitation and any help given. Also note whether the scenario completed.
6. Afterwards, add each obstacle to the "Participant sessions" section of [usability-findings.md](usability-findings.md) as Found by "Participant session", with a severity from the scale below.

### Consent statement

> We are testing README Studio, not you. There are no wrong answers. Please think aloud as you work. You can skip any task or stop at any time without giving a reason. I will take written notes about what happens on the screen. Nothing is recorded on video or audio, and the notes will not include your name. Is that all right?

### Privacy statement

> You will use made-up README files and a test GitHub account. Please do not open or type your own repositories, tokens, passwords or private text. Your notes are filed under an ID such as P1, never your name. Notes describe what happened, not who you are, and no recordings or screenshots of you are kept.

- Participants are pseudonymous: P1, P2 and so on. A list linking IDs to people, if one is needed for scheduling, is never committed.
- Use synthetic data only.
- Commit no recordings, screenshots of participants, quotes that identify someone, or contact details.

## Severity scale

| Severity | Meaning                                                                              |
| -------- | ------------------------------------------------------------------------------------ |
| 1        | Cannot complete the scenario.                                                        |
| 2        | Completes only with help, with a workaround, or after more than 2 wrong turns.       |
| 3        | Hesitation: completes, but pauses, searches or takes more steps than the path needs. |
| 4        | Cosmetic: wording, layout or polish that did not slow the task.                      |

Severity 1 and 2 Friction found by Scripted runs or a heuristic walkthrough is fixed in the same release, each with a regression test linked in the tracker. Severity 3 and 4 items stay tracked. Participant session items of severity 1 and 2 are fixed once the maintainer has recorded them.

## What stays manual

These have not happened yet, and nothing in this repository claims they have:

- Novice and Experienced Participant sessions.
- Screen-reader runs and physical touch-device runs of Guided start and Next steps.

Use this script for them, and record the results in [usability-findings.md](usability-findings.md).
