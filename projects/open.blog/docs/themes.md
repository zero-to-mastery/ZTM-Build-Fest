# Themes and the design system

A theme is a folder in `themes/<name>/` with a `theme.json`. The renderer emits the
same semantic HTML for every theme. A theme changes the look in three layers, from
cheapest to most powerful:

1. **Tokens** in `theme.json`: colours, fonts, sizes, radii. They compile to CSS
   custom properties (`--ob-*`) in a generated `tokens.css`.
2. **Options** in `theme.json`: small rendering switches (code-label headings, a heading
   wrapper element for the theme's own effect, navigation label template, list style, post
   covers, code highlighting).
3. **A stylesheet** (`theme.css`, listed under `stylesheets`) for anything tokens can't
   express. Scope its rules with `[data-ob-theme="<name>"]`.

`web/base.css` holds structure only and reads nothing but tokens, so a theme that
overrides a handful of values is a complete theme.

## theme.json

```jsonc
{
  "label": "Shown in theme lists",
  "extends": "base",            // inherit everything, override what differs
  "colorScheme": "dark",        // scheme used when the visitor has no preference
  "colors": {
    "dark":  { "page": "#111418", "text": "#eceff4", "accent": "#7aa2ff" },
    "light": { "page": "#ffffff", "text": "#14171c", "accent": "#2457d6" }
  },
  "fonts": {
    "body": "\"Inter\", system-ui, sans-serif",
    "heading": "\"Fraunces\", Georgia, serif",
    "mono": "ui-monospace, monospace",
    "faces": [                                     // font files you place in the theme folder
      { "family": "Inter", "src": "fonts/Inter.woff2", "format": "woff2" },
      { "family": "Fraunces", "src": "fonts/Fraunces-Bold.woff2", "format": "woff2", "weight": "700" }
    ]
  },
  "tokens": { "maxWidth": "70rem", "radius": "12px", "headingWeight": "400" },
  "options": {
    "headingCodeLabels": true,
    "headingWrapper": "my-effect",      // wrap titles in your own custom element
    "navLabel": "//{index}. <{label}/>",
    "listStyle": "rows",
    "postCovers": true
  },
  "stylesheets": ["theme.css"],
  "scripts": ["effect.js"]              // ES modules the theme ships, e.g. web components
}
```

Every key under `colors.<scheme>` becomes `--ob-color-<kebab-name>`; every key under
`tokens` becomes `--ob-<kebab-name>`. Add your own and use them in `theme.css`.

A font face takes `family`, `src` (relative to the theme folder), and optionally `format`,
`weight` (default `400`), `style` (default `normal`), `display` (default `swap`), and
`unicodeRange`. Declare one entry per file, so a bold or italic face is its own entry.
Relative `src`, `stylesheets`, and `scripts` paths resolve against the theme folder.
A theme's scripts are linked on every page that uses it; see
[Adding web components to a theme](theme-components.md) and the `demo` theme.

### Colour tokens `base.css` uses

`page`, `outer`, `surface`, `surfaceRaised`, `text`, `muted`, `subtle`, `border`,
`accent`, `accentSoft`, `accentBorder`, `accentContrast`, `link`, `glow`, `codeBg`,
`codeText`, `ink` (text drawn on top of the accent fill), and the syntax highlighting
colours `codeKeyword`, `codeString`, `codeComment`, `codeNumber`, `codeFunction`,
`codeType`, `codeAttr`, `codeTag`, `codeMeta`, `codeVariable`, `codeProperty`,
`codeOperator`, `codePunctuation`, `codeConstant`, `codeRegex`. The last five are
optional: a theme without them falls back to `codeAttr`, `codeVariable`, the code
text colour, `codeNumber`, and `codeString`. Callouts use `calloutNote`, `calloutTip`,
`calloutImportant`, `calloutWarning`, and `calloutCaution` for their accent colour.

### Other tokens

`maxWidth`, `readingWidth` (the article column; text, code, tables, and embeds all share it), `gutter`, `radius`, `radiusSm`, `borderWidth`, `bodySize`,
`bodyLeading`, `headingLeading`, `headingWeight`, `headingTransform`, `headingTracking`,
`titleSize`, `sectionTitleSize`, `rowTitleSize`, `shadow`, `focusRing`, `rowBorderWidth`,
`hoverText`, `motion`. The full defaults are in `themes/base/theme.json`.

### Options

