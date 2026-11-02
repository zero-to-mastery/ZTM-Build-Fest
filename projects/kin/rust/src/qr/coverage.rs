//! Decoder verification beyond the round trips in `tests.rs`: every version
//! and mask, inverted and blurred frames, perspective across the version
//! range, damage at and beyond the correction budget, malformed and oversized
//! frames, scratch reuse, and panic-safety fuzzing.
//!
//! The long fuzz run is `#[ignore]`d; run it with
//! `cargo test --release qr::coverage -- --ignored`.

use super::tests::{code_from, render, warp};
use super::{
    decode::{
        decode, decode_in, decode_with_budget, project, solve_homography, Frame, Scratch,
        MAX_PIXELS, PIXEL_BUDGET,
    },
    encode::{encode, encode_with_mask, Code, MAX_BYTES},
    layout::{format_modules, Grid, MAX_MODULES},
    tables, QrError,
};

/// Longest payload a version holds at level M, in bytes.
fn capacity_bytes(version: usize) -> usize {
    let bits = tables::DATA_CODEWORDS[version - 1] * 8;
    (bits - 4 - tables::count_bits(version)) / 8
}

/// Deterministic xorshift, so every failure reproduces.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}

fn text_of(length: usize, seed: u8) -> Vec<u8> {
    (0..length)
        .map(|i| b'a' + ((i as u8).wrapping_mul(7).wrapping_add(seed) % 26))
        .collect()
}

fn decode_luma(width: usize, height: usize, luma: &[u8]) -> Result<Vec<u8>, QrError> {
    decode(&Frame {
        width,
        height,
        luma,
    })
}

/// Wraps a rendered symbol in a white `width` × `height` canvas, centred.
fn pad_to(width: usize, height: usize, frame: &(usize, usize, Vec<u8>)) -> Vec<u8> {
    let (w, h, luma) = frame;
    let mut canvas = vec![255u8; width * height];
    let (x0, y0) = ((width - w) / 2, (height - h) / 2);
    for y in 0..*h {
        canvas[(y0 + y) * width + x0..(y0 + y) * width + x0 + w]
            .copy_from_slice(&luma[y * w..(y + 1) * w]);
    }
    canvas
}

/// A box blur of radius `radius` pixels, as an out-of-focus lens produces.
fn blur(frame: &(usize, usize, Vec<u8>), radius: usize) -> (usize, usize, Vec<u8>) {
    let (w, h, luma) = frame;
    let mut out = vec![0u8; w * h];
    for y in 0..*h {
        for x in 0..*w {
            let (mut sum, mut count) = (0u32, 0u32);
            for yy in y.saturating_sub(radius)..=(y + radius).min(h - 1) {
                for xx in x.saturating_sub(radius)..=(x + radius).min(w - 1) {
                    sum += u32::from(luma[yy * w + xx]);
                    count += 1;
                }
            }
            out[y * w + x] = (sum / count) as u8;
        }
    }
    (*w, *h, out)
}

/// The frame of `source` tilted to the four `corners` on a square canvas.
fn tilt(
    source: &(usize, usize, Vec<u8>),
    corners: [(f64, f64); 4],
    canvas: usize,
) -> (usize, usize, Vec<u8>) {
    let (w, h) = (source.0 as f64, source.1 as f64);
    let forward = solve_homography([
        ((0.0, 0.0), corners[0]),
        ((w, 0.0), corners[1]),
        ((w, h), corners[2]),
        ((0.0, h), corners[3]),
    ])
    .expect("a non-degenerate quadrilateral");
    warp(source, forward, (canvas, canvas), 5)
}

