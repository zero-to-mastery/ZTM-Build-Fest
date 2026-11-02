# Studio usability budgets and evaluation

Measurements of the old guided experience (questionnaire, step wizard,
Simple/Advanced Studio) were removed with that interface in v5.0.0. See
[ADR-0008](architecture/decisions/ADR-0008-STUDIO-REBUILD.md) for why it was
replaced.

## Automated budgets

The Playwright suite in `e2e/` now enforces the Studio's budgets in a real
browser, on a desktop (1440×900) and a phone (390×844) viewport, with stubbed
GitHub responses. A change that breaks a budget fails CI.

```sh
npx playwright test
```

| Budget | Value | Spec |
| --- | --- | --- |
| Visible controls on Home | at most 6 | `home.spec.mjs` |
| Visible controls on each Studio tab | at most 40 | `studio.spec.mjs` |
| Visible controls in **Get it** | at most 8 | `get-it.spec.mjs` |
| Visible controls in the sign-in dialog | at most 16 | `sign-in.spec.mjs` |
| Primary actions | exactly one on Home and in the Studio (**Show my sky**, **Get it**) | `home.spec.mjs`, `studio.spec.mjs` |
| Map share of the screen | at least 55% on desktop, at least 35% on a phone, and not blank | `studio.spec.mjs` |
| Overlapping controls | none | every screen the suite checks |
| Controls without a visible label | none | every screen the suite checks |
| Engine jargon on screen | none of the banned terms (for example "semantic", "topology", "seed", "ring meaning", "design code") | every screen the suite checks |
| Horizontal scroll | none, including at 320 px wide | `a11y.spec.mjs`, `get-it.spec.mjs` |
| Accessibility | no axe WCAG 2.2 AA violations | `a11y.spec.mjs` |
| Phone top-bar targets | at least 44 px | `studio.spec.mjs` |
| Large account | 100 projects load and draw within 5 seconds | `studio.spec.mjs` |
| GitHub requests | none for presentation changes, the example sky, or **Get it** | `studio.spec.mjs`, `home.spec.mjs`, `get-it.spec.mjs` |

The banned terms live in `e2e/support/ux.mjs`. Canonical engine names may
still appear in configuration and these docs; they never appear on screen.

These are fixture-based checks. They are regression evidence, not proof of
performance on real networks or devices, and not a human usability
evaluation.

## Manual first-time participant procedure

Use 3–5 participants unfamiliar with Constellation. Ask permission to record
observations; do not capture credentials. Give each participant a public account
with known projects and the same browser viewport. Do not explain controls
before the task. Record elapsed time, completion, prompts for help, confusion,
and errors for each task:

1. From Home, show the map for the public account.
2. Click a star and explain, from its card, why it is on the map and what its
   size means.
3. Make one project stand out and take another off the map.
4. Change the theme and the layout, then undo the last change.
5. Using **Get it**, set up the map for a GitHub profile README; explain what
   still has to happen on GitHub and how often the image refreshes.

Repeat with a sparse account (two projects) and with a saved design reopened
from Home. Check keyboard-only completion, focus visibility, the explanation
for an unavailable layout, phone scrolling, and returning from **Get it** to
the map.

Use this record per participant/task:

| Participant | Task | Completed | Time | Help requested | Confusion | Observed error |
|---|---|---|---|---|---|---|
| Not yet evaluated | — | — | — | — | — | — |

No real participants have completed this procedure. Automated fixtures are
regression evidence, not human usability evaluation.
