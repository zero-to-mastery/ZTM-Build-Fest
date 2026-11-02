# Story Clarity v1

Story Clarity is an internal, deterministic presentation analyzer for a final
composed scene. It is separate from Graph Quality and candidate recommendation:
it returns structured diagnostics and bounded suggestions but does not score,
rank, or select story candidates.

## Input and output

The JS scene adapter supplies project IDs and authored roles, coordinates,
estimated label rectangles, relationship endpoints and types, group membership,
legend bounds, and target SVG dimensions. Estimated text bounds use a
conservative glyph-width approximation. They are not browser font measurements.

The Rust/WASM analyzer returns `version: 1`, diagnostics with stable codes,
severity, and affected IDs, plus suggestions such as moving or suppressing a
label or reducing visible relationship annotations. It never changes the scene.
The renderer may apply only bounded presentation adjustments to static Profile
Story exports; explicit manual labels and positions keep precedence.

Diagnostics cover estimated label collisions and bounds, featured prominence,
featured/supporting hierarchy, relationship density and label crossings,
crowded groups, relationship-style differentiation, and legend overlap. A
missing diagnostic does not prove that browser-rendered text cannot overlap.
Browser geometry regression tests check actual text and legend rectangles at
480px and 900px.

## Limits and determinism

Input is limited to 1 MiB, 512 projects, 1,024 labels, 4,096 relationships, and
128 groups. Output is capped at 256 diagnostics and 256 suggestions. IDs and
diagnostics are sorted so reordered records produce identical output. Numeric
geometry must be finite and bounded. No DOM, network, generated code, or
developer assessment is involved.

## Static Profile Story exports

Profile Story provides a wide 900px export and a compact 480px export from the
same selected candidate scene. Both retain the same projects and evidence.
Compact output prioritizes Featured and Supporting labels, reduces secondary
labels and visible relationship annotations, and scales role labels for the
smaller intrinsic width. Connection patterns retain non-color distinctions and
accessible SVG titles. The SVG remains understandable with JavaScript
disabled. Reduced-motion preferences do not remove static information.

Suggestions are presentation guidance. They do not change evidence, semantic
selection, project identity, or user-authored layout.

### Label ownership

The SVG renderer applies one deterministic label policy wherever labels are
suppressed:

1. Explicitly hidden labels stay hidden at every width.
2. Visible labels with a manual position are protected. They are never removed
   by the compact budget or by Story Clarity `suppress-or-offset-label`
   suggestions, and they do not count against the compact budget.
3. Remaining labels are automatic. They are ranked Featured, then Supporting,
   then ordinary, with the project ID as the tie-breaker, so input order does
   not matter. At 480px and narrower, only the first eight automatic labels are
   shown.
4. Story Clarity sees only the protected and budget-selected labels, and its
   suppression suggestions apply only to automatic labels.
5. Automatic labels are kept inside the frame at their rendered role font
   size (Featured, Supporting, and ordinary labels are larger at 480px), using
   a conservative glyph width that covers wide fallback fonts. Story Clarity
   analyzes those same positions. Manual label positions are never moved.

Project nodes are never removed to satisfy the label budget. When protected
manual labels overlap each other, the renderer keeps the user's choices and
reports the limitation with `data-label-limitation="manual-labels-overlap"` on
the root `<svg>`.

### Fingerprints

Both exports carry the candidate's `sceneFingerprint`, which identifies the
source scene: the selected projects, evidence, and composition. Because the
480px and 900px exports come from the same source scene, they share this
fingerprint by design. The SVG text itself is specific to each output and can
differ between widths (for example, in which labels are visible). Compare the
SVG bytes, not the scene fingerprint, to identify a particular output file.

## Human comprehension review

The automated geometry checks establish that labels and legends fit; they do
not establish that a person understands the story. Before treating the visual
hierarchy as user validated, show the static export without coaching and ask a
reviewer to answer:

1. Which project is featured, and what visual cue made that clear?
2. Which projects support it, and what evidence connects them?
3. What does each visible connection style mean?
4. Is anything important missing or difficult to distinguish?

Record answers for both 480px and 900px exports, including uncertainty and any
misread relationship. No participant study has been run for this release, so
comprehension remains an explicit human-review item rather than a measured
claim.
