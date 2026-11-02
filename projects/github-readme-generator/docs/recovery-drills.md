# Offline recovery drills

These drills certify bounded, testable recovery behavior for a release candidate. They do not claim that an abrupt operating-system failure can preserve edits that never reached browser storage, and they do not certify a live production host.

| Failure                         | Expected result                                                                                                                            | Automated evidence                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Storage quota or revoked writes | Current source remains in memory, the save state says it failed, and exact README/workspace downloads remain available.                    | `tests/browser/hardening.spec.js` — quota and unavailable storage |
| Unreadable saved workspace      | The original bytes remain untouched and download byte-for-byte; recovered readable drafts stay temporary until an explicit restore.        | `tests/browser/hardening.spec.js` — corrupted storage recovery    |
| Browser/tab interruption        | Page hide flushes the current draft; a reload opens the last successfully persisted exact source.                                          | `tests/browser/hardening.spec.js` — rapid edit/unload recovery    |
| Waiting application update      | Activation occurs only after a successful workspace save. A failed save keeps the old page active and directs the author to download work. | `tests/offline-status.test.js` and `scripts/static-smoke.mjs`     |
| Origin/network unavailable      | Cached application editing, preview and export continue; GitHub-dependent actions fail visibly without changing source.                    | `tests/browser/hardening.spec.js` and `scripts/static-smoke.mjs`  |

## Manual spot check

1. Open a release candidate, edit a distinctive line, and wait for **Saved locally**.
2. Disconnect the network and reload. Confirm the line is exact, edit again, and download `README.md` plus **Download all drafts backup**.
3. Open each download outside Studio and compare the distinctive line byte-for-byte.
4. Restore network access. If an update is offered, simulate blocked/full storage before choosing **Save and reload update**. Confirm the page does not reload and offers a download-first recovery instruction.
5. Remove the storage fault, save, activate the update, and confirm the exact source returns.

Record browser/version, operating system, candidate commit, UTC date and any exception. A mocked or local run must be labelled as such.