/// A 1280 × 720 frame: `decoys` finder-like bullseyes (7 × 7 modules, the
/// symbol's own module size) in the upper part, and the symbol bottom-centre.
fn decoy_frame(code: &Code, decoys: usize, jitter: bool) -> (usize, usize, Vec<u8>) {
    let (w, h, scale) = (1280usize, 720usize, 5usize);
    let mut luma = vec![255u8; w * h];
    let symbol = render(code, scale);
    let (x0, y0) = ((w - symbol.0) / 2, h - symbol.1);
    for y in 0..symbol.1 {
        luma[(y0 + y) * w + x0..(y0 + y) * w + x0 + symbol.0]
            .copy_from_slice(&symbol.2[y * symbol.0..(y + 1) * symbol.0]);
    }
    let pitch = 50usize;
    let columns = w / pitch;
    let mut rng = Rng(0x5EED);
    for index in 0..decoys {
        let (column, row) = (index % columns, index / columns);
        let (mut left, mut top) = (column * pitch + 6, row * pitch + 6);
        if jitter {
            left += rng.below(8);
            top += rng.below(8);
        }
        if top + 7 * scale >= y0 {
            break;
        }
        for my in 0..7usize {
            for mx in 0..7usize {
                let ring = (mx as isize - 3).abs().max((my as isize - 3).abs());
                let dark = ring != 2;
                for py in 0..scale {
                    for px in 0..scale {
                        let at = (top + my * scale + py) * w + left + mx * scale + px;
                        luma[at] = if dark { 0 } else { 255 };
                    }
                }
            }
        }
    }
    (w, h, luma)
}

#[test]
fn every_version_and_mask_round_trips() {
    for version in 1..=10 {
        let text = text_of(capacity_bytes(version), version as u8);
        for mask in 0..8u8 {
            let code = encode_with_mask(&text, Some(mask)).expect("encodes");
            let (w, h, luma) = render(&code, 4);
            assert_eq!(
                decode_luma(w, h, &luma).as_deref(),
                Ok(text.as_slice()),
                "version {version}, mask {mask}"
            );
        }
    }
}

#[test]
fn every_version_reads_through_a_mild_tilt() {
    // Symbols that are sure to be tilted, not just rotated: each corner moves
    // a few percent of the frame. Version 1 has no alignment pattern and is
    // the documented limit, so it is covered by the straight round trip above.
    for version in 2..=10 {
        let text = text_of(capacity_bytes(version), 3);
        let code = encode(&text).expect("encodes");
        let source = render(&code, 8);
        let frame = tilt(
            &source,
            [(40.0, 46.0), (600.0, 30.0), (616.0, 606.0), (28.0, 620.0)],
            660,
        );
        assert_eq!(
            decode_luma(frame.0, frame.1, &frame.2).as_deref(),
            Ok(text.as_slice()),
            "version {version}"
        );
    }
}

#[test]
fn reads_light_on_dark_symbols() {
    for version in [1usize, 4, 10] {
        let text = text_of(capacity_bytes(version), 9);
        let code = encode(&text).expect("encodes");
        let (w, h, mut luma) = render(&code, 6);
        for value in luma.iter_mut() {
            *value = 255 - *value;
        }
        assert_eq!(
            decode_luma(w, h, &luma).as_deref(),
            Ok(text.as_slice()),
            "inverted version {version}"
        );
    }
}

#[test]
fn reads_blurred_frames() {
    let text = b"https://kin.example.org/#sign-in=q7tk-2mzp-vx8r-3hdn";
    let code = encode(text).expect("encodes");
    let source = render(&code, 6);
    // One pixel of blur is the sharpness a phone's focus delivers on a screen.
    let once = blur(&source, 1);
    assert_eq!(
        decode_luma(once.0, once.1, &once.2).as_deref(),
        Ok(text.as_slice()),
        "radius 1"
    );
}

#[test]
fn reads_damage_up_to_the_correction_budget() {
    // Level M corrects half the check codewords of each block. Flipping one bit
    // in each of the first codewords spreads damage across the interleaved
    // blocks; keeping one below the limit per block must still decode.
    for version in 1..=10 {
        let text = text_of(capacity_bytes(version), 21);
        let mut code = encode(&text).expect("encodes");
        let grid = Grid::with_function_patterns(version);
        let order: Vec<usize> = grid.data_order().collect();
        let blocks = tables::block_data_lengths(version).count;
        let budget_per_block = tables::EC_PER_BLOCK[version - 1] / 2 - 1;
        for codeword in 0..blocks * budget_per_block {
            code.dark[order[codeword * 8]] ^= 1;
        }
        let (w, h, luma) = render(&code, 6);
        assert_eq!(
            decode_luma(w, h, &luma).as_deref(),
            Ok(text.as_slice()),
            "version {version}"
        );
    }
}

