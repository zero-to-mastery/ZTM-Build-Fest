use std::f64::consts::TAU;

const MAX_INPUT_BYTES: usize = 16_384;
const RINGS: usize = 4;
const POINTS_PER_RING: usize = 6;

// Version 1: FNV-1a over UTF-8 metadata, a separator, and the little-endian
// variation. Fixed-width wrapping arithmetic is identical natively and in WASM.
fn seed(input: &str, variation: u32) -> u32 {
    input
        .bytes()
        .chain([0])
        .chain(variation.to_le_bytes())
        .fold(2_166_136_261_u32, |hash, byte| {
            (hash ^ u32::from(byte)).wrapping_mul(16_777_619)
        })
}

struct Random(u32);

impl Random {
    fn unit(&mut self) -> f64 {
        // A small, explicitly specified LCG; neither identity nor security data.
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.0) / 4_294_967_296.0
    }

    fn between(&mut self, min: f64, max: f64) -> f64 {
        min + (max - min) * self.unit()
    }
}

fn rounded(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

// Return one point per node, visiting every ring before adding another point
// to a ring. Existing coordinates remain stable as the node count grows.
pub(crate) fn points(input: &str, count: usize) -> Result<Vec<f64>, &'static str> {
    if count > 2048 {
        return Err("At most 2048 ring points are supported");
    }
    let geometry = generate(input, 0)?;
    let mut rings: Vec<Vec<f64>> = geometry[2..]
        .chunks_exact(22)
        .map(|ring| {
            let mut angles: Vec<_> = ring[4..]
                .chunks_exact(3)
                .map(|p| (p[1] - 240.0).atan2(p[0] - 240.0).rem_euclid(TAU))
                .collect();
            angles.sort_by(f64::total_cmp);
            angles
        })
        .collect();
    let mut result = Vec::with_capacity(count.max(RINGS * POINTS_PER_RING) * 3);
    for point in 0..POINTS_PER_RING {
        for ring in geometry[2..].chunks_exact(22) {
            result.extend_from_slice(&ring[4 + point * 3..7 + point * 3]);
        }
    }
    while result.len() / 3 < count {
        let mut best = (0, 0, -1.0);
        let least_points = rings.iter().map(Vec::len).min().unwrap();
        for (r, angles) in rings.iter().enumerate() {
            if angles.len() != least_points {
                continue;
            }
            for i in 0..angles.len() {
                let next = if i + 1 == angles.len() {
                    angles[0] + TAU
                } else {
                    angles[i + 1]
                };
                let gap = next - angles[i];
                if gap > best.2 {
                    best = (r, i, gap);
                }
            }
        }
        let (r, i, gap) = best;
        let angle = (rings[r][i] + gap / 2.0).rem_euclid(TAU);
        let radius = geometry[2 + r * 22];
        result.extend([
            rounded(240.0 + radius * angle.cos()),
            rounded(240.0 + radius * angle.sin()),
            2.5,
        ]);
        rings[r].push(angle);
        rings[r].sort_by(f64::total_cmp);
    }
    result.truncate(count * 3);
    Ok(result)
}

pub(crate) fn rotated_points(
    input: &str,
    count: usize,
    rotations: &[f64],
) -> Result<Vec<f64>, &'static str> {
    if rotations.len() != 4
        || rotations
            .iter()
            .any(|degrees| !degrees.is_finite() || !(0.0..=360.0).contains(degrees))
    {
        return Err("Ring rotations must contain four angles between 0 and 360 degrees");
    }
    let geometry = generate(input, 0)?;
    let mut result = points(input, count)?;
    for point in result.chunks_exact_mut(3) {
        let (x, y) = (point[0] - 240.0, point[1] - 240.0);
        let radius = x.hypot(y);
        let ring = (0..4)
            .min_by(|a, b| {
                (radius - geometry[2 + a * 22])
                    .abs()
                    .total_cmp(&(radius - geometry[2 + b * 22]).abs())
            })
            .unwrap();
        let degrees = rotations[ring];
        if degrees == 0.0 || degrees == 360.0 {
            continue;
        }
        let (sin, cos) = degrees.to_radians().sin_cos();
        point[0] = rounded(240.0 + x * cos - y * sin);
        point[1] = rounded(240.0 + x * sin + y * cos);
    }
    Ok(result)
}

