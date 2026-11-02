//! Civil periods for the proposed v0.7 contract. No clock or timestamp arithmetic.

use crate::error::KinError;

/// A validated Gregorian date, encoded as year * 10000 + month * 100 + day.
/// The private representation prevents invalid dates entering period arithmetic.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct CivilDate(u32);

impl CivilDate {
    pub fn from_encoded(value: u32) -> Result<Self, KinError> {
        let year = value / 10_000;
        let month = value / 100 % 100;
        let day = value % 100;
        if !(1..=9999).contains(&year)
            || !(1..=12).contains(&month)
            || day == 0
            || day > days_in_month(year, month)
        {
            return Err(KinError::MalformedProtocol);
        }
        Ok(Self(value))
    }

    pub const fn encoded(self) -> u32 {
        self.0
    }

    /// Days since 0001-01-01 (Monday), for calendar arithmetic only.
    fn ordinal(self) -> u32 {
        let year = self.0 / 10_000;
        let month = self.0 / 100 % 100;
        let previous_year = year - 1;
        let mut days =
            365 * previous_year + previous_year / 4 - previous_year / 100 + previous_year / 400;
        for preceding_month in 1..month {
            days += days_in_month(year, preceding_month);
        }
        days + self.0 % 100 - 1
    }

    fn from_ordinal(ordinal: u32) -> Self {
        let mut low = 1;
        let mut high = 10_000;
        while low + 1 < high {
            let middle = (low + high) / 2;
            let previous_year = middle - 1;
            let days_before_year =
                365 * previous_year + previous_year / 4 - previous_year / 100 + previous_year / 400;
            if days_before_year <= ordinal {
                low = middle;
            } else {
                high = middle;
            }
        }
        let previous_year = low - 1;
        let days_before_year =
            365 * previous_year + previous_year / 4 - previous_year / 100 + previous_year / 400;
        let mut day_of_year = ordinal - days_before_year;
        let mut month = 1;
        while day_of_year >= days_in_month(low, month) {
            day_of_year -= days_in_month(low, month);
            month += 1;
        }
        Self(low * 10_000 + month * 100 + day_of_year + 1)
    }

    /// Days since 0001-01-01, for comparing dates a number of days apart.
    pub fn day_number(self) -> u32 {
        self.ordinal()
    }

    /// Saturday or Sunday. Ordinal 0 (0001-01-01) is a Monday.
    pub fn is_weekend(self) -> bool {
        self.ordinal() % 7 >= 5
    }

    /// The date `days` later, or `None` past the representable range.
    pub fn checked_add_days(self, days: u32) -> Option<Self> {
        let ordinal = self.ordinal().checked_add(days)?;
        (ordinal <= MAX_ORDINAL).then(|| Self::from_ordinal(ordinal))
    }

    /// The date `day_number` days after 0001-01-01, or `None` past
    /// 9999-12-31 (the inverse of `day_number`).
    pub fn from_day_number(day_number: u32) -> Option<Self> {
        (day_number <= MAX_ORDINAL).then(|| Self::from_ordinal(day_number))
    }

    /// The date `days` earlier, or `None` before 0001-01-01.
    pub fn checked_sub_days(self, days: u32) -> Option<Self> {
        Some(Self::from_ordinal(self.ordinal().checked_sub(days)?))
    }

    /// A date from its parts, or `None` when it doesn't exist.
    pub fn from_ymd(year: u32, month: u32, day: u32) -> Option<Self> {
        if !(1..=9999).contains(&year) || !(1..=12).contains(&month) {
            return None;
        }
        Self::from_encoded(year * 10_000 + month * 100 + day).ok()
    }

    pub const fn year(self) -> u32 {
        self.0 / 10_000
    }

    pub const fn month(self) -> u32 {
        self.0 / 100 % 100
    }

    pub const fn day(self) -> u32 {
        self.0 % 100
    }

    /// 0 Monday … 6 Sunday.
    pub fn weekday(self) -> u32 {
        self.ordinal() % 7
    }

    pub fn monday(self) -> Self {
        let mut year = self.0 / 10_000;
        let mut month = self.0 / 100 % 100;
        let mut day = self.0 % 100;
        // At most six calendar steps. The minimum supported date is itself a
        // Monday, so this cannot cross the lower bound of the representation.
        for _ in 0..self.ordinal() % 7 {
            if day > 1 {
                day -= 1;
            } else {
                if month > 1 {
                    month -= 1;
                } else {
                    year -= 1;
                    month = 12;
                }
                day = days_in_month(year, month);
            }
        }
        Self(year * 10_000 + month * 100 + day)
    }
}

