# Calm Reader

A small browser extension that makes web pages easier to read for people with dyslexia, ADHD or sensory sensitivity. Built for ZTM Build Fest.

## The problem

Web pages are cluttered and dense. Most helper tools only swap the font. Calm Reader also hides pop-ups and distractions, and can rewrite hard text in plain language.

## What it does

1. **Reading profiles** (work offline, no key needed)
   - **Dyslexia**: Atkinson Hyperlegible font, wider letter and word spacing, a warm background, a comfortable line length.
   - **ADHD**: narrower column, larger text, a highlight on the paragraph under your cursor, pop-ups and overlays hidden.
   - **Calm**: muted colours, no animation, autoplay media paused, ads and pop-ups hidden.
   - A per-site "off" switch for pages a profile doesn't suit.
2. **Simplify** (needs your own API key)
   - Select some text, or use the whole page, and press **Simplify this page**.
   - A side panel shows a one-line "In short" and a plain-language version.

## Install

Needs Node 20 or later.

```bash
git clone https://github.com/zero-to-mastery/ZTM-Build-Fest.git
cd ZTM-Build-Fest/projects/calm-reader
npm install
npm run build
```

Then, in Chrome, Edge or Brave:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `dist/` folder.
3. Pin the Calm Reader icon, tick **Use a reading profile**, and pick one.

Tabs that were already open need a reload before the extension works in them.

## Using Simplify

1. Open the extension's **Settings and API key** link.
2. Pick Anthropic or OpenAI, paste your key, and press **Save and test key**. The browser asks you to allow access to that provider only.
3. On any page, press **Simplify this page**.

The default models are `claude-haiku-5-5` (Anthropic) and `gpt-4o-mini` (OpenAI). You can enter a different model name in settings.

## Privacy

- Your key is stored in this browser (`chrome.storage.local`) and is only used by the extension's background worker.
- There is no Calm Reader server, no account and no analytics.
- Page text leaves your browser only when you press Simplify, and only goes to the provider you chose.
- You pay your provider directly. Long pages are cut at about 18,000 characters.
- The content script runs on all sites because restyling a page needs that. It only changes styles unless you press Simplify.

## How AI was used

- **In the product:** your chosen model rewrites text into plain language. The prompt keeps every fact and number, and treats the page text as content to rewrite, not as instructions. Output is written to the panel as plain text, never as HTML.
- **In the build:** the code was written with the help of Claude (Anthropic) and tested with a headless-browser smoke test.

## Development

```bash
npm run typecheck   # TypeScript check
npm run build       # bundle into dist/
node build.mjs --watch
```

Layout: `src/content.ts` (profiles, text extraction, panel), `src/background.ts` and `src/provider.ts` (API calls), `src/popup.ts`, `src/options.ts`, `static/` (manifest, HTML, CSS, icons). See `SPEC.md` for the design.

## Known limits

- Chromium browsers only for now (Chrome, Edge, Brave). A Firefox build is not done.
- Profiles are CSS overrides, so some sites will look off. Use the per-site off switch.
- Overlay hiding is a heuristic: it hides fixed-position elements that aren't a short bar at the top of the page.
- Simplify results depend on the model and can still make mistakes. Check anything important against the original.

## Licence

MIT. The Atkinson Hyperlegible font is bundled under the SIL Open Font License 1.1 (see `dist/fonts/LICENSE.txt` after a build). Text extraction uses Mozilla Readability (Apache-2.0).
