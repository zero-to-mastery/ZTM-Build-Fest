//! A tiny UTC date-time type with the parsing and formatting a blog needs.
//!
//! Supports ISO 8601 / RFC 3339 input (`2026-10-21`, `2026-10-21T04:15:10Z`,
//! `2026-10-21 04:15:10.033+02:00`) and produces RFC 3339, RFC 2822 (RSS),
//! and human-readable output. No external crate is needed.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DateTime {
    /// Seconds since the Unix epoch, UTC.
    unix: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Civil {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_LONG: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
// 1970-01-01 was a Thursday.
const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];

impl DateTime {
    pub fn from_unix(unix: i64) -> Self {
        Self { unix }
    }

    pub fn unix(self) -> i64 {
        self.unix
    }

    pub fn from_civil(c: Civil) -> Option<Self> {
        if !(1..=12).contains(&c.month) || c.day == 0 || c.day > days_in_month(c.year, c.month) {
            return None;
        }
        if c.hour > 23 || c.minute > 59 || c.second > 60 {
            return None;
        }
        let days = days_from_civil(c.year, c.month, c.day);
        Some(Self {
            unix: days * 86_400
                + i64::from(c.hour) * 3600
                + i64::from(c.minute) * 60
                + i64::from(c.second),
        })
    }

    /// Parse an ISO 8601 date or date-time. Missing time means midnight UTC;
    /// a missing offset means UTC. Fractional seconds are accepted and dropped.
    pub fn parse(input: &str) -> Option<Self> {
        let s = input.trim();
        // Everything below slices by byte offset; a multi-byte character
        // straddling an offset would panic instead of failing cleanly.
        if !s.is_ascii() {
            return None;
        }
        let b = s.as_bytes();
        if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
            return None;
        }
        let year: i64 = s[0..4].parse().ok()?;
        let month: u32 = s[5..7].parse().ok()?;
        let day: u32 = s[8..10].parse().ok()?;
        let mut civil = Civil {
            year,
            month,
            day,
            hour: 0,
            minute: 0,
            second: 0,
        };
        let mut rest = &s[10..];
        let mut offset_seconds = 0i64;
        if !rest.is_empty() {
            let sep = rest.as_bytes()[0];
            if sep != b'T' && sep != b't' && sep != b' ' {
                return None;
            }
            rest = &rest[1..];
            if rest.len() < 5 || rest.as_bytes()[2] != b':' {
                return None;
            }
            civil.hour = rest[0..2].parse().ok()?;
            civil.minute = rest[3..5].parse().ok()?;
            rest = &rest[5..];
            if rest.len() >= 3 && rest.as_bytes()[0] == b':' {
                civil.second = rest[1..3].parse().ok()?;
                rest = &rest[3..];
                if rest.starts_with('.') || rest.starts_with(',') {
                    let digits = rest[1..].bytes().take_while(u8::is_ascii_digit).count();
                    rest = &rest[1 + digits..];
                }
            }
            match rest {
                "" | "Z" | "z" => {}
                _ => {
                    let sign = match rest.as_bytes()[0] {
                        b'+' => 1,
                        b'-' => -1,
                        _ => return None,
                    };
                    let tz = &rest[1..];
                    let (h, m) = match tz.len() {
                        5 if tz.as_bytes()[2] == b':' => (&tz[0..2], &tz[3..5]),
                        4 => (&tz[0..2], &tz[2..4]),
                        2 => (&tz[0..2], "00"),
                        _ => return None,
                    };
                    let h: i64 = h.parse().ok()?;
                    let m: i64 = m.parse().ok()?;
                    offset_seconds = sign * (h * 3600 + m * 60);
                }
            }
        }
        let local = Self::from_civil(civil)?;
        Some(Self {
            unix: local.unix - offset_seconds,
        })
    }

    pub fn civil(self) -> Civil {
        let days = self.unix.div_euclid(86_400);
        let secs = self.unix.rem_euclid(86_400) as u32;
        let (year, month, day) = civil_from_days(days);
        Civil {
            year,
            month,
            day,
            hour: secs / 3600,
            minute: (secs / 60) % 60,
            second: secs % 60,
        }
    }

    /// `2026-10-21T04:15:10Z`
    pub fn rfc3339(self) -> String {
        let c = self.civil();
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            c.year, c.month, c.day, c.hour, c.minute, c.second
        )
    }

    /// `2026-10-21`
    pub fn ymd(self) -> String {
        let c = self.civil();
        format!("{:04}-{:02}-{:02}", c.year, c.month, c.day)
    }

    /// `Wed, 21 Oct 2026 04:15:10 GMT`, the format RSS 2.0 requires.
    pub fn rfc2822(self) -> String {
        let c = self.civil();
        let weekday = WEEKDAYS[self.unix.div_euclid(86_400).rem_euclid(7) as usize];
        format!(
            "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
            weekday,
            c.day,
            MONTHS[(c.month - 1) as usize],
            c.year,
            c.hour,
            c.minute,
            c.second
        )
    }

    /// `Oct 21, 2026`
    pub fn short(self) -> String {
        let c = self.civil();
        format!("{} {}, {}", MONTHS[(c.month - 1) as usize], c.day, c.year)
    }

    /// `October 21, 2026`
    pub fn long(self) -> String {
        let c = self.civil();
        format!(
            "{} {}, {}",
            MONTHS_LONG[(c.month - 1) as usize],
            c.day,
            c.year
        )
    }

    pub fn year(self) -> i64 {
        self.civil().year
    }
}

impl fmt::Display for DateTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.rfc3339())
    }
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

// Howard Hinnant's proleptic Gregorian algorithms.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = i64::from((m + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_round_trip() {
        let dt = DateTime::parse("2026-10-21T04:15:10.033Z").unwrap();
        assert_eq!(dt.rfc3339(), "2026-10-21T04:15:10Z");
        assert_eq!(dt.rfc2822(), "Wed, 21 Oct 2026 04:15:10 GMT");
        assert_eq!(dt.short(), "Oct 21, 2026");
        assert_eq!(dt.long(), "October 21, 2026");
    }

    #[test]
    fn applies_offsets() {
        let a = DateTime::parse("2026-10-21T06:15:10+02:00").unwrap();
        let b = DateTime::parse("2026-10-21T04:15:10Z").unwrap();
        assert_eq!(a, b);
        assert_eq!(
            DateTime::parse("2024-03-10").unwrap().rfc2822(),
            "Sun, 10 Mar 2024 00:00:00 GMT"
        );
    }

    #[test]
    fn epoch_and_leap_years() {
        assert_eq!(
            DateTime::from_unix(0).rfc2822(),
            "Thu, 01 Jan 1970 00:00:00 GMT"
        );
        assert_eq!(DateTime::parse("2024-02-29").unwrap().ymd(), "2024-02-29");
        assert!(DateTime::parse("2023-02-29").is_none());
        assert!(DateTime::parse("not a date").is_none());
    }

    #[test]
    fn non_ascii_input_never_panics() {
        for s in [
            "2026-10-1\u{fffd}",
            "2026-10-21T0\u{e9}:00",
            "２０２６-10-21",
            "2026-10-21T04:15:10+0\u{3b1}:00",
            "\u{1f600}\u{1f600}\u{1f600}\u{1f600}-10-21",
        ] {
            assert!(DateTime::parse(s).is_none(), "{s:?}");
        }
    }
}
