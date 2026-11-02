# Universe dimensions and Temporal Stack

In the Studio, choose **Through time** under **Pick a layout** in the **Layout** tab
(it needs projects from at least three different years). **Through time: one layer per** in
**Fine-tune** switches between Year, Language, Project and Topic. Each year is a transformed cross-section; the newest is
largest and nearest, with older years receding downward. Filaments connect the
same project in adjacent displayed layers. Selection highlights its occurrences
and reports first visibility, last visibility and number of layers.

```json
{
  "arrangement": "temporal-stack",
  "temporalStack": {
    "yearStart": 2021, "yearEnd": 2026, "yearStep": 1,
    "depthGap": 120, "perspective": 0.8, "tilt": 0.35,
    "scaleFalloff": 0.035, "connections": "same-node",
    "innerArrangement": "solar-system"
  }
}
```

All settings are optional. `temporalStack.enabled: true` also enables the mode.
The default window is the reference year and five preceding years. Supply an
explicit `referenceDate` to the API for reproducible exports. `yearEnd` cannot
exceed the reference year; `yearStep` selects backwards from `yearEnd`. Set `innerArrangement` to identity ring points, Solar System or
Galaxy, plus form parameters, in **Fine-tune** → **Edit all settings as JSON** or a settings file. Identity points come from the existing
Rust ring engine. The API also supports `galaxy` and `rings` as inner arrangements. This is temporal composition,
not a replacement Layout API algorithm.

## Dimensional layers (v3.4)

Set `temporalStack.axis` to `language`, `repository` or `topic`; omitted means `year`.
Language and topic layers contain repositories with that membership. Polyglot repositories occur in multiple planes. Filaments connect each repeated identity to its previous occurrence, including across intervening planes without that identity. Repository layers use the existing combined graph: the project plus its language and topic nodes. Shared language/topic identities connect repository planes.

Defaults select at most eight values, ranked by repository representation, then total stars, then name. Explicit `layerValues` selects and orders up to twenty values. Set it in **Edit all settings as JSON** or a settings file; an empty list restores defaults. Values must exist in the filtered project pool; unavailable values produce a recoverable error. Compact exports show at most three selected layers and disclose reduction. A repository without technology/topic metadata has no invented identities.

```json
{ "arrangement": "temporal-stack", "temporalStack": {
  "axis": "language", "layerValues": ["JavaScript", "Rust", "CSS"],
  "innerArrangement": "rings", "connections": "same-node"
} }
```

Config remains v7. Existing v1 year attachments deserialize unchanged. Dimensional attachments are v2: `layers` hold `id, axis, value, label, depth, frameId, evidence`; `frames` hold isolated scenes and `current-membership` evidence. They have no fabricated year/date or Timeline attachment. Frame count, recursive attachments, identities, anchors, bridges and aggregate node bounds are validated. The same ring layout, geometry projections, motion and SVG/offline/component rendering serve every axis.

The runtime and web component add `focusLayer(layerId)`; dimensional controls emit `universe-layer-change` with layer, axis and evidence. Year controls retain `focusYear` and existing events. Dimensional views have no Timeline toggle. Existing geometry, camera, manual ring placement, animation, reduced motion, filtering and exports remain available.

## Year evidence

Default historical layers reuse Timeline's creation-date filtering at year end.
Their evidence is `current-metadata`: repositories known to exist by that date,
using current metrics. Unknown creation dates are omitted from retrospective
layers. The reference year uses the current frame (`current`). Stars, topics and
contributor counts are never reconstructed from today's data.

Pass `timeline.snapshots` or use `createTimeline` with Temporal Stack options to
use saved records (`snapshot`). The latest supplied frame within each selected
year represents that year, with its actual date visible. Years with no supplied
frame are omitted. All supplied frames remain available through ordinary Timeline
controls. A missing project in an intervening displayed layer breaks its trail;
a missing year is not evidence of absence. First-visible halos refer to this
window, not a proven birth event. Recorded creation dates appear separately.

```js
import { createTimeline, renderSceneHTML } from '@constellation/core';
const scene = createTimeline('example', currentRecords, {
  referenceDate: '2026-09-01T00:00:00Z', arrangement: 'temporal-stack',
}, { snapshots: [{ date: '2024-06-01', records: savedRecords }] });
const html = renderSceneHTML(scene);
```

## Offline interaction and accessibility

HTML and `<constellation-view>` expose:

- `setTemporalView({ depth: 1, rotation: 0, tilt: 0.35 })`: depth 0–2,
  rotation −1–1, tilt 0.15–0.85.
