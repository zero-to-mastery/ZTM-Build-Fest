//! QR decoder for camera frames, written from scratch.
//!
//! Pipeline: a locally adaptive threshold; finder-pattern detection by the
//! 1:1:3:1:1 run ratio, confirmed on both axes and grouped into one
//! right-angled triangle; an alignment-pattern refinement for versions 2+; a
//! homography from module grid to frame; format read with BCH correction;
//! unmasking; de-interleaving; Reed–Solomon correction; byte-mode parse.
//!
//! Only level M, byte mode and versions 1–10 are read: the symbols Kin draws.
//!
//! Resource limits, enforced here rather than by callers:
//! - frames are at most [`MAX_WIDTH`] × [`MAX_HEIGHT`] and [`MAX_PIXELS`] in
//!   total, which is what a camera delivers at 720p;
//! - each pass has a work budget ([`PIXEL_BUDGET`]) charged for axis scans,
//!   alignment template checks and finder merges, so a noisy frame stops
//!   searching instead of running on. Fixed linear passes over the frame
//!   (binarizing, building row runs, sampling the grid) are not charged:
//!   their cost is bounded by the frame limits;
//! - at most [`MAX_FINDERS`] finder candidates are kept; when the table is
//!   full, a candidate seen on one row only is evicted first;
//! - working memory lives in a [`Scratch`] that the caller reuses, and every
//!   other buffer is a fixed-size array sized for version 10.
//!
//! A frame is tried as dark-on-light first, then inverted if that fails.

use super::{
    layout::{self, Grid, MAX_MODULES},
    rs, tables, QrError,
};

/// Largest frame side accepted.
pub const MAX_WIDTH: usize = 1280;
/// Largest frame side accepted.
pub const MAX_HEIGHT: usize = 1280;
/// Largest frame accepted, in pixels (1280 × 720).
pub const MAX_PIXELS: usize = 1280 * 720;

// Integral-image sums stay within u32 for every accepted frame: at most 255
// per pixel over MAX_PIXELS pixels.
const _: () = assert!(MAX_PIXELS * 255 <= u32::MAX as usize);

/// Work allowed per decoding pass, in units of one pixel read or one finder
/// comparison. A clean 720p symbol needs a small fraction of this; a frame
/// that exhausts it reports no symbol.
pub const PIXEL_BUDGET: usize = 4_000_000;

/// Finder candidates kept per pass. When full, a candidate seen on a single
/// row is replaced; if every candidate has been confirmed on several rows,
/// new ones are dropped. A frame with more than this many finder-like
/// patterns ahead of the symbol in raster order can therefore lose it.
pub const MAX_FINDERS: usize = 256;

/// A grayscale frame, one byte per pixel, row-major.
pub struct Frame<'a> {
    pub width: usize,
    pub height: usize,
    pub luma: &'a [u8],
}

/// Reusable working memory for [`decode_in`]. Buffers keep their capacity
/// between frames, so steady-state decoding does not allocate.
pub struct Scratch {
    integral: Vec<u32>,
    binary: Vec<u8>,
    runs: Vec<Run>,
    finders: Vec<Finder>,
}

impl Scratch {
    pub const fn new() -> Scratch {
        Scratch {
            integral: Vec::new(),
            binary: Vec::new(),
            runs: Vec::new(),
            finders: Vec::new(),
        }
    }

    /// Bytes of capacity held. Callers that need a bound drop the scratch.
    pub fn reserved_bytes(&self) -> usize {
        self.integral.capacity() * std::mem::size_of::<u32>()
            + self.binary.capacity()
            + self.runs.capacity() * std::mem::size_of::<Run>()
            + self.finders.capacity() * std::mem::size_of::<Finder>()
    }
}

impl Default for Scratch {
    fn default() -> Scratch {
        Scratch::new()
    }
}

/// Reads the single QR symbol in `frame` and returns its payload.
pub fn decode(frame: &Frame) -> Result<Vec<u8>, QrError> {
    decode_in(frame, &mut Scratch::new())
}

/// Like [`decode`], reusing `scratch` for the frame's working memory.
pub fn decode_in(frame: &Frame, scratch: &mut Scratch) -> Result<Vec<u8>, QrError> {
    decode_with_budget(frame, scratch, PIXEL_BUDGET)
}

/// [`decode_in`] with an explicit per-pass work budget. Tests use a small one
/// to show that exhausting it ends the search with `NotFound`.
pub(crate) fn decode_with_budget(
    frame: &Frame,
    scratch: &mut Scratch,
    budget: usize,
) -> Result<Vec<u8>, QrError> {
    let (w, h) = (frame.width, frame.height);
    if w == 0 || h == 0 {
        return Err(QrError::BadFrame);
    }
    // Bounds first, so the product below can't overflow a 32-bit usize.
    if w > MAX_WIDTH || h > MAX_HEIGHT || w * h > MAX_PIXELS {
        return Err(QrError::FrameTooLarge);
    }
    if frame.luma.len() != w * h {
        return Err(QrError::BadFrame);
    }
    binarize(frame, &mut scratch.integral, &mut scratch.binary);
    match read_binary(w, h, scratch, budget) {
        Ok(payload) => Ok(payload),
        Err(first) => {
            // Light-on-dark symbols: retry with the modules inverted.
            invert(&mut scratch.binary);
            read_binary(w, h, scratch, budget).map_err(|_| first)
        }
    }
}

