//! QR round trips: encode, draw, warp and add noise like a camera would, then
//! decode. Also checks that damaged symbols are corrected and that frames
//! without a symbol are refused.

use super::{
    decode::{decode, project, solve_homography, Frame},
    encode,
    layout::{self, Grid},
    Code, QrError,
};

/// A code from an explicit module list (fixtures), in the fixed storage.
pub(super) fn code_from(size: usize, modules: &[u8]) -> Code {
    let mut dark = [0u8; layout::MAX_MODULES];
    dark[..modules.len()].copy_from_slice(modules);
    Code { size, dark }
}

/// Draws a code as luma: `scale` pixels per module, four-module quiet zone.
pub(super) fn render(code: &Code, scale: usize) -> (usize, usize, Vec<u8>) {
    let quiet = 4;
    let side = (code.size + 2 * quiet) * scale;
    let mut luma = vec![255u8; side * side];
    for my in 0..code.size {
        for mx in 0..code.size {
            if code.dark[my * code.size + mx] == 1 {
                for py in 0..scale {
                    for px in 0..scale {
                        luma[((my + quiet) * scale + py) * side + (mx + quiet) * scale + px] = 0;
                    }
                }
            }
        }
    }
    (side, side, luma)
}

/// Warps a grayscale image through `forward` (source pixel → destination
/// pixel), filling outside with white, and adds deterministic noise and a
/// lighting gradient.
pub(super) fn warp(
    src: &(usize, usize, Vec<u8>),
    forward: [f64; 8],
    out: (usize, usize),
    noise: u32,
) -> (usize, usize, Vec<u8>) {
    let (sw, sh, luma) = src;
    // The inverse: destination pixel → source pixel, from four corner pairs.
    let corners = [
        (0.0, 0.0),
        (*sw as f64, 0.0),
        (*sw as f64, *sh as f64),
        (0.0, *sh as f64),
    ];
    let mapped: Vec<((f64, f64), (f64, f64))> = corners
        .iter()
        .map(|&c| (project(&forward, c.0, c.1), c))
        .collect();
    let inverse =
        solve_homography([mapped[0], mapped[1], mapped[2], mapped[3]]).expect("invertible warp");
    let (ow, oh) = out;
    let mut dest = vec![255u8; ow * oh];
    let mut seed = noise.max(1);
    for y in 0..oh {
        for x in 0..ow {
            let (sx, sy) = project(&inverse, x as f64 + 0.5, y as f64 + 0.5);
            let (ix, iy) = (sx.floor(), sy.floor());
            let mut value = if ix >= 0.0 && iy >= 0.0 && (ix as usize) < *sw && (iy as usize) < *sh
            {
                f64::from(luma[iy as usize * sw + ix as usize])
            } else {
                255.0
            };
            // Lighting falls off across the frame, and there is sensor noise.
            value *= 0.75 + 0.25 * (x as f64 / ow as f64);
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            value += f64::from(seed >> 27) - 16.0;
            dest[y * ow + x] = value.clamp(0.0, 255.0) as u8;
        }
    }
    (ow, oh, dest)
}

pub(super) fn round_trip(text: &[u8]) -> Vec<u8> {
    let code = encode(text).expect("encodes");
    let (w, h, luma) = render(&code, 6);
    decode(&Frame {
        width: w,
        height: h,
        luma: &luma,
    })
    .expect("decodes its own symbol")
}

#[test]
fn round_trips_across_versions() {
    for length in [1usize, 17, 50, 120, 213] {
        let text: Vec<u8> = (0..length).map(|i| b'a' + (i % 26) as u8).collect();
        assert_eq!(round_trip(&text), text, "length {length}");
    }
}

#[test]
fn round_trips_utf8_invitation_links() {
    let link = "https://kin.example.org/#join=7KQ4-ZPM2-HR9T-VXB6&household=é";
    assert_eq!(round_trip(link.as_bytes()), link.as_bytes());
}

