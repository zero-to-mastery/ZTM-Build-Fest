# Evidence and provenance

Scene Evidence v1 is the shared, JSON-only provenance attachment for explanations in Constellation. It is optional on Scene API v1 scenes, so older serialized scenes remain valid. `scene.evidence` contains deduplicated `facts` and bounded `subjects` that reference those facts. A fact has a compact claim and one of three provenance classes: `source`, `user`, or `derived`.

```json
{
  "version": 1,
  "facts": [
    { "id": "fact:0", "kind": "primary-language", "value": "Rust", "provenance": "source", "source": "github" },
    { "id": "fact:1", "kind": "showcase-role", "value": "featured", "provenance": "user" },
    { "id": "fact:2", "kind": "profile-evidence", "value": "Systems: Rust", "provenance": "derived", "source": "constellation" }
  ],
  "subjects": [{ "kind": "node", "id": "octocat/engine", "facts": ["fact:0", "fact:1", "fact:2"] }]
}
```

## Provenance classes

- **Source evidence** describes compact facts from the already-loaded registered source, such as primary language, available language byte counts, topics, stars, or creation date. It is not an evaluation of quality or ability.
- **User intent** records explicit choices such as a repository in `includeRepos`, a Showcase role, manual position, or manual color. Explicitly selected projects are explained as selected by the user. Showcase roles affect presentation; they do not by themselves determine repository selection.
- **Derived evidence** identifies deterministic Constellation results, such as ordinary scene inclusion through selection and filters and Developer Topology reasons. The existing Rust/WASM profile engine remains canonical for profile evidence and scores; this attachment adapts its reasons without recomputing or changing scores. Profile emphasis changes placement only.

No evidence means “unknown”, not a negative finding. Temporal year explanations use the repository creation date and current metadata; they do not reconstruct historical language, stars, or activity. Evidence describes selected work and configuration. It must not claim professional identity, skill, seniority, or job suitability.

## Scene and Core API

The compiler builds the attachment from final scene nodes, existing Developer Topology reasons, and the explicit configuration. Explicit `includeRepos` entries are recorded as user selection; other included nodes are explained as derived from current scene selection and filters. GitHub existence is source evidence, not an explanation for why a node appears. Source facts are reduced to short scalar claims; whole provider payloads, commit histories, access tokens, and authorization data are not copied. Fact IDs follow deterministic compile order. Duplicate facts are stored once and referenced by each subject. Creation is capped at 32,768 facts, 2,048 subjects, 64 references per subject and eight topic facts per node; scene validation checks record shape, references, scalar values and collection limits.

`node scripts/benchmark-html.mjs` now reports serialized scene bytes with and without evidence. On the fixed 45/256/2,048 node fixtures, the measured evidence attachments were 7.2 KiB, 38.3 KiB and 298.4 KiB. The 2,048-node serialized scene was 2.57 MiB including evidence versus 2.26 MiB without it; the offline HTML artifact was 3.99 MiB, below its existing 12 MiB budget. These are fixture measurements, not universal size guarantees.

```js
import { createScene, explainNode, explainVisual, explainEdge } from '@constellation/core';
const scene = createScene('octocat', repositories, options);
const explanation = explainNode(scene, 'octocat/engine');
const appearance = explainVisual(scene, 'octocat/engine');
const connection = scene.edges[0] && explainEdge(scene, scene.edges[0].id);
```

The APIs are framework-independent and deterministic. They perform no acquisition and need no DOM or network. `explainNode` returns `null` for missing IDs. `explainVisual` describes only mappings and explicit appearance modes present in the scene; a default style does not invent an input metric. A manual color or position takes precedence in the explanation. `explainEdge` reports structured shared-language, shared-topic, or membership reasons and reports unsupported edge reasons as unavailable. The Core API never exposes raw WASM memory.

Core and offline interactive HTML call the same pure explanation helpers over Scene Evidence v1. The Studio's star card writes its own plain-language sentences from your settings and the project's GitHub data, and labels each one **From GitHub**, **Worked out by Constellation** or **Your choice**. Position wording distinguishes Identity Rings, Identity Orbits, Developer Topology and temporal layouts; other deterministic layouts use generic wording. Interactive HTML bundles the helpers locally, uses DOM text APIs, works without network requests, and retains its restrictive CSP. SVG remains a concise accessible summary, not a full evidence report. Existing structured edge metadata may explain shared languages, topics, repository memberships, or commit parents; an edge type with no structured reason should be described as unavailable rather than reverse-engineered from its appearance.

## Privacy, limits, and reuse

Evidence is validated as plain JSON with bounded IDs, text and item counts. Values that look like GitHub/OAuth bearer tokens are excluded. Provider-specific objects and credentials are never enumerated into evidence. Scene exports follow the existing source/privacy filter and should be reviewed before publication; GitHub descriptions and topics can be incomplete or stale.

Scene Evidence v1 also supports `group` subjects for Semantic Groups. User families carry a user-provenance “Defined by you” fact; deterministic derived groups carry bounded derived basis facts. Existing node subjects remain unchanged. Grouping basis explains why a group exists; characteristics describe current member metadata and do not imply the cause of grouping. Characteristics and aggregate relationship evidence use the same bounded secret-filtering policy as Scene Evidence. Projected semantic explanations are validated at the Scene trust boundary, while scenes without explanations remain valid. Aggregate edge explanations preserve complete relationship counts and distinguish universal evidence from partial evidence using exact coverage over the complete represented edge set. Up to five representative examples reference real source edges, while retained source edge IDs remain capped at 256. See [Semantic Groups](semantic-groups.md).
