# Contributing

Use Node 22.12+ and `npm ci`, then `npm run dev`. Core authoring needs no credentials or backend. See [contributor checks](docs/contributing.md), [architecture](docs/architecture.md) and the [documentation index](docs/index.md).

## Validation

Run `npm test`, `npm run test:browser`, `npm run build` and `npm run test:static` for normal changes. Install browser binaries with `npx playwright install chromium firefox webkit`. Release checkpoints require `npm run test:browser:all`. Rust changes also require `npm run test:rust`, `npm run build:wasm` and `npm run test:wasm`; the pinned toolchain and build instructions are in [the Rust guide](docs/rust-core.md).

Keep pure serialization, validation and transformation logic outside DOM components. Use existing URL-safety and preview sanitization boundaries. Never make sanitized preview HTML the source for a Markdown export. Use ordinary readable JavaScript modules and native Web Components; avoid adding dependencies for small helpers.

Format with Prettier using the repository scripts. Do not format malicious/source-preservation fixtures or the maintainer-owned roadmap. Use synthetic fixtures and mocked network responses. Test failure behavior as well as the successful path. Automated browser checks are not a substitute for keyboard, touch or screen-reader review.

## Compatibility and security-sensitive work

Public format changes need explicit schema versions, deterministic migration fixtures, future-version rejection and exact Markdown recovery tests. Do not infer a new schema from the application version. Do not silently overwrite unsupported files or browser storage.

Treat imports, metadata, URLs, SVG settings and workflow settings as untrusted. Authentication credentials belong only in the publishing server's ephemeral session boundary. Do not put secrets in fixtures, browser state, logs, projects or release artifacts. Publishing changes need tests for permissions, stale SHAs, review invalidation and partial failures. Use test repositories only for explicitly authorized live write verification.

## Pull requests and releases

Explain the resulting behavior, preservation/recovery guarantees and relevant test evidence. State limits honestly, particularly manual checks and live integrations that were not exercised. Follow [the release process](docs/releasing.md); each requested version must have its own tested checkpoint. Do not combine a release train into a final version bump.