#[test]
fn damage_beyond_the_budget_is_refused_or_detected() {
    // Damage the first 43 codewords in placement order (about 22 and 21 in
    // version 4's two blocks, which correct 9 each). A decoder may refuse, but
    // it must never report a different payload as if it were correct.
    let text = text_of(capacity_bytes(4), 33);
    let mut code = encode(&text).expect("encodes");
    let grid = Grid::with_function_patterns(4);
    let order: Vec<usize> = grid.data_order().collect();
    for &index in order.iter().take(8 * 43) {
        code.dark[index] ^= 1;
    }
    let (w, h, luma) = render(&code, 6);
    match decode_luma(w, h, &luma) {
        Err(_) => {}
        Ok(payload) => assert_eq!(payload, text, "a wrong payload must never be returned"),
    }
}

#[test]
fn a_damaged_format_copy_is_still_read() {
    // Format information is stored twice. Damage in one copy must not stop the
    // other from being read.
    let text = b"format copies";
    let mut code = encode_with_mask(text, Some(5)).expect("encodes");
    let size = code.size;
    for (x, y, _) in format_modules(size).into_iter().take(3) {
        code.dark[y * size + x] ^= 1;
    }
    let (w, h, luma) = render(&code, 6);
    assert_eq!(decode_luma(w, h, &luma).as_deref(), Ok(&text[..]));
}

#[test]
fn malformed_frames_are_refused_with_the_reason() {
    let frame = |width: usize, height: usize, length: usize| {
        decode(&Frame {
            width,
            height,
            luma: &vec![0u8; length],
        })
    };
    assert_eq!(frame(0, 10, 0), Err(QrError::BadFrame), "zero width");
    assert_eq!(frame(10, 0, 0), Err(QrError::BadFrame), "zero height");
    assert_eq!(frame(10, 10, 99), Err(QrError::BadFrame), "short luma");
    assert_eq!(frame(1281, 1, 1281), Err(QrError::FrameTooLarge), "wide");
    assert_eq!(frame(1, 1281, 1281), Err(QrError::FrameTooLarge), "tall");
    assert_eq!(
        frame(1280, 721, 1280 * 721),
        Err(QrError::FrameTooLarge),
        "one row past 1280 × 720"
    );
    assert_eq!(
        frame(720, 1280, 720 * 1280),
        Err(QrError::NotFound),
        "portrait 720p is within the limit"
    );
}

#[test]
fn blank_and_flat_frames_have_no_symbol() {
    for value in [0u8, 255, 128] {
        let luma = vec![value; 320 * 240];
        assert_eq!(decode_luma(320, 240, &luma), Err(QrError::NotFound));
    }
}

#[test]
fn a_symbol_fits_a_full_720p_frame() {
    let text = b"https://kin.example.org/#join=7kq4";
    let code = encode(text).expect("encodes");
    let frame = render(&code, 8);
    let canvas = pad_to(1280, 720, &frame);
    assert_eq!(
        decode_luma(1280, 720, &canvas).as_deref(),
        Ok(&text[..]),
        "centred in 1280 × 720"
    );
}

#[test]
fn exhausting_the_work_budget_ends_the_search() {
    // The same clean symbol reads with the production budget and is refused,
    // not scanned further, when the budget is too small to find it.
    let text = b"https://kin.example.org/#join=budget";
    let code = encode(text).expect("encodes");
    let (w, h, luma) = render(&code, 6);
    let frame = Frame {
        width: w,
        height: h,
        luma: &luma,
    };
    let mut scratch = Scratch::new();
    assert_eq!(
        decode_with_budget(&frame, &mut scratch, PIXEL_BUDGET).as_deref(),
        Ok(&text[..])
    );
    for budget in [0usize, 1, 100, 1_000] {
        assert_eq!(
            decode_with_budget(&frame, &mut scratch, budget),
            Err(QrError::NotFound),
            "budget {budget}"
        );
    }
}

#[test]
fn reads_a_symbol_among_finder_like_decoys() {
    // Up to 29 bullseyes as strong as a real finder, above the symbol. The
    // decoder tries several triangles and ranks them by their timing patterns.
    let text = b"https://kin.example.org/#join=7kq4-zpm2-hr9t-vxb6";
    let code = encode(text).expect("encodes");
    for jitter in [false, true] {
        for decoys in [1usize, 10, 29] {
            let (w, h, luma) = decoy_frame(&code, decoys, jitter);
            assert_eq!(
                decode_luma(w, h, &luma).as_deref(),
                Ok(&text[..]),
                "{decoys} decoys, jitter {jitter}"
            );
        }
    }
}

