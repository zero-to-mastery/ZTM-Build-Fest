# Writing content

Everything on the site comes from Markdown files under `content/`:

```
content/posts/     one file per post
content/series/    one file per series (optional)
content/pages/     one file per page, such as About (optional)
content/services/  one file per service, for trades and local businesses (optional; see [Services](services.md))
```

Files anywhere in `content/posts/` are posts, including in subfolders. A `README.md`, and
any file or folder whose name starts with `_` (such as `content/posts/_notes.md` or
`content/posts/_ideas/`), are ignored, so you can keep notes beside your posts.

## Posts

A post is Markdown with a front matter block between `---` lines:

```markdown
---
title: Writing a post
date: 2026-01-12
tags: [guide, markdown]
description: What goes in a post file and which Markdown features work.
---

The body starts here.
```

Only `date` is required (a draft may omit it), plus a `title` unless the body starts with
a `#` heading, which is then used. Everything else is optional:

| Field | Meaning |
| --- | --- |
| `title` | The headline. If missing, the first `#` heading in the body is used. |
| `subtitle` | An optional one-line subheading shown under the title. Plain text; line breaks become spaces. Also accepted as `subheading` or `dek`. Separate from `description`, which is for search and feeds. |
| `date` | `YYYY-MM-DD` (midnight UTC) or a full time such as `2026-01-12T09:30:00Z` or `2026-01-12T09:30:00-05:00`. A future date **schedules** the post. |
| `updated` | When the post was last revised. Shown on the page and used in feeds. |
| `slug` | The address part. Defaults to the file name without a leading `YYYY-MM-DD-`. |
| `tags` | A list (`[a, b]` or one per line with `- `). Matched case-insensitively. |
| `series` | The slug of a series this post belongs to. |
| `seriesOrder` | Position within the series. Without it, parts are ordered by date. |
| `description` | A sentence or two for feeds, search results, and social cards. Defaults to an excerpt. |
| `cover` | Image shown at the top and used as the social card. Defaults to the first image in the body. |
| `coverAlt` | Alternative text for the cover. |
| `draft` | `true` keeps the post out of every build and feed. |
| `comments` | `open` (default), `locked` (read-only), or `hidden` when hosted comments are enabled. |
| `participation` | This post's mode for reader participation beyond comments, as `kind: mode` entries: `participation: [question: open, third-perspective: locked]`, or one `- kind: mode` per line. Modes are `open`, `locked` and `hidden`, as for `comments`. A kind only takes effect once the site switches it on; see [Reader participation](configuration.md#reader-participation). |
| `theme` | A theme name, to render this post differently from the rest. |
| `canonical` | If the post was first published elsewhere, that address. Search engines then credit the original. |
| `sourceUrl` | Shown as "Originally published at" under the post. The Hashnode importer fills this in. |
| `guidingQuestion`, `sharedSourceTitle`, `sharedSourceUrl`, `sharedSourceType` | Shared-reflection attribution: the guiding question and the original source's title, HTTP(S) link, and type (`Video`, `Article`, `Podcast`, `Book`, or `Other`), shown beside the post and in feeds and exports. The title is required with a link or type; the source is always a link, never an embed. |
| `aliases` | Old addresses that should redirect here, such as `[/old-slug/]`. Also accepted as `redirectFrom`. Works on posts, pages and series pages (a series page in `content/series/`). The engine always writes a redirect page; set `redirectsFile: true` in `openblog.json` to also write a `_redirects` file with real 301s on hosts that read one. |
| `highlight` | `false` turns off code colouring for this post; `true` turns it on. Overrides the site and theme. |
| `lineNumbers` | `false` or `true`: line numbers on this post's code blocks. Overrides the site and theme. |
| `profile` | Authoring and publishing behavior for this post. Defaults to `article`; built-ins also include `recipe`, `research`, `video`, `field-journal`, and `job`. |
| `recipe` | Legacy recipe marker. `true` remains supported; new posts should use `profile: recipe`. |
| `doi` | Research profile only. A DOI name or `https://doi.org/` URL for this work. |
| `license` | Research profile only. An absolute HTTP or HTTPS URL for the work's license. |
| `citations` | `notes` or `bibliography` publishes the post's `[@key, locator]` citations from the private source library as numbered notes or a reference list. Without it, `[@...]` stays text. See [Research posts](research-profile.md#citations-notes-and-bibliographies). |
| `citationLocale` | With `citations`: `en`, `de`, `fr` or `es` for the generated notes. Defaults to the site language when it is one of those, otherwise English. |
| `videoUrl` | Video profile only. A YouTube watch, short-link, or Shorts URL. |
| `duration` | Video profile only. A duration such as `12 min 34 sec`, `12:34`, or `PT12M34S`. |
| `thumbnail` | Video profile only. A site-relative or absolute video thumbnail URL. A `cover` is used as the fallback. |
| `aiDisclosure` | Video profile only. Creator-authored disclosure of meaningful AI assistance. |
| `productionStatus` | Video profile only. `idea`, `scripting`, `storyboarding`, `generating`, `editing`, `scheduled`, or `released`. |
| `seasonNumber`, `episodeNumber` | Video profile only. Optional production sequence numbers. |
| `productionCredits` | Video profile only. Concise writing, direction, animation, or editing credits. |
| `activity`, `location` | Field-journal profile only. The activity and a deliberately publishable area name. |
| `locationPrivacy` | Field-journal profile only. `hidden`, `trimmed`, `approximate`, or `exact`; defaults to `hidden`. |
| `distanceKm`, `elevationGainM` | Field-journal profile only. Route measurements, entered manually or derived from GPX. |
| `conditions` | Field-journal profile only. Creator-observed trail, water, weather, or habitat conditions. |

