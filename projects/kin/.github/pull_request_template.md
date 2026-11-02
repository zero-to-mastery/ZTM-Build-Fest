## What changed

<!-- The problem, what you did about it, and the issue it closes (e.g. "Closes #123"). -->

## How you checked it

<!-- Which of `npm run verify`, `npm run verify:browser`, a single suite, or a manual pass you ran, and what they showed. Say plainly what you could not run. -->

## Checklist

- [ ] Every changed path is under `projects/kin/`.
- [ ] The change does one thing; anything else is a separate issue or PR.
- [ ] No new dependency, or its justification is written above.
- [ ] Household text and imported data stay untrusted (rendered as text, never HTML); no secrets, real household data or storage dumps in code, fixtures, screenshots or logs.
- [ ] Keyboard, focus, 48 px targets, 320 px reflow, reduced motion and easy mode still work for anything a person can see.
- [ ] Frozen v1.0 formats are untouched, or `docs/V1.0-COMPATIBILITY.md` is updated with them.
- [ ] The documentation this touches is updated, the README describes only what exists, and there is a line under *Unreleased* in `CHANGELOG.md`.
- [ ] `npm run verify` passes locally, or the reason it could not run is stated above.