/// One decoding pass over the binarized frame in `scratch`.
fn read_binary(
    w: usize,
    h: usize,
    scratch: &mut Scratch,
    limit: usize,
) -> Result<Vec<u8>, QrError> {
    let Scratch {
        binary,
        runs,
        finders,
        ..
    } = scratch;
    let mut budget = Budget { used: 0, limit };
    find_finders(binary, w, h, runs, finders, &mut budget);
    let (triangles, count) = rank_triangles(finders, binary, w, h, &mut budget);
    // Finder-like patterns elsewhere in the frame can form triangles as
    // plausible as the symbol's own, so the best few are tried in turn; only
    // the format and Reed–Solomon checks tell them apart.
    let mut first_error = None;
    for triangle in &triangles[..count] {
        if budget.exhausted() {
            break;
        }
        budget.charge(ATTEMPT_COST);
        match read_triangle(triangle, binary, w, h, &mut budget) {
            Ok(payload) => return Ok(payload),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    Err(first_error.unwrap_or(QrError::NotFound))
}

/// Triangles tried per pass, best first.
pub const MAX_TRIANGLE_TRIES: usize = 12;

/// Finders considered when forming triangles: the strongest by row count.
const TRIANGLE_POOL: usize = 32;

/// Budget charged per triangle attempt: sampling the grid and fitting the
/// fourth corner read up to about this many pixels.
const ATTEMPT_COST: usize = 32_000;

/// Reads the symbol framed by one finder triangle.
fn read_triangle(
    triangle: &Triangle,
    binary: &[u8],
    w: usize,
    h: usize,
    budget: &mut Budget,
) -> Result<Vec<u8>, QrError> {
    let geometry = Geometry::from_triangle(triangle, binary, w, h, budget)?;
    let version = geometry.version;
    let transform = geometry.transform()?;
    let mut dark = [0u8; MAX_MODULES];
    sample(binary, w, h, &transform, geometry.dim, &mut dark);
    let (mask, _) = read_format(&dark, geometry.dim)?;
    let grid = Grid::with_function_patterns(version);
    let (codewords, total) = read_codewords(&dark, &grid, version, mask);
    let (data, data_length) = correct_blocks(&codewords[..total], version)?;
    parse_byte_mode(&data[..data_length], version)
}

/// Work spent in the current pass, against its limit ([`PIXEL_BUDGET`] in
/// production).
struct Budget {
    used: usize,
    limit: usize,
}

impl Budget {
    fn exhausted(&self) -> bool {
        self.used >= self.limit
    }

    fn charge(&mut self, cost: usize) {
        self.used = self.used.saturating_add(cost);
    }
}

// ---------------------------------------------------------------------------
// Binarization
// ---------------------------------------------------------------------------

/// Dark if a pixel is clearly darker than its neighbourhood mean. Local means
/// tolerate uneven lighting and glare, which a global threshold doesn't.
fn binarize(frame: &Frame, integral: &mut Vec<u32>, out: &mut Vec<u8>) {
    let (w, h) = (frame.width, frame.height);
    integral.clear();
    integral.resize((w + 1) * (h + 1), 0);
    for y in 0..h {
        let mut row = 0u32;
        for x in 0..w {
            row += u32::from(frame.luma[y * w + x]);
            integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
        }
    }
    let half = (w.min(h) / 12).max(4);
    out.clear();
    out.resize(w * h, 0);
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(half), (y + half + 1).min(h));
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(half), (x + half + 1).min(w));
            let sum = integral[y1 * (w + 1) + x1] + integral[y0 * (w + 1) + x0]
                - integral[y0 * (w + 1) + x1]
                - integral[y1 * (w + 1) + x0];
            let count = ((y1 - y0) * (x1 - x0)) as u64;
            let pixel = u64::from(frame.luma[y * w + x]);
            // pixel < mean - 8, without dividing.
            if pixel * count + 8 * count < u64::from(sum) {
                out[y * w + x] = 1;
            }
        }
    }
}

fn invert(binary: &mut [u8]) {
    for module in binary.iter_mut() {
        *module ^= 1;
    }
}

// ---------------------------------------------------------------------------
// Finder patterns
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Finder {
    x: f64,
    y: f64,
    unit: f64,
    hits: u32,
}

/// A maximal run of one colour along a row.
#[derive(Clone, Copy)]
struct Run {
    colour: u8,
    start: usize,
    length: usize,
}

/// Position along one axis through a dark centre, measured outward.
struct Axis {
    /// Offset of the centre run's midpoint from the scan origin.
    mid: f64,
    /// Length of the dark run through the origin.
    centre: usize,
    /// Light, dark, light, dark run lengths, outward on the negative side
    /// first, then the positive side.
    outer: [usize; 4],
}

