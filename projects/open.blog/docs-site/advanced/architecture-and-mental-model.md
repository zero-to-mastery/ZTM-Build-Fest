---
title: Architecture and Mental Model
parent: Advanced Capabilities
nav_order: 1
---

# Architecture and Mental Model

open.blog is a **Markdown-first static publishing system** with a Rust core and optional browser-based authoring layer.

## System model

1. **Source of truth**: files in your repository (`content/`, `themes/`, `openblog.json`).
2. **Compilation**: `openblog build` converts source into static output (`dist/`).
3. **Distribution**: any static host (GitHub Pages, Netlify, self-hosted static serving).
4. **Authoring options**: CLI-only or Admin (`openblog serve --admin`) over same files.

## Workspace boundaries

- `crates/openblog-core`: parsing, rendering, feeds, search model.
- `crates/openblog-wasm`: browser-facing WASM bindings.
- `crates/openblog-cli`: command orchestration, server/admin features, import/publish flows.
- `web/`: stylesheet, components, search integration assets.
- `themes/`: design tokens + optional styles/scripts/fonts.

## Why this matters

- No hidden database state.
- Git-native backup and change history.
- Reproducible builds and deploys.
- Easy local/remote environment parity.

## Operational principle

Treat **build output as disposable** and **source content/config as durable**.

- Durable: `content/`, `themes/`, `openblog.json`, tracked media.
- Disposable: `dist/`, temporary build artifacts.
