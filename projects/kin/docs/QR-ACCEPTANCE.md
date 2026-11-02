# QR engine: acceptance status (#94, #95)

Each acceptance criterion from issues #94 (encoder) and #95 (decoder) is
marked **Done** (verified by the named test or check), **Partial** or
**Changed** (met in part or in a different form, with the reason), or
**Deferred** (moved to the named issue). Nothing here is marked done without
evidence. Test names refer to `rust/src/qr/` (`coverage.rs`, `tests.rs`,
`wire.rs`, `rs.rs`).

## #94 — encoder

| Criterion | Status | Evidence / reason |
|---|---|---|
| Byte mode, versions 1–10, level M, smallest version chosen | Done | `encode.rs` `choose_version`; `versions_grow_with_the_payload` |
| Reed–Solomon over GF(256), generator built at compile time | Done | `rs.rs` `build_generators` is a `const fn` table; `generators_have_the_standard_roots` |
| Function patterns, format BCH(15,5), version BCH(18,6) from v7 | Done | `golden_grids_match_an_independent_encoder_for_every_mask` pins v1, v4, v5, v7 and v10 grids, so version information is checked against the reference. |
| Zigzag data placement, all 8 masks, 4 penalty rules, lowest chosen | Done | `layout.rs` `DataOrder`, `penalty`; `data_modules_match_the_codeword_capacity_of_every_version`; the golden test covers every mask. |
| Fixed module buffer `[u8; 57 × 57]` plus `size`; no heap on the encode path | Done | `Code { size, dark: [u8; 3249] }`; every encoder buffer (bit stream, blocks, checks) is an array. The ABI result buffer (`wire.rs`) is the only allocation, and the host owns it. |
| `qr_encode(in, len, out) -> size` ABI | Changed | Implemented as `kin_qr_encode(ptr, len)` returning a `KQRM` result, with KERR errors. ABI.md requires host-owned result buffers and KERR on every export; an out-pointer would bypass that contract. The size is in the result header. |
| ISO 18004 Annex I example, byte-mode equivalent, codewords asserted | Changed | `01234567` in byte mode is pinned to the reference grid for all 8 masks. The assertion is on the full module grid, which embeds every codeword, not on a codeword list. The annex's own example is numeric and cannot be a byte-mode fixture. |
| Golden grids in TEST-VECTORS (issue asked for 3 URLs) | Changed | Five texts (the Annex I equivalent, two Kin links, and version 7 and 10 strings), each pinned for all 8 masks by an FNV-1a 64 hash (40 hashes). They are in `docs/TEST-VECTORS.md` and asserted in Rust. Hashes, not full grids, because the full grids would be about 40 KB of bit strings. The hashes are reproducible from the reference encoder. |
| Round-trip every version and mask through the decoder | Done | `every_version_and_mask_round_trips` (80 cases) |
| Reject input over capacity | Done | `TooLong` → `SizeLimit`; `rejects_empty_and_oversized_text` |

## #95 — decoder

