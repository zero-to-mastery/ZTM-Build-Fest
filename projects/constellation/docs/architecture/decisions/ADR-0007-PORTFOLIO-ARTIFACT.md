# ADR-0007: Portable portfolio artifacts reuse validated Scene and semantic contracts

**Status:** Accepted  
**Date:** 2026-10-11

## Context

Portfolio embeds need a bounded, deterministic deployable artifact with evidence identities, a static fallback, and corruption detection. The repository already owns Scene v1 validation, Semantic Graph v1 identity, static SVG, interactive HTML, and publication integrity. Browser Studio cannot write directories or ZIP archives through platform APIs without a new dependency.

## Decision

Keep artifact orchestration in JavaScript Core and the CLI. Core reuses validated Semantic Graph v1 and Scene v1, the existing renderers, and Web Crypto SHA-256. The manifest is an internal v1 format; it does not alter Config, Scene, Evidence, Semantic Graph, Semantic Markdown, Atlas State, Project Constellation, or Web Component API versions. It lists fixed relative filenames, bounded UTF-8 sizes, SHA-256 digests, entry points, and the embedded HTML runtime mode. The generated `constellation.html` is the only executable artifact; the validator rejects other executable names and unlisted files. Digests detect corruption, not a replaced manifest, so consumers must trust the delivery channel.

The offline CLI writes the validated artifact directory. Studio's existing publishing flow offers a JSON container around the same manifest and files because browsers have no built-in directory/ZIP writer. Consumers extract that container before hosting. The Web Component remains the runtime for framework integrations; it loads only the explicitly supplied scene and does not fetch GitHub data.

## Consequences

- Invalid or oversized assets fail before export and the component consumes Scene v1 using existing validation.
- Static SVG remains available when JavaScript or WASM is unavailable; standalone HTML embeds its runtime.
- Artifact identity and integrity are inspectable, but hashes do not prove authenticity.
- Rust is unchanged because file packaging, Web Crypto, DOM, and CLI I/O belong to JavaScript.
- Studio's single JSON container can be larger than the sum of its named files due to JSON encoding and is intended for manual download/extraction, not as an archive standard.