- `focusYear(year)` emphasizes a displayed year; `focusYear(null)` restores all
  layers. `temporal-year-change` includes year and evidence.
- `focusTemporalNode(canonicalId)` reveals a project's full trail.
- `resetTemporalView()` restores the default projection and all years.

Native labelled sliders and a selector provide keyboard camera/year control.
Latest year returns to the newest displayed layer. Only focused year explicitly
hides other layers. Pan, zoom, filters, themes, keyboard selection and live status
remain available. Selecting an occurrence shows its frame's metadata/evidence.
Camera and birth treatments are static, including with reduced motion.

Open Timeline switches to the existing one-frame experience and comparison.
`setFrame`, `setDate` and `compareWithNow` retain their meaning and switch to that
view; temporal methods return to the stack. Selection, filters and theme survive
switches when the selected project remains visible. Story and Hierarchy forward
both sets of APIs to the active scene.

Manual `starPositions` still address canonical IDs in local XY coordinates.
Enable **Line stars up on the rings** in **Fine-tune** and drag a project on any
year cross-section in the Studio (or focus it and use arrow keys). Pointer coordinates are inverse-projected
into that exact plane before choosing a ring point; camera distortion does not
change the snapping metric. Occupied points swap projects across all years.
The editor saves `ringPlacements: { "owner/project": { "ring": 1, "point": 7 } }`
with zero-based indices. These identities survive shape switches and ring
rotations; they are not projected pixels. Turn snapping off for free local XY
placement. Existing non-temporal configurations keep their prior behavior.

## Architecture

Scene API v1 gains an optional validated `temporalStack` attachment, version 1:
`axis: 'year'`, normalized settings, descending `layers` with year, Timeline
`frameId` and depth (0, −1, …), typed `bridges`, and a small-format reduction flag.
Frame nodes retain canonical IDs. DOM instances use deterministic encoded
`year::canonicalId` names; `data-node-id` retains canonical identity.

Compilation reuses Timeline, normalizers, transforms, mappings and Rust/WASM
relationships. Existing `artifactPositions()` computes union anchors using each
project's latest available metadata. Ring placement reuses Rust's `identityGeometry`
and `identityPoints`; explicit semantic placements reserve their slots. Manual
positions can override anchors when snapping is off.
Each occurrence retains its XY anchor; radius, metadata and relationships can
differ. Adjacent identity maps make bridge construction linear.

JavaScript composes precomputed scenes using shared geometry math and projected
drawing commands in SVG and the offline runtime. The version-1
`temporalStack.geometry` attachment stores a declarative profile,
Rust-generated ring radii and points, and project ring identities. World transforms
apply each section's radius, center, phase and orientation before a bounded
perspective camera. Segmented ring curves, guide lines and faint surface facets
are sorted by camera depth, with rear arcs thinner and dashed. Labels stay
upright and stars stay round. Camera
movement updates projected SVG elements and their painter order; it never invokes
layout or network requests. Rust's existing responsibilities are unchanged.

## Temporal forms and persistent identity

Choose **Temporal form**: Stack, Cylinder, Cone, Sphere, Dome, Hourglass or Helix.
The same ring placement works in every form. Cylinder uses constant radii; Cone
interpolates newest/oldest radii; Sphere uses the spherical cross-section equation;
Dome uses half that profile; Hourglass narrows to a configurable waist. Twist is
zero by default. The Evolution Helix preset intentionally supplies 240 degrees of
total twist. Development Sphere is also available as a preset.

`temporalGeometry` is declarative:

```json
{
  "arrangement": "temporal-stack",
  "temporalStack": { "innerArrangement": "rings" },
  "temporalGeometry": {
    "shape": "sphere", "radius": 320, "depth": 640, "twist": 0,
    "surface": "wireframe", "orientation": { "x": 0, "y": 0, "z": 0 }
  },
  "ringPlacements": { "owner/project": { "ring": 1, "point": 7 } }
}
```

Sphere sections are sampled at latitude-band centers so projects never collapse
at zero-radius poles. Guide-only caps complete the silhouette. A sphere uses
`depth = 2 * radius`; other depths intentionally stretch it into an ellipsoid.
Dome defaults to `depth = radius`. Profiles normalize the displayed sections,
including sparse snapshot years; they do not invent missing snapshots.

Parameters: radius 80–600, depth 80–1600, cone startRadius/endRadius 40–600,
hourglass waist 0.1–1, twist −720–720 degrees. Orientation is XYZ Euler degrees
(each −180–180). Advanced API-only `lean: {x,y,z}` offsets centers through depth
(±600); `planeTilt: {x,y,z}` changes cross-section orientation through time
(±60 degrees). All fields contain numbers, never callbacks.