Unknown fields are kept and ignored, so you can store your own notes in the front matter.

### Content profiles

Content profiles add field-specific authoring and rendering behavior to a post without
changing its basic document type. A normal post uses `article` automatically. Select a
profile in the admin's **Settings** view or write it directly:

```yaml
profile: recipe
```

The built-in profiles are `article`, `recipe`, `research`, `video`, `field-journal`, and `job`. Existing `recipe: true`,
`type: recipe`, `layout: recipe`, and `kind: recipe` files continue to work. When both a
canonical `profile` and a legacy recipe marker exist, `profile` wins and the build warns
if they disagree.

An unrecognized profile id is preserved rather than deleted or rewritten. The post renders
with ordinary article behavior, and `openblog check`, builds, and admin previews report a
warning so the missing profile can be installed or corrected later.

The `research` profile adds visible DOI and license details, `ScholarlyArticle` structured
data, conservative scholarly HTML metadata, and deterministic evidence checks. Citations
remain ordinary Markdown links and footnotes under a visible `References` or `Bibliography`
section. See [Research posts and Evidence Studio](research-profile.md) for the complete
authoring contract and limits.

The `video` profile turns a YouTube production into a creator-owned companion page with a
privacy-enhanced embed, `VideoObject` structured data, transcript-friendly Markdown, and an
Admin release kit for validating chapters and composing reusable YouTube copy. See
[Video productions and release kits](video-production.md).

The `field-journal` profile adds field facts and offline GPX analysis with private-by-default
route publication. See [Field journals and private-by-default tracks](field-journal.md).

The job profile records one piece of finished trade work (flooring, excavation, auto body, and so on) as an ordinary post. See [Jobs](jobs.md).

The admin editor's **Search & answer readiness** checklist updates while you write. The
same conservative checks run during a build and warn about weak descriptions, unusually
long titles or descriptions, and covers without alternative text. They are editorial
prompts, not a made-up SEO score and not a guarantee of placement.

### Work-specific credits

Posts inherit the site-level `author` by default. To publish multiple authors, editors,
translators, or CRediT contributions, first register each person in `openblog.json`:

```json
{
  "contributors": {
    "ada-lovelace": {
      "name": "Ada Lovelace",
      "url": "https://example.com/ada",
      "sameAs": ["https://social.example/@ada"],
      "orcid": "0000-0002-1825-0097"
    }
  }
}
```

Then add a versioned JSON file beside the post. For `content/posts/analysis.md`, use
`content/posts/analysis.credits.json`:

```json
{
  "version": 1,
  "credits": [
    {
      "contributor": "ada-lovelace",
      "roles": [
        { "vocabulary": "crossref", "role": "author" },
        { "vocabulary": "credit", "role": "software" }
      ]
    }
  ]
}
```

Credit order and role order are preserved. Only `crossref:author` appears in the byline,
research `citation_author` metadata, and per-item feed authors; every credited person and
role appears in the visible Contributions panel. JSON-LD separates ordered authors from
other contributors. An explicit empty `credits` array suppresses inherited authorship.
Contributor profile `url` values must be complete HTTP(S) URLs or site-root paths beginning
with `/`; `sameAs` values must be complete HTTP(S) URLs. Executable and protocol-relative
schemes are rejected during configuration load. Admin Studio's **Site → Contributors**
workspace manages this registry with conflict-aware saves, stable IDs, and deletion guards;
editing `openblog.json` directly remains supported.

Accepted Crossref roles are `author`, `corresponding-author`, `editor`, `chair`, `other`,
`reviewer`, `review-assistant`, `reviewer-external`, `stats-reviewer`, `reader`, and
`translator`. Accepted CRediT roles are `conceptualization`, `data-curation`,
`formal-analysis`, `funding-acquisition`, `investigation`, `methodology`,
`project-administration`, `resources`, `software`, `supervision`, `validation`,
`visualization`, `writing-original-draft`, and `writing-review-editing`.

