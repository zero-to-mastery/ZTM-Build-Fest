# Accessibility Contract

**Status:** Current through v0.7.0 Routines; earlier version sections are historical contracts. See v0.7.0 below.

## Baseline requirements

- Use semantic HTML first and native form controls wherever possible.
- Give every input and button a programmatic name and visible label where appropriate.
- Preserve complete keyboard operation and a logical focus order.
- Restore focus to the compose input after add, complete, reopen, and archive transactions that disable or replace the originating control.
- When canonical peer refresh replaces a focused item action, restore focus to the compose input; a stale item retry must not remain available after the item is archived or missing.
- Provide a clear, visible focus indicator that is not obscured.
- Use meaningful heading hierarchy and landmarks.
- Announce asynchronous loading, save/completion success, and errors through an appropriately scoped status region without moving focus unexpectedly.
- Never convey item state by color alone; use text, icon plus accessible name, or another non-color cue.
- Maintain readable contrast for text, controls, boundaries, and focus states.
- Support browser zoom and reflow at narrow viewport widths without loss of functionality.
- Use touch targets large enough for one-handed mobile use; do not make a tiny icon the only way to complete an item.
- Respect `prefers-reduced-motion`; avoid unnecessary motion.
- Use ARIA only when native HTML cannot express the needed semantics.
- Test custom elements and shadow-boundary event behavior with keyboard and assistive technology where practical.

## Mobile interaction contract

Kin should remain usable one-handed on a phone and during interruptions:

- Keep item capture to a short text entry and one clear submit action.
- Default classification to Needs and expose Today through one labeled native control.
- Keep classification label, visible focus, and touch target clear under forced colors and increased text spacing.
- Minimize typing and avoid mandatory metadata.
- Keep primary controls stable and easy to reach.
- Provide accessible names for icon-only controls; prefer a visible text label for unfamiliar actions.
- Preserve draft text and communicate failures if an interaction is interrupted where practical.
- Restore a typed draft after same-tab reload when session storage is available; clear it only after a successful append.
- Avoid dense administration, tiny hit targets, and layouts that require precise gestures.
- Test 320px reflow and browser/page-scale zoom where supported; report emulated page scaling separately from native desktop zoom.

## v0.1.0 acceptance

Today/Needs capture and complete/reopen/archive controls work with keyboard alone, restore focus after asynchronous updates, announce result/error state, expose a busy state, and remain understandable without color. Release-specific browser evidence and unverified platforms are recorded in the changelog. Mobile usability and accessibility checks are release requirements, not optional polish.

## Handoff

Handoff add/acknowledge/archive restore its input focus. Peer refresh restores focus there when replacing a focused Handoff action. Busy state disables every Item/Handoff control plus retry. Semantic headings and textual acknowledgement communicate status without color or named identity.

## v0.3.2 resilience and accessibility

The browser runner covers delayed Handoff persistence across reconnect/peer refresh, newer draft ownership, sessionStorage denial, acknowledgement/archive failure and abort retry, rapid repeated retry, and stale actions without invalidation delivery. Handoff semantics, focus, announcements, disabled controls and touch targets are checked under the existing accessibility modes. No screen-reader or native desktop zoom certification is claimed.

## v0.4.0 Talk

Talk uses semantic heading/lists, native labels/buttons, textual status and input focus restoration after add/resolve/reopen/archive and peer action replacement. Busy state disables all controls. Require 48px targets, 320px reflow and accessibility modes; do not claim untested assistive-technology certification. See [V0.4.0](V0.4.0.md).

## v0.4.2 resilience and accessibility evidence

Expanded Talk browser checks for keyboard resolve/reopen/archive, native input-to-Add focus order, semantic headings/lists, labels, polite status/assertive errors, visible focus and 48px targets under forced colors. Added independent draft assertions and direct stale retries with missed invalidation, alongside repeated-refresh recovery. Retained delayed saves, reconnect, queued peer refresh, sessionStorage denial, quota/abort rollback, rapid retry once and supersession. No production defect was found. Passed 56 Rust and 17 Node/real-WASM tests, formatting, Clippy, version consistency, release WASM, both build scripts/launchers (page/WASM HTTP 200), and complete browser suite in Windows x64/Chrome 154.0.8037.59/Node 22.12.0, POSIX via WSL. 320px, increased spacing, forced colors, reduced motion and 200% page-scale emulation pass; native zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

## v0.4.3 reflow correction

Added every truncated v4 result-header/Talk-record boundary, malformed request headers and extreme lengths, 10,000-event mixed replay, and 10,000-Talk real-WASM growth with independent copied results across repeated success/error/empty calls. Retained explicit v3 Handoff truncation/trailing-byte coverage. Visual inspection found and fixed horizontal overflow caused by a 320px page minimum width when a desktop scrollbar consumes space; reflow assertions now compare scrollWidth with clientWidth. The corrected 320px screen preserves full input focus outlines and wrapping actions.