/// Ordinal of 9999-12-31, the last representable civil date.
const MAX_ORDINAL: u32 = 3_652_058;

pub(crate) fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 31,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Cadence {
    Daily = 0,
    Weekly = 1,
    Biweekly = 2,
    Monthly = 3,
    /// Protocol 24: one occurrence per Monday-Friday civil date. Saturday and
    /// Sunday have no occurrence at all, rather than carrying Friday's over.
    Weekdays = 4,
}

impl TryFrom<u8> for Cadence {
    type Error = KinError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Daily),
            1 => Ok(Self::Weekly),
            2 => Ok(Self::Biweekly),
            3 => Ok(Self::Monthly),
            4 => Ok(Self::Weekdays),
            _ => Err(KinError::MalformedProtocol),
        }
    }
}

impl Cadence {
    /// The period containing `date`. For Weekdays a weekend date names no
    /// period; callers use `current_key`/`validate_key`, which exclude it.
    pub fn period_key(self, created_on: CivilDate, date: CivilDate) -> CivilDate {
        match self {
            Self::Daily | Self::Weekdays => date,
            Self::Weekly => date.monday(),
            Self::Biweekly => {
                if date < created_on {
                    return date;
                }
                let elapsed = date.ordinal() - created_on.ordinal();
                CivilDate::from_ordinal(date.ordinal() - elapsed % 14)
            }
            Self::Monthly => CivilDate(date.0 / 100 * 100 + 1),
        }
    }

    /// A definition has no current occurrence before its creation civil date.
    /// Archival and completion belong to replay, not calendar arithmetic.
    pub fn current_key(self, created_on: CivilDate, today: CivilDate) -> Option<CivilDate> {
        if self == Self::Weekdays && today.is_weekend() {
            return None;
        }
        (today >= created_on).then(|| self.period_key(created_on, today))
    }

    /// Historical key validity is independent of the current projection date.
    /// Otherwise clock rollback could invalidate an already saved event stream.
    pub fn validate_key(self, created_on: CivilDate, key: CivilDate) -> Result<(), KinError> {
        if key < self.period_key(created_on, created_on)
            || self.period_key(created_on, key) != key
            || (self == Self::Weekdays && key.is_weekend())
        {
            return Err(KinError::InvalidEvent);
        }
        Ok(())
    }

    /// The civil date on which the next new occurrence opens after `today`:
    /// the start of the following period, or the creation date while `today`
    /// precedes it. A new occurrence never reuses an earlier key, so this is
    /// always later than the current key. `None` past 9999-12-31.
    pub fn next_start(self, created_on: CivilDate, today: CivilDate) -> Option<CivilDate> {
        let first = if self == Self::Weekdays {
            next_weekday(created_on)
        } else {
            Some(created_on)
        };
        if today < created_on {
            return first;
        }
        match self {
            Self::Daily => today.checked_add_days(1),
            Self::Weekdays => next_weekday(today.checked_add_days(1)?),
            Self::Weekly => today.monday().checked_add_days(7),
            Self::Biweekly => self.period_key(created_on, today).checked_add_days(14),
            Self::Monthly => {
                let year = today.0 / 10_000;
                let month = today.0 / 100 % 100;
                let (year, month) = if month == 12 {
                    (year + 1, 1)
                } else {
                    (year, month + 1)
                };
                CivilDate::from_encoded(year * 10_000 + month * 100 + 1).ok()
            }
        }
    }
}

/// `date` itself when it is Monday-Friday, otherwise the following Monday.
fn next_weekday(date: CivilDate) -> Option<CivilDate> {
    match date.ordinal() % 7 {
        5 => date.checked_add_days(2),
        6 => date.checked_add_days(1),
        _ => Some(date),
    }
}

#[cfg(test)]
mod tests {
    use super::{Cadence, CivilDate};
    use crate::error::KinError;

    fn date(value: u32) -> CivilDate {
        CivilDate::from_encoded(value).unwrap()
    }

    #[test]
    fn civil_dates_reject_impossible_fields_and_overflow_values() {
        for value in [
            0,
            101,
            9999,
            20260001,
            20261301,
            20260100,
            20260132,
            20260431,
            20260229,
            20240230,
            19000229,
            21000229,
            100000101,
            u32::MAX,
        ] {
            assert_eq!(
                CivilDate::from_encoded(value),
                Err(KinError::MalformedProtocol),
                "{value}"
            );
        }
        for value in [10101, 99991231, 20000229, 20240229, 24000229] {
            assert_eq!(date(value).encoded(), value);
        }
    }

