//! Video-production metadata shared by rendering and the browser studio.

use crate::{embed, frontmatter::FrontMatter};

pub const PRODUCTION_STATUSES: &[&str] = &[
    "idea",
    "scripting",
    "storyboarding",
    "generating",
    "editing",
    "scheduled",
    "released",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VideoMetadata {
    pub production_status: Option<String>,
    pub season_number: Option<u32>,
    pub episode_number: Option<u32>,
    pub production_credits: Option<String>,
    pub url: Option<String>,
    pub youtube_id: Option<String>,
    pub duration_seconds: Option<u32>,
    pub thumbnail: Option<String>,
    pub ai_disclosure: Option<String>,
}

impl VideoMetadata {
    pub fn from_front_matter(fm: &FrontMatter) -> Self {
        let value = |key: &str| {
            fm.get(key)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let url = value("videoUrl");
        Self {
            production_status: value("productionStatus"),
            season_number: value("seasonNumber").and_then(|value| value.parse().ok()),
            episode_number: value("episodeNumber").and_then(|value| value.parse().ok()),
            production_credits: value("productionCredits"),
            youtube_id: url.as_deref().and_then(embed::youtube_video_id),
            duration_seconds: value("duration")
                .as_deref()
                .and_then(parse_duration_seconds),
            thumbnail: value("thumbnail"),
            ai_disclosure: value("aiDisclosure"),
            url,
        }
    }

    /// The reader-facing production notes (episode label, status, credits) as
    /// an escaped `<aside>`, or nothing when the post has none.
    pub(crate) fn production_notes_html(&self) -> String {
        use crate::escape::text;
        let facts: Vec<String> = [
            ("Production", self.production_label()),
            ("Status", self.production_status.clone()),
            ("Credits", self.production_credits.clone()),
        ]
        .into_iter()
        .filter_map(|(label, value)| {
            value.map(|value| format!("<div><dt>{label}</dt><dd>{}</dd></div>", text(&value)))
        })
        .collect();
        if facts.is_empty() {
            return String::new();
        }
        format!("<aside class=\"ob-video-production\" aria-label=\"Video production summary\"><h2>Production notes</h2><dl>{}</dl></aside>\n", facts.join(""))
    }

    pub fn production_label(&self) -> Option<String> {
        match (self.season_number, self.episode_number) {
            (Some(season), Some(episode)) => Some(format!("Season {season}, episode {episode}")),
            (None, Some(episode)) => Some(format!("Episode {episode}")),
            (Some(season), None) => Some(format!("Season {season}")),
            _ => None,
        }
    }

    pub fn has_known_production_status(&self) -> bool {
        self.production_status.as_deref().is_none_or(|status| {
            PRODUCTION_STATUSES.contains(&status.to_ascii_lowercase().as_str())
        })
    }

    pub fn embed_url(&self) -> Option<String> {
        self.youtube_id
            .as_ref()
            .map(|id| format!("https://www.youtube-nocookie.com/embed/{id}"))
    }

    pub fn iso_duration(&self) -> Option<String> {
        let total = self.duration_seconds?;
        let hours = total / 3600;
        let minutes = total % 3600 / 60;
        let seconds = total % 60;
        let mut value = String::from("PT");
        if hours > 0 {
            value.push_str(&format!("{hours}H"));
        }
        if minutes > 0 {
            value.push_str(&format!("{minutes}M"));
        }
        if seconds > 0 || total == 0 {
            value.push_str(&format!("{seconds}S"));
        }
        Some(value)
    }
}

/// Seconds in `HH:MM:SS`, `MM:SS`, ISO 8601 `PT...`, or a readable value
/// such as `12 min 34 sec`.
pub fn parse_duration_seconds(input: &str) -> Option<u32> {
    let input = input.trim().to_ascii_lowercase();
    if input.is_empty() {
        return None;
    }
    if input.contains(':') {
        let values = input
            .split(':')
            .map(|part| part.trim().parse::<u32>().ok())
            .collect::<Option<Vec<_>>>()?;
        return match values.as_slice() {
            [minutes, seconds] if *seconds < 60 => minutes.checked_mul(60)?.checked_add(*seconds),
            [hours, minutes, seconds] if *minutes < 60 && *seconds < 60 => hours
                .checked_mul(3600)?
                .checked_add(minutes.checked_mul(60)?)?
                .checked_add(*seconds),
            _ => None,
        };
    }

    let mut rest = input.as_str();
    if let Some(value) = rest.strip_prefix("pt") {
        rest = value;
    }
    let mut total = 0u32;
    let mut found = false;
    while !rest.trim_start().is_empty() {
        rest = rest.trim_start();
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        let amount = rest[..digits].parse::<u32>().ok()?;
        rest = rest[digits..].trim_start();
        let unit_len = rest.chars().take_while(|c| c.is_ascii_alphabetic()).count();
        let unit = &rest[..unit_len];
        rest = &rest[unit_len..];
        let multiplier = match unit {
            "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
            "m" | "min" | "mins" | "minute" | "minutes" => 60,
            "s" | "sec" | "secs" | "second" | "seconds" => 1,
            _ => return None,
        };
        total = total.checked_add(amount.checked_mul(multiplier)?)?;
        found = true;
    }
    found.then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_human_iso_and_clock_durations() {
        for (source, seconds) in [
            ("12 min 34 sec", 754),
            ("PT1H2M3S", 3723),
            ("12:34", 754),
            ("1:02:03", 3723),
        ] {
            assert_eq!(parse_duration_seconds(source), Some(seconds), "{source}");
        }
        assert_eq!(parse_duration_seconds("unknown"), None);
    }

    #[test]
    fn validates_production_workflow_statuses_case_insensitively() {
        let mut video = VideoMetadata {
            production_status: Some("Editing".into()),
            ..VideoMetadata::default()
        };
        assert!(video.has_known_production_status());
        video.production_status = Some("waiting-on-magic".into());
        assert!(!video.has_known_production_status());
    }
}
