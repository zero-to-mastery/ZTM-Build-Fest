# Constellation theme packs

Import `themePacks` from `@constellation/themes`. Each entry has `id`, an exact content `version`, and `preset`. Register packs with `host.registerThemePack(pack)` and pass `themePack: { id, version }` to `host.render`, or embed the whole pack in portable config.

Package and content versions are independent. Package 1.0.1 retains the original 1.0.0 pack content. Use a new content version when changing a preset; keep old versions available for reproducible saved designs. Explicit caller styling takes precedence.