An ORCID iD entered in configuration is checksum-validated and normalized to its full HTTPS
URL, but remains manual and unauthenticated. Public pages label it `(unauthenticated)`; the
configuration format cannot claim OAuth provenance. See the
[contributor identity decision](adr/0003-contributor-identity-and-orcid-provenance.md) for
the model and trust boundary.

Legacy posts remain valid without sidecars. To opt into explicit credits across existing
posts, use the dry-run-first [contributor migration command](contributor-migration.md).

#### Runnable contributor demonstration

The repository example site contains a complete, synthetic demonstration you can inspect or
copy:

- [`openblog.json`](../openblog.json) registers `example-author` and `example-editor`;
- the [research Markdown](../content/posts/2026-02-16-research-and-contributor-credits.md)
  selects the `research` profile; and
- its adjacent [credit sidecar](../content/posts/2026-02-16-research-and-contributor-credits.credits.json)
  assigns ordered Crossref and CRediT roles.

Run `cargo run -p openblog-cli -- user add you` once, then
`cargo run -p openblog-cli -- serve --admin` from the repository to inspect the authoring
workflow. Alternatively, run `cargo run -p openblog-cli -- build` and inspect the generated
page, feeds, and JSON-LD. The example identities are not real people and intentionally omit
ORCID iDs.

### File names and addresses

A file named `2026-01-12-writing-a-post.md` gets the slug `writing-a-post` and, with the
default settings, the address `/posts/writing-a-post/`. The `postPath` setting changes the
pattern; `"/{slug}/"` puts posts at the site root, which matches most blog platforms.

### Markdown