#[test]
fn too_many_decoys_are_refused_not_misread() {
    // Past the triangle pool (32 finders, so 29 decoys plus the symbol's three),
    // the symbol may be missed. It must be refused, never misread.
    let text = b"https://kin.example.org/#join=7kq4-zpm2-hr9t-vxb6";
    let code = encode(text).expect("encodes");
    for decoys in [30usize, 60, 200] {
        let (w, h, luma) = decoy_frame(&code, decoys, true);
        if let Ok(payload) = decode_luma(w, h, &luma) {
            assert_eq!(payload, text, "{decoys} decoys: wrong payload");
        }
    }
}

#[test]
fn scratch_memory_is_reused_across_frames() {
    let text = b"https://kin.example.org/#join=reuse";
    let code = encode(text).expect("encodes");
    let frame = render(&code, 8);
    let canvas = pad_to(1280, 720, &frame);
    let mut scratch = Scratch::new();
    let read = |scratch: &mut Scratch| {
        decode_in(
            &Frame {
                width: 1280,
                height: 720,
                luma: &canvas,
            },
            scratch,
        )
    };
    assert_eq!(read(&mut scratch).as_deref(), Ok(&text[..]));
    let after_first = scratch.reserved_bytes();
    for _ in 0..3 {
        assert_eq!(read(&mut scratch).as_deref(), Ok(&text[..]));
        assert_eq!(scratch.reserved_bytes(), after_first, "no growth per frame");
    }
    // A smaller frame needs less, and never more than the first one reserved.
    let small = render(&code, 3);
    assert!(decode_luma(small.0, small.1, &small.2).is_ok());
    assert!(scratch.reserved_bytes() <= after_first);
}

#[test]
fn data_modules_match_the_codeword_capacity_of_every_version() {
    // Total codewords (ISO/IEC 18004 table 9) times eight, plus the remainder
    // bits that don't fill a codeword (versions 2–6 have seven).
    const TOTALS: [usize; 10] = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
    const REMAINDER: [usize; 10] = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
    for version in 1..=10 {
        let grid = Grid::with_function_patterns(version);
        assert_eq!(
            grid.data_order().count(),
            TOTALS[version - 1] * 8 + REMAINDER[version - 1],
            "version {version}"
        );
    }
}

#[test]
fn fixed_limits_match_the_specification() {
    assert_eq!(
        MAX_MODULES,
        57 * 57,
        "one byte per module of a version-10 symbol"
    );
    let code = code_from(21, &[0; 21 * 21]);
    assert_eq!(code.modules().len(), 21 * 21);
    assert_eq!(MAX_BYTES, 213);
    assert_eq!(MAX_PIXELS, 1280 * 720);
}

/// FNV-1a 64 over the module bytes (row-major, one byte per module). The same
/// hash is computed by the reference encoder in docs/TEST-VECTORS.md.
fn fnv1a64(modules: &[u8]) -> u64 {
    modules
        .iter()
        .fold(0xcbf2_9ce4_8422_2325u64, |hash, &module| {
            (hash ^ u64::from(module)).wrapping_mul(0x0000_0100_0000_01b3)
        })
}