Passed 58 Rust tests and 19 Node bridge/real-WASM tests, formatting, Clippy with warnings denied, version consistency, release WASM, PowerShell and WSL POSIX build scripts and build/run launchers (page and WASM HTTP 200), and complete browser regressions. Environment: Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.59; POSIX via WSL. Keyboard, all Talk lifecycle focus restoration, native focus order, semantics, busy/status/error, 48px targets, scrollbar-aware 320px reflow, forced colors, increased spacing, reduced motion and 200% page-scale emulation passed. Native desktop zoom, Firefox, Safari, NVDA and VoiceOver remain unverified.

## v0.5.0 Pulse

Pulse uses semantic heading, labeled native selects/buttons, textual state, visible focus and 48px targets. Busy disables controls, success is polite, errors assertive. Refresh preserves selections/focus. Report actual zoom/assistive-technology coverage per milestone. See [V0.5.0](V0.5.0.md).

## v0.5.2 resilience and accessibility evidence

Fixed focus restoration when expiry hides the focused active Pulse action: return to the native capacity selector. Added simulated suspension/missed timer and visibility return, delayed focus refresh, forward/backward wall-clock projections, late timer non-append, missed peer invalidation, original SET/CLEAR retries through quota/transaction abort and repeated refresh failure, supersession, rapid repeated intents and reconnect during busy save. Native keyboard tests exercise value/duration/Set/Change/Clear focus order and activation. Pulse labels, semantic heading, 48px targets and visible focus pass in forced colors; 320px reflow, increased spacing, reduced motion and 200% page-scale emulation pass with previous features retained.

Passed 67 Rust and 24 Node/real-WASM tests, fmt, Clippy, release WASM, version consistency, complete Chrome browser suite, PowerShell and WSL POSIX WASM builds and both build/run launchers (page/WASM HTTP 200). Windows x64, Rust 1.93.0, Node 22.12.0, Chrome 154.0.8037.59. Sleep and clock changes are deterministic browser fault injection, not a physical device suspend or OS clock modification. Firefox, Safari, native desktop zoom, NVDA and VoiceOver remain unverified.

## v0.6.0 Since You Last Looked

The catch-up section uses a semantic heading and unordered list, a visible native “Caught up” button, a textual empty state, and no color-only state or per-entry timestamps. Enter/Space operate the button natively; focus moves to the heading if the button disappears after clearing. The global status is polite and cursor-write/refresh errors are assertive. Browser regressions check the 48px target, 320px reflow, forced colors, increased text spacing, reduced motion, focus and 200% page-scale emulation. Screen-reader certification and native desktop zoom are not claimed without direct testing.

## v0.6.1 cursor correctness evidence

The correctness audit covered empty/first/middle/latest cursor cases, exact and conflicting duplicate event IDs, eight/nine-entry caps, and malformed/partial cursor metadata preservation. Browser evidence includes stale-tab monotonicity and preservation of stored metadata on failure. Recorded validation passed 81 Rust tests, 29 Node/real-WASM tests, and the complete Chrome 154.0.8037.95 browser suite; this adds no assistive-technology or other-browser certification. See [V0.6.0](V0.6.0.md) and the [changelog](../CHANGELOG.md).

## v0.6.2 resilience and accessibility evidence

Catch-up quota and transaction-abort tests preserve the cursor and restore focus to the visible control; repeated refresh failure retains the summary and retry state. A pending mark remains busy through reconnect. Keyboard activation, semantic section/heading/list, polite completion and assertive error feedback, textual empty state, focus restoration, 48px target, 320px reflow, forced colors, increased text spacing, reduced motion and 200% Chromium page-scale emulation are checked. No native desktop zoom or assistive-technology certification is claimed.

## v0.6.3 hardening, polish, and cursor recovery evidence

The hardening/polish audit covered summary copy, omitted count, empty state, placement, mobile wrapping, and focus visibility alongside malformed v6 results, truncation boundaries, 10,000-event replay, memory growth, and copied-result lifetime. Commit `45ca041` fixes a committed cursor followed by a failed snapshot reload: the displayed summary is preserved, peers receive content-free invalidation, and retry reloads canonical state without another cursor write. Two-tab recovery and quota/abort no-broadcast regressions preserve the distinction between refresh failure and failed writes.

Recorded revalidation passed 82 Rust tests, 31 Node/real-WASM tests, and the complete Chrome 154.0.8037.95 runner (12 initial scenarios and 21 PASS groups). Existing 320px reflow, forced colors, increased spacing, reduced motion, and 200% Chromium page-scale emulation passed. Firefox, Safari, macOS, native desktop zoom, NVDA, and VoiceOver remain unverified; page-scale emulation is not native zoom and no screen-reader certification is claimed. See [V0.6.0](V0.6.0.md) and the [changelog](../CHANGELOG.md).

## v0.7.0 Routines

Routine capture uses labeled native text/cadence controls, a semantic list and named native actions. Text says Open/Done today or this week. Focus follows the corresponding row action, or returns to capture after archive; quiet periodic refresh does not announce a fabricated household change. Verify keyboard create/complete/reopen/archive, visible focus, 48px targets, forced colors, 320px reflow, spacing and zoom. Actual assistive-technology gaps remain in [V0.7.0](V0.7.0.md).
