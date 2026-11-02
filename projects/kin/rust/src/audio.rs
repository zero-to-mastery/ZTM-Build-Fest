//! Waveform peaks for voice messages (#134).
//!
//! The host decodes a recording to mono 32-bit floats and hands the samples
//! to the engine, which reduces them to `PEAK_COUNT` loudness values in one
//! pass over the slice. The peaks are small enough to ride in the encrypted
//! message, so everyone can draw the waveform before the audio arrives.
//!
//! KAPQ v1 request: `"KAPQ"`, version `1`, 3 reserved zero bytes, sample
//! count u32, then that many little-endian f32 samples. KAPR v1 result:
//! `"KAPR"`, version `1`, 3 reserved zero bytes, then `PEAK_COUNT` bytes.
//! Sample `i` of `n` belongs to bucket `i * PEAK_COUNT / n`; a bucket's value
//! is its largest magnitude (clamped to 1.0, NaN counting as silence) scaled
//! to 0–255. When there are fewer samples than buckets the unused ones are 0.

use crate::error::KinError;
use crate::wire::MAX_PROTOCOL_BYTES;

pub const PEAK_COUNT: usize = 64;
const HEADER: usize = 12;

/// KAPQ request bytes to KAPR result bytes.
pub fn encode_peaks(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    if bytes.len() < HEADER || bytes.len() > MAX_PROTOCOL_BYTES || &bytes[..4] != b"KAPQ" {
        return Err(KinError::MalformedProtocol);
    }
    if bytes[4] != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes[5..8] != [0, 0, 0] {
        return Err(KinError::MalformedProtocol);
    }
    let count = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let samples = &bytes[HEADER..];
    if count == 0 || samples.len() != count.checked_mul(4).ok_or(KinError::MalformedProtocol)? {
        return Err(KinError::MalformedProtocol);
    }
    let mut peaks = [0f32; PEAK_COUNT];
    for (index, chunk) in samples.chunks_exact(4).enumerate() {
        let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        // NaN is silence; anything past full scale is full scale.
        let magnitude = if sample.is_nan() {
            0.0
        } else {
            sample.abs().min(1.0)
        };
        let bucket = (index as u64 * PEAK_COUNT as u64 / count as u64) as usize;
        if magnitude > peaks[bucket] {
            peaks[bucket] = magnitude;
        }
    }
    let mut result = Vec::with_capacity(8 + PEAK_COUNT);
    result.extend_from_slice(b"KAPR");
    result.extend_from_slice(&[1, 0, 0, 0]);
    result.extend(peaks.iter().map(|peak| (peak * 255.0).round() as u8));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(samples: &[f32]) -> Vec<u8> {
        let mut bytes = b"KAPQ".to_vec();
        bytes.extend_from_slice(&[1, 0, 0, 0]);
        bytes.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    fn peaks(samples: &[f32]) -> Vec<u8> {
        let result = encode_peaks(&request(samples)).unwrap();
        assert_eq!(&result[..8], b"KAPR\x01\0\0\0");
        result[8..].to_vec()
    }

    #[test]
    fn each_bucket_keeps_its_loudest_sample() {
        let mut samples = vec![0.0f32; 640];
        samples[5] = 0.5;
        samples[6] = -1.0;
        samples[639] = -0.25;
        let result = peaks(&samples);
        assert_eq!(result.len(), PEAK_COUNT);
        assert_eq!(result[0], 255, "magnitude, not sign");
        assert_eq!(result[1], 0);
        assert_eq!(result[63], 64);
    }

    #[test]
    fn loud_nan_and_infinite_samples_are_clamped_or_silent() {
        let result = peaks(&[f32::NAN, 7.5, f32::INFINITY, f32::NEG_INFINITY]);

        assert_eq!(result[0], 0);
        assert_eq!(result[16], 255);
        assert_eq!(result[32], 255);
        assert_eq!(result[48], 255);
    }

    #[test]
    fn fewer_samples_than_buckets_leave_the_rest_silent() {
        let result = peaks(&[1.0, 0.5]);
        assert_eq!(result[0], 255);
        assert_eq!(result[32], 128);
        assert_eq!(result.iter().filter(|&&value| value != 0).count(), 2);
    }

    #[test]
    fn every_sample_is_counted_exactly_once() {
        // 100 samples, one loud in each position: every bucket sees some.
        for loud in 0..100 {
            let mut samples = vec![0.0f32; 100];
            samples[loud] = 1.0;
            assert_eq!(
                peaks(&samples)
                    .iter()
                    .filter(|&&value| value == 255)
                    .count(),
                1
            );
        }
    }

    #[test]
    fn malformed_requests_are_refused() {
        let good = request(&[0.1, 0.2]);
        assert!(encode_peaks(&good).is_ok());
        assert!(encode_peaks(&good[..11]).is_err());
        assert!(encode_peaks(&good[..good.len() - 1]).is_err());
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(encode_peaks(&trailing).is_err());
        let mut wrong = good.clone();
        wrong[0] = b'X';
        assert!(encode_peaks(&wrong).is_err());
        let mut version = good.clone();
        version[4] = 2;
        assert_eq!(encode_peaks(&version), Err(KinError::UnsupportedVersion));
        let mut reserved = good.clone();
        reserved[6] = 1;
        assert!(encode_peaks(&reserved).is_err());
        assert!(encode_peaks(&request(&[])).is_err(), "no samples");
        let mut count = good;
        count[8] = 9;
        assert!(
            encode_peaks(&count).is_err(),
            "count disagrees with the bytes"
        );
    }
}
