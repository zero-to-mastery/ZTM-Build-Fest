# Large graphs

Set `nodeCap` above 100 to opt into a stable overview, with a maximum of 2048 nodes. Set `maxRepos` to the desired repository limit, no greater than `nodeCap`. This explicit opt-in uses identity-based Rust coordinates instead of the selected arrangement; it keeps unchanged nodes in place when filters change. Without `nodeCap`, the original layouts and limits remain unchanged. JSON import in the studio expands the project-limit control to the configured cap.

The overview draws a sparse sample of actual relationships. `simplifyAbove` defaults to 256; above it, automatic labels are limited to 100, while manually placed labels remain available. Omission diagnostics explain this limit. The overview is intended for responsive exploration, not for displaying every possible relationship. Exported SVG uses the same policy. Ring snapping projects movable nodes to the nearest configured ring point; manual positions remain fixed. Refinement remains optional and can be expensive on crowded large graphs.

The coordinate cache is keyed by account/seed, size and node identity. Only missing nodes go to Rust; style changes and filter removals reuse existing coordinates. Recomputing after cache eviction yields identical coordinates. `layoutStatistics` exposes computed/reused node counts for benchmarks. Manual positions bypass the generated coordinates.

Plugin hosts cache source snapshots by account, instance, source and options, independently of view/style filters. `host.load(config, { account, refresh: true })` clears snapshots before loading. `host.clearCache()` also invalidates pending loads; an old pending load rejects rather than returning stale data after refresh. Returned nodes are copied. Registries and caches are isolated per host.

Source caches retain at most 32 snapshots within an 8 MiB estimated serialization budget. A larger single snapshot remains usable but is not retained. `host.cacheStatistics` reports entries and estimated bytes (not exact heap size). Run `node --expose-gc scripts/profile-source-cache.mjs` to measure retained heap across twelve 2048-node snapshots, and `node scripts/benchmark-scaling.mjs` for render timings and Rust work counts.

GitHub HTTP request caching is a separate layer from coordinate, pipeline and plugin-source caching. Its TTL, ETag, persistence, authentication and refresh behavior are documented in [GitHub request caching](github-data-cache.md).
