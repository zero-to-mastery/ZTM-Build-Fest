# Story Composition v1

Story Composition is an internal bounded Rust/WASM operation used by the
existing Projects, Technical Shape, and Journey candidates. It does not add a
candidate or change Config v7, Scene v1, Evidence v1, or Semantic Graph v1.

The compositor consumes the selected project IDs, primary language, topics,
featured role, current scene position, user-authored family membership, and
existing explicit project relationships. It creates one stable connection per
project pair, combines all applicable evidence references on that connection,
and ranks authored relationships before shared language and shared topics.
Featured endpoints and shorter geometric distance break later ties. The native
compositor defaults to two connections per project and is capped at 4,096.
Story candidates request at most one connection per selected project, keeping
dense Profile Story scenes readable within their existing 12-project bound.

Every emitted connection carries a stable ID, endpoints, semantic type, all
supporting evidence keys, and a deterministic score. Connections omitted by the
budget have bounded per-edge diagnostics. Authored relationships whose endpoint
is hidden by a story projection receive an `endpoint-not-visible-in-this-story-view`
diagnostic. Projects and Technical Shape preserve their bounded project nodes
even when authored families cover the selection; family membership is drawn as
an evidence-backed relationship between those visible projects.

Static SVG uses solid paths for shared languages, dashed paths for shared
topics and authored families, and dotted paths for explicit project
relationships. Each path has an accessible title naming its endpoints and
available evidence. Up to three longer, spatially separated paths receive visible evidence labels;
short paths keep their accessible titles without placing text across the
connection. A compact legend appears below the constellation when more than
one relationship type is visible. Color is not the only distinction.

The operation is deterministic under record reordering. It accepts at most 512
projects, 256 families, 4,096 explicit relationships, 64 language/topic facts
per project, and a 1 MiB serialized input. It uses primary language metadata
already present in Semantic Graph v1; it does not infer dependency, ownership,
collaboration, skill, or professional-experience claims. Rust positions are
used only as a bounded distance tie-breaker; browser text metrics remain owned
by the renderer.

## Manual static-SVG review

For a release review, render representative small (3–5 project), typical (12 project),
and long-name fixtures at 480 px compact profile width and 900 px README width.
Inspect both light and dark themes in a browser, then inspect the downloaded SVG
with scripting and network disabled. Check that featured names remain readable,
labels do not collide or cover stars, relationship labels and line styles remain
legible, technical groups are visually separable, and the legend does not cover
important content. Repeat at a narrow 320 px viewport and with reduced motion
enabled. This review checks actual browser text rendering; Rust placement uses
bounded text-width approximations and does not claim browser-exact metrics.

The 2026-10-10 Chrome review used six- and twelve-project fixtures at 480 px
and 900 px in light and dark themes. The original all-edge labels collided on
dense graphs and the legend fell outside cropped viewBoxes; the renderer now
labels only three longer, separated paths and places the multi-type legend in
reserved space below the nodes. In the reviewed outputs, featured labels stay
emphasized, relationship patterns remain distinguishable without color, and
the starfield remains subordinate to the project nodes. Long labels still use
the existing compact name treatment; their SVG titles retain the full names.