    #[test]
    fn cadence_codes_are_explicit_and_unknown_values_fail() {
        assert_eq!(Cadence::try_from(0), Ok(Cadence::Daily));
        assert_eq!(Cadence::try_from(1), Ok(Cadence::Weekly));
        assert_eq!(Cadence::try_from(2), Ok(Cadence::Biweekly));
        assert_eq!(Cadence::try_from(3), Ok(Cadence::Monthly));
        assert_eq!(Cadence::try_from(4), Ok(Cadence::Weekdays));
        assert_eq!(Cadence::Daily as u8, 0);
        assert_eq!(Cadence::Weekly as u8, 1);
        assert_eq!(Cadence::Biweekly as u8, 2);
        assert_eq!(Cadence::Monthly as u8, 3);
        assert_eq!(Cadence::Weekdays as u8, 4);
        for value in 5..=u8::MAX {
            assert_eq!(Cadence::try_from(value), Err(KinError::MalformedProtocol));
        }
    }

    #[test]
    fn daily_keys_follow_civil_dates_including_leap_day_and_long_suspension() {
        let created = date(20240228);
        assert_eq!(Cadence::Daily.current_key(created, date(20240227)), None);
        for value in [20240228, 20240229, 20240301, 20241231, 20250101, 99991231] {
            let today = date(value);
            assert_eq!(Cadence::Daily.current_key(created, today), Some(today));
            assert_eq!(Cadence::Daily.period_key(created, today), today);
        }
    }

    #[test]
    fn biweekly_periods_are_anchored_to_creation_and_span_calendar_boundaries() {
        let created = date(20240228);
        assert_eq!(Cadence::Biweekly.current_key(created, date(20240227)), None);
        for (today, expected) in [
            (20240228, 20240228),
            (20240229, 20240228),
            (20240312, 20240228),
            (20240313, 20240313),
            (20241231, 20241218),
            (20250101, 20250101),
        ] {
            assert_eq!(
                Cadence::Biweekly.current_key(created, date(today)),
                Some(date(expected)),
                "{today}"
            );
        }
        assert_eq!(
            Cadence::Biweekly.validate_key(created, date(20240313)),
            Ok(())
        );
        for invalid in [20240227, 20240312, 20240314] {
            assert_eq!(
                Cadence::Biweekly.validate_key(created, date(invalid)),
                Err(KinError::InvalidEvent)
            );
        }
        assert_eq!(
            Cadence::Biweekly.current_key(date(99991220), date(99991231)),
            Some(date(99991220))
        );
    }

    #[test]
    fn monthly_periods_use_calendar_months_and_leap_years() {
        let created = date(20240131);
        assert_eq!(Cadence::Monthly.current_key(created, date(20240130)), None);
        for (today, expected) in [
            (20240131, 20240101),
            (20240201, 20240201),
            (20240229, 20240201),
            (20240301, 20240301),
            (20241231, 20241201),
            (20250101, 20250101),
        ] {
            assert_eq!(
                Cadence::Monthly.current_key(created, date(today)),
                Some(date(expected)),
                "{today}"
            );
        }
        assert_eq!(
            Cadence::Monthly.validate_key(created, date(20240101)),
            Ok(())
        );
        assert_eq!(
            Cadence::Monthly.validate_key(created, date(20240201)),
            Ok(())
        );
        for invalid in [20231201, 20240202, 20240229] {
            assert_eq!(
                Cadence::Monthly.validate_key(created, date(invalid)),
                Err(KinError::InvalidEvent)
            );
        }
    }

    #[test]
    fn monday_keys_cross_month_year_and_century_boundaries() {
        // Fixed calendar anchors, including an ISO week-year boundary. The
        // contract uses the Monday date, never an ISO week number.
        for (input, expected) in [
            (10101, 10101),
            (10107, 10101),
            (10108, 10108),
            (19000301, 19000226),
            (20000229, 20000228),
            (20201228, 20201228),
            (20201231, 20201228),
            (20210101, 20201228),
            (20210103, 20201228),
            (20210104, 20210104),
            (20240229, 20240226),
            (20240303, 20240226),
            (20240304, 20240304),
            (99991231, 99991227),
        ] {
            assert_eq!(date(input).monday(), date(expected), "{input}");
        }
    }