/// Reference matrices from python-qrcode 8.x, forced to byte mode and to each
/// mask in turn: the module grid is pinned by its FNV-1a 64 hash, per mask.
/// The first text is the ISO/IEC 18004 Annex I example in byte mode (the
/// annex's own example is numeric, so this is its byte-mode equivalent). The
/// last two are versions 7 and 10, which also carry version information.
const GOLDEN: [(&str, usize, [u64; 8]); 5] = [
    (
        "01234567",
        21,
        [
            0x6ca8_5568_5a57_b68d,
            0xd3a2_a295_bf82_e0c3,
            0x0326_6a2f_be56_02a3,
            0xe2cf_fb09_8f25_ae39,
            0xfef5_e643_e723_249b,
            0xe202_13af_a430_7655,
            0x4c91_aab4_c8c0_1f95,
            0xef39_ad58_6b7e_bd8f,
        ],
    ),
    (
        "https://kin.example.org/#join=7kq4-zpm2-hr9t-vxb6",
        33,
        [
            0x9242_4d5f_7ff9_a791,
            0x5e76_1cb0_29f5_07e3,
            0x21f4_527d_a733_5d8a,
            0x18e0_17e9_e3e7_1022,
            0xc01a_ac4b_6d43_773f,
            0x2aff_60ef_a4dc_7421,
            0x9eed_ae69_d113_31e6,
            0x31ab_0d47_1c81_9530,
        ],
    ),
    (
        "https://kin.example.org/#sign-in=q7tk-2mzp-vx8r-3hdn-4wjb-9cfl-6ygs-zt5m",
        37,
        [
            0x9050_850d_9fab_18d5,
            0x0777_23bf_1256_28f3,
            0x76bb_94d4_4063_b69f,
            0x7c55_179d_943c_7a85,
            0x532d_2551_8e35_45cf,
            0x12bc_4b76_d93e_24be,
            0x524e_fe13_60e9_9449,
            0xaee5_e630_353e_1e1f,
        ],
    ),
    (
        "https://kin.example.org/#v7=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        45,
        [
            0x5b34_cdae_c1d9_bd61,
            0x0e6a_1f27_4c02_af4a,
            0xd237_884c_d26c_a547,
            0x8da5_669b_736d_8525,
            0x08a6_e8a9_8fd7_136b,
            0xcd1d_4ccb_eab9_f7a9,
            0x7a10_146e_7cc5_a345,
            0x9794_1fff_7077_a7d7,
        ],
    ),
    (
        "https://kin.example.org/#v10=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        57,
        [
            0x1bf5_16d3_9bd3_7249,
            0xf77d_c892_ed14_5b02,
            0xf3d2_907f_803b_734f,
            0xce25_9b63_f00e_8839,
            0x4ded_c77e_fa96_692b,
            0x234f_cb9d_1fb8_814d,
            0x2ce9_1836_c8b2_447d,
            0x01e5_eb08_f87c_65ab,
        ],
    ),
];

#[test]
fn golden_grids_match_an_independent_encoder_for_every_mask() {
    for (text, side, hashes) in GOLDEN {
        for (mask, expected) in hashes.iter().enumerate() {
            let code = encode_with_mask(text.as_bytes(), Some(mask as u8)).expect("encodes");
            assert_eq!(code.size, side, "{text}: side");
            assert_eq!(
                fnv1a64(code.modules()),
                *expected,
                "{text}: mask {mask} differs from the reference grid"
            );
        }
    }
}

/// Adds zero-mean Gaussian-like noise of standard deviation `sigma` (a sum of
/// four uniforms, Irwin–Hall, rescaled), as a sensor produces in dim light.
fn gaussian(frame: &(usize, usize, Vec<u8>), sigma: f64, seed: u64) -> (usize, usize, Vec<u8>) {
    let (w, h, luma) = frame;
    let mut rng = Rng(seed | 1);
    let luma = luma
        .iter()
        .map(|&value| {
            let sum: f64 = (0..4)
                .map(|_| rng.below(1 << 20) as f64 / (1 << 20) as f64)
                .sum();
            let noise = (sum - 2.0) * 3f64.sqrt() * sigma;
            (f64::from(value) + noise).clamp(0.0, 255.0) as u8
        })
        .collect();
    (*w, *h, luma)
}

#[test]
fn reads_at_every_fifteen_degrees_of_rotation() {
    // A symbol turned through a full circle, in 15° steps, on a square canvas.
    let text = b"https://kin.example.org/#join=rotate-me";
    let code = encode(text).expect("encodes");
    let source = render(&code, 8);
    for step in 0..24 {
        let angle = f64::from(step) * std::f64::consts::PI / 12.0;
        let (sin, cos) = angle.sin_cos();
        let (cx, cy, half) = (320.0, 320.0, 200.0);
        let corners = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)].map(|(x, y)| {
            (
                cx + half * (x * cos - y * sin),
                cy + half * (x * sin + y * cos),
            )
        });
        let frame = tilt(&source, corners, 640);
        assert_eq!(
            decode_luma(frame.0, frame.1, &frame.2).as_deref(),
            Ok(&text[..]),
            "rotated {}°",
            step * 15
        );
    }
}

#[test]
fn reads_at_every_scale_from_three_to_eight_pixels_per_module() {
    let text = b"https://kin.example.org/#sign-in=scale-sweep";
    let code = encode(text).expect("encodes");
    for scale in 3..=8 {
        let (w, h, luma) = render(&code, scale);
        assert_eq!(
            decode_luma(w, h, &luma).as_deref(),
            Ok(&text[..]),
            "scale {scale}"
        );
    }
}

