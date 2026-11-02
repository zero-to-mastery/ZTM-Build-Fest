//! Reed–Solomon over GF(256) for QR codes (primitive polynomial 0x11D,
//! generator roots α^0 … α^(n-1)). Tables are built at compile time, so the
//! runtime has no allocation-heavy setup and no dependency.

const fn build_tables() -> ([u8; 512], [u8; 256]) {
    let mut exp = [0u8; 512];
    let mut log = [0u8; 256];
    let mut value: u16 = 1;
    let mut i = 0;
    while i < 255 {
        exp[i] = value as u8;
        log[value as usize] = i as u8;
        value <<= 1;
        if value & 0x100 != 0 {
            value ^= 0x11D;
        }
        i += 1;
    }
    // Doubled so that log(a) + log(b) never needs a modulo.
    let mut i = 255;
    while i < 512 {
        exp[i] = exp[i - 255];
        i += 1;
    }
    (exp, log)
}

const TABLES: ([u8; 512], [u8; 256]) = build_tables();
const EXP: [u8; 512] = TABLES.0;
const LOG: [u8; 256] = TABLES.1;

pub const fn mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        0
    } else {
        EXP[LOG[a as usize] as usize + LOG[b as usize] as usize]
    }
}

pub fn inv(a: u8) -> u8 {
    debug_assert!(a != 0, "zero has no inverse");
    EXP[255 - LOG[a as usize] as usize]
}

/// α^power, for any non-negative power.
pub const fn exp(power: usize) -> u8 {
    EXP[power % 255]
}

/// The largest check-symbol count any QR version at level M uses (version
/// 10 uses 26). Working storage is sized from it, so no call allocates.
pub const MAX_CHECK: usize = 30;

/// Enough room for the locator polynomial's transient growth in
/// Berlekamp–Massey (its length can reach about twice the check count).
const LOCATOR_CAPACITY: usize = 2 * MAX_CHECK + 2;

/// Generator polynomials for every check count, built at compile time:
/// `GENERATORS[n]` has its degree-`n` coefficients (highest first) in
/// entries `0..=n`, with roots α^0 … α^(n-1).
const fn build_generators() -> [[u8; MAX_CHECK + 1]; MAX_CHECK + 1] {
    let mut all = [[0u8; MAX_CHECK + 1]; MAX_CHECK + 1];
    let mut n = 1;
    while n <= MAX_CHECK {
        let mut poly = [0u8; MAX_CHECK + 1];
        poly[0] = 1;
        let mut i = 0;
        while i < n {
            // Multiply by (x + α^i); before this step the polynomial has i+1 terms.
            let root = exp(i);
            let mut next = [0u8; MAX_CHECK + 1];
            let mut j = 0;
            while j <= i {
                next[j] ^= poly[j];
                next[j + 1] ^= mul(poly[j], root);
                j += 1;
            }
            poly = next;
            i += 1;
        }
        all[n] = poly;
        n += 1;
    }
    all
}

const GENERATORS: [[u8; MAX_CHECK + 1]; MAX_CHECK + 1] = build_generators();

/// Writes the check codewords for `data` into `check`; its length is the
/// number of check symbols. Nothing is allocated.
pub fn encode_into(data: &[u8], check: &mut [u8]) {
    let n = check.len();
    debug_assert!(
        n <= MAX_CHECK,
        "check count is bounded by the version table"
    );
    if n == 0 || n > MAX_CHECK {
        check.fill(0);
        return;
    }
    let generator = &GENERATORS[n];
    check.fill(0);
    for &byte in data {
        let factor = byte ^ check[0];
        check.rotate_left(1);
        check[n - 1] = 0;
        for (slot, &g) in check.iter_mut().zip(&generator[1..=n]) {
            *slot ^= mul(g, factor);
        }
    }
}

/// The `n` error-correction codewords for `data`.
pub fn encode(data: &[u8], n: usize) -> Vec<u8> {
    let mut check = vec![0u8; n];
    encode_into(data, &mut check);
    check
}

