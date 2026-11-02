# Web sandbox capabilities

Status: implemented. Extends the `web runnable` lesson runner (`web/components/ob-web-sandbox.js`)
so self-contained browser lessons that previously needed CodePen can run in the article.

## Problem

The sandbox ran authored HTML, CSS, and JavaScript in an opaque-origin iframe with only
`allow-scripts` and a CSP that blocked everything external. That kept lessons private and
inert, but it also broke ordinary teaching material:

- `console.log` output had nowhere to go, so console-driven examples showed a blank preview.
- Forms never fired `submit` (the sandbox lacked `allow-forms`), and `alert`/`confirm`/`prompt`
  were silently dropped.
- `localStorage` and `sessionStorage` threw `SecurityError` in the opaque origin.
- Scripts ran as classic scripts, so `import`/`export` syntax and top-level `await` failed.
- Blob workers and `AudioWorklet` modules were blocked by the CSP.
- Lessons that call a public HTTPS API, show remote images, or use a UI library could not run.

## Always-on behavior (no new risk)

| Capability | Mechanism | Boundary kept |
| --- | --- | --- |
| Console panel | A bootstrap script forwards `console.*`, uncaught errors, and unhandled rejections to the host with `postMessage`; the host renders them as text in a log below the preview. | Messages are accepted only from that preview's `contentWindow` and rendered with `textContent`; output is capped. |
| Forms | `allow-forms` | CSP `form-action 'none'` still blocks every real submission, so only in-page `submit` handlers run. |
| Dialogs | `allow-modals` | Dialogs belong to the preview; no navigation or popups. |
| Storage | In-memory `localStorage`/`sessionStorage` installed when the real ones throw. | Nothing persists past the preview; no access to the host origin's storage. |
| Workers | CSP `worker-src blob:` and `blob:` in `script-src` (worklets load through `script-src`). | Only code the lesson itself created; still no network. |
| Local media | `media-src data: blob:` | No remote media. |
| `eval` and WebAssembly | `'unsafe-eval'` and `'wasm-unsafe-eval'` in `script-src` | Adds nothing beyond inline script inside the opaque origin; feature-detection lessons depend on it. |

## Opt-in fence options

Written after `web runnable`, e.g. ```` ```web runnable module network title="Try it" ````.

| Option | Effect | Reader-facing disclosure |
| --- | --- | --- |
| `module` | Runs the JavaScript as `<script type="module">` (import/export syntax, top-level `await`). Bare or relative imports still have nothing to load. | none |
| `network` | CSP `connect-src https:` so `fetch`/XHR/WebSocket can reach HTTPS APIs. | Warning states that the preview may contact external HTTPS services. |
| `images` | CSP `img-src https:` in addition to `data:`/`blob:`. | Warning states that the preview may load external images. |
| `libs=a,b` | Inlines site-hosted library files configured under `webSandbox.libraries` before the lesson script, in order. | none (files come from the blog itself) |

The sandbox stays opaque-origin in every mode: no cookies, no host storage, no host DOM.
Unknown options are ignored like other fence options; an unknown `libs` name is a build error.

## Site-hosted libraries

```json
"webSandbox": {
  "libraries": {
    "react": ["/vendor/react.production.min.js", "/vendor/react-dom.production.min.js"]
  }
}
```

Paths must be root-relative files the site serves (usually under `static/`). The page fetches
them same-origin and inlines their text into the preview, so the preview needs no network and
the files need no CORS headers. Each file is emitted as `<link rel="preload" as="fetch">` inside
the sandbox element so it downloads early and receives the site base path like any other URL.
open.blog bundles no libraries; a site vendors the exact builds it wants and keeps their licenses.

## Portable output

Unchanged: feeds and cross-posted copies show the HTML, CSS, and JavaScript as static code with a
link to the live preview. Options and library links are not emitted there.