/// Measures the run structure through (x, y) along one axis. Fails if the
/// origin isn't dark, the pattern runs off the frame, or the budget is spent.
fn scan_axis(
    binary: &[u8],
    w: usize,
    h: usize,
    x: usize,
    y: usize,
    horizontal: bool,
    budget: &mut Budget,
) -> Option<Axis> {
    let mut pixel = |t: isize| -> Option<bool> {
        if budget.exhausted() {
            return None;
        }
        budget.charge(1);
        let (px, py) = if horizontal {
            (x as isize + t, y as isize)
        } else {
            (x as isize, y as isize + t)
        };
        if px < 0 || py < 0 || px >= w as isize || py >= h as isize {
            return None;
        }
        Some(binary[py as usize * w + px as usize] == 1)
    };
    if !pixel(0)? {
        return None;
    }
    let mut neg = 0isize;
    while pixel(-neg - 1)? {
        neg += 1;
    }
    let mut pos = 0isize;
    while pixel(pos + 1)? {
        pos += 1;
    }
    let centre = (neg + pos + 1) as usize;
    let mid = (pos - neg) as f64 / 2.0;
    // Runs are measured up to a cap: a run that reaches it is too long for
    // any pattern here, and the caller's length check rejects it. Measuring
    // stops there so a dark area next to a pattern can't stall the scan.
    let limit = centre * 2 + 4;
    let mut outer = [0usize; 4];
    let mut t = -neg - 1;
    for (slot, light) in [(0usize, true), (1, false)] {
        while outer[slot] < limit && pixel(t)? != light {
            outer[slot] += 1;
            t -= 1;
        }
    }
    let mut t = pos + 1;
    for (slot, light) in [(2usize, true), (3, false)] {
        while outer[slot] < limit && pixel(t)? != light {
            outer[slot] += 1;
            t += 1;
        }
    }
    Some(Axis { mid, centre, outer })
}

/// Confirms a centre-plus-four-outer run pattern with `centre_units` units in
/// the centre and one unit in each outer run. Returns the unit size.
fn unit_of(axis: &Axis, centre_units: usize) -> Option<f64> {
    let total = axis.centre + axis.outer.iter().sum::<usize>();
    let unit = total as f64 / (centre_units + 4) as f64;
    if unit < 1.0 {
        return None;
    }
    let tolerance = 0.5 * unit;
    let expected = [centre_units as f64 * unit, unit, unit, unit, unit];
    let measured = [
        axis.centre as f64,
        axis.outer[0] as f64,
        axis.outer[1] as f64,
        axis.outer[2] as f64,
        axis.outer[3] as f64,
    ];
    let ok = expected
        .iter()
        .zip(&measured)
        .all(|(e, m)| (e - m).abs() <= tolerance);
    ok.then_some(unit)
}

/// Collects finder candidates into `found`, reusing `runs` for each row.
fn find_finders(
    binary: &[u8],
    w: usize,
    h: usize,
    runs: &mut Vec<Run>,
    found: &mut Vec<Finder>,
    budget: &mut Budget,
) {
    found.clear();
    for y in 0..h {
        if budget.exhausted() {
            break;
        }
        runs.clear();
        let row = &binary[y * w..(y + 1) * w];
        let mut x = 0;
        while x < w {
            let colour = row[x];
            let start = x;
            while x < w && row[x] == colour {
                x += 1;
            }
            runs.push(Run {
                colour,
                start,
                length: x - start,
            });
        }
        for window in runs.windows(5) {
            let pattern = [window[0].colour, window[1].colour, window[2].colour];
            if pattern != [1, 0, 1] || window[3].colour != 0 || window[4].colour != 1 {
                continue;
            }
            let lengths: [usize; 5] = std::array::from_fn(|k| window[k].length);
            let total: usize = lengths.iter().sum();
            if total < 7 {
                continue;
            }
            let unit = total as f64 / 7.0;
            let fits = [1.0, 1.0, 3.0, 1.0, 1.0]
                .iter()
                .zip(&lengths)
                .all(|(k, &len)| (len as f64 - k * unit).abs() <= 0.5 * unit);
            if !fits {
                continue;
            }
            let centre_run = window[2];
            let cx = centre_run.start as f64 + centre_run.length as f64 / 2.0;
            // Confirm vertically through the centre column.
            let column = cx.round() as usize;
            let Some(vertical) = scan_axis(binary, w, h, column, y, false, budget) else {
                continue;
            };
            let Some(vertical_unit) = unit_of(&vertical, 3) else {
                continue;
            };
            let cy = y as f64 + vertical.mid;
            let candidate_unit = (unit + vertical_unit) / 2.0;
            merge(found, cx, cy, candidate_unit, budget);
        }
    }
}