    #[test]
    fn weekly_creation_allows_partial_week_but_not_precreation_projection() {
        let created = date(20261002); // Friday
        assert_eq!(Cadence::Weekly.current_key(created, date(20261001)), None);
        for today in [20261002, 20261003, 20261004] {
            assert_eq!(
                Cadence::Weekly.current_key(created, date(today)),
                Some(date(20260928))
            );
        }
        assert_eq!(
            Cadence::Weekly.current_key(created, date(20261005)),
            Some(date(20261005))
        );
        assert_eq!(
            Cadence::Weekly.current_key(created, date(20270101)),
            Some(date(20261228))
        );
    }

    #[test]
    fn historical_keys_validate_without_a_projection_clock() {
        let created = date(20261002);
        assert_eq!(
            Cadence::Daily.validate_key(created, date(20261001)),
            Err(KinError::InvalidEvent)
        );
        assert_eq!(Cadence::Daily.validate_key(created, created), Ok(()));
        assert_eq!(Cadence::Daily.validate_key(created, date(20990101)), Ok(()));
        assert_eq!(
            Cadence::Weekly.validate_key(created, date(20260928)),
            Ok(())
        );
        for invalid in [20260921, 20261002, 20261004] {
            assert_eq!(
                Cadence::Weekly.validate_key(created, date(invalid)),
                Err(KinError::InvalidEvent)
            );
        }
        assert_eq!(
            Cadence::Weekly.validate_key(created, date(20270104)),
            Ok(())
        );
    }

    #[test]
    fn repeated_and_backward_context_selects_the_same_period() {
        for cadence in [Cadence::Daily, Cadence::Weekly] {
            let created = date(20260301);
            let expected = cadence.current_key(created, date(20260308));
            for later in [20260309, 20261101, 20290101] {
                let _ = cadence.current_key(created, date(later));
                assert_eq!(cadence.current_key(created, date(20260308)), expected);
            }
            assert_eq!(cadence.current_key(created, date(20260228)), None);
        }
    }

    #[test]
    fn full_gregorian_cycle_has_contiguous_days_and_seven_day_periods() {
        let mut count = 0;
        let mut previous_monday = date(10101);
        for year in 1..=400 {
            for month in 1..=12 {
                for day in 1..=31 {
                    let Ok(current) = CivilDate::from_encoded(year * 10_000 + month * 100 + day)
                    else {
                        continue;
                    };
                    assert_eq!(current.ordinal(), count);
                    let monday = current.monday();
                    assert_eq!(monday.ordinal(), count - count % 7);
                    assert_eq!(monday.monday(), monday);
                    assert!(monday <= current);
                    if count % 7 != 0 {
                        assert_eq!(monday, previous_monday);
                    }
                    previous_monday = monday;
                    count += 1;
                }
            }
        }
        // Independent Gregorian-cycle total: 400 common years + 97 leap days.
        assert_eq!(count, 146_097);
        assert_eq!(date(4010101).monday(), date(4010101));
        assert_eq!(date(99991231).ordinal(), super::MAX_ORDINAL);
    }

    #[test]
    fn weekdays_have_one_occurrence_per_weekday_and_none_on_weekends() {
        let created = date(20261002); // Friday
        assert_eq!(Cadence::Weekdays.current_key(created, date(20261001)), None);
        for (today, expected) in [
            (20261002, Some(20261002)),
            (20261003, None), // Saturday
            (20261004, None), // Sunday
            (20261005, Some(20261005)),
            (20261009, Some(20261009)),
            (20261231, Some(20261231)), // Thursday, across the year boundary
            (20270101, Some(20270101)),
            (20270102, None),
        ] {
            assert_eq!(
                Cadence::Weekdays.current_key(created, date(today)),
                expected.map(date),
                "{today}"
            );
        }
        for valid in [20261002, 20261005, 20270101] {
            assert_eq!(Cadence::Weekdays.validate_key(created, date(valid)), Ok(()));
        }
        for invalid in [20261001, 20261003, 20261004, 20270102] {
            assert_eq!(
                Cadence::Weekdays.validate_key(created, date(invalid)),
                Err(KinError::InvalidEvent),
                "{invalid}"
            );
        }
        // Created on a Saturday: nothing is due until Monday.
        let saturday = date(20261003);
        assert_eq!(Cadence::Weekdays.current_key(saturday, saturday), None);
        assert_eq!(
            Cadence::Weekdays.current_key(saturday, date(20261004)),
            None
        );
        assert_eq!(
            Cadence::Weekdays.current_key(saturday, date(20261005)),
            Some(date(20261005))
        );
        assert_eq!(
            Cadence::Weekdays.validate_key(saturday, saturday),
            Err(KinError::InvalidEvent)
        );
    }