pub(crate) fn generate(input: &str, variation: u32) -> Result<Vec<f64>, &'static str> {
    if input.trim().is_empty() || input.len() > MAX_INPUT_BYTES {
        return Err("Identity metadata must contain 1 to 16384 UTF-8 bytes");
    }
    if variation > 999 {
        return Err("Identity variation must be between 0 and 999");
    }
    let seed = seed(input, variation);
    let mut random = Random(seed);
    let mut geometry = Vec::with_capacity(2 + RINGS * (4 + POINTS_PER_RING * 3));
    geometry.extend([1.0, f64::from(seed)]);
    let orientation = random.between(0.0, TAU);
    for ring in 0..RINGS {
        let radius = rounded(72.0 + ring as f64 * 32.0 + random.between(-4.0, 4.0));
        let rotation = rounded(random.between(0.0, 360.0));
        let circumference = rounded(TAU * radius);
        let arc = rounded(circumference * random.between(0.62, 0.88));
        geometry.extend([radius, rotation, arc, circumference]);
        for point in 0..POINTS_PER_RING {
            let angle = orientation
                + point as f64 * TAU / POINTS_PER_RING as f64
                + random.between(-0.28, 0.28);
            geometry.extend([
                rounded(240.0 + radius * angle.cos()),
                rounded(240.0 + radius * angle.sin()),
                rounded(random.between(2.5, 5.0)),
            ]);
        }
    }
    Ok(geometry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_ring_gets_a_point_before_any_ring_gets_another() {
        let geometry = generate("few nodes", 0).unwrap();
        let expanded = points("few nodes", 256).unwrap();
        let mut counts = [0usize; RINGS];
        for (index, point) in expanded.chunks_exact(3).enumerate() {
            let radius = (point[0] - 240.0).hypot(point[1] - 240.0);
            let ring = (0..RINGS)
                .min_by(|a, b| {
                    (radius - geometry[2 + a * 22])
                        .abs()
                        .total_cmp(&(radius - geometry[2 + b * 22]).abs())
                })
                .unwrap();
            assert_eq!(counts[ring], *counts.iter().min().unwrap());
            counts[ring] += 1;
            assert_eq!(
                points("few nodes", index + 1).unwrap(),
                expanded[..(index + 1) * 3]
            );
        }
    }

    #[test]
    fn metadata_and_variation_determine_the_entire_geometry() {
        let initial = generate("Mikey Nichols / Rust / React", 0).unwrap();
        assert_eq!(
            initial,
            generate("Mikey Nichols / Rust / React", 0).unwrap()
        );
        assert_ne!(
            initial,
            generate("Mikey Nichols / Rust / React", 1).unwrap()
        );
        assert_ne!(initial, generate("Mikey Nichols / Rust", 0).unwrap());
        assert_eq!(initial.len(), 90);
        assert_eq!(initial[0], 1.0);
    }

    #[test]
    fn seed_and_random_sequence_have_stable_versioned_vectors() {
        // FNV-1a's empty-prefix offset; each zero byte still participates.
        assert_eq!(seed("a", 0), 4_167_209_092);
        let mut random = Random(0);
        random.unit();
        assert_eq!(random.0, 1_013_904_223);
        random.unit();
        assert_eq!(random.0, 1_196_435_762);
    }

    #[test]
    fn rings_are_ordered_and_points_stay_finite_and_on_their_orbit() {
        for variation in 0..=999 {
            let geometry = generate("Web Components · Rust · WebAssembly", variation).unwrap();
            assert!(geometry.iter().all(|number| number.is_finite()));
            let mut previous = 0.0;
            for ring in geometry[2..].chunks_exact(22) {
                let radius = ring[0];
                assert!(radius > previous && radius <= 172.0);
                assert!((0.0..360.0).contains(&ring[1]));
                assert!(ring[2] > 0.0 && ring[2] < ring[3]);
                for point in ring[4..].chunks_exact(3) {
                    assert!((68.0..=412.0).contains(&point[0]));
                    assert!((68.0..=412.0).contains(&point[1]));
                    assert!((2.5..=5.0).contains(&point[2]));
                    assert!(((point[0] - 240.0).hypot(point[1] - 240.0) - radius).abs() < 0.001);
                }
                previous = radius;
            }
        }
    }

    #[test]
    fn empty_oversized_and_invalid_variations_return_errors() {
        for input in ["", " \n\t"] {
            assert!(generate(input, 0).is_err());
        }
        assert!(generate(&"x".repeat(MAX_INPUT_BYTES), 999).is_ok());
        assert!(generate(&"é".repeat(MAX_INPUT_BYTES / 2 + 1), 0).is_err());
        assert!(generate("portfolio", 1000).is_err());
        assert!(generate("portfolio", u32::MAX).is_err());
    }
}
