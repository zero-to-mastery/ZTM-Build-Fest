# Reading a constellation

This page explains what a constellation's rings, colours, sizes and motion can
mean, and which parts are only decoration. It used to describe the
"Semantic Studio" tour, presets and randomizer locks; those screens were
replaced in v5.0.0. For how to use the Studio, read the
[Studio guide](studio.md).

In the Studio, click any star to open its card. The card says in plain
sentences why the star is on the map, where it sits, and what its size and
colour show, and marks each reason **From GitHub**, **Worked out by
Constellation**, or **Your choice**.

## Reading a constellation

| Encoding | What it says | Missing evidence |
| --- | --- | --- |
| Identity rings (default) | Account-seeded geometric anchors; distance has no importance meaning | No project classification |
| Capability rings | Six sectors use strongest Developer Topology affinity; stronger evidence is closer | Outer no-evidence band |
| Showcase rings | Featured, Supporting, Experimental, Historical, then Unassigned, inner to outer | Explicit Unassigned band |
| Repository update rings | Within 30 days, 31–180, 181–365, older, then unavailable/future dates | Explicit unavailable/future band |
| Era rings | Creation dates, oldest inside; five-year units merged into at most five dated bands | Separate outer unavailable band |
| Developer Profile Sun | Six labelled rays; longer rays mean more evidence across selected projects | Zero-length ray, dimension label and no-evidence description |
| Color, size and glow | The mappings you chose under **Details** and **Look** | Existing mapper fallbacks; authored colors take precedence |
| Ring motion, floating, twinkle, camera motion | Decorative presentation | No motion required to read evidence |

In the Studio, ring meaning is **Distance from the centre shows** in
**Fine-tune** (Nothing in particular, Kind of work, Featured first, Recently
updated first, Newest first). The Profile Sun is **Centre of the map** →
**Your profile summary**. In configuration they are `ringMeaning` and
`accountSun`.

Profile evidence reuses Rust Developer Topology: languages, topics and authored role weights. Scores are bounded evidence indicators, not percentages of expertise, job titles or skill assessments. In interactive exports, select a ray or focus it with the keyboard to inspect contributing repositories and reasons. SVG descriptions contain those reasons. Labels survive monochrome rendering.

Capability ties use stable order: Interface, Services, Data, Systems, Tooling, Automation. Strength bands use the existing 0–1 affinity: at least 0.67, at least 0.34, positive but below 0.34, and zero. These thresholds describe the evidence model, not measured ability.

Recency uses `pushed_at`, falling back to `updated_at`, relative to the configuration’s reference date. It is **not contribution activity**. Era rings use creation dates of surviving repositories and current metadata, **not historical snapshots**. Existing temporal views and recorded snapshots remain separate features.

## Group detail

**Group related projects** in Fine-tune selects Automatic, Grouped or Every
project. Automatic follows camera scale with hysteresis; the other two lock the
projection. It is stored as `semanticZoom: { "mode": "auto" | "groups" | "projects" }`
in Config v7. See [Semantic Groups](semantic-groups.md) for thresholds and
legacy-config normalization.

## Reading guide in exports

`semanticLegend: true` appends a static reading guide below an exported SVG;
leave it off for compact README images. Set it in **Edit all settings as JSON**
or a settings file. Accessible descriptions are always included. Profile Sun
and semantic band labels are visible without hover.

## Compatibility and limits

Additive fields: `accountSun: "profile"`, `ringMeaning: "identity" | "capability" | "showcase" | "activity" | "era"`, and `semanticLegend: true | false`. Existing `accountSun: "sun"` means Identity. Absent new fields retain legacy visuals. Config JSON, shares, CLI/Action workflows and generated Core copies use the same schema and renderer.

Semantic rings apply to repository nodes in the built-in Rings arrangement. Other arrangements retain their layouts. Manual node positions override bands. Refinement and decorative ring/floating motion do not move semantic nodes between evidence bands; switch to Identity for those free-form effects.

Design codes written by the old randomizer (`v1`–`v6`) still decode from share links and settings files. Partial and locked draws stored explicit configuration, so they replay exactly from a settings file or share link.

Rust `semantic_layout` accepts at most 256 normalized repository records and 1,000,000 input bytes. It validates dates, roles, evidence and finite rotations, rejects duplicate IDs, sorts IDs deterministically, and returns profile scores/evidence, categories, bands, sectors, positions, ray geometry and label anchors. Native and WASM share the algorithm. Dates are explicit inputs; Rust reads no clock or network and uses no system randomness. Oversized input reports an error rather than dropping projects.

Changing ring meaning, the Profile Sun, group detail or any other presentation setting requests no GitHub data. Public exploration keeps its two-request load.