    #[test]
    fn next_start_names_the_following_period_for_every_cadence() {
        for (cadence, created, today, expected) in [
            (Cadence::Daily, 20240228, 20240227, Some(20240228)),
            (Cadence::Daily, 20240228, 20240228, Some(20240229)),
            (Cadence::Daily, 20240228, 20240229, Some(20240301)),
            (Cadence::Daily, 20240228, 20241231, Some(20250101)),
            (Cadence::Daily, 20240228, 99991231, None),
            (Cadence::Weekdays, 20261002, 20261002, Some(20261005)),
            (Cadence::Weekdays, 20261002, 20261003, Some(20261005)),
            (Cadence::Weekdays, 20261002, 20261004, Some(20261005)),
            (Cadence::Weekdays, 20261002, 20261005, Some(20261006)),
            (Cadence::Weekdays, 20261002, 20261008, Some(20261009)),
            (Cadence::Weekdays, 20261003, 20261001, Some(20261005)),
            (Cadence::Weekdays, 20261002, 99991231, None),
            (Cadence::Weekly, 20261002, 20261002, Some(20261005)),
            (Cadence::Weekly, 20261002, 20261004, Some(20261005)),
            (Cadence::Weekly, 20261002, 20261005, Some(20261012)),
            (Cadence::Weekly, 20261002, 20261231, Some(20270104)),
            (Cadence::Weekly, 20261002, 99991231, None),
            (Cadence::Biweekly, 20240228, 20240228, Some(20240313)),
            (Cadence::Biweekly, 20240228, 20240312, Some(20240313)),
            (Cadence::Biweekly, 20240228, 20240313, Some(20240327)),
            (Cadence::Biweekly, 20240228, 20241231, Some(20250101)),
            (Cadence::Biweekly, 99991220, 99991231, None),
            (Cadence::Monthly, 20240131, 20240131, Some(20240201)),
            (Cadence::Monthly, 20240131, 20240229, Some(20240301)),
            (Cadence::Monthly, 20240131, 20241215, Some(20250101)),
            (Cadence::Monthly, 20240131, 99991215, None),
        ] {
            assert_eq!(
                cadence.next_start(date(created), date(today)),
                expected.map(date),
                "{cadence:?} {created} {today}"
            );
        }
    }

    #[test]
    fn next_start_is_the_first_later_date_with_a_new_occurrence() {
        // Exhaustive over two years spanning a leap day, a year boundary and
        // creation dates on every weekday: between today and next_start the
        // current occurrence never changes, and next_start opens a new one.
        let mut created = date(20231225);
        let end = date(20251231);
        while created < date(20240108) {
            for cadence in [
                Cadence::Daily,
                Cadence::Weekdays,
                Cadence::Weekly,
                Cadence::Biweekly,
                Cadence::Monthly,
            ] {
                let mut today = date(20231220);
                while today < end {
                    let current = cadence.current_key(created, today);
                    let next = cadence.next_start(created, today).unwrap();
                    assert!(next > today, "{cadence:?} {today:?}");
                    let opened = cadence.current_key(created, next);
                    assert!(
                        opened.is_some() && opened != current,
                        "{cadence:?} {today:?}"
                    );
                    assert_eq!(cadence.validate_key(created, opened.unwrap()), Ok(()));
                    let mut between = today.checked_add_days(1).unwrap();
                    while between < next {
                        let key = cadence.current_key(created, between);
                        assert!(key.is_none() || key == current, "{cadence:?} {between:?}");
                        between = between.checked_add_days(1).unwrap();
                    }
                    today = today.checked_add_days(1).unwrap();
                }
            }
            created = created.checked_add_days(1).unwrap();
        }
    }

    #[test]
    fn monthly_from_the_thirty_first_covers_short_months_without_clamping() {
        // Monthly is one occurrence per calendar month, keyed by its first
        // day. A Routine created on January 31 has a February occurrence for
        // the whole of February, so no day-of-month clamping is needed.
        let created = date(20250131);
        for (today, key) in [
            (20250131, 20250101),
            (20250201, 20250201),
            (20250228, 20250201),
            (20250430, 20250401),
        ] {
            assert_eq!(
                Cadence::Monthly.current_key(created, date(today)),
                Some(date(key))
            );
        }
        assert_eq!(
            Cadence::Monthly.next_start(created, date(20250131)),
            Some(date(20250201))
        );
        assert_eq!(
            Cadence::Monthly.next_start(created, date(20250228)),
            Some(date(20250301))
        );
    }
}
