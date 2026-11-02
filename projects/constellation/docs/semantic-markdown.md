# Semantic Markdown v1

Semantic Markdown is a deterministic, bounded projection from Semantic Graph v1 to Markdown. It reads the portable graph directly, validates it first, and does not use Scene, layout, SVG, DOM, or Studio state. It is useful without AI and is not an import format or a source of truth.

```js
import { renderSemanticMarkdown } from '@constellation/core';

const markdown = renderSemanticMarkdown(graph, { detail: 'standard' });
```

The public API is `renderSemanticMarkdown(graph, options?)`; `SEMANTIC_MARKDOWN_VERSION` is `1`. Detail is `summary`, `standard` (the default), or `detailed`. Summary gives a compact inventory, standard adds factual languages, topics, relationships, structure, and coverage, and detailed adds bounded evidence or provenance context. No mode dumps the graph JSON.

Developer graphs list repositories, user-defined project families, derived repository-owner groups, factual language/topic relationships, and generic explicitly curated project relationships. A repository-owner group means only that projects share an owner; it does not imply a shared purpose. External projects are not described as owned by the developer. User-authored relationships remain generic and are not restated as dependencies or architectural claims. A `uses-language` edge means the project uses that language; “Primary language” is printed only when explicit project metadata supplies the same language.

Project graphs show repository identity, ref and commit when present, visibility, a bounded structural hierarchy, package entry points, verified workspace and static import relationships, and source coverage. Structural wording follows the graph's `contains`, `workspace-member`, `entry-of`, and `imports` edges and their evidence. A workspace member is the edge target; an entry point is also the `entry-of` target, while an import is described from source to target using its stored literal specifier. Static import evidence does not claim runtime behavior. Private graphs include a warning that exporting Markdown may disclose repository names, paths, and structure.

Source graph truncation and Markdown projection truncation are independent. Source coverage warnings and up to eight source limitations are emitted before optional sections, so a Markdown size cap cannot hide incomplete source data. Projection omissions receive a separate notice. Limits are 512 KiB, 12,000 lines, 64 projects, 128 groups, 32 displayed members per group, 512 relationships, 64 languages, 128 topics, 8 languages and 16 topics per project, 256 structure nodes, 64 evidence items, and 300 description characters. Collection ordering is stable. The renderer does not mutate its input.

Graph values are normalized to one line before escaping, code-span creation, or bounding: CRLF, CR, and LF sequences become a single space. Values are escaped for Markdown text; paths and identifiers use dynamically sized code fences. No raw HTML is emitted and arbitrary URLs are rendered as plain code text. The Semantic Graph validator rejects unsafe secret-like values before projection. Descriptions, when present in detailed output, are bounded.

Semantic Markdown does not parse Markdown, import graphs, infer documentation, generate prose with AI, edit README files, or create repository commits. Semantic Graph v1, Scene v1, Evidence v1, Project Constellation v1, Config v7, and Web Component API v1 remain unchanged.