#[test]
fn reads_through_perspective_rotation_and_noise() {
    let text = b"https://kin.example.org/#join=7KQ4-ZPM2-HR9T-VXB6";
    let code = encode(text).unwrap();
    let source = render(&code, 8);
    let (w, h) = (source.0 as f64, source.1 as f64);
    // A tilted, rotated, perspective-foreshortened quadrilateral in a larger frame.
    let destination = [(60.0, 90.0), (520.0, 40.0), (560.0, 470.0), (30.0, 430.0)];
    let forward = solve_homography([
        ((0.0, 0.0), destination[0]),
        ((w, 0.0), destination[1]),
        ((w, h), destination[2]),
        ((0.0, h), destination[3]),
    ])
    .unwrap();
    let frame = warp(&source, forward, (600, 520), 11);
    let got = decode(&Frame {
        width: frame.0,
        height: frame.1,
        luma: &frame.2,
    })
    .expect("decodes a tilted camera frame");
    assert_eq!(got, text);
}

#[test]
fn corrects_damage_inside_the_symbol() {
    let text = b"Kin pairing: scan this and approve on your phone";
    let mut code = encode(text).unwrap();
    // Flip a band of data modules. They must lie outside the function patterns.
    assert_eq!(code.size, 33, "version 4");
    let grid = Grid::with_function_patterns(4);
    let order: Vec<usize> = grid.data_order().collect();
    for &index in order.iter().skip(40).step_by(9).take(12) {
        code.dark[index] ^= 1;
    }
    let (w, h, luma) = render(&code, 6);
    assert_eq!(
        decode(&Frame {
            width: w,
            height: h,
            luma: &luma
        })
        .unwrap(),
        text
    );
}

/// `https://kin.example.org/#join=7kq4-zpm2-hr9t-vxb6`, generated by an independent encoder (python-qrcode, level M). Its data and error correction match ours; its mask choice differs, which is still a valid symbol.
const V4_TEXT: &str = "https://kin.example.org/#join=7kq4-zpm2-hr9t-vxb6";
const V4: &[&str] = &[
    "111111100000110011000000001111111",
    "100000101011000000101010001000001",
    "101110101011101010011110001011101",
    "101110101101101110111100101011101",
    "101110100111111110001011101011101",
    "100000100110101101110000101000001",
    "111111101010101010101010101111111",
    "000000001110101110111000000000000",
    "100000101010010001010010111001110",
    "100111000110110101110011000011110",
    "111000101000011111000010100010100",
    "111111001101110001111001001111110",
    "000101100110010001000000011000011",
    "011000000011110000100011001001111",
    "001000111000001111001100011000110",
    "110110011010110010001000110100101",
    "001011110000000101100011110110001",
    "100000010110100110110101101001111",
    "001000100000101101110111100101101",
    "110010001011111110001001010011111",
    "010111100011000000100011010111001",
    "100100000100001001000111100111000",
    "101010101101000001010110101101110",
    "100011000011011110011011111001110",
    "110110110011001010101001111110011",
    "000000001100000111111010100010101",
    "111111100110110101000001101010110",
    "100000100101101111100011100011110",
    "101110100001001010010000111111010",
    "101110100111000000100011110110011",
    "101110100110000100111111010111011",
    "100000100100111000011001001111100",
    "111111101001000101000011100101010",
];

/// `https://kin.example.org/#sign-in=q7tk-2mzp-vx8r-3hdn-4wjb-9cfl-6ygs-zt5m-kr2n-pd8a-bq3v`, generated by an independent encoder (python-qrcode, level M). Its data and error correction match ours; its mask choice differs, which is still a valid symbol.
const V6_TEXT: &str =
    "https://kin.example.org/#sign-in=q7tk-2mzp-vx8r-3hdn-4wjb-9cfl-6ygs-zt5m-kr2n-pd8a-bq3v";
