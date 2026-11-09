# Accessibility acceptance

Version 1.9.22 records the repeatable automated acceptance boundary and the remaining physical-test protocol for Epic 10. It is evidence of keyboard, semantic, reflow, contrast and browser behavior; it is not a WCAG conformance statement or a substitute for testing with a person's own assistive technology.

## Automated release evidence

Release branches and version tags run the complete browser suite in branded Chrome, Playwright Chromium, Firefox and WebKit. The following journeys collectively cover the scoped acceptance criteria:

| Contract                | Evidence                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit                    | `hardening.spec.js` exercises keyboard focus, source editing, save announcements, Undo, recovery and exact export without source loss.                                                                                                                                                                            |
| Audit                   | `repository-audit.spec.js`, `attention-queue.spec.js` and `analyzer.spec.js` cover keyboard operation, focus preservation, progress/failure status, cancellation and source jumps.                                                                                                                                |
| Import                  | `import.spec.js` covers keyboard merge decisions, labeled inputs, stale/cancelled requests, status feedback, exact source and Undo.                                                                                                                                                                               |
| Export                  | `hardening.spec.js` and `export-review.spec.js` cover keyboard-triggered downloads, exact bytes, warnings and offline fallback.                                                                                                                                                                                   |
| Publish                 | `release-review.spec.js` and `publishing.spec.js` cover lazy-load focus, labeled dialogs, read-only fallback, preflight/status feedback and explicit reviewed approval before remote writes.                                                                                                                      |
| Reflow and visual modes | `hardening.spec.js` covers 320–768 CSS-pixel layouts, the 320 CSS-pixel equivalent of a 1280-pixel viewport at 400% zoom, light/dark preview and application themes, reduced motion and source preservation. The Epic 10 certification case directly checks light/dark text, muted text and focus-color contrast. |
| Large documents         | `performance-smoke.test.js` covers 100 KB, 250 KB, 500 KB and 1 MB analysis/diff/project round trips. `hardening.spec.js` measures complete 100/250 KB editing, preview, Worker Health, parsing and autosave journeys in every release engine.                                                                    |

The suite locates controls by accessible role and name, verifies labeled dialogs and inputs, checks focus destinations/returns, and waits on visible or polite status output. The 2026-10-23 release audit ran the edit, audit, import, export and publish cases in those four engines and passed. This is a screen-reader-facing accessibility-tree and keyboard audit: it catches missing semantics and keyboard regressions, but it does not reproduce speech output, rotor/browse modes, platform accessibility APIs or a user's extensions and preferences.

## Manual assistive-technology protocol

Run this checklist for release candidates when physical platform coverage is available. Record browser, operating system, assistive technology and version with the result; do not convert an unrun row into a pass.

1. Start with a clean local workspace. With keyboard only, create or open a sample, edit Source, move among Builder, Source, Preview and Health, then Undo and Redo. Confirm the current pane, save result and Health completion are announced without moving focus unexpectedly.
2. Import a local README. Confirm the file control has a useful name, review choices are read in logical order, errors/status are announced, Apply is explicit, Escape returns focus, and exact source can be undone.
3. Open Repositories and run a mocked or test-repository audit. Confirm progress, partial/offline/cancel states, findings, project-type choices and source-jump controls are understandable without visual position.
4. Export the README and, when warnings exist, review the warning dialog before choosing the exact-source fallback. Confirm no publishing language is announced for a local download.
5. Open Publish to GitHub with publishing disabled, then with a test configuration. Confirm destination, branch/path, base revision, preflight blockers, diff and approval are announced before the enabled write control. Cancel without writing and verify focus returns to the trigger.
6. Repeat the core path in light and dark themes, at 200% and 400% browser zoom, with reduced motion enabled. Confirm no required control or status becomes unreachable and no horizontal page scrolling is required at the 400%/1280-pixel reflow checkpoint.

Recommended physical matrix:

| Platform | Browser               | Assistive technology | Release status                          |
| -------- | --------------------- | -------------------- | --------------------------------------- |
| Windows  | Current Firefox       | NVDA                 | Manual run required; not executed by CI |
| Windows  | Current Edge/Chromium | Narrator or NVDA     | Manual run required; not executed by CI |
| macOS    | Current Safari        | VoiceOver            | Manual run required; not executed by CI |

Automated release evidence may close a regression only within its stated keyboard/DOM/browser scope. A physical matrix row is considered accepted only when a human records the versions, date, completed steps and any exceptions. Failures become release-blocking issues when they prevent a core task or hide a destructive/remote-write decision.
