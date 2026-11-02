# Calm Reader: spec (working name)

Status: MVP built for ZTM Build Fest. This is the original design; the README describes what shipped.

## Problem

Web pages are hard to read for people who are dyslexic, ADHD or sensitive to clutter. Existing tools are mostly font toggles. They don't help when the text itself is dense or confusing.

## Solution

A browser extension that does two things:

1. **Reading profiles** (no AI, works offline): one-click presets that restyle the page.
2. **Simplify** (AI, optional): rewrites selected text or the page in plain language, using the user's own API key.

## Principles

- Simple: install, optionally paste a key, click.
- Private: no backend, no account, no analytics. Text leaves the browser only when the user presses Simplify, and goes only to the provider they chose.
- Useful without AI: profiles work with no key.
- Open source (MIT).

## Users

- People with dyslexia, ADHD or sensory sensitivity.
- Anyone who finds long or jargon-heavy pages tiring.

## Features

### MVP (must ship)

| # | Feature | Detail |
|---|---|---|
| 1 | Popup | Profile picker, on/off toggle, "Simplify" button, link to settings |
| 2 | Profiles | **Dyslexia**: Atkinson Hyperlegible or OpenDyslexic, wider letter and line spacing, left-aligned, about 65ch line width, warm off-white background. **ADHD**: narrower column, larger text, highlight the current paragraph on hover, hide sticky bars and pop-ups. **Calm**: muted colours, no animation, autoplay media paused, ads and overlays hidden. |
| 3 | Settings page | Provider (Anthropic or OpenAI), API key, model name, a "test key" button. Stored in `chrome.storage.local`. |
| 4 | Simplify | Uses the selected text, or the main article text if nothing is selected. Result shows in a side panel: a short TL;DR, then the plain-language version. |
| 5 | Errors | Clear messages for missing key, bad key, rate limit, network failure, and text that is too long. |

### Stretch (only if time remains)

- Reading ruler (a line that follows the cursor).
- Tiny breathing circle in the popup.
- Per-site memory of the chosen profile.
- Firefox build.

### Out of scope

Accounts, sync, analytics, in-place page rewriting, mobile, custom font uploads.

## How it works

- **Manifest V3**, TypeScript, no UI framework. Bundle with esbuild or Vite.
- **Content script**: injects or removes a `<style>` element for the active profile, extracts main text for Simplify (a lightweight readability-style extractor, or Mozilla Readability), and renders the side panel in a shadow root so page CSS can't break it.
- **Service worker**: makes the API call, so the key never enters page context. The content script only sends text and receives the result by message.
- **Storage**: `chrome.storage.local` for the key and settings. `chrome.storage.sync` is not used for the key.
- **Permissions**: `storage`, `activeTab`, `scripting`. Host permission only for the chosen provider's API origin.

### Simplify prompt (sketch)

System: "Rewrite the text in plain language at about a 7th-grade reading level. Keep every fact, number, name and instruction. Do not add information. Start with a one-sentence TL;DR. Use short sentences and short paragraphs."

Safeguards: the page text is passed as data, not instructions. The panel renders the result as plain text, never as HTML. Truncate over a set token limit and tell the user.

## AI use (for the README)

- The user's own model rewrites text on demand.
- It is bring-your-own-key, so there is no cost or data pipeline for the project.
- AI was also used to help write the code (state this honestly in the README).

## Accessibility of the extension itself

Keyboard operable, visible focus, proper labels, sufficient contrast, respects `prefers-reduced-motion`.

## Risks

| Risk | Mitigation |
|---|---|
| Profiles break some sites | Keep CSS to safe properties, add a per-site off switch |
| Key exposure | Service worker only, never logged, plain-language note in settings |
| Text extraction misses content | Fall back to selection, let the user select manually |
| Provider API changes | One small adapter per provider |

## Plan

| Days | Work |
|---|---|
| 1–2 | Manifest, build, popup, settings, key storage |
| 3–5 | Three profiles and live toggle |
| 6–8 | Extraction, service worker call, side panel |
| 9–10 | Error handling, polish, accessibility pass, stretch items if time |
| 11–12 | README, MIT LICENSE, demo GIF, PR to `projects/calm-reader/` |

## Definition of done

- Fresh clone, `npm install && npm run build`, load unpacked, and it works.
- All three profiles toggle on common sites (news, Wikipedia, a docs site).
- Simplify works end to end with at least one provider.
- README covers the problem, install, how AI was used, and privacy.
- LICENSE present. PR opened against the Build Fest repo with changes only in the project folder.

## Open questions

- Which provider first? Suggest Anthropic, with OpenAI as a second adapter if time allows.
- Final name.
- Atkinson Hyperlegible only, or both fonts?
