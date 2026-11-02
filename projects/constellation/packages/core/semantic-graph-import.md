# Semantic Graph Import and Round Trip

Semantic Graph v1 JSON is Constellation's portable semantic artifact. The JSON document is the graph itself; it is not wrapped in a separate manifest. Export uses `serializeSemanticGraph(graph)` and import uses `parseSemanticGraph(json)`, which calls `validateSemanticGraph` before returning the canonical graph. Unknown versions fail with `Unsupported Semantic Graph version.`

Files use UTF-8 JSON with the suggested filename `<subject>.semantic-graph.json` (project slashes become hyphens) and media type `application/json`. The maximum serialized size is 16 MiB. Invalid UTF-8 and a leading UTF-8 BOM are rejected. YAML, JSON5, TOML, and JavaScript modules are not supported. Imported values are bounded plain JSON; unsafe keys, secret-like strings, malformed evidence, invalid endpoints, inconsistent groups, and invalid project structure fail validation before projection.

Canonical serialization sorts keys and graph entity arrays. For an unchanged graph, serialize → parse → serialize produces identical bytes and the semantic fingerprint is preserved. The fingerprint is a non-cryptographic change identifier. Evidence, provenance, group membership, project structure, visibility, truncation, and statistics remain part of the artifact. Private visibility is retained, and a graph derived from private data may contain names, paths, and structure derived from a private repository. Credentials and source contents are excluded.

After import, graph-to-Scene projection uses the existing Scene v1 path. Scene, SVG, offline HTML, and Semantic Markdown rendering require no GitHub request. Semantic Markdown is a human-facing one-way projection; it cannot be imported as a graph.

## Studio

The Studio does not import or export semantic graph files since v5.0.0; use the CLI below or Core. **Get it** → **Put it on a website** → **Download portfolio package** includes the semantic graph derived from the current map. Visual presentation settings do not edit the graph artifact.

## CLI

The CLI can read a graph without GitHub credentials, configuration, or network access:

```sh
constellation --semantic-graph alice.semantic-graph.json --format json
constellation --semantic-graph alice.semantic-graph.json --format markdown > profile.md
constellation --semantic-graph alice.semantic-graph.json --format svg --output constellation.svg
constellation --semantic-graph owner-repo.semantic-graph.json --format html --output constellation.html
```

Supported formats are `json`, `markdown`, `svg`, `html`, and `bundle`. JSON and Markdown go to stdout if `--output` is omitted. SVG and HTML use the normal generated output paths. Diagnostics go to stderr. `--fingerprint` prints the semantic fingerprint to stderr. Graph input is mutually exclusive with GitHub acquisition, config, fixture, and migration inputs. For bundle format, `--output` is a required directory and contains the canonical graph, standard Markdown, SVG, standalone HTML, and a versioned manifest. See [Portable Embed and Export](portable-embed.md).

## Guarantees and boundaries

- Developer and project graphs retain their canonical semantic data through exact JSON round trips.
- Fingerprints and Semantic Markdown output remain stable across round trips.
- Imported graphs project through the existing Scene/rendering APIs and work offline.
- Invalid imports fail before any graph or scene is replaced.
- Semantic Graph remains v1; unsupported future versions are rejected rather than guessed or migrated.
- No Markdown-to-graph parser, graph editor, alternate renderer, custom MIME registration, or wrapper manifest is introduced.