/// Corrects `codeword` (data followed by `n` check codewords) in place.
/// Returns the number of corrected symbols, or `None` when there are more
/// errors than the code can correct (`n / 2`), or when `n` is out of range.
/// Working storage is fixed-size, so the call does not allocate.
pub fn correct(codeword: &mut [u8], n: usize) -> Option<usize> {
    if n == 0 || n > MAX_CHECK {
        return None;
    }
    let length = codeword.len();
    // Syndromes S_j = c(α^j).
    let mut syndromes = [0u8; MAX_CHECK];
    for (j, slot) in syndromes[..n].iter_mut().enumerate() {
        *slot = codeword.iter().fold(0u8, |acc, &c| mul(acc, exp(j)) ^ c);
    }
    if syndromes[..n].iter().all(|&s| s == 0) {
        return Some(0);
    }
    // Berlekamp–Massey: the error locator Λ, lowest coefficient first.
    let mut lambda = [0u8; LOCATOR_CAPACITY];
    lambda[0] = 1;
    let mut lambda_length = 1usize;
    let mut previous = [0u8; LOCATOR_CAPACITY];
    previous[0] = 1;
    let mut previous_length = 1usize;
    let mut errors = 0usize;
    let mut shift = 1usize;
    let mut previous_discrepancy = 1u8;
    for k in 0..n {
        let mut discrepancy = syndromes[k];
        for i in 1..=errors.min(lambda_length - 1).min(k) {
            discrepancy ^= mul(lambda[i], syndromes[k - i]);
        }
        if discrepancy == 0 {
            shift += 1;
            continue;
        }
        let scale = mul(discrepancy, inv(previous_discrepancy));
        let next_length = lambda_length.max(previous_length + shift);
        if next_length > LOCATOR_CAPACITY {
            return None;
        }
        let mut next = lambda;
        for (i, &p) in previous[..previous_length].iter().enumerate() {
            next[i + shift] ^= mul(scale, p);
        }
        if 2 * errors <= k {
            errors = k + 1 - errors;
            previous = lambda;
            previous_length = lambda_length;
            previous_discrepancy = discrepancy;
            shift = 1;
        } else {
            shift += 1;
        }
        lambda = next;
        lambda_length = next_length;
    }
    // Only the first errors+1 coefficients are the locator; the rest is
    // transient growth that the search must ignore.
    if errors == 0 || errors > n / 2 {
        return None;
    }
    let locator = &lambda[..=errors];
    // Chien search: position p (power of x) is in error when Λ(α^-p) = 0.
    let mut positions = [(0usize, 0usize); MAX_CHECK / 2];
    let mut found = 0usize;
    for index in 0..length {
        let power = length - 1 - index;
        let x = exp((255 - power % 255) % 255);
        let value = locator.iter().rev().fold(0u8, |acc, &c| mul(acc, x) ^ c);
        if value == 0 {
            if found == errors {
                return None;
            }
            positions[found] = (index, power);
            found += 1;
        }
    }
    if found != errors {
        return None;
    }
    // Forney: Ω = S·Λ mod x^n, then the magnitudes (first root α^0).
    let mut omega = [0u8; MAX_CHECK];
    for (i, &l) in locator.iter().enumerate() {
        for (j, &s) in syndromes[..n].iter().enumerate() {
            if i + j < n {
                omega[i + j] ^= mul(l, s);
            }
        }
    }
    for &(index, power) in &positions[..found] {
        let x = exp(power); // X_k
        let x_inverse = exp((255 - power % 255) % 255);
        let omega_value = omega
            .iter()
            .rev()
            .fold(0u8, |acc, &c| mul(acc, x_inverse) ^ c);
        // Formal derivative: only odd-power terms survive in characteristic 2.
        let derivative = (1..locator.len())
            .step_by(2)
            .fold(0u8, |acc, i| acc ^ mul(locator[i], pow(x_inverse, i - 1)));
        if derivative == 0 {
            return None;
        }
        codeword[index] ^= mul(x, mul(omega_value, inv(derivative)));
    }
    // A correction that doesn't yield a valid codeword means it failed.
    let check = (0..n).all(|j| codeword.iter().fold(0u8, |acc, &c| mul(acc, exp(j)) ^ c) == 0);
    check.then_some(found)
}

fn pow(base: u8, power: usize) -> u8 {
    (0..power).fold(1u8, |acc, _| mul(acc, base))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_inverse_and_generator_roots() {
        for a in 1..=255u8 {
            assert_eq!(mul(a, inv(a)), 1);
        }
        assert_eq!(exp(255), 1, "α has order 255");
    }

    #[test]
    fn generators_have_the_standard_roots() {
        for n in 1..=MAX_CHECK {
            let poly = &GENERATORS[n];
            assert_eq!(poly[0], 1, "monic, n={n}");
            for i in 0..n {
                let root = exp(i);
                let value = poly[..=n].iter().fold(0u8, |acc, &c| mul(acc, root) ^ c);
                assert_eq!(value, 0, "α^{i} is a root for n={n}");
            }
        }
    }

    #[test]
    fn corrects_up_to_half_the_check_symbols() {
        let data: Vec<u8> = (0..26u8)
            .map(|i| i.wrapping_mul(37).wrapping_add(11))
            .collect();
        let check = encode(&data, 10);
        let mut codeword = data.clone();
        codeword.extend(&check);
        let original = codeword.clone();
        assert_eq!(correct(&mut codeword, 10), Some(0));
        for (k, position) in [0usize, 5, 17, 30, 35].iter().enumerate() {
            codeword[*position] ^= (k as u8).wrapping_mul(91).wrapping_add(7).max(1);
        }
        assert_eq!(correct(&mut codeword, 10), Some(5));
        assert_eq!(codeword, original);
    }

    #[test]
    fn refuses_more_errors_than_it_can_correct() {
        let data: Vec<u8> = (1..=16u8).collect();
        let mut codeword = data.clone();
        codeword.extend(encode(&data, 10));
        for position in 0..6 {
            codeword[position * 3] ^= 0x5A;
        }
        assert_eq!(correct(&mut codeword, 10), None);
    }
}