/// Adds a detection, or folds it into a nearby one: a finder is seen on many
/// rows, and each row's measurement is averaged in. Each comparison is charged
/// to the budget. When the table is full, a single-row candidate makes room.
fn merge(found: &mut Vec<Finder>, x: f64, y: f64, unit: f64, budget: &mut Budget) {
    budget.charge(found.len());
    for finder in found.iter_mut() {
        let reach = 1.5 * finder.unit.max(unit);
        if (finder.x - x).hypot(finder.y - y) < reach {
            let n = finder.hits as f64;
            finder.x = (finder.x * n + x) / (n + 1.0);
            finder.y = (finder.y * n + y) / (n + 1.0);
            finder.unit = (finder.unit * n + unit) / (n + 1.0);
            finder.hits += 1;
            return;
        }
    }
    let candidate = Finder {
        x,
        y,
        unit,
        hits: 1,
    };
    if found.len() < MAX_FINDERS {
        found.push(candidate);
    } else if let Some(slot) = found.iter_mut().find(|finder| finder.hits == 1) {
        // Seen on one row only: most likely noise, so it gives way.
        *slot = candidate;
    }
}

/// The three finders as (top-left, top-right, bottom-left).
#[derive(Clone, Copy)]
struct Triangle {
    top_left: Finder,
    top_right: Finder,
    bottom_left: Finder,
}

/// The most plausible finder triples, best first, in fixed storage. Triples
/// rank first by how well the timing patterns between their finders alternate
/// (only a real symbol has them), then by their weakest finder's row count
/// (stray matches in data are seen on few rows), then by shape. Perspective
/// bends the triangle a lot, so the shape test is loose.
fn rank_triangles(
    finders: &mut [Finder],
    binary: &[u8],
    w: usize,
    h: usize,
    budget: &mut Budget,
) -> ([Triangle; MAX_TRIANGLE_TRIES], usize) {
    // Unstable sort: in place, so no allocation.
    finders.sort_unstable_by_key(|f| std::cmp::Reverse(f.hits));
    let candidates = &finders[..finders.len().min(TRIANGLE_POOL)];
    let empty = Finder {
        x: 0.0,
        y: 0.0,
        unit: 0.0,
        hits: 0,
    };
    let blank = Triangle {
        top_left: empty,
        top_right: empty,
        bottom_left: empty,
    };
    let mut ranked = [((0u32, 0u32, f64::NEG_INFINITY), blank); MAX_TRIANGLE_TRIES];
    let mut count = 0;
    for a in 0..candidates.len() {
        for b in a + 1..candidates.len() {
            for c in b + 1..candidates.len() {
                let trio = [candidates[a], candidates[b], candidates[c]];
                let weakest = trio.iter().map(|f| f.hits).min().unwrap_or(0);
                let Some((shape, triangle)) = score_triangle(trio) else {
                    continue;
                };
                if budget.exhausted() {
                    break;
                }
                // Timing agreement in twentieths, so near-equal fractions tie
                // and the row count and shape decide.
                let timing =
                    (timing_fraction(&triangle, binary, w, h, budget) * 20.0).round() as u32;
                let key = (timing, weakest, -shape);
                let better = |other: &(u32, u32, f64)| {
                    (key.0, key.1) > (other.0, other.1)
                        || ((key.0, key.1) == (other.0, other.1) && key.2 > other.2)
                };
                // Insert into the sorted top list, dropping the last if full.
                let mut at = count;
                while at > 0 && better(&ranked[at - 1].0) {
                    at -= 1;
                }
                if at < MAX_TRIANGLE_TRIES {
                    let end = count.min(MAX_TRIANGLE_TRIES - 1);
                    ranked.copy_within(at..end, at + 1);
                    ranked[at] = (key, triangle);
                    count = (count + 1).min(MAX_TRIANGLE_TRIES);
                }
            }
        }
    }
    (ranked.map(|(_, triangle)| triangle), count)
}

/// The fraction of timing modules (row 6 and column 6 between the finders)
/// that alternate as they should, sampled through the affine frame the
/// triangle implies. Near 1 for a real symbol; about one half for finder-like
/// patterns with no symbol between them. Each sample is charged to `budget`.
fn timing_fraction(t: &Triangle, binary: &[u8], w: usize, h: usize, budget: &mut Budget) -> f64 {
    let Some(ModuleFrame {
        dim,
        module_x,
        module_y,
        ..
    }) = module_frame(t)
    else {
        return 0.0;
    };
    let origin = (
        t.top_left.x - 3.5 * (module_x.0 + module_y.0),
        t.top_left.y - 3.5 * (module_x.1 + module_y.1),
    );
    let at = |mx: f64, my: f64| {
        (
            origin.0 + mx * module_x.0 + my * module_y.0,
            origin.1 + mx * module_x.1 + my * module_y.1,
        )
    };
    let (mut agreed, mut total) = (0usize, 0usize);
    for i in 8..dim - 8 {
        let want = u8::from(i.is_multiple_of(2));
        for (px, py) in [at(i as f64 + 0.5, 6.5), at(6.5, i as f64 + 0.5)] {
            total += 1;
            let (x, y) = (px.floor(), py.floor());
            if x >= 0.0
                && y >= 0.0
                && (x as usize) < w
                && (y as usize) < h
                && binary[y as usize * w + x as usize] == want
            {
                agreed += 1;
            }
        }
    }
    budget.charge(total);
    if total == 0 {
        0.0
    } else {
        agreed as f64 / total as f64
    }
}

