# ADR 0010 — A Refresh Keeps Kin Unlocked in the Same Tab

Status: Accepted (#352, for the stay-unlocked-on-refresh epic #351)

## Context

Kin holds the household root key only in memory and locks on `pagehide`. Until
now every reload therefore started locked, and unlocking again needed the
passkey (which also needs the household service) or the recovery key. People
reload by accident all the time, most often by dragging down at the top of a
phone screen, and were signed out for it.

When a page unloads, the browser does not say whether it is being refreshed,
closed or left. Only the next page load knows, through
`PerformanceNavigationTiming.type`.

## Decision

- **Make accidental refresh rarer.** The page root sets
  `overscroll-behavior-y: none`, which stops the browser's pull-to-refresh
  where the browser honours it. Inner scroll areas keep their own behaviour.
- **One tab, one use, a short window.** `web/security/reload-resume.js`:
  - At unlock, the tab makes a **non-extractable** AES-GCM key, stores it in
    IndexedDB (`kin-reload-resume`) under a random ticket id, and seals the
    root with it in memory. The additional data binds the ticket id, vault id
    and root version. Raw root bytes are never stored.
  - On `pagehide`, the tab writes only the sealed root, ticket id, vault id,
    root version, durable lock epoch, an expiry (**2 minutes**) and the
    auto-lock deadline to **sessionStorage**, then locks exactly as before.
  - At startup, the ticket and its key are read and **deleted at once**. Kin
    unseals only if the page load is a `reload` (not `navigate`,
    `back_forward` or `prerender`), the window and the auto-lock deadline have
    not passed, the setting is on, and the vault id, root version and lock
    epoch still match a household in the `encrypted` phase. The unsealed root
    goes through the ordinary unlock checks (`finishUnlock`). Anything else is
    an ordinary locked start, with no error shown.
- **Every real lock ends it.** Lock, automatic lock, a lock from another tab
  (which moves the durable lock epoch), logout, leaving the household and
  turning the setting off delete the key and any ticket. Returning from the
  back/forward cache counts as navigating and deletes them too. A root
  rotation or removed unlock path changes the root version or lock epoch, so
  an old ticket is refused.
- **The inactivity clock carries over.** A refresh does not restart automatic
  lock; Kin resumes with the time that was left.
- **Liveness.** Each armed tab holds a Web Lock named for its ticket id, so the
  startup sweep deletes keys left by closed tabs but never a live tab's.
- **A device setting, on by default.** Security → Automatic lock → "Stay
  unlocked when I refresh this tab". Off restores the old behaviour. Browser
  regressions start with it off and one check turns it on.

## Consequences

- Neither half unlocks alone: the ticket is useless without the key, and the
  key cannot be exported from the browser.
- Someone with access to the person's browser profile in the two minutes after
  a refresh could combine them. **The owner accepted this risk**: whoever can
  use the person's browser is the person's responsibility. Script running in
  Kin's page already has the unlocked root, so the ticket gives it nothing new.
- Restoring a closed tab can bring back its sessionStorage; the two-minute
  window and the sweep bound that case.
- A tab holding a Web Lock is not kept in the back/forward cache by some
  browsers. Kin locked on leaving anyway, so nothing visible changes.
- Drafts are still memory-only and are discarded by a refresh.
- No household format, event or server change.
