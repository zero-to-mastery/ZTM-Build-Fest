# Portable extensions are declarative data

Extension packs need to add reusable component shapes without turning a shared JSON file into a browser plugin system. README Studio therefore accepts version-1 `readme-studio-extension-manifest` objects only inside version-2 snippet packs. A manifest has a named HTTPS publisher, an explicit list of allowlisted inert capabilities and ordinary version-1 component entries. It cannot name code, modules, scripts, handlers or active HTML. Rendering uses the existing string interpolator and sanitized preview; validation never imports or evaluates a module.

The pack review is the trust boundary. It shows the local provenance label, author/publisher claims, capabilities and collected external URLs before the author can import. Import performs no network request and leaves the current draft unchanged. Loading a rendered remote image remains a separate explicit action that can contact its host.

New pack exports use version 2. Version-1 packs migrate in memory by adding an empty extension list while preserving component source exactly. Unknown future versions are rejected. This prevents an older reader from accepting a file while silently discarding extensions and gives future executable-looking fields fail-closed behavior.