const V6: &[&str] = &[
    "11111110101010101010111010101110101111111",
    "10000010011110000110000011101000001000001",
    "10111010101011001010010100101101001011101",
    "10111010010000000011000110101001101011101",
    "10111010011101000010010010100000001011101",
    "10000010111100101110001000001100101000001",
    "11111110101010101010101010101010101111111",
    "00000000001010011010001000001011100000000",
    "10100011010101000010101010000001100100101",
    "01011100011000001001010111011001111000101",
    "01101111101101111101011110110101011011101",
    "10011100001011111001100010001001110111000",
    "00011011010110011001000010010000111100010",
    "00101101011001110100011011100100111101011",
    "11010010000101001101010011010100111010001",
    "11010101101010011010001110100011111011000",
    "00011011010110000001100010010010111001001",
    "10000100100000001011110110111111111101001",
    "11001010000101010111100101110001100110001",
    "11100100111001000011010010111101101001010",
    "10010110101110101111110101111101011001010",
    "11001000101001010011110110111101011100001",
    "10100010011101101011000111111111010100101",
    "10010000010110001011000110110010010000011",
    "00100010110101011001100110011001101101001",
    "00011100011110010111100110011101001001011",
    "01110111000010110001101111111011011101111",
    "00101001011000000001000000011011111001000",
    "11111011110001001011101100101010101100001",
    "00101001100010001000110001001000011101111",
    "11110010111100100110101100101001110011011",
    "00001101101011000001101000011001101110010",
    "11000111010011001000000100001001111111000",
    "00000000100000100101001101111010100010101",
    "11111110101101100001111110010110101011001",
    "10000010011100011101001011000011100011011",
    "10111010011001100101011101000111111111011",
    "10111010010010110001011111010111100111110",
    "10111010111100010111000101010001110010101",
    "10000010001001111100101010101001111001000",
    "11111110100011100010000000001010101011001",
];

/// Two segments (byte, then alphanumeric) from the same encoder: a valid symbol
/// that this decoder must refuse rather than return only the first segment.
const MIXED_SEGMENTS: &[&str] = &[
    "1111111000110000000001001100101111111",
    "1000001001110000001010011010001000001",
    "1011101011000010110001111011101011101",
    "1011101010100010111000101110001011101",
    "1011101010100101010100111110101011101",
    "1000001011100111110011000101101000001",
    "1111111010101010101010101010101111111",
    "0000000010101001111010110011000000000",
    "1011111001110001100100110001001111100",
    "0001100010101101001011001010110101110",
    "1100011001010111100100010000000100011",
    "0010010111111001011111111000010000101",
    "0101101101001011001110101111011011011",
    "0111000011101100100100011000100100010",
    "1111101010100010001000000011001111010",
    "0110010011111111000111110001010110001",
    "1011101011001010001111100110010110101",
    "1110000011101111110000000111000011010",
    "0000011111110100001011010010100100111",
    "0100110100010000110001111001011001001",
    "1100111010111100011000101110111011000",
    "0111010101100111111111010100100001000",
    "0011001111111110010011001101111111011",
    "1100000101001011011001111001101110001",
    "1010001110010011100100001001011100100",
    "1111100011110011001011010001011101100",
    "1000111110110111100100111010010111111",
    "1001010100101101010111101010100001111",
    "1010011001110101011100100101111111001",
    "0000000011011001000111010001100011000",
    "1111111001101001001010000100101010101",
    "1000001010000010100010010110100011010",
    "1011101010101010001101010101111110100",
    "1011101011010001110000110111101010000",
    "1011101011100110000000110110100001101",
    "1000001001111100111001001000111011101",
    "1111111010110100100100011110100011011",
];

#[test]
fn refuses_a_symbol_with_more_than_one_segment() {
    let size = MIXED_SEGMENTS.len();
    let dark: Vec<u8> = MIXED_SEGMENTS
        .iter()
        .flat_map(|row| row.bytes().map(|b| b - b'0'))
        .collect();
    let (w, h, luma) = render(&code_from(size, &dark), 6);
    assert_eq!(
        decode(&Frame {
            width: w,
            height: h,
            luma: &luma
        }),
        Err(QrError::Unsupported)
    );
}