Surface choices are Off (yearly rings only), Wireframe, or Translucent. Surface
facets stay at 2.2% opacity; they cannot become opaque. The wireframe connects the
first six stable points on each of the four identity rings, a bounded geometric
guide independent of the project relationship graph. Temporal trails follow the
profile between years, producing meridian-like curves or helices. Extra Rust
identity points remain available for project placement and appear when editing.

Offline HTML can switch forms with `setTemporalView({ shape: 'sphere', surface:
'wireframe', twist: 0 })`. Node DOM identities, selection and filters persist.
Form changes are immediate, with no required morph animation; reduced motion has
the same final geometry. The original affine projection remains available for
older serialized Temporal Stack attachments that lack geometry.

Run `node --test scripts/preview-temporal-forms.mjs` to produce the static form
gallery and separate offline demos in `.dist/temporal-forms.html`.

## Limits and performance

Static SVG includes planes, year/evidence labels, first-visible halos and temporal
filaments. Compact layouts and `compact`, `profile`, `readme`, and `repository`
profiles show only the latest three selected years, with a visible note. SVG grows
vertically to fit planes instead of squeezing them into an ordinary 280px chart.

Defaults: six layers. Maximum: 20 layers, 4,096 displayed node occurrences and
2,048 distinct projects. Timeline's 64-frame/16,384-node limits and Scene's 32 MiB
serialization limit also apply. Oversized requests fail with instructions to
reduce years or graph size. Old layers retain at least 55% default opacity.

Run `node scripts/benchmark-temporal-stack.mjs` for compilation/export sizes and
`node --test scripts/benchmark-temporal-browser.mjs` for Chromium camera timings
and previews in `.dist/temporal-stack.html` and `.dist/temporal-stack.svg`.
Timings depend on hardware. The 3D renderer's Windows measurements: 25 × 6
compiled in 67 ms / 1.81 MB HTML; 100 × 20 in 128 ms / 11.22 MB HTML; 200 × 20 in
177 ms / 15.37 MB HTML. Browser camera updates measured 28–32 ms for the default
example, 133–187 ms for 100 × 20, and 223–253 ms for 200 × 20. Large scenes are
intended for deliberate exploration, not continuous 60 fps rotation. Slider
updates coalesce once per animation frame. Projection bases are reused per
cross-section and nodes already in painter order avoid unnecessary DOM moves.

Tests cover determinism, evidence, missing dates/projects, gaps, manual anchors,
malformed attachments, limits, offline interaction, reduced motion, ring-point editing
and the packaged component.

## Motion composition and random discovery

Full Random v6 can discover all seven profiles when the loaded source has useful
history. Its weighted form selection, bounded radii/depth/orientation, moderate
helix twist and subtle surfaces are deterministic. Static recipes are equally
eligible. Styling-only and animation-only draws keep the current temporal form.

Ring animation preserves the established placement semantics: attached projects
move with their ring, with the same ring phase across every yearly cross-section.
Their labels, relationship endpoints and persistence trails use the same moving
local coordinate before projection. Floating applies only to unattached nodes.
Perspective motion moves the camera around that geometry. Shape switching does
not change the stored ring/point identity. Editing pauses native SVG spatial
motion at its base pose so inverse-projected snapping remains stable.

Offline HTML projects and depth-sorts moving geometry live, pauses spatial motion
during pointer interaction/hidden tabs, and restores the static pose for reduced
motion. Background stars remain outside the world camera. Repository starlight,
background twinkle, activity and observation layers retain independent permissions.
Current activity effects occur only on the current-year instances; account coding
rhythm and contribution orbit render once as reference-date observations.

Standalone SVG uses script-free sampled projected motion when the independent
periods share a cycle of at most ten minutes, with at most 144 sample intervals.
Longer asynchronous cycles play the first minute forward and then backward in a
bounded two-minute SVG loop, keeping geometry moving without a jump at the loop
boundary. Interactive HTML retains continuous motion at the configured speeds.
SVG images provide a reduced-motion fallback; explicitly
`animate: false` exports contain no animation elements. Static geometry never
depends on motion to show its shape.

Temporal time-lapse in HTML operates on the existing cross-sections: grow reveals
oldest to newest; crossfade and orbit emphasize successive years. It does not
replace the structure or fabricate frames. Focusing a year temporarily overrides
playback emphasis. Reduced motion shows all existing slices. The regular Timeline
remains available for frame-by-frame inspection.
