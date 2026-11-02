# Representative migration fixtures

These are synthetic schema fixtures, not captured exports from historical binaries. Each 0.1–0.8 fixture exercises the legacy single-draft adapter with exact BOM, CRLF, mixed line endings, Unicode and code examples. The 0.9 fixture uses the portable schema introduced in 0.9.1. Era labels describe intended coverage; they do not assert a distinct historical schema for each release.

Tests also damage builder metadata and exercise workspace recovery. Feature-specific ownership, collections, visual packs and publishing metadata have their own round-trip suites. Never regenerate expected source through a Markdown renderer.
