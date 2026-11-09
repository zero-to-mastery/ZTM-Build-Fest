# Optional Rust/WASM analysis core

The editor and preview require no Rust or WebAssembly. Health lazily loads a local WASM asset inside its worker, with a two-second load deadline. Missing assets, unsupported WebAssembly, offline fetch failures and runtime errors fall back to the matching JavaScript implementation. No third-party request is made. A failed load is cached for that worker lifetime.

## Scope and API

Marked remains the single Markdown parser. The Rust crate does not introduce another Markdown dialect. `document_stats(source)` counts lines, ECMAScript-whitespace-separated source words, UTF-16 characters and UTF-8 bytes in one pass. The browser uses this statistics path, retaining JavaScript for token-derived boundaries and rules.

The portable crate also exports `analyze_readme(source, headingsJson)`, `extract_sections(length, headingsJson)` and `lint_structure(length, headingsJson)`. Headings are parser-supplied `{level,start,end}` records with original UTF-16 offsets. These APIs validate ranges and return `{ok,value}` or `{ok:false,error}` JSON, never interpret HTML, and never change source. Full structural API output is parity-tested against JavaScript, but is not transferred through JSON in the browser hot path.

Why that boundary? The initial experiment transferring all section records cost about 41 ms versus 6 ms in JavaScript at 500 KB. The final statistics-only transfer plus JS boundaries measured 1.871 ms versus 6.485 ms at 500 KB. At 1 MB it measured 9.557 ms versus 21.600 ms. These are warm Node measurements on this development machine, not browser latency guarantees. Rust is retained for the measured statistics improvement and portable deterministic API, not as a replacement for UI or parsing.

## Reproduce measurements

`npm run benchmark:analysis` measures parsing and cached analysis separately at 10/100/250/500 KB and 1 MB. The pre-Rust results are preserved in `docs/analysis-baseline.json`: 100 KB parse/analysis 13.359/10.843 ms; 500 KB 61.674/35.054 ms. `npm run benchmark:core` includes transfer costs for the runtime boundary; results are in `docs/analysis-core-benchmark.json`. Both discard warmup and report the median of five runs. Results vary by machine and workload.

Health initially renders 100 findings with an explicit Show more control and limits the section inventory to its first 100 entries, reducing large-document DOM work. The complete structural model retains all sections and caps findings at 1,000. The parser cache retains only the latest source.

## Build, tests and size

Consumers run ordinary `npm ci` and `npm run build`; generated JS/WASM is committed. Contributors changing Rust need the pinned Rust 1.93 toolchain and wasm-pack 0.15.0. Run `npm run test:rust`, `cargo fmt --manifest-path rust/readme-core/Cargo.toml --check`, `npm run build:wasm`, and `npm run test:wasm`. CI rebuilds WASM and runs parity against that rebuilt artifact, alongside native tests and formatting checks.

The optional WASM artifact is 140,743 bytes (56,368 gzip); generated JS glue minifies to about 3.8 KB. The JS fallback source is roughly 1.3 KB and shares the existing analyzer/Marked dependency. WASM and glue are separate assets loaded only by Health. No parser crate, UI framework or network client was added. Serde, serde_json and wasm-bindgen are pinned through Cargo.lock.

The shared fixture corpus lives in `tests/fixtures/analysis`; parity checks also cover CRLF, BOM/ECMAScript whitespace, lone surrogates, malformed HTML, and deterministic 100/250/500 KB/1 MB runs. Browser tests exercise the actual worker WASM asset and an aborted-asset fallback in Chromium, Firefox and WebKit. Completion assertions use generous timeouts rather than fragile speed thresholds.

Build integration follows the [wasm-pack web target](https://wasm-bindgen.github.io/wasm-pack/book/commands/build.html) and [wasm-bindgen explicit initialization](https://wasm-bindgen.github.io/wasm-bindgen/examples/without-a-bundler.html). Generated artifacts are excluded from Prettier and regenerated only by the Rust build script.