/// The symbol size a finder triangle implies, and the pixel step of one
/// module along the symbol's own x and y axes.
struct ModuleFrame {
    version: usize,
    dim: usize,
    module_x: (f64, f64),
    module_y: (f64, f64),
}

/// The module frame of a triangle, or `None` when its size is outside versions
/// 1–10.
fn module_frame(t: &Triangle) -> Option<ModuleFrame> {
    let leg = |a: Finder, b: Finder| (a.x - b.x).hypot(a.y - b.y);
    // A finder's runs are measured along rows and columns. At angle θ to the
    // symbol's axes, a run of one module measures m / max(|cos θ|, |sin θ|)
    // pixels, so the module size is the measured unit scaled by that factor.
    // θ comes from the top edge of the triangle.
    let (edge_x, edge_y) = (t.top_right.x - t.top_left.x, t.top_right.y - t.top_left.y);
    let edge = edge_x.hypot(edge_y).max(1e-9);
    let angle_factor = edge_x.abs().max(edge_y.abs()) / edge;
    let unit = (t.top_left.unit + t.top_right.unit + t.bottom_left.unit) / 3.0 * angle_factor;
    let modules = (leg(t.top_left, t.top_right) + leg(t.top_left, t.bottom_left)) / 2.0 / unit;
    // Centre-to-centre distance is dim - 7 modules. Sizes step by four, so the
    // estimate snaps to the nearest valid version; a module count off by one
    // at high versions is common and harmless.
    let version = ((modules + 7.0 - 17.0) / 4.0).round() as i64;
    if !(1..=10).contains(&version) {
        return None;
    }
    let dim = (17 + 4 * version) as usize;
    let span = (dim - 7) as f64;
    Some(ModuleFrame {
        version: version as usize,
        dim,
        module_x: (edge_x / span, edge_y / span),
        module_y: (
            (t.bottom_left.x - t.top_left.x) / span,
            (t.bottom_left.y - t.top_left.y) / span,
        ),
    })
}

