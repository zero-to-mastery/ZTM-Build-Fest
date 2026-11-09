# Usability findings

The Friction tracker for the Usability scenarios in [usability-scripts.md](usability-scripts.md). Each row is one obstacle in one scenario at a named step, with a severity from 1 (cannot complete) to 4 (cosmetic) and the kind of run that found it.

Rows are filed by kind of evidence and never mixed ([ADR 0006](adr/0006-usability-evidence-comes-from-scripted-runs-and-facilitated-sessions-not-analytics.md)). Scripted runs are automated and measure navigation cost. A heuristic walkthrough is the implementer's own review of the scripted paths, not user evidence. Only the "Participant sessions" section holds what real people did, and only once sessions have happened. `tests/usability.test.js` checks that this file stays consistent: valid severities and statuses, each kind of run in its own section, and no open severity 1 or 2 item from a Scripted run or walkthrough.

Columns: Step names the step number in the scenario's intended path. Fix PR/test links the change and its regression tests. Status is Open or Fixed. Open severity 3 and 4 items are tracked for later releases.

## Scripted run baseline (automated)

Baseline from `tests/browser/usability-scenarios.spec.js` in Chromium, Firefox and WebKit, with GitHub and remote images mocked. Before the fixes below, N1 did not complete (the exported README lacked the author's name) and N4 took 7 steps and ended on the wrong draft. After them, every scenario completes within its budget, with the same Step count in each engine.

| ID  | Scenario | Step                       | Audience    | Found by     | Severity | Status | Fix PR/test                                                                                                           |
| --- | -------- | -------------------------- | ----------- | ------------ | -------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| F1  | N1       | 7 · Export README          | Novice      | Scripted run | 1        | Fixed  | #76 · `tests/browser/usability-fixes.spec.js`, `tests/browser/usability-scenarios.spec.js`, `tests/usability.test.js` |
| F2  | N4       | 5 · Restore backup         | Novice      | Scripted run | 2        | Fixed  | #76 · `tests/browser/usability-fixes.spec.js`, `tests/browser/usability-scenarios.spec.js`, `tests/usability.test.js` |
| F4  | E1       | 8 · Tab to Add to README   | Experienced | Scripted run | 3        | Open   |                                                                                                                       |
| F5  | E1       | 4 · Tab to Search logos    | Experienced | Scripted run | 3        | Open   |                                                                                                                       |
| F6  | E2       | 8 · Save document settings | Experienced | Scripted run | 3        | Open   |                                                                                                                       |

- **F1.** After typing a name into the Hero section, Export README downloaded the README without it and gave no sign: section edits reach the README only through Save section. The run could not complete (7 steps, wrong file). Fix: Export README and Copy Markdown now ask first while the open section form has unsaved edits, offering "Save section and export", "Export without these edits" or "Keep editing". Save Studio project, Download all drafts backup and Download draft backup ask the same question. Nothing is saved without that choice, and saving is an ordinary step that Undo reverses.
- **F2.** Restoring the backup in a fresh browser merged it beside the new sample draft but left the sample open, so the editor still showed "Your Name" and the restored work was only listed under Current draft. Fix: a merge restore now opens the backup's own active draft, and the notification says which draft opened and that the others are still under Current draft. Merge still replaces nothing.
- **F4.** In Badge Studio, choosing a logo moves focus to the Label field. Reaching Add to README takes 21 Tab presses past the badge fields, generated output, copy and collection controls.
- **F5.** Badge Studio opens with focus on "Use theme defaults", 4 Tab presses before Search logos.
- **F6.** Set document target, opened from Drift check, closes the dialog after Save document settings. The author has to open Drift check again (3 more steps).

## Heuristic walkthrough (implementer, not user evidence)

The implementer's review of the intended paths against the severity scale. It predicts likely obstacles and is not evidence of what participants do.

| ID  | Scenario | Step                          | Audience | Found by              | Severity | Status | Fix PR/test                                                                                |
| --- | -------- | ----------------------------- | -------- | --------------------- | -------- | ------ | ------------------------------------------------------------------------------------------ |
| F3  | N4       | 3 · Guided start, new browser | Novice   | Heuristic walkthrough | 2        | Fixed  | #76 · `tests/browser/usability-fixes.spec.js`, `tests/browser/usability-scenarios.spec.js` |
| F7  | N1       | 7 · Find Export README        | Novice   | Heuristic walkthrough | 3        | Open   |                                                                                            |
| F8  | N4       | 5 · After the restore         | Novice   | Heuristic walkthrough | 3        | Open   |                                                                                            |
| F9  | N3       | 6 · Audit selected            | Novice   | Heuristic walkthrough | 3        | Open   |                                                                                            |

- **F3.** After browser data is lost, Guided start is the first screen. It said to download a backup but offered no way to restore one, so a novice had to close it and find Restore backup under Settings or Manage drafts, which is likely to take more than 2 wrong turns. Fix: "Restore a backup" is now one of the Other ways to start. It opens the existing restore dialog, which validates the file before anything changes.
- **F7.** Next steps after a profile template end with Preview README. Export README is in the fifth tool group, Save, with no route from the preview.
- **F8.** A restore in a fresh browser keeps the automatically created sample draft beside the restored drafts.
- **F9.** Audit selected stays disabled until a repository is selected. Only the count line ("0 selected") hints why.

## Participant sessions

None recorded. No Participant sessions have been run yet. Rows are added here, as Found by "Participant session" with pseudonymous participant IDs, only after a facilitated session has actually happened, following [usability-scripts.md](usability-scripts.md).