| Criterion | Status | Evidence / reason |
|---|---|---|
| Grayscale input up to 1280 × 720 | Done | `MAX_WIDTH`, `MAX_HEIGHT`, `MAX_PIXELS`, checked before any multiplication; `malformed_frames_are_refused_with_the_reason`, `a_symbol_fits_a_full_720p_frame`, `oversized_frames_report_the_size_limit` |
| Adaptive threshold, integral image, fixed scratch sized for the maximum frame | Changed | The integral image and binary buffers live in a reusable `Scratch`, owned by the wire layer for the ABI. They grow to the largest frame seen, capped at `MAX_PIXELS`, rather than being reserved at startup. `scratch_memory_is_reused_across_frames` checks that repeat frames don't grow its capacity. `kin_clear` frees the scratch for reuse by the allocator. WASM linear memory never shrinks, so the high-water mark stays committed to the instance. |
| Finder search; the 3 best candidates | Done | At most 256 candidates (`MAX_FINDERS`), with single-row candidates evicted first when full. Triangles from the 32 strongest are ranked by timing-pattern agreement, then row count, then shape. Up to 12 are tried until one passes the format and Reed–Solomon checks. |
| Alignment search and perspective from 4 points | Done | Template matched along the symbol's own axes in a window of 12 modules, which scales with the symbol and is clamped to the frame; `reads_at_every_fifteen_degrees_of_rotation` (24 angles), `every_version_reads_through_a_mild_tilt` |
| Format info with error tolerance, unmasking, codeword reading | Done | Distance ≤ 3; `a_damaged_format_copy_is_still_read` |
| Reed–Solomon: syndromes, Berlekamp–Massey, Chien, Forney | Done | `rs.rs`, on fixed arrays; `corrects_up_to_half_the_check_symbols`, `reads_damage_up_to_the_correction_budget` |
| Byte-mode payload out, `qr_decode(frame, w, h) -> len` | Changed | Implemented as `kin_qr_decode(ptr, len)` with `width:u32, height:u32, luma` in one buffer, and the payload as the result. Same KERR contract as the rest of the ABI. |
| Frame copied into a preallocated WASM buffer, no copy back | Done (#96) | `web/wasm/kin-qr.js` holds one `kin_alloc` frame buffer per frame size and writes each frame's luma straight into it; nothing is copied back. `one frame buffer is held per frame size…` and `a new frame size replaces the held buffer` in `web/wasm/kin-qr.test.mjs`. |
| Hard caps on frame size, candidates and iterations; no panic | Done | Frame limits as above; `MAX_FINDERS`; `MAX_TRIANGLE_TRIES`; a per-pass work budget (`PIXEL_BUDGET`, 4 000 000 units) charged for axis-scan pixel reads, alignment template checks, finder merge comparisons, timing samples and triangle attempts. Fixed linear passes (binarizing, row runs, the window scan, sampling the grid) are not charged; the frame limits bound them. `exhausting_the_work_budget_ends_the_search` shows that a spent budget ends the search with `NotFound`. Fuzz tests below. |
| No allocation per frame | Partial | The decoder core allocates nothing per frame once its scratch has grown, and the browser codec reuses its frame input buffer (#96). What remains per decode is the engine's result buffer and the payload (at most 213 bytes), plus the canvas `getImageData` copy the browser makes for each frame. `scratch_memory_is_reused_across_frames` checks scratch capacity, not an allocation count. |
| Round trip across all versions and masks | Done | `every_version_and_mask_round_trips` |
| Rotation 0–360°, perspective, scaling, Gaussian noise, blur, inversion, damage | Done | `reads_at_every_fifteen_degrees_of_rotation`, `every_version_reads_through_a_mild_tilt`, `reads_through_perspective_rotation_and_noise`, `reads_at_every_scale_from_three_to_eight_pixels_per_module`, `reads_through_gaussian_sensor_noise` (Irwin–Hall approximation), `reads_light_on_dark_symbols`, `reads_blurred_frames` (radius 1 at 6 px per module), `reads_two_pixel_blur_at_a_comfortable_scale` (radius 2 at 8 px per module), `reads_damage_up_to_the_correction_budget`, `damage_beyond_the_budget_is_refused_or_detected` |
| Fuzz-style panic safety | Done | `fuzz_random_frames_never_panic` (612 frames), `fuzz_corrupted_symbols_never_panic` (120 symbols), `long_fuzz_run` (20 000 frames, `#[ignore]`, passes in release). No wrong payload is returned in the corruption tests. These run in debug builds; the release WASM build wraps arithmetic silently rather than panicking. |
| Finder-like patterns elsewhere in the frame | Partial (documented limit) | Up to 29 finder-like bullseyes as strong as a real finder read correctly (`reads_a_symbol_among_finder_like_decoys`). From 30, the symbol's finders can fall outside the 32-candidate triangle pool, and the frame is refused, never misread (`too_many_decoys_are_refused_not_misread`). More than 256 weaker multi-row patterns ahead of the symbol in raster order also fill the finder table first and lose it, which the independent review reproduced with a tile field. The slowest adversarial frame it measured took 36 ms natively. Timing ranking is what makes this work; the retry of further triangles adds robustness, but no test isolates it. |
| Release-WASM benchmark, ≤ 25 ms at 640 × 480 | Deferred (not measured here) | The native release figure on this machine is 2.6–2.9 ms median at 640 × 480 and 7.0–7.3 ms at 1280 × 720 (`bench_decode_native`). The WASM figure needs the `wasm32` target, which this environment couldn't install. CI builds the WASM but doesn't run the benchmark. The benchmark is `scripts/qr-performance.mjs`; it must be run after `build-wasm.sh`, and its result recorded. |
| Version 1 symbols on perspective frames | Deferred (documented limitation) | The fourth corner needs an alignment pattern, which version 1 lacks. Kin's links are far longer than 14 bytes. Recorded in `docs/ABI.md`. |

## Limits of what the checks prove

- A payload is accepted after the BCH format check, the Reed–Solomon codeword
  check and the byte-mode parse. There is no CRC or signature in a QR symbol,
  so the pairing protocol's own gates (one-time secret, passkey, fingerprint)
  remain the authority (PAIRING.md).
- Only byte mode, level M and versions 1–10 are read.

## Out of scope for this PR

- #96: camera capture, the frame loop and the QR display component (`<kin-qr>`, `<kin-qr-scanner>`, `web/wasm/kin-qr.js`).
- #97, #98: invite and sign-in flows, and their server endpoints and passkey gates.
- #102: PAIRING.md, CHANGELOG and the user-facing docs. The version 1 limit and
  the ABI are documented here and in `docs/ABI.md`.