/// A right triangle of similar-sized finders; lower error is better.
fn score_triangle(trio: [Finder; 3]) -> Option<(f64, Triangle)> {
    let dist = |p: Finder, q: Finder| (p.x - q.x).hypot(p.y - q.y);
    let units = [trio[0].unit, trio[1].unit, trio[2].unit];
    let (umin, umax) = (
        units.iter().cloned().fold(f64::MAX, f64::min),
        units.iter().cloned().fold(0.0, f64::max),
    );
    if umax / umin > 1.6 {
        return None;
    }
    // The right angle sits at the vertex opposite the longest side.
    let sides = [
        (dist(trio[1], trio[2]), 0usize),
        (dist(trio[0], trio[2]), 1),
        (dist(trio[0], trio[1]), 2),
    ];
    let (hyp, right) = sides
        .iter()
        .cloned()
        .fold((0.0, 0), |acc, s| if s.0 > acc.0 { s } else { acc });
    let legs: [usize; 2] = match right {
        0 => [1, 2],
        1 => [0, 2],
        _ => [0, 1],
    };
    let (l1, l2) = (
        dist(trio[legs[0]], trio[right]),
        dist(trio[legs[1]], trio[right]),
    );
    let (lo, hi) = (l1.min(l2), l1.max(l2));
    if lo <= 0.0 {
        return None;
    }
    let leg_error = (hi - lo) / hi;
    let hyp_error = (hyp * hyp - (l1 * l1 + l2 * l2)).abs() / (hyp * hyp);
    if leg_error > 0.35 || hyp_error > 0.35 || hi / lo > 1.6 {
        return None;
    }
    let corner = trio[right];
    let (mut tr, mut bl) = (trio[legs[0]], trio[legs[1]]);
    // Orientation: from the corner, top-right lies to the right and
    // bottom-left below; a mirrored triple has the cross product negative.
    let cross = (tr.x - corner.x) * (bl.y - corner.y) - (tr.y - corner.y) * (bl.x - corner.x);
    if cross < 0.0 {
        std::mem::swap(&mut tr, &mut bl);
    }
    Some((
        leg_error + hyp_error,
        Triangle {
            top_left: corner,
            top_right: tr,
            bottom_left: bl,
        },
    ))
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

struct Geometry {
    version: usize,
    dim: usize,
    /// Pixel step of one module along the symbol's own x and y axes, from the
    /// finder triangle. They follow the symbol through rotation, so templates
    /// sampled along them match at any angle.
    module_x: (f64, f64),
    module_y: (f64, f64),
    top_left: (f64, f64),
    top_right: (f64, f64),
    bottom_left: (f64, f64),
    /// The fourth correspondence: alignment centre if found, else affine
    /// extrapolation.
    bottom_right: (f64, f64),
}

impl Geometry {
    fn from_triangle(
        t: &Triangle,
        binary: &[u8],
        w: usize,
        h: usize,
        budget: &mut Budget,
    ) -> Result<Geometry, QrError> {
        let frame = module_frame(t).ok_or(QrError::Unsupported)?;
        let dim = frame.dim;
        let tl = (t.top_left.x, t.top_left.y);
        let tr = (t.top_right.x, t.top_right.y);
        let bl = (t.bottom_left.x, t.bottom_left.y);
        // Where the bottom-right alignment centre (module dim-6.5) falls if the
        // symbol is an affine image of the finder triangle. Its centre is
        // (dim-6.5)-3.5 = dim-10 modules along an axis that is dim-7 long.
        let fraction = (dim as f64 - 10.0) / (dim - 7) as f64;
        let expected = (
            tl.0 + fraction * (tr.0 - tl.0) + fraction * (bl.0 - tl.0),
            tl.1 + fraction * (tr.1 - tl.1) + fraction * (bl.1 - tl.1),
        );
        let mut geometry = Geometry {
            version: frame.version,
            dim,
            module_x: frame.module_x,
            module_y: frame.module_y,
            top_left: tl,
            top_right: tr,
            bottom_left: bl,
            bottom_right: expected,
        };
        // Versions 2 and up have an alignment pattern there: prefer its
        // measured centre to the extrapolation.
        if geometry.version >= 2 {
            let axes = (geometry.module_x, geometry.module_y);
            if let Some(found) = find_alignment(binary, w, h, expected, axes, budget) {
                geometry.bottom_right = found;
            }
        }
        // Perspective makes the fourth point hard to predict (version 1 has no
        // alignment pattern at all). Fit it to the timing patterns, which
        // alternate along the top and left edges at known module positions.
        geometry.bottom_right = refine_bottom_right(binary, w, h, &geometry);
        Ok(geometry)
    }

    /// Homography from module coordinates to frame pixels.
    fn transform(&self) -> Result<[f64; 8], QrError> {
        let d = self.dim as f64;
        let pairs = [
            ((3.5, 3.5), self.top_left),
            ((d - 3.5, 3.5), self.top_right),
            ((3.5, d - 3.5), self.bottom_left),
            ((d - 6.5, d - 6.5), self.bottom_right),
        ];
        solve_homography(pairs).ok_or(QrError::NotFound)
    }
}

/// Moves the fourth correspondence within about a module of its estimate to
/// the position where the timing patterns agree best with their known
/// alternation. Two passes, coarse then fine.
fn refine_bottom_right(binary: &[u8], w: usize, h: usize, geometry: &Geometry) -> (f64, f64) {
    let start = geometry.bottom_right;
    let mut best = (timing_agreement(binary, w, h, geometry, start), start);
    let module_pixels = (geometry.top_left.0 - geometry.top_right.0)
        .hypot(geometry.top_left.1 - geometry.top_right.1)
        / (geometry.dim - 7) as f64;
    for step in [0.25, 0.05] {
        let centre = best.1;
        for dy in -6..=6 {
            for dx in -6..=6 {
                let candidate = (
                    centre.0 + f64::from(dx) * step * module_pixels,
                    centre.1 + f64::from(dy) * step * module_pixels,
                );
                let score = timing_agreement(binary, w, h, geometry, candidate);
                if score > best.0 {
                    best = (score, candidate);
                }
            }
        }
    }
    best.1
}

/// How many timing modules agree with the expected alternation under the
/// homography implied by `bottom_right`.
fn timing_agreement(
    binary: &[u8],
    w: usize,
    h: usize,
    geometry: &Geometry,
    bottom_right: (f64, f64),
) -> usize {
    let d = geometry.dim as f64;
    let pairs = [
        ((3.5, 3.5), geometry.top_left),
        ((d - 3.5, 3.5), geometry.top_right),
        ((3.5, d - 3.5), geometry.bottom_left),
        ((d - 6.5, d - 6.5), bottom_right),
    ];
    let Some(transform) = solve_homography(pairs) else {
        return 0;
    };
    let mut agreed = 0;
    for i in 8..geometry.dim - 8 {
        let want = u8::from(i.is_multiple_of(2));
        for (mx, my) in [(i as f64 + 0.5, 6.5), (6.5, i as f64 + 0.5)] {
            let (px, py) = project(&transform, mx, my);
            let (x, y) = (px.floor(), py.floor());
            if x >= 0.0
                && y >= 0.0
                && (x as usize) < w
                && (y as usize) < h
                && binary[y as usize * w + x as usize] == want
            {
                agreed += 1;
            }
        }
    }
    agreed
}

/// Mismatching modules between the frame and an alignment pattern centred at
/// `(cx, cy)` (frame pixels). The 5×5 template is sampled along the symbol's
/// own module axes, so it matches at any rotation. Light ring and dark outer
/// ring are both checked, so neighbouring data can't fake a full match.
fn alignment_mismatches(
    binary: &[u8],
    w: usize,
    h: usize,
    centre: (f64, f64),
    axes: ((f64, f64), (f64, f64)),
) -> usize {
    let ((ux, uy), (vx, vy)) = axes;
    let mut mismatches = 0;
    for dy in -2isize..=2 {
        for dx in -2isize..=2 {
            let want = u8::from(dx.abs().max(dy.abs()) != 1);
            let (fdx, fdy) = (dx as f64, dy as f64);
            let x = (centre.0 + fdx * ux + fdy * vx).floor();
            let y = (centre.1 + fdx * uy + fdy * vy).floor();
            let got = if x >= 0.0 && y >= 0.0 && (x as usize) < w && (y as usize) < h {
                binary[y as usize * w + x as usize]
            } else {
                0
            };
            mismatches += usize::from(got != want);
        }
    }
    mismatches
}

/// Pixel reads charged per alignment template check, for the budget.
const TEMPLATE_COST: usize = 25;

/// Finds the alignment pattern near `expected`: the dark pixel whose 5×5
/// template matches best, within a window of twelve modules (the affine
/// estimate can be several modules off under strong perspective). Among
/// matches with at most three mismatches, the nearest to `expected` wins.
fn find_alignment(
    binary: &[u8],
    w: usize,
    h: usize,
    expected: (f64, f64),
    axes: ((f64, f64), (f64, f64)),
    budget: &mut Budget,
) -> Option<(f64, f64)> {
    let module = (axes.0 .0.hypot(axes.0 .1)).max(1e-9);
    let radius = (12.0 * module).ceil() as isize;
    let (cx, cy) = (expected.0.round() as isize, expected.1.round() as isize);
    let mut best: Option<(f64, (f64, f64))> = None;
    for y in (cy - radius).max(0)..=(cy + radius).min(h as isize - 1) {
        for x in (cx - radius).max(0)..=(cx + radius).min(w as isize - 1) {
            let (ux, uy) = (x as usize, y as usize);
            if binary[uy * w + ux] != 1 {
                continue;
            }
            if budget.exhausted() {
                return best.map(|(_, centre)| centre);
            }
            budget.charge(TEMPLATE_COST);
            let centre = (x as f64, y as f64);
            let mismatches = alignment_mismatches(binary, w, h, centre, axes);
            if mismatches > 3 {
                continue;
            }
            let distance = (centre.0 - expected.0).hypot(centre.1 - expected.1);
            let cost = mismatches as f64 + distance / (12.0 * module);
            if best.is_none_or(|(c, _)| cost < c) {
                best = Some((cost, centre));
            }
        }
    }
    best.map(|(_, centre)| centre)
}

/// Solves the eight-unknown homography mapping four module points to pixels.
pub(crate) fn solve_homography(pairs: [((f64, f64), (f64, f64)); 4]) -> Option<[f64; 8]> {
    // Rows of the linear system A·h = b, h = [a b c d e f g h] with i = 1.
    let mut a = [[0f64; 9]; 8];
    for (k, ((mx, my), (ix, iy))) in pairs.iter().enumerate() {
        a[2 * k] = [*mx, *my, 1.0, 0.0, 0.0, 0.0, -mx * ix, -my * ix, *ix];
        a[2 * k + 1] = [0.0, 0.0, 0.0, *mx, *my, 1.0, -mx * iy, -my * iy, *iy];
    }
    // Gaussian elimination with partial pivoting.
    for col in 0..8 {
        let pivot = (col..8).max_by(|&p, &q| a[p][col].abs().total_cmp(&a[q][col].abs()))?;
        if a[pivot][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, pivot);
        let pivot_row = a[col];
        for (row, row_cells) in a.iter_mut().enumerate() {
            if row != col {
                let factor = row_cells[col] / pivot_row[col];
                for (cell, &p) in row_cells[col..].iter_mut().zip(&pivot_row[col..]) {
                    *cell -= factor * p;
                }
            }
        }
    }
    let mut solution = [0f64; 8];
    for i in 0..8 {
        solution[i] = a[i][8] / a[i][i];
    }
    Some(solution)
}

/// Maps a module-space point through the homography to a pixel.
pub(crate) fn project(h: &[f64; 8], mx: f64, my: f64) -> (f64, f64) {
    let denominator = h[6] * mx + h[7] * my + 1.0;
    (
        (h[0] * mx + h[1] * my + h[2]) / denominator,
        (h[3] * mx + h[4] * my + h[5]) / denominator,
    )
}

/// Samples the module grid at module centres into `modules` (row-major,
/// `dim` wide). Modules outside the frame read as light.
fn sample(
    binary: &[u8],
    w: usize,
    h: usize,
    transform: &[f64; 8],
    dim: usize,
    modules: &mut [u8; MAX_MODULES],
) {
    for my in 0..dim {
        for mx in 0..dim {
            let (px, py) = project(transform, mx as f64 + 0.5, my as f64 + 0.5);
            let (x, y) = (px.round(), py.round());
            modules[my * dim + mx] = if x >= 0.0 && y >= 0.0 && (x as usize) < w && (y as usize) < h
            {
                binary[y as usize * w + x as usize]
            } else {
                0
            };
        }
    }
}

// ---------------------------------------------------------------------------
// Format, data and correction
// ---------------------------------------------------------------------------

/// Reads the two format copies and returns the mask of the closest valid word.
fn read_format(dark: &[u8], dim: usize) -> Result<(u8, u32), QrError> {
    let mut first = 0u32;
    let mut second = 0u32;
    let mut seen = [false; 15];
    for (x, y, bit) in layout::format_modules(dim) {
        let value = u32::from(dark[y * dim + x]);
        let target = if seen[bit as usize] {
            &mut second
        } else {
            &mut first
        };
        *target |= value << bit;
        seen[bit as usize] = true;
    }
    let valid = layout::all_format_words();
    let mut best: Option<(u32, u8, u32)> = None;
    for word in [first, second] {
        for (mask, &candidate) in valid.iter().enumerate() {
            let distance = (word ^ candidate).count_ones();
            if best.is_none_or(|(d, _, _)| distance < d) {
                best = Some((distance, mask as u8, word));
            }
        }
    }
    match best {
        Some((distance, mask, word)) if distance <= 3 => Ok((mask, word)),
        _ => Err(QrError::Unsupported),
    }
}

/// Reads the codeword bytes in placement order, undoing the mask. Returns the
/// bytes and how many of them are codewords for this version.
fn read_codewords(
    dark: &[u8],
    grid: &Grid,
    version: usize,
    mask: u8,
) -> ([u8; tables::MAX_CODEWORDS], usize) {
    let size = grid.size;
    let total = tables::DATA_CODEWORDS[version - 1]
        + tables::EC_PER_BLOCK[version - 1] * tables::block_data_lengths(version).count;
    let mut bytes = [0u8; tables::MAX_CODEWORDS];
    for (position, index) in grid.data_order().enumerate().take(total * 8) {
        let (row, column) = (index / size, index % size);
        let bit = dark[index] ^ u8::from(layout::mask_applies(mask, row, column));
        bytes[position / 8] |= bit << (7 - position % 8);
    }
    (bytes, total)
}

/// De-interleaves the blocks, corrects each one, and returns the data bytes
/// with their count.
fn correct_blocks(
    codewords: &[u8],
    version: usize,
) -> Result<([u8; tables::MAX_DATA_CODEWORDS], usize), QrError> {
    let lengths = tables::block_data_lengths(version);
    let ec = tables::EC_PER_BLOCK[version - 1];
    let mut blocks = [[0u8; tables::MAX_BLOCK_BYTES]; tables::MAX_BLOCKS];
    let longest = lengths.as_slice().iter().copied().max().unwrap_or(0);
    let mut k = 0;
    for i in 0..longest {
        for (block, &d) in blocks.iter_mut().zip(lengths.as_slice()) {
            if i < d {
                block[i] = codewords[k];
                k += 1;
            }
        }
    }
    for i in 0..ec {
        for (block, &d) in blocks.iter_mut().zip(lengths.as_slice()) {
            block[d + i] = codewords[k];
            k += 1;
        }
    }
    let mut data = [0u8; tables::MAX_DATA_CODEWORDS];
    let mut length = 0;
    for (index, &d) in lengths.as_slice().iter().enumerate() {
        let block = &mut blocks[index][..d + ec];
        rs::correct(block, ec).ok_or(QrError::Uncorrectable)?;
        data[length..length + d].copy_from_slice(&block[..d]);
        length += d;
    }
    Ok((data, length))
}

/// Parses a byte-mode segment: mode, count, payload.
fn parse_byte_mode(data: &[u8], version: usize) -> Result<Vec<u8>, QrError> {
    let mut reader = BitReader {
        bytes: data,
        position: 0,
    };
    if reader.read(4)? != 0b0100 {
        return Err(QrError::Unsupported);
    }
    let count = reader.read(tables::count_bits(version))? as usize;
    // A count can't exceed what the data holds; checking first keeps a corrupt
    // count from reserving memory.
    let mut payload = Vec::with_capacity(count.min(data.len()));
    for _ in 0..count {
        payload.push(reader.read(8)? as u8);
    }
    // Anything but a terminator (or padding) after the payload is another
    // segment in a different mode. Kin reads one byte segment only, so refuse
    // rather than return a truncated payload.
    if reader.remaining_nonzero_mode() {
        return Err(QrError::Unsupported);
    }
    Ok(payload)
}

struct BitReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl BitReader<'_> {
    /// True when the next four bits name a mode: a terminator is 0000.
    fn remaining_nonzero_mode(&self) -> bool {
        let mut probe = BitReader {
            bytes: self.bytes,
            position: self.position,
        };
        probe.read(4).map(|mode| mode != 0).unwrap_or(false)
    }

    fn read(&mut self, width: usize) -> Result<u32, QrError> {
        if self.position + width > self.bytes.len() * 8 {
            return Err(QrError::Malformed);
        }
        let mut value = 0u32;
        for _ in 0..width {
            let bit = (self.bytes[self.position / 8] >> (7 - self.position % 8)) & 1;
            value = (value << 1) | u32::from(bit);
            self.position += 1;
        }
        Ok(value)
    }
}
