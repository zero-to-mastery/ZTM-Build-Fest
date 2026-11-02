# Project Principles

## 1. The platform is the framework

Prefer Custom Elements, Shadow DOM, semantic HTML, SVG, modern CSS, browser events, Web Workers, and Service Workers where useful. Framework adapters may exist; the core should not depend on them.

## 2. Rust is the engine, not decoration

Strong Rust candidates:

- graph topology;
- adjacency/evidence indexes;
- validation and normalization;
- semantic compilation;
- pathfinding;
- layout/refinement;
- spatial indexing;
- deterministic derived state;
- evidence analysis.

Weak Rust candidates:

- fetch;
- DOM manipulation;
- OAuth redirects;
- Custom Element lifecycle;
- service-worker registration;
- tiny event glue;
- CSS-driven animation.

Use Rust because it improves the architecture, not the language chart.

## 3. AI is a compiler frontend for human intent

Natural language is ambiguous. Geometry should not be.

AI converts intent into semantic constraints. Rust converts those constraints into validated graph behavior.

A future DSL, form builder, config editor, MCP client, or local model should be able to produce the same semantic spec.

## 4. Evidence remains evidence

Constellation may visualize languages, topics, relationships, activity, contribution evidence, and declared project roles. Do not silently turn those into ability scores, employability judgments, personality claims, job titles, or seniority classifications.

## 5. Reproducibility matters

Prefer versioned schemas, stable IDs, seeded randomness, explicit reference dates, deterministic defaults, and documented migrations.

## 6. Progressive enhancement

Static SVG stays first-class. Interactive HTML, `<constellation-view>`, AI authoring, and advanced exploration should enhance the same underlying scene/data model.

## 7. Offline testability is a design constraint

Core behavior should be testable with fixtures without GitHub credentials, an AI provider, network access, or a Rust toolchain for packaged consumers.

## 8. Size and startup matter

WASM has binary size, startup, serialization, copy, and debugging costs. Optimize measured bottlenecks.

## 9. Public contracts should be boring

Expose groups, filters, relationships, focus, placement, clustering, and ranking—not internal physics and memory layout.

## 10. Explainability is a product feature

Constellation should be able to explain why a repository is included, why it belongs to a group, why nodes connect, why a rule failed, and what evidence was used.

## 11. Useful by default

A Constellation feature is successful when it helps a viewer understand a developer's work more quickly, with less effort and without unsupported inference.

The default output must be useful without configuration. Advanced controls may improve or personalize it, but must never be required to rescue it.
