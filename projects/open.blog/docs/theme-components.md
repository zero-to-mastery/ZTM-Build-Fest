# Adding web components to a theme

A theme is not limited to tokens and CSS. It can ship JavaScript, and it can ask the
renderer to wrap every heading in a custom element of its own. That is how a theme adds a
heading effect (typing, revealing, glitching, whatever you like) without touching the
engine. The open-source engine ships no effects; `themes/demo/` is a worked example to copy.

## The two hooks

```jsonc
// themes/<name>/theme.json
{
  "extends": "base",
  "options": {
    "headingWrapper": "demo-reveal"     // a custom element name (must contain a hyphen)
  },
  "scripts": ["reveal.js"],             // ES modules, relative to the theme folder
  "stylesheets": ["theme.css"]
}
```

- **`scripts`** are copied with the theme and linked on every page that uses it, after
  the engine's own `openblog.js`, as `<script type="module">`. Any theme in the `extends`
  chain contributes its scripts, parents first.
- **`options.headingWrapper`** makes the renderer emit each page or section title as
  `<h1 class="ob-title"><demo-reveal>Title</demo-reveal></h1>` instead of plain text. The
  wrapper is applied to page and section titles only, not to headings inside post bodies.
  Leave it unset and titles stay plain.

Because the element wraps text that is already in the HTML, the page is complete before
JavaScript runs, and search engines and feed readers see ordinary headings.

## Styling the landing page

When a site has a landing page, each section is written as
`<section class="ob-section ob-home-section ob-home-<type>" id="ob-home-<id>">`. The page has one `<h1>` (the
first heading) and `<h2>` for the rest. The engine styles these classes with the `--ob-*` tokens, so most
themes need nothing; a theme may restyle them.

- Structure: `ob-home-section`, `ob-home-title`, `ob-home-lede`, `ob-home-welcome` and `ob-home-welcome-hook`,
  `ob-home-actions`, `ob-home-all`, `ob-home-link`, `ob-home-note`, `ob-home-place`.
- Section types: `ob-home-rich-text`, `ob-home-latest-posts`, `ob-home-series`, `ob-home-featured-post`,
  `ob-home-buttons`, `ob-home-image` and `ob-home-figure`, `ob-home-video`, `ob-home-map`,
  `ob-home-opening-hours` and `ob-home-hours`, `ob-home-contact`, `ob-home-social-links` and `ob-home-social`,
  `ob-home-faq` and `ob-home-faq-item`, `ob-home-business-facts`.
- Buttons: `ob-home-button` with `ob-home-button-primary` or `ob-home-button-secondary`.
- Call-outs: `ob-home-callout`, `ob-home-callout-box`, `ob-home-callout-title` and the kind classes
  `ob-home-callout-info`, `ob-home-callout-success` and `ob-home-callout-warning`.

The classes are a stable hook, not a promise about the markup inside them. Keep text contrast at WCAG AA and
focus rings visible when you restyle buttons and links.

## Styling business facts