#[test]
fn reads_through_gaussian_sensor_noise() {
    let text = b"https://kin.example.org/#join=sensor-noise";
    let code = encode(text).expect("encodes");
    let source = render(&code, 8);
    // Moderate noise (σ 12 of 255) is what a phone in ordinary light produces.
    let noisy = gaussian(&source, 12.0, 0xA5A5);
    assert_eq!(
        decode_luma(noisy.0, noisy.1, &noisy.2).as_deref(),
        Ok(&text[..])
    );
}

#[test]
fn reads_two_pixel_blur_at_a_comfortable_scale() {
    let text = b"https://kin.example.org/#join=soft-focus";
    let code = encode(text).expect("encodes");
    let source = render(&code, 8);
    let soft = blur(&source, 2);
    assert_eq!(
        decode_luma(soft.0, soft.1, &soft.2).as_deref(),
        Ok(&text[..]),
        "radius 2 at 8 px per module"
    );
}

#[test]
fn fuzz_random_frames_never_panic() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..600 {
        let (w, h) = (1 + rng.below(96), 1 + rng.below(96));
        let luma: Vec<u8> = (0..w * h).map(|_| rng.below(256) as u8).collect();
        let _ = decode_luma(w, h, &luma);
    }
    for _ in 0..12 {
        let (w, h) = (1280, 720);
        let luma: Vec<u8> = (0..w * h).map(|_| rng.below(256) as u8).collect();
        let _ = decode_luma(w, h, &luma);
    }
}

#[test]
fn fuzz_corrupted_symbols_never_panic() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    for iteration in 0..120 {
        let version = 1 + rng.below(10);
        let text = text_of(1 + rng.below(capacity_bytes(version)), iteration as u8);
        let code = encode(&text).expect("encodes");
        let source = render(&code, 3 + rng.below(4));
        let mut frame = tilt(
            &source,
            [
                (30.0 + rng.below(20) as f64, 30.0),
                (300.0, 26.0 + rng.below(20) as f64),
                (290.0, 300.0),
                (26.0, 290.0),
            ],
            320,
        );
        for _ in 0..rng.below(400) {
            let at = rng.below(frame.2.len());
            frame.2[at] = rng.below(256) as u8;
        }
        if let Ok(payload) = decode_luma(frame.0, frame.1, &frame.2) {
            assert_eq!(payload, text, "iteration {iteration}: wrong payload");
        }
    }
}

#[test]
#[ignore]
fn long_fuzz_run() {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for _ in 0..20_000 {
        let (w, h) = (1 + rng.below(160), 1 + rng.below(160));
        let luma: Vec<u8> = (0..w * h).map(|_| rng.below(256) as u8).collect();
        let _ = decode_luma(w, h, &luma);
    }
}

/// Timing for the decoder on this machine, for the performance budget in
/// issue #95. Run it in release: `cargo test --release qr::coverage::bench
/// -- --ignored --nocapture`. The WASM figure comes from scripts/qr-performance.mjs.
#[test]
#[ignore]
fn bench_decode_native() {
    use std::time::Instant;
    let text = b"https://kin.example.org/#sign-in=q7tk-2mzp-vx8r-3hdn-4wjb";
    let code = encode(text).expect("encodes");
    for (width, height, scale) in [(640usize, 480usize, 5usize), (1280, 720, 8)] {
        let frame = render(&code, scale);
        let canvas = pad_to(width, height, &frame);
        let mut scratch = Scratch::new();
        let mut times = Vec::new();
        for _ in 0..40 {
            let started = Instant::now();
            let got = decode_in(
                &Frame {
                    width,
                    height,
                    luma: &canvas,
                },
                &mut scratch,
            );
            times.push(started.elapsed().as_secs_f64() * 1000.0);
            assert!(got.is_ok());
        }
        times.sort_by(|a, b| a.total_cmp(b));
        println!(
            "{width}x{height} median {:.2} ms, p90 {:.2} ms",
            times[times.len() / 2],
            times[times.len() * 9 / 10]
        );
    }
    // A projection helper stays in use for the homography checks above.
    let _ = project(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], 0.0, 0.0);
}
