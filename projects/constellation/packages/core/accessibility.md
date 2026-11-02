# Accessibility

## The Studio

Accessibility is part of the Studio's tests, not a separate review. The Playwright suite in `e2e/` checks every screen (Home, loading, errors, each tab, the star card, **Get it**, **Fine-tune**, **Save**, sign-in) for:

- no axe WCAG 2.2 AA violations;
- no control without a visible label, and no overlapping controls;
- no horizontal scroll, including at 320 px wide;
- controls that stay visible with forced colours;
- a map that doesn't move when reduced motion is requested, even with **Spinning rings** or **Floating stars** on.

It also completes the core journey with the keyboard only (type a username, choose a theme, open **Get it**) with focus always visible. These automated checks complement manual assistive-technology testing; they are not a claim of universal screen-reader coverage.

What that means when you use it:

- **Home** puts focus in the username field. Errors appear as text under the field and are announced.
- **Tabs** (**Look**, **Layout**, **Projects**, **Details**) follow the tab pattern: Left/Right arrow, Home and End move between them.
- **Theme and layout cards** are a radio group. Arrow keys move between cards; a choice that can't work says why instead of disappearing.
- **The map** is reachable with Tab. Each star is a button named after its project: Enter or Space opens its card, arrow keys move it. Escape closes the card and returns focus to the star. The card's explanations are text, not colour or position alone.
- **Undo** and **Redo** have keyboard shortcuts (Ctrl+Z, Ctrl+Shift+Z) and announce what they undid.
- **Dialogs** trap focus, close with Escape, and return focus to the button that opened them.
- **Phone** top-bar buttons are at least 44 px. On a phone the panel sits below the map.
- **Gentle motion** is on by default, and is paused for anyone who prefers reduced motion. Changing the system setting applies immediately.
- **Title** (in **Details**) is read aloud by screen readers as the map's name.

See the [Studio guide](studio.md).

## Exported maps

Static SVG exports include descriptive text and retain reduced-motion alternatives. Interactive exports and components provide labelled native controls, live status updates, keyboard-selectable nodes and visible focus. Tab reaches the canvas and current node target; arrows/Home/End navigate nodes; Enter/Space selects, Shift-select traces a path, Escape steps back one focus level and restores keyboard focus to the connection or project you came from, and +/- zooms. Project and relationship focus are announced in the status region, inspector buttons are at least 44 px tall, and focus dimming has no transition under reduced motion. See [Evidence Navigation and Interactive Focus](evidence-navigation.md).

Profile Sun rays and ring bands are labelled, and SVG descriptions are derived from the configuration. Colours and motion are never required to identify a dimension or missing evidence. Semantic nodes remain in their evidence bands during decorative motion; reduced-motion viewers retain all data and labels. An optional static reading guide (`semanticLegend`) can be appended to exports. See [Reading a constellation](semantic-studio.md).

Dense grouped README SVGs distinguish groups from projects by shape and description, and explain that aggregate line weight reports represented relationship counts. When a low-priority label is hidden for space, its node remains named in the SVG accessible title; interactive HTML retains all available semantic detail.

Showcase roles are stated in SVG accessible descriptions and node details, not conveyed by colour alone. Featured category nodes list the Featured projects that contribute their real membership. Featuring a project in the Studio uses a toggle button (**Feature it**, or the star beside it in **Projects**); dragging is never required.

Timelines expose a native date range with actual date/evidence text. Then/Now comparison includes text counts, not colour alone. Hierarchy uses breadcrumb buttons with the current scene identified; focus follows navigation. Story chapters use a labelled selector, Previous/Next controls, narration and heading focus. Autoplay is never required.

Reduced motion pauses SVG animation and disables CSS/node/camera transitions. Changing the system preference during an effect immediately applies its final state. Filters update keyboard targets and clear hidden selections. Resizing preserves the camera; narrow comparison views stack vertically.

Temporal Stack exports provide labelled depth, rotation and tilt sliders, a year selector, Latest year and Reset perspective buttons. Year focus announces its evidence. Halos and camera changes are static with or without reduced motion. See [Temporal Stack](temporal-stack.md).

## Embedding

Embedders should provide a useful page heading and record labels/descriptions, preserve visible control focus, and avoid custom CSS that hides content or reduces contrast. The component uses Shadow DOM for style isolation and composed events for host integration.

Node browser tests exercise keyboard operation, reduced-motion changes, mobile sizing, breadcrumb focus, Story previews and Chromium's accessibility tree for exports and the component.