| Option | Effect |
| --- | --- |
| `colorSchemeToggle` | Show the header light/dark toggle and restore its saved choice (default `true`). Set `false` to follow the system preference without a manual override |
| `headingCodeLabels` | Wrap page and section titles in dim `<h1>` / `</h1>` (or `<h2>` / `</h2>`) labels, a code-themed look |
| `headingWrapper` | Custom element name to wrap page and section titles in, for a theme's own effect (see [theme-components.md](theme-components.md)) |
| `navLabel` | Template for nav text; `{index}` is 01, 02, ... and `{label}` the link text |
| `listStyle` | `rows` (compact, hover fill) or `cards` (cover images) |
| `postCovers` | Show the cover image on the post page |
| `codeHighlighting` | Colour code blocks with the built-in highlighter (`codeKeyword`, `codeString`, ... colour tokens); off when the theme brings its own |
| `codeLineNumbers` | Number the lines of code blocks with two or more lines (default `true`). The numbers are never copied with the code |

## Look controls

Site owners can change the look from Admin by choosing presets (never CSS): an accent color, a curated
palette, a font style, text size, corner roundness, spacing, page width and heading weight. The engine
compiles those choices into a short block of `--ob-*` tokens appended to your theme's `tokens.css`, so
they layer over whichever theme a page uses.

A theme says which controls it honors with `customizable` in `theme.json`:

```json
{ "extends": "base", "customizable": ["accent", "roundness", "textSize"] }
```

The valid names are `accent`, `palette`, `fontStyle`, `textSize`, `roundness`, `spacing`, `pageWidth` and
`headingWeight`. Omit it and the theme inherits its parent's list (`base` honors all of them); `[]` opts out
of every control. Admin shows only the controls the active theme honors and explains the rest, and the build
compiles only those, so list a control only when your theme's own stylesheet does not set the tokens it
changes (for example `--ob-radius` for `roundness`, or `--ob-color-accent` for `accent`), because the
owner's block loads before your extra stylesheets.

### How the owner's look layers over your tokens

The cascade is: the `base` tokens, then your theme's `tokens.css`, then the owner's compiled block (only the
controls you list in `customizable`), then your theme's extra stylesheets. The block sets nothing but
allowlisted tokens: `--ob-color-*` for the accent and palette (the accent is adjusted for WCAG AA contrast in
light and dark, and more strictly for visitors who ask for higher contrast), `--ob-font-body`,
`--ob-font-heading`, `--ob-text-scale`, `--ob-radius` and `--ob-radius-sm`, `--ob-space-*`, `--ob-max-width`,
`--ob-reading-width` and `--ob-heading-weight`. Nothing an owner types can reach the stylesheet. A theme with
no `customizable` list inherits its parent's, and a site with no `appearance` builds byte for byte as before.
To style the landing page's own sections, see [the `ob-home-*` classes](theme-components.md#styling-the-landing-page).

## Light and dark

Both schemes are compiled. The theme's `colorScheme` is the default, the other scheme
applies through `prefers-color-scheme`, and the header toggle (`<ob-theme-toggle>`)
overrides both and remembers the choice.

Set `options.colorSchemeToggle` to `false` to omit the toggle and ignore previously
saved overrides before first paint. The CSS follows system preference changes live,
including without JavaScript. This option is inherited and can be re-enabled by a
child theme.

## Different themes for different series

Resolution order for a post: its own `theme:` front matter, then its series' theme, then
the site `theme` in `openblog.json`.

```markdown
---
# content/series/getting-started.md  (the file name is the series slug)
name: Getting started
theme: paper
---
```

Every post in that series, and the series page itself, then render with `paper`. A single
post can override with `theme:` in its own front matter. Pages work the same way. On the
home page, each series card carries `data-ob-theme="<its theme>"`, so a theme's own
stylesheet can style the cards that lead to it.

## Reproducing the look of a site you already have

A theme is the place to carry an existing design over. Copy the colours from the site's
stylesheet into `colors.light` and `colors.dark`, name its fonts in `fonts` (with
`@font-face` entries under `faces` for files you ship in the theme folder), and set
`tokens` such as `maxWidth`, `radius`, `headingWeight`, and `headingTransform`. The
`headingCodeLabels` and `navLabel` options cover two common "developer site" touches,
and anything structural goes in `theme.css`. A heading animation or other behaviour
becomes a web component the theme ships; see
[Adding web components to a theme](theme-components.md).

Check the licences of any fonts before publishing them in a theme.

## Keeping a theme private

A theme can live in the blog's repository, in a private repository, or be copied in at
build time. If you publish your blog's source but not its theme, add the theme folder to
`.gitignore`. A build in CI then needs the theme from somewhere else: check it out from a
private repository in a workflow step, or build locally and upload `dist/`. See
[Deploying](deploy.md).

## Making a theme

1. Create `themes/mytheme/theme.json` with `"extends": "base"`.
2. Override a few colours and fonts. Run `openblog serve`; edits rebuild instantly.
3. Set it as `theme` in `openblog.json`, or per series/post in front matter.
4. `openblog themes` lists every theme and its inheritance chain.

The WebAssembly module also exports `themeCss(themesJson, name)`, which compiles a theme
in the browser with the exact code the build uses. It is the basis for a live theme editor.
