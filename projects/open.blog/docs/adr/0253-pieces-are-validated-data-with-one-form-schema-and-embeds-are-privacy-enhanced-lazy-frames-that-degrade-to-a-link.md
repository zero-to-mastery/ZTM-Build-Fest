# ADR 0253: Pieces are validated data with one form schema, and embeds are privacy-enhanced lazy frames that degrade to a link

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#331](https://github.com/journey-to-code-org/open.blog/issues/331)
- Parent story: [#317](https://github.com/journey-to-code-org/open.blog/issues/317)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Serves: [#332](https://github.com/journey-to-code-org/open.blog/issues/332), [#333](https://github.com/journey-to-code-org/open.blog/issues/333)
- Contract: `openblog_core::piece`, `openblog_core::render::piece`

## Context

The landing sections (ADRs 0245 to 0247) render video and map as plain links, because an embedded frame was
deferred. Authors also want the same few things in a post: a button, a video, a map, opening hours, contact
details, social links, an image with a caption, a FAQ and a call-out. They must be a few form fields, the
landing page and the post editor must ask for them the same way, and a post must stay Markdown.

## Decision

- **A piece is validated data, not markup.** `Piece` is the closed set Button, Image, Video, Map, Opening
  hours, Contact, Social links, FAQ and Call-out. Its data types are the landing section types, and
  `Piece::problems` runs the landing validators, so one rule set holds on both surfaces. There is no
  "write my own HTML" piece.
- **One form schema.** `piece::schema` describes every piece (labels, hints, limits, choices, repeated groups)
  and `piece::schema_json` serves it to the Admin in `GET /admin/api/meta` as `pieces`. The post editor's
  "Add something" dialog and the landing page workspace both build their forms from it. `Piece::from_values`
  turns form values into a validated piece and reports every problem in words.
- **In a post a piece is Markdown.** A call-out is the existing `> [!NOTE]` / `[!TIP]` / `[!WARNING]` call-out,
  unchanged. Every other piece is a fenced directive, ```` ```piece <kind> ````, whose body is one
  `field: value` per line; a value continues on lines indented two spaces; a list piece repeats its first
  list field to start each item. The fence is longer than any backtick run in the values. A reader that does
  not know the directive (GitHub, another engine) shows a code block, so the text is never lost. A malformed
  directive is a Markdown error and renders an inline alert; it never renders broken markup. A fence whose first
  word is not exactly `piece` is an ordinary code block, so existing posts build unchanged.
- **One set of renderers.** `render::piece` renders each piece from validated data and escapes every value.
  The landing renderer calls the same functions for the matching section types, so the two surfaces cannot
  drift. Landing markup for buttons, image, hours, contact, social links, FAQ and call-out is byte-identical to
  before; in a post the markup sits in `<div class="ob-piece ob-piece-<kind>">`.
- **Embeds: links become privacy-enhanced, lazy, titled frames with a link fallback.** A video renders as
  `youtube-nocookie.com/embed/<id>` or `player.vimeo.com/video/<id>?dnt=1`; a map renders as the
  OpenStreetMap embed for the stored coordinates. Every frame has `loading="lazy"`, a `title` and a
  `referrerpolicy`, and its address is **rebuilt from a provider and an id or two coordinates**, never copied
  from input; the id and the coordinates are checked again at render time. The same figure carries a visible
  link to the video or place on the provider's own site, so a reader whose browser or network blocks frames, or
  who reads without scripts or in a feed reader, still has the link.
- **Portable projection.** In a portable export an embed is a link only (`<p class="ob-embed-link ...">`),
  like posts' existing media embeds; every other piece is static HTML and is kept. The export's semantic-fact
  check requires the pieces' names and labels to survive.
- **Allowlist.** Providers are `youtube`, `vimeo` and `openstreetmap`. The Admin preview's frame policy
  (`embed::FRAME_SOURCES`) gains the two new origins; no other origin is added.
- **Supersedes ADR 0247's "no frame or third-party request on the home page" rule for Video and Map sections.**
  ADR 0247 rendered a video as a link and a map as a link, and ADR 0245 deferred embedded frames. Issue #331 asks
  for privacy-enhanced lazy embeds, so a Video or Map section now renders the frame described above. Landing
  sections are unreleased, so no live site regresses. A page with no Video or Map section still has no frame and
  makes no third-party request, and the frame is lazy, titled, no-cookie where the provider offers it, and keeps
  its link fallback.
- **The Admin preview's Content Security Policy widens for every preview.** `frame-src` now also allows
  `https://player.vimeo.com` and `https://www.openstreetmap.org` (besides the existing YouTube and CodePen
  origins), because the preview shares one policy. It applies to all previews, not only those that contain a
  video or map; no other directive changes.
- **No HTML in a call-out.** A call-out's heading or text that holds `<` followed by an ASCII letter, `/`,
  `!` or `?` is refused (`Piece::from_values`, so `/admin/api/pieces` answers 422, and the Visual call-out
  form says so early; hint: "HTML tags are not allowed"). A call-out is written into the post as ordinary
  Markdown and the post renderer passes raw HTML through, so typed markup would become live. Every other piece
  is written as a `piece` fence whose values the renderer escapes (the FAQ answer through the inert Markdown
  renderer), so those fields stay free text.

## Considered options

- **A `:::` container syntax.** Rejected: it needs a Markdown extension, and a plain fence already degrades to
  visible text everywhere.
- **JSON in the fence.** Rejected: hard to write and to edit in plain Markdown mode; `field: value` lines read
  like front matter.
- **Click to load the frame.** Deferred: lazy loading and the no-cookie hosts are the privacy floor; a
  click-to-load facade needs scripts and so would not work without them.
- **A second landing model for the post.** Rejected: duplicates validation.

## Consequences

- #332 and #333 write and read these directives in the editor and offer the pieces from `pieces` in the
  metadata; the landing workspace (LB2) can build its section forms from the same schema.
- Adding a piece or a provider is a change in one place, a schema entry and a renderer, and the exhaustive
  matches make a missing renderer a compile error.