The business facts (`business` in `openblog.json`, [Configuration](configuration.md#business-facts)) are written by
the engine as one block, `ob-business`, in two places: the footer of every page (inside
`<section class="ob-footer-business" aria-label="Business details">`) and the Landing page's Business facts section.
The engine styles it in `base.css` with `--ob-*` tokens, so a theme gets it with no markup or CSS of its own and
restyles it by changing tokens or by overriding the hooks. Do not rebuild the markup in a theme: the same block
must read the same on every page.

- Block: `ob-business`, `ob-business-name`, `ob-business-badge` with `ob-badge` (the "Licensed and insured" badge).
- Contact: `ob-business-contact` (a list with `ob-business-phone` and `ob-business-email`).
- Hours: `ob-business-hours`, a `dl` with one `div` per run of days; closed days read "Closed".
- Notes: `ob-business-notes` (license and issuer, accepted payment kinds, the year founded).

A site with no business facts writes none of these.

## Styling before and after pairs

A `compare` fence in a post (see [Content](content.md#before-and-after)) renders as one component:

```html
<ob-compare class="ob-compare">
  <figure class="ob-compare-pane ob-compare-before"><img src alt><figcaption><span class="ob-compare-label">Before</span>: caption</figcaption></figure>
  <figure class="ob-compare-pane ob-compare-after"><img src alt><figcaption>…</figcaption></figure>
</ob-compare>
```

Without JavaScript, and for a reader who prefers reduced motion, the two figures sit side by side (one above the other on
a narrow screen). Where the element runs it adds `data-enhanced`, moves the pictures into a `.ob-compare-stage` with a
native range input (`.ob-compare-range`, arrow keys, Home and End all work), a `.ob-compare-bar` with a
`.ob-compare-knob`, and two `.ob-compare-tag` labels; the captions stay below. It keeps nothing and asks for nothing.

Every bundled theme gets this from `web/base.css` through the tokens it already has, so a theme needs nothing. To
restyle it, set these custom properties on `ob-compare` or on `:root` in a theme stylesheet:

| Token | Default | What it sets |
| --- | --- | --- |
| `--ob-compare-radius` | `--ob-radius` | Corners of the pictures and the stage |
| `--ob-compare-gap` | `--ob-space-4` | Space between the two figures in the side-by-side layout |
| `--ob-compare-line` | `#fff` | The dividing line and the knob's border |
| `--ob-compare-line-width` | `2px` | Width of the dividing line |
| `--ob-compare-handle` | `--ob-color-accent` | The knob's fill |
| `--ob-compare-handle-ink` | `--ob-color-accent-contrast` | The arrow on the knob |
| `--ob-compare-handle-size` | `2.75rem` | The knob's diameter; keep it at least 2.75rem for touch |
| `--ob-compare-focus` | `--ob-color-accent` | The ring around the knob while the control has keyboard focus |
| `--ob-compare-tag-bg`, `--ob-compare-tag-ink` | translucent black, white | The Before and After labels on the picture |

The component sets `--ob-compare-pos` (the reveal, `0%` to `100%`) and `--ob-compare-ratio` (the first picture's shape);
leave those alone. Keep the line and knob visible against light and dark pictures, and the focus ring at 3:1 or better.

## Try the demo

`openblog init` writes the `demo` theme (and `paper`) into your blog's `themes/` folder,
so it is there to try and to copy. In an older blog without it, copy `themes/demo/` from
the open.blog repository.

```sh
openblog serve
```

Set `"theme": "demo"` in `openblog.json`, or give one series `theme: demo` in its front
matter to see the effect on that series only. Every title's words rise into place when the
heading scrolls into view. The whole effect is three small files in `themes/demo/`:

- `theme.json` declares the wrapper element and the script.
- `reveal.js` defines `<demo-reveal>` in about forty lines.
- `theme.css` holds the transition the element toggles.

## Writing your own

Copy `themes/demo/` to `themes/<yours>/`, rename the element (names must contain a hyphen,
and a short prefix of your own avoids clashes with other themes), and change what
`connectedCallback` does. The rules that keep an effect from degrading the page:

1. **The text is already there.** Read `this.textContent`; never fetch or reconstruct it.
2. **Keep an accessible copy.** Screen readers should get the heading as text, not as a
   stream of animated spans. The demo appends a visually hidden span with the full text
   and marks the animated copy `aria-hidden="true"`.
3. **Respect reduced motion.** Check `matchMedia("(prefers-reduced-motion: reduce)")` first
   and return without changing anything.
4. **No layout shift.** Reserve the heading's final size before animating. The demo
   animates `opacity` and `transform` only, which never move surrounding content. A
   typing effect needs a hidden full-width copy underneath the growing visible text.
5. **Start on view, once.** Use an `IntersectionObserver` so an effect far down the page
   waits until it is seen, and mark the element done so re-connection does not replay it.
6. **Guard the definition.** Wrap `customElements.define` in `if (!customElements.get(...))`
   so loading the script twice (for example from two themes in a chain) is harmless.
7. **Clean up.** Disconnect observers and clear timers in `disconnectedCallback`.

## Sketch of a typing effect

A typewriter is a reveal that adds characters over time instead of toggling a class. The
shape of such an element:

```js
class XTypewriter extends HTMLElement {
  connectedCallback() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const full = this.textContent;
    // 1. accessible copy (visually hidden) with the full text
    // 2. an invisible sizer with the full text, so the box is final size at once
    // 3. a positioned, visible span that grows by one character every ~35 ms
    //    once an IntersectionObserver reports the heading is on screen
    // 4. a CSS rule such as `x-typewriter[typing]::after { content: "_" }` for a cursor
  }
}
```

The behaviour lives in the theme, so a blog that switches themes loses the effect and
gains whatever the next theme brings. That is the point: effects are a theme's identity,
not the engine's.

## Beyond headings

A theme script is an ordinary module and can define any number of elements, register
event listeners, or enhance other parts of the page by class name (`.ob-row`,
`.ob-card`, `.ob-prose`, see `web/base.css` for the full set). The heading wrapper is the
only place where the engine changes its markup for a theme; everything else is reached by
selector from your script and stylesheet.