CommonMark plus the GitHub extensions: tables, task lists, footnotes, and strikethrough.
Raw HTML is passed through, so an `<iframe>` for a video or a `<details>` block works.
Portable copies are stricter: they keep only static, widely supported HTML, replace frames and
media with a link to the post, and remove scripts (see the
[portable HTML pipeline](./portability/portable-html-pipeline.md#raw-html-urls-anchors-and-size-bounds)).
Headings get ids and a hover anchor so sections can be linked. A table of contents appears
automatically on posts with three or more section headings (configurable).

Callouts are quotes whose first line names a kind, as on GitHub:

```markdown
> [!TIP]
> Toast the spices first for a deeper flavour.
```

The kinds are `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, and `CAUTION` (any case); each gets
its own colour and is titled with its kind. Put the marker alone on the first line: any
other text after it, or another kind, leaves an ordinary quote that shows the marker.

#### Pieces: buttons, videos, maps and more

Besides call-outs, a post can hold a few ready-made pieces, written as a `piece` fence of `field: value` lines
(the Admin's **Add something** writes them for you). A value continues on lines indented by two spaces, and a
list piece repeats its first field to start each item:

````markdown
```piece video
provider: youtube
video: dQw4w9WgXcQ
title: A short tour of the shop
```

```piece hours
note: Closed on public holidays.
days: Monday to Friday
hours: 9am to 5pm
days: Saturday
hours: Closed
```
````

The pieces are `button` (`label`, `href`, `style`), `image` (`src`, `alt`, `caption`; alt text is required),
`video` (`provider` of `youtube` or `vimeo`, `video`, `title`), `map` (`provider: openstreetmap`, `label`, `lat`,
`lon`), `hours` (`note`, then `days`/`hours` pairs), `contact` (`email`, `phone`, `address`), `social` (`label`/`href`
pairs, `https` only) and `faq` (`question`/`answer` pairs; answers are Markdown with raw HTML shown as text). A
call-out is the `> [!NOTE]` call-out above. Addresses must be `https`, `mailto`, `tel` or a page of the site;
anything else is refused with a message, and a piece that is not valid shows an error in place and is reported by
the build. Videos and maps are lazy-loaded, titled, privacy-enhanced frames (`youtube-nocookie.com`, Vimeo with
`dnt`, OpenStreetMap) with a plain link beside them; in portable copies they are links only. See ADR 0253.

#### Before and after

A `compare` fence pairs two photos, in any post (not only a job). One `key: value` per line; the picture and its
description are required for each side, and the caption and label are optional (the labels are "Before" and
"After" unless you change them). Admin's **Add something** writes it for you.

````markdown
```compare
before: /images/floor-before.jpg
before-alt: The old floor, stained and cracked along the door
before-caption: Day one
after: /images/floor-after.jpg
after-alt: The same floor, sanded and sealed
after-label: Finished
```
````

The fields are `before`, `before-alt`, `before-caption`, `before-label` and the same four for `after`. A picture
is an `https` address or a file on this site. A missing picture or description, an unknown field and a repeated
field are refused with a plain message; the post shows the error in place and the build reports it. On the page the
pair is a comparison control (`ob-compare`) where JavaScript runs and motion is welcome. Without JavaScript, in
feeds, in syndicated copies and in portable export it is two captioned pictures, each with its label, and nothing
else. The pictures use the same lazy loading as any Markdown image. See ADR 0291.

#### Landing page sections

When `content/landing.json` exists, the home page is built from it instead of the fixed intro, post list and
series (without the file the home page is built from `home.heading`, `home.intro` and `home.showSeries` as
before). The Admin [Landing page](admin.md#the-landing-page) writes it; you can also edit it by hand:

```json
{ "format": "openblog-landing", "version": 1, "sections": [
  { "id": "hello", "type": "welcome", "heading": "Welcome", "button": { "label": "Read the blog", "href": "/archive/", "style": "primary" } },
  { "id": "about", "type": "rich-text", "markdown": "About **this** blog." },
  { "id": "latest", "type": "latest-posts", "heading": "Newest", "count": 5 }
] }
```

Each section has a unique `id` (lowercase letters, digits and single hyphens), a `type`, and an optional
`hidden: true`. The types are `welcome`, `rich-text`, `latest-posts`, `series`, `featured-post`, `buttons`,
`image`, `video`, `map`, `opening-hours`, `contact`, `social-links`, `faq`, `callout` and `business-facts`; the
media, hours, contact, social, question and call-out types hold the same fields as the
[pieces](#pieces-buttons-videos-maps-and-more) above. The `business-facts` section holds only a `heading`: it
places the [business facts](configuration.md#business-facts) from `openblog.json` (name, phone, hours, license and
insurance badge) under that heading, and renders nothing while none are stated. Because it is a new type, a page
that holds one is stored as `"version": 2` (every other page stays version 1, byte for byte, and a version 1
file cannot hold it). There are at most 40 sections and 256 KiB. The page is accepted whole or not at all, and
a file from a newer release is never overwritten.

Landing content never accepts markup. There is no HTML section; a button is a label and an address, a video is
a provider and an id, a map is coordinates. Only Markdown is rich (the text section, answers, call-out bodies)
and it is read with raw HTML turned off, so a tag typed into it shows as text; addresses must be `https`,
`mailto`, `tel` or a page of the site. Saving a section touches only this file. See ADRs 0245 to 0247 and the
overview in ADR 0265.

#### Linking a word to the Knowledge Atlas

When your site publishes its [Knowledge Atlas](configuration.md#knowledge-atlas), link a word to an
approved entry by writing a Markdown link to `atlas:` and the entry's id:

```markdown
In the [allegory of the cave](atlas:allegory-of-the-cave), [Plato](atlas:plato) imagines prisoners.
```

Only the words you link are linked; the same word elsewhere stays plain text, and nothing is
recognised automatically. The build turns each link into an ordinary link to the entry's page. If
the entry is unknown, not approved, withdrawn, or the atlas is off, the words are published as plain
text and the build, `check` and Admin tell you which link and why. Feeds and portable copies keep
the words without the link. See the [format](specs/knowledge-atlas.md#concept-links-in-articles).

### Knowledge checks

Put a short multiple-choice question in a `quiz` fence. Readers receive feedback as soon
as they choose an answer; their attempt is remembered only in that browser and is never
sent to the blog or its analytics.

````markdown
```quiz
What does `draft: true` do?
- [ ] Publishes the post privately
- [x] Excludes the post from public builds
- [ ] Schedules it for tomorrow
> Drafts remain available in the admin preview.
```
````

A question needs two to four choices and exactly one checked (`[x]`) answer. The final
`>` explanation is optional. Prompts, choices, and explanations support emphasis,
strikethrough, and inline code, but not links, images, raw HTML, or multiple lines.
`openblog check` reports an invalid knowledge check instead of publishing it.

In the admin editor, choose **Add knowledge check** to fill in a small form instead of
writing the fence. You can add up to three questions at once. If the site owner configured
generation, select some article text (or put the cursor in a section), open the same form,
and choose **Generate draft**. Generated questions remain editable and are not added to
the post until you choose **Insert**.

### Code blocks

Fenced code blocks are coloured in the browser, numbered when they have two or more
lines, and get a Copy button. A block without a language has its language guessed. Plain
output is best marked `text`, which is neither coloured nor numbered.

After the language you can add options, in the style other site generators use:

````markdown
```rust title="src/main.rs" {2,4-6} showLineNumbers=10
fn main() {}
```
````

| Option | Effect |
| --- | --- |
| `title="..."` | A caption bar above the block, for a file name or a label. |
| `{2,4-6}` | Highlight those lines, counted from 1 at the top of the block (even with `showLineNumbers=10`). |
| `showLineNumbers` | Number this block even when numbering is off, when it has one line, or when it is a terminal block (`bash`, `sh`, `console`, `powershell`). |
| `showLineNumbers=10` | Number this block starting at 10. |
| `showLineNumbers=false` | No numbers on this block. |
| `runnable` | Make Rust, web, or an explicitly configured runner language editable and runnable. Unsupported languages stay static. |
| `playgroundLink=false` | On a runnable Rust block, hide the separate **Open in Rust Playground** link. `playgroundLink=true` shows it when the site setting `code.playgroundLink` is off. |

Colours can be turned off for a post (`highlight: false`) or the whole blog, but not for
one block; mark a block `text` to leave it plain. Copying a block, with the button or by
selecting it, never includes the line numbers.
For the whole blog, see `code` in [Configuration](configuration.md#code-blocks).

#### HTML, CSS, and JavaScript sandboxes

Use a `web runnable` fence with explicit section markers. Readers get three editable tabs, Run and
Reset controls, and a live preview:

````markdown
```web runnable title="Try the card"
---html
<button id="reveal">Reveal</button>
---css
button { color: rebeccapurple; }
---js
document.querySelector("#reveal").onclick = () => { document.body.textContent = "Revealed"; };
```
````

The preview runs locally in an opaque-origin iframe. Its content-security policy blocks external
resources, network APIs, form submission, frames, plugins, fonts, and navigation bases, while the
iframe sandbox prevents access to the host page. Browser sandboxes still let authored code navigate
its own preview, so never enter secrets there. No source is uploaded or persisted by open.blog.

Inside that boundary, ordinary lesson code works:

- `console.log`, warnings, errors, uncaught exceptions, and anything the sandbox blocks appear in a
  **Console** panel under the preview.
- Forms fire their `submit` event (call `preventDefault()` as usual; real submission stays blocked),
  and `alert`, `confirm`, and `prompt` work.
- `localStorage` and `sessionStorage` work in memory for the life of the preview.
- `eval`, WebAssembly, blob workers, and `AudioWorklet` modules the lesson creates itself all run.

Add options after `web runnable` when a lesson needs more:

| Option | Effect |
| --- | --- |
| `module` | Runs the JavaScript as an ES module, for `import`/`export` syntax or top-level `await`. There is nothing to import from, so keep the lesson in one file. |
| `network` | Lets the lesson `fetch` HTTPS APIs. Readers see that the preview may contact external services. |
| `images` | Lets the lesson show HTTPS images. Readers see that the preview may load external images. |
| `libs=react` | Loads site-hosted libraries listed under `webSandbox.libraries` in `openblog.json` (see [Configuration](configuration.md#web-sandbox)) before the lesson, for example React's UMD build as the global `React`. Separate several names with commas. |

````markdown
```web runnable network libs=react title="Load a user"
---html
<div id="root"></div>
---js
fetch("https://jsonplaceholder.typicode.com/users/1")
  .then((response) => response.json())
  .then((user) => ReactDOM.render(React.createElement("h2", null, user.name), document.getElementById("root")));
```
````

`openblog check` reports a `libs=` name that is not configured. See the
[web sandbox capabilities specification](specs/web-sandbox-capabilities.md) for the exact policy.

#### Interactive demos

A `demo` fence embeds one of the site's lesson demos in a post. Name the kind after `demo`;
the fence body is the description a reader sees when the demo is not running:

````markdown
```demo git-sandbox title="Break Git on purpose"
Branch, commit on both sides, then merge: Git creates a commit with **two parents**.
If both sides edited the same file, Git stops with a conflict.
```
````

| Kind | Demo |
| --- | --- |
| `git-sandbox` | An in-memory Git you can drive with commands or buttons: commits, branches, merges, conflicts. |
| `git-practice` | A guided practice terminal: one goal at a time, the reader types each Git command and sees what it would print. Add `lesson="<id>"` to pick a scripted lesson (ids in `web/components/ob-practice-model.js`). |
| `fetch-lab` | A simulated network inspector and Web Storage panel: edit a request, see what `fetch()` and `response.json()` do, hit the quota. Add `lesson="login"`, `lesson="caching"` or `lesson="testing"` to swap in a scenario instead: cookies and `credentials` with CORS, `Cache-Control`/`ETag`/304 with a pretend clock, or a stubbed `fetch` for testing. Without `lesson` the original lab is unchanged. |
| `component-lab` | A live custom element with a shadow root: change attributes, slots and CSS custom properties. |
| `js-evolution` | Older and newer JavaScript for the same task, side by side, run on the same fixed data across three milestones (2015, 2017, 2020). |
| `audio-lab` | A real, quiet Web Audio synth: oscillator, low-pass filter, live signal trace. Sound plays only after Start. |
| `native-lab` | View Transitions, Web Animations, the popover attribute and the Intersection/Resize observers, each reporting browser support. |

Everything the demo does runs in the reader's browser against pretend data; nothing is sent or
stored. The body is plain Markdown, and the same text is used everywhere the demo cannot run:
readers without JavaScript, feed readers, and portable HTML and Markdown copies for syndication.
There it appears under the title with a link to the live version on the original article.
Leave the body empty to use the kind's own one-paragraph description, but a body written for the
lesson (a worked example, the result the demo shows) is the better fallback.

The body cannot contain raw HTML or images, and links must be absolute `https://` URLs, because
the same text is rendered into feeds and exports; `openblog build` and `openblog check` report
an unknown kind or a body that breaks these rules.

#### Runnable Rust examples

Add `runnable` after `rust` when a self-contained example should be editable and
runnable directly in the lesson:

````markdown
```rust runnable title="Try changing the greeting"
fn main() {
    println!("Hello, adventurer!");
}
```
````

Keep ordinary examples as `rust` without `runnable` when they are meant for reading and
copying. Those blocks retain syntax colouring, line numbers, highlighted lines, and other
decorative code-block options. Runnable blocks become code-editor surfaces, but still
honour the configured syntax colouring, `showLineNumbers`, starting line number, and
highlighted-line ranges. In a tutorial that uses both, label them clearly—for example,
`title="Read-only example"` and `title="Live example · try it"`.

Readers can edit, reset, copy, or run the example and see compiler messages and
program output below it. Running sends the edited source to the
[official Rust Playground](https://play.rust-lang.org/); open.blog does not store
the source. A separate link opens the same code on the Playground if inline execution
is unavailable; add `playgroundLink=false` to that fence to omit the link. Without
JavaScript, the original code block remains readable.

Without `codeRunner`, runnable remote execution is intentionally limited to Rust and 20,000 bytes,
and displayed output is capped at 64,000 bytes. Rust uses stable 2021 in debug mode and is best for
self-contained lessons. The Playground offers popular preinstalled crates, but an
arbitrary local Cargo project, custom manifest, stdin, and local files are not available.

When the site owner configures `codeRunner.endpoint`, Rust uses that external gateway instead.
Languages in `codeRunner.languages` use the same author syntax:

````markdown
```python runnable title="Try changing the greeting"
name = input().strip() or "traveler"
print(f"Welcome, {name}!")
```
````

Readers get source and optional standard-input editors, Run, Reset, Copy, status, and plain-text
output. A disclosure explains that source and standard input leave the page. The browser sends no
credentials. If Python is not explicitly allowed, the example remains a normal static code block.
See [Execution gateway](deploy.md#execution-gateway) before enabling a language.

#### Small coding challenges

A coding challenge is ordinary instructional Markdown around a runnable block. Give the reader
one bounded task, keep a visible comment-form `TODO` in the starter source, state the expected result, and add a
hint only when it helps without giving away the whole solution:

````markdown
**Coding challenge: Finish the greeting**

Replace the placeholder with the adventurer's name.

**Expected result:** The program prints `Hello, Mira!`

```rust runnable title="Finish the greeting"
fn main() {
    // TODO: print "Hello, Mira!"
}
```

> [!TIP]
> Use `println!` with a string literal.
````

#### Rust checks: hidden tests that give the reader feedback

Add `check` after `rust runnable`, then a `---checks` line and ordinary `#[test]` functions. The
reader sees and edits only the starter above the marker. A **Check my code** button appends your
tests to what they wrote, compiles it on the Rust Playground in test mode, and shows *your* feedback
for every check that fails: the doc comment (`///`) on the test, or the function name if there is none.

````markdown
```rust runnable check title="Finish the damage rule"
fn click_damage(base: u32, bonus: u32) -> u32 {
    // TODO: add them without overflowing
    0
}
---checks
/// Add the base and the bonus together.
#[test]
fn adds_bonus() {
    assert_eq!(click_damage(5, 3), 8);
}

/// Stop at the ceiling instead of wrapping around: try saturating_add.
#[test]
fn saturates() {
    assert_eq!(click_damage(u32::MAX, 1), u32::MAX);
}
```
````

- The checks run in a child module with `use super::*`, so they can call the reader's functions,
  private ones included. The program is compiled as a library, so the reader's `fn main` is optional.
  The reader's code and your checks together must stay under 40,000 bytes (the starter alone under 20,000).
- A wrong answer shows only your feedback lines. Code that does not compile shows the compiler output.
  The raw assertion text is never shown, so a check does not spoil its own answer.
- **Hidden is not secret.** The checks ship in the page data (`<script data-ob-rust-checks>`), so
  a curious reader can find them. This is a teaching aid, not a grader.
- **Other platforms.** A copy cannot run the checks, so feeds, exports and syndicated copies show the
  starter as the code, then the checks inside a collapsed `<details>` block labelled "Spoiler: the
  checks for this challenge", then the link to the canonical page. A reader elsewhere can see how the
  challenge is checked without having the answer in their face.
- Pin down behaviour, not style: tests that call `click_damage(5, 3)` fix the function's name and
  signature, so say so in the task, and prefer several small checks with specific feedback over one big one.
- The build rejects `check` on anything but `rust runnable`, a missing `---checks` line, an empty
  starter, or a `---checks` section with no `#[test]`.

The Admin's **Assistant → Interactions → Create runnable-code proposal** dialog can draft either a
complete example or this challenge pattern from selected text or the current section. Every field is
editable, insertion is explicit, and the form also works without an AI provider. These challenges do
not add hidden tests or grading: the reader runs the visible source and compares its behavior with the
authored expected result.

### Images

Put files in `static/`; they are copied to the site root unchanged. `static/images/a.png`
is `/images/a.png`:

```markdown
![A short description](/images/a.png)
```

In the admin editor, images can be inserted with a button, dragged in, or pasted; they are
saved under `static/images/uploads/<year>/`.

### Drafts

`draft: true` hides a post everywhere. Preview drafts locally with
`openblog serve --drafts`, or in the admin editor, where drafts have their own badge.

### Scheduling

A post whose `date` is in the future is held back from the site, the feeds, the sitemap,
search, and tag and series pages. The first build after that time includes it. When
`openblog serve` is running, it rebuilds by itself at the right moment; on a static host, a
scheduled build (a cron job or workflow) does the same. See [Deploying](deploy.md).

To preview a scheduled post before its time, run `openblog serve --drafts` or
`openblog build --drafts`; the flag includes drafts and scheduled posts. The admin editor
lists them with a "scheduled" badge.

## Recipes

open.blog is not only for code. Add `profile: recipe` to a post's front matter, put the
ingredients in a list under an `## Ingredients` heading and the steps in a list under a
`## Steps` heading, and readers get:

- a summary card with the times and servings, and a "Jump to recipe" link,
- buttons that scale the amount at the start of each ingredient to more or fewer servings,
- checkboxes to tick off ingredients and steps as they cook (remembered on their device),
- timers: a duration in a step, such as "simmer for 10 minutes", starts a countdown when tapped,
- a cook mode that keeps the screen awake, and a "Print recipe" button that prints just the recipe,
- schema.org recipe data for search engines.

`openblog new "Lemon garlic pasta" --recipe` creates a recipe post (older generated files
may contain the equivalent `recipe: true` marker),
`servings: 4`, `prep: 15 min`, `cook: 25 min`, a tip callout, and a placeholder
Ingredients list and Steps list, ready to fill in. A finished recipe looks like this:

```markdown
---
title: Lemon garlic pasta
date: 2026-02-02
profile: recipe
servings: 4
prep: 10 min
cook: 15 min
cuisine: Italian
course: Dinner
cover: /images/lemon-pasta.jpg
---

A few words about the dish.

## Ingredients

- 400 g spaghetti
- 1 1/2 lemons, zested and juiced
- Salt, to taste

## Steps

1. Cook the spaghetti for 9 minutes.
2. Toss with the lemon and serve.
```

| Field | Meaning |
| --- | --- |
| `profile` | `recipe` enables recipe behavior. Legacy `recipe: true` and `type: recipe` markers also work. |
| `servings` | How many it serves. A number (`4`) can be scaled; a range (`4-6`) scales from its first number. Also `serves`. Scaling needs a number here. |
| `makes` | What it makes: `12 cookies`, `1 loaf`. Shown on the card only; to let readers scale a batch, also give `servings` (`servings: 24` and `makes: 24 cookies`). Also `yield`. |
| `prep`, `cook`, `total` | One length of time: `15 min`, `1 hr 30 min`, `1.5 hours`, `1 1/2 hours`, `1h30m`, `1:30` (1 hour 30 minutes), or `PT1H30M`. Anything else, such as `overnight` or `10-15 min`, is shown on the card as written and left out of the search-engine data. `total` defaults to prep plus cook when both are given. Also `prepTime`, `cookTime`, `totalTime`. |
| `cuisine`, `course` | Shown on the card and given to search engines. `category` also works for `course`. |
| `calories` | Free text, per serving, such as `520 kcal`. |

**Sections.** The labels must be headings (`## Ingredients`), not bold text, and each
ingredient and step must be a list item (`- ` or `1. `); `openblog check` warns about a
recipe with no ingredients or no steps. An ingredients section starts at a heading that
begins with "Ingredients", "What you need", "You will need", or "You'll need" (also
Ingrédients, Ingredientes, Ingredienti, Ingrediënten, Zutaten). A steps section starts at
"Steps", "Method", "Instructions", "Directions", "Preparation", or "How to make" (also
Étapes, Préparation, Instrucciones, Preparación, Pasos, Elaboración, Procedimiento,
Procedimento, Preparazione, Zubereitung, Anleitung, Bereiding). Sub-headings inside a
section, such as `### For the sauce`, are fine. A section ends at the next heading with
the same number of `#` or fewer, or at a heading that starts the other kind of section.
Paragraphs inside a section are shown but get no checkbox or timer. Everything else in
the post, such as the story before the recipe or notes after it, is ordinary Markdown.

**Amounts.** Scaling changes the number at the start of each ingredient: `2`, `1.5`,
`1,5`, `1,000`, `1/2`, `1 1/2`, `1-1/2`, `½`, and ranges like `2-3`. A second measure
right after the unit is scaled too (`12 oz / 340 g`, `1 cup (240 ml)`). Fractions stay
fractions, rounded to the nearest eighth, sixth, quarter or third (`¾ cup`); decimals and
metric amounts stay decimals, and grams and millilitres are whole numbers from 10 up.
Lines that do not start with a number, such as "Salt, to taste", are left alone, and so
are amounts written in the steps, so put quantities in the ingredient list. The chosen
number of servings is remembered on the reader's device.

**Timers** recognise hours, minutes, and seconds, written out or as hr, hrs, min, mins,
sec, secs: `10 minutes`, `1 1/2 hours`, `1 hr 30 mins`, `2 minutes 30 seconds`, and
`20-25 minutes`, which starts at 20. Single letters (`1h`, `10m`) and other languages'
words are not recognised. A timer runs while the page is open; when it finishes, the
button says "Done" and the device beeps and vibrates if it can. Turn on Cook mode so the
screen does not go to sleep meanwhile.

**Search engines** show a recipe result only for recipes with a photo, so set `cover` or
put an image in the post.

Each extra can be switched off for the whole blog under `recipes` in
[Configuration](configuration.md#recipes).

## Series

A series groups posts in reading order and gets its own page. Create
`content/series/<slug>.md`:

```markdown
---
name: Getting started
description: Three short parts that cover the basics.
theme: paper          # optional: every post in the series uses this theme
cover: /images/getting-started.png
order: 1              # position on the /series/ page (lower first)
---

Optional Markdown shown at the top of the series page.
```

Posts join with `series: getting-started`. Each post then shows "Part 2 of 3" with
previous and next links and a list of all parts. If you reference a series that has no
file, one is created from the slug and the build prints a warning.

A series that holds a collaborative work, a published post whose credits name two or more
authors (such as a shared reflection), also says who wrote what: its page lists the series'
contributors, and every part, ordinary posts included, shows "By ..." on the series page, in the
previous and next links and in the list of all parts. Names come from each post's credits and are
shown as plain text. Every other series looks exactly as before. Feeds, exports and syndicated
copies of such a series' parts say the same: the series and a link to it, the part's place in it,
and who wrote it.

## Pages

Pages live in `content/pages/` and have no date, tags, or series:

```markdown
---
title: About
nav: true             # add to the header navigation
description: About this blog.
theme: paper          # optional
---

Text.
```

A page named `about.md` is served at `/about/`. The slugs `series`, `tags`, `archive`,
`search`, `page`, `themes`, `assets`, and `api` are reserved by the engine.

## What the engine generates

| Address | Content |
| --- | --- |
| `/` and `/page/2/` ... | The post list, newest first, with a series overview |
| `/posts/<slug>/` | A post (pattern set by `postPath`) |
| `/series/` and `/series/<slug>/` | Series overview and each series that has at least one published post (a series whose parts are all drafts or scheduled has no page yet) |
| `/tags/` and `/tags/<slug>/` | Tags and the posts in each |
| `/archive/` | Every post by year |
| `/search/` | Client-side search |
| `/<page>/` | Pages |
| `/rss.xml`, `/feed.json` | Feeds |
| `/sitemap.xml`, `/robots.txt` | For search engines |
| `/api/blog.json` | The four newest posts as JSON, for other sites |
| `/404.html` | The not-found page most hosts serve automatically |

## Checking your work

```sh
openblog check     # lists every problem with the file name and the reason
openblog build     # the same checks, then writes dist/
```

Typical problems: a missing `date`, a date in an unrecognised format, two posts with the
same slug, a theme that does not exist, or an alias that collides with a real page.
Accessibility findings appear separately with an outcome, source location, and repair
instruction. They are authoring guidance rather than a WCAG pass/fail result; see
[Accessibility checks and manual review](accessibility.md).
Research-profile evidence findings are reported separately with stable codes, locations,
and repair guidance; see [Research posts and Evidence Studio](research-profile.md).