#[test]
fn reads_symbols_from_an_independent_encoder() {
    for (text, rows) in [(V4_TEXT, V4), (V6_TEXT, V6)] {
        let size = rows.len();
        let dark: Vec<u8> = rows
            .iter()
            .flat_map(|row| row.bytes().map(|b| b - b'0'))
            .collect();
        let code = code_from(size, &dark);
        let (w, h, luma) = render(&code, 6);
        assert_eq!(
            decode(&Frame {
                width: w,
                height: h,
                luma: &luma
            })
            .unwrap(),
            text.as_bytes()
        );
    }
}

#[test]
fn refuses_a_frame_without_a_symbol() {
    let luma = vec![200u8; 320 * 240];
    assert_eq!(
        decode(&Frame {
            width: 320,
            height: 240,
            luma: &luma
        }),
        Err(QrError::NotFound)
    );
    let mut checker = vec![0u8; 320 * 240];
    for (i, px) in checker.iter_mut().enumerate() {
        *px = if (i / 320 / 8 + i % 320 / 8).is_multiple_of(2) {
            255
        } else {
            0
        };
    }
    assert!(decode(&Frame {
        width: 320,
        height: 240,
        luma: &checker
    })
    .is_err());
}

#[test]
fn rejects_a_frame_whose_size_disagrees_with_its_pixels() {
    assert_eq!(
        decode(&Frame {
            width: 10,
            height: 10,
            luma: &[0u8; 5]
        }),
        Err(QrError::BadFrame)
    );
}

/// Validation hook (not run by default): `KIN_QR_DUMP=<dir> cargo test
/// dump_symbols -- --ignored` writes each symbol as text rows of 0/1.
#[test]
#[ignore]
fn dump_symbols() {
    let Ok(dir) = std::env::var("KIN_QR_DUMP") else {
        return;
    };
    let texts: Vec<Vec<u8>> = (1..=213usize)
        .step_by(7)
        .map(|n| {
            (0..n)
                .map(|i| b"abcdefghijklmnopqrstuvwxyz0123456789 /#:=-"[(i * 7 + n) % 42])
                .collect()
        })
        .collect();
    for (k, text) in texts.iter().enumerate() {
        let code = encode(text).unwrap();
        let rows: String = (0..code.size)
            .map(|y| {
                (0..code.size)
                    .map(|x| {
                        if code.dark[y * code.size + x] == 1 {
                            '1'
                        } else {
                            '0'
                        }
                    })
                    .collect::<String>()
                    + "\n"
            })
            .collect();
        std::fs::write(
            format!("{dir}/symbol-{k:03}.txt"),
            format!("{}\n{}", String::from_utf8_lossy(text), rows),
        )
        .unwrap();
    }
}

/// Validation hook: decodes every `*.pgm` (binary P5, 8-bit) in
/// `KIN_QR_PGM` and writes `<name>.out` with the payload or the error.
#[test]
#[ignore]
fn decode_pgm_files() {
    let Ok(dir) = std::env::var("KIN_QR_PGM") else {
        return;
    };
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("pgm") {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        // Header: "P5", width, height, maxval, then one whitespace byte.
        let mut fields = Vec::new();
        let mut i = 0;
        while fields.len() < 4 {
            while bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let start = i;
            while !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            fields.push(String::from_utf8_lossy(&bytes[start..i]).to_string());
        }
        i += 1;
        let (w, h): (usize, usize) = (fields[1].parse().unwrap(), fields[2].parse().unwrap());
        let result = match decode(&Frame {
            width: w,
            height: h,
            luma: &bytes[i..],
        }) {
            Ok(payload) => format!("OK {}", String::from_utf8_lossy(&payload)),
            Err(error) => format!("ERR {error:?}"),
        };
        std::fs::write(path.with_extension("out"), result).unwrap();
    }
}
