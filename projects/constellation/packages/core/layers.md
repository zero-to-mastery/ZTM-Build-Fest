# Scene layers

Scenes compose nine logical layers: background, effects, rings, starfield,
annotations, connections, nodes, labels and selection. Each layer has a stable ID,
type, numeric order and fixed rendering phases. SVG rendering consumes these
records instead of assembling an unrelated global order.

| Phase | Contributions in default order |
| --- | --- |
| backdrop | background, effects, starfield |
| underlay | historical/organization/rhythm annotations |
| world | rings, classic starfield dust, connections, nodes, labels |
| overlay | captions, legends, timestamps and empty-state text |
| interaction | selection/highlight |

The world phase is inside the existing perspective camera and historical scene
markers. Underlay and overlay annotations have different placement but share one
logical layer identity. Starfield similarly controls both background stars and
classic world dust. Selection applies the existing graph highlight pass after
composition. Node-local activity/glow remains attached to node geometry.

This phased composition is deliberate: blindly sorting all SVG fragments into
one flat list would break perspective, animated historical frames and node-attached
effects. Layer phases are validated internal semantics rather than editable
configuration. Defaults preserve the 2.0 SVG byte fixtures.

Scene serialization includes layer records and deterministic order. Config v6
accepts an optional `layers` object:

```json
{
  "version": 6,
  "layers": {
    "rings": { "visible": false },
    "starfield": { "opacity": 0.25, "order": 8 },
    "labels": { "visible": false }
  }
}
```

Visibility defaults to true, opacity to 1. Order is an integer priority from
-1000 to 1000; ties retain the default layer order. Scenes store the resulting
unique ascending order. Ordering applies within each fixed phase. The background
must remain behind decorations, connections behind nodes, and nodes behind labels;
invalid combinations fail validation. Moving dust in front of nodes is supported.

Selection supports visibility only; its intensity remains controlled by highlight
styling. Effects controls background decoration; activity and glow stay attached
to nodes. Hiding nodes does not implicitly hide labels, allowing label-only views.
Controls persist through v6 config, scene and workflow export. They never change
layout coordinates or source data. Missing controls preserve existing SVG bytes.

## Studio

The Studio has no layer editor since v5.0.0. Set `layers` with **Fine-tune** →
**Edit all settings as JSON** or in a settings file. Invalid ordering is
refused with a message and the previous design stays on screen. No layer
editing is required to make a map.

Zero opacity omits a layer's markup, avoiding invisible keyboard targets in
interactive previews. Hiding the selection layer keeps node selection and details
available but suppresses highlight dimming in both the Studio and exported SVG.
Annotation controls also apply to year captions added by the time-lapse adapter.

Try [the layer example](../examples/layer-study.json) and its
[generated SVG](../examples/gallery/layer-study.svg). Run
`node scripts/generate-examples.mjs` to regenerate the offline gallery.
Config imports and share links validate layer IDs and scalar controls; they cannot
supply executable code, markup or arbitrary rendering phases. Workflow export uses
the same validated v6 controls. Scene JSON remains an internal trusted format.

The `mnichols08/constellation` project credit is always rendered independently of annotation visibility, opacity and order, including Temporal Universe exports.
