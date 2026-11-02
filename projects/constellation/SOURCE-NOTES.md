# Source Notes

Prepared against the public `mnichols08/constellation` repository as observed on 2026-10-03.

Consulted repository areas:

- root README;
- `docs/core-api.md`;
- `docs/web-component.md`;
- `docs/extension-authoring.md`;
- package/repository structure.

Key constraints reflected in this kit:

- v3 uses bundled Rust/WASM;
- core targets Node 22+ and browsers with WebAssembly;
- core has no runtime npm dependencies;
- Web Component is framework-free and uses Shadow DOM;
- contracts are versioned;
- GitHub acquisition is separable from rendering/computation;
- config/component inputs should not implicitly execute arbitrary plugins/code;
- accessibility and reduced motion are part of the component contract;
- developer topology is evidence-oriented, not a professional-ability assessment.

Reconcile wording with any repository changes made after 2026-10-03 before committing wholesale.
