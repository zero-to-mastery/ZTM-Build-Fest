//! The `job` content profile: one piece of completed trade work, written as a
//! post (ADR 0285). Pure validation of front matter; nothing here reads a
//! file, a clock or the network.
//!
//! The front matter is one `job` mapping. The parser flattens it to dotted
//! keys (`job.trade`, `job.place.town`, `job.media.before`), and unknown keys
//! stay in the front matter untouched so a newer file survives an older build.

use crate::{date::DateTime, frontmatter::FrontMatter};

/// Prefix of every flattened job key in [`FrontMatter::fields`].
pub const JOB_KEY: &str = "job";

/// The bundled trades. A site may add more with `extraTrades` in `openblog.json`.
pub const TRADES: &[&str] = &[
    "general-contractor",
    "excavation",
    "flooring",
    "mobile-mechanic",
    "auto-body-paint",
    "roofing",
    "plumbing",
    "electrical",
    "landscaping",
    "painting",
    "hvac",
    "other",
];

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"];
/// page is the archive's pagination path, so it cannot name a trade or service.
pub(crate) const RESERVED: &str = "page";
const MAX_TEXT: usize = 80;
const MAX_MATERIALS: usize = 50;
const MAX_MATERIAL: usize = 120;
const MAX_MEDIA: usize = 50;
const MAX_REF: usize = 500;
const MAX_HOURS: f64 = 100_000.0;

/// A public price signal, never free text and never a quote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CostBand {
    Under500,
    From500To2k,
    From2kTo10k,
    From10kTo50k,
    Over50k,
    Ask,
}

impl CostBand {
    pub const ALL: [CostBand; 6] = [
        Self::Under500,
        Self::From500To2k,
        Self::From2kTo10k,
        Self::From10kTo50k,
        Self::Over50k,
        Self::Ask,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Under500 => "under-500",
            Self::From500To2k => "500-2k",
            Self::From2kTo10k => "2k-10k",
            Self::From10kTo50k => "10k-50k",
            Self::Over50k => "over-50k",
            Self::Ask => "ask",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|band| band.as_str() == value.trim())
    }

    /// The words a page shows for the band. A label only: nothing is
    /// computed from it, and it is never a quote.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Under500 => "Under $500",
            Self::From500To2k => "$500 to $2,000",
            Self::From2kTo10k => "$2,000 to $10,000",
            Self::From10kTo50k => "$10,000 to $50,000",
            Self::Over50k => "Over $50,000",
            Self::Ask => "Ask for a quote",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobMetadata {
    pub trade: String,
    pub service: String,
    pub town: String,
    pub region: String,
    /// `YYYY-MM-DD`
    pub started: String,
    /// `YYYY-MM-DD`
    pub finished: String,
    pub duration_hours: Option<String>,
    pub materials: Vec<String>,
    pub cost_band: Option<CostBand>,
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub review: Option<String>,
}

/// The site's trades: the bundled list followed by the site's own, normalized
/// and de-duplicated.
pub fn known_trades(extra: &[String]) -> Vec<String> {
    let mut all: Vec<String> = TRADES.iter().map(|trade| trade.to_string()).collect();
    for trade in extra {
        let trade = trade.trim().to_ascii_lowercase();
        if is_slug(&trade) && trade != RESERVED && !all.contains(&trade) {
            all.push(trade);
        }
    }
    all
}

/// Whether a `extraTrades` entry is usable, with the plain reason when not.
pub fn check_extra_trade(trade: &str) -> Result<(), String> {
    let trade = trade.trim().to_ascii_lowercase();
    if is_slug(&trade) && trade != RESERVED {
        Ok(())
    } else {
        Err(format!(
            "extraTrades: `{trade}` is not a trade id; use lowercase letters, digits and hyphens"
        ))
    }
}

/// The four headings a new job starts with (ADR 0287). They are ordinary
/// Markdown: the author may rename, reorder or delete them.
pub const SCAFFOLD_HEADINGS: [&str; 4] = ["Problem", "What we found", "What we did", "Result"];

/// The starting body of a job: each scaffold heading with an empty line to
/// write under it. Shared by `openblog new --profile job` and Admin.
pub fn scaffold_body() -> String {
    let mut body = String::new();
    for heading in SCAFFOLD_HEADINGS {
        body.push_str(&format!("## {heading}\n\n"));
    }
    body
}

/// A trade id the site knows, lowercased, or the sentence listing the bundled
/// and site-level options.
pub fn normalize_trade(value: &str, extra_trades: &[String]) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    let trades = known_trades(extra_trades);
    if trades.contains(&normalized) {
        return Ok(normalized);
    }
    let bundled = TRADES.join(", ");
    let site: Vec<&String> = trades
        .iter()
        .filter(|trade| !TRADES.contains(&trade.as_str()))
        .collect();
    let site = if site.is_empty() {
        "none yet; add your own to `extraTrades` in openblog.json".to_string()
    } else {
        site.iter()
            .map(|trade| trade.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    Err(format!(
        "job.trade: `{}` is not a known trade; bundled trades are {bundled}; this site's own trades: {site}",
        value.trim()
    ))
}

/// A service id, lowercased, or the sentence naming the rule.
pub fn normalize_service(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if is_slug(&normalized) && normalized != RESERVED {
        Ok(normalized)
    } else {
        Err(format!(
            "job.service: `{}` is not a service id; use lowercase letters, digits and hyphens",
            value.trim()
        ))
    }
}

/// A town or region name for a job, or the sentence saying why it is refused
/// (a town only, never an address).
pub fn normalize_place(value: &str, field: &str) -> Result<String, String> {
    let mut problems = Vec::new();
    let value = place_part(Some(value.trim()), field, &mut problems);
    match problems.into_iter().next() {
        Some(problem) => Err(problem),
        None => Ok(value),
    }
}

/// Read and validate the `job` mapping. Every problem is a sentence naming
/// the field; all of them are returned, not only the first.
pub fn from_front_matter(
    fm: &FrontMatter,
    extra_trades: &[String],
) -> Result<JobMetadata, Vec<String>> {
    let mut problems = Vec::new();
    use crate::frontmatter::Value;
    if match fm.fields.get(JOB_KEY) {
        Some(Value::List(_)) => true,
        Some(Value::Scalar(value)) => !value.trim().is_empty(),
        None => false,
    } {
        return Err(vec![
            "job: must be a mapping with `trade`, `service`, `place`, `started` and `finished`"
                .into(),
        ]);
    }
    let scalar = |key: &str| {
        fm.get(&format!("{JOB_KEY}.{key}"))
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let list = |key: &str| fm.get_list(&format!("{JOB_KEY}.{key}"));

    let trade = match scalar("trade") {
        None => {
            problems.push("job.trade: add a trade, such as `flooring` or `other`".into());
            String::new()
        }
        Some(value) => match normalize_trade(value, extra_trades) {
            Ok(trade) => trade,
            Err(problem) => {
                problems.push(problem);
                value.to_ascii_lowercase()
            }
        },
    };

    let service = match scalar("service") {
        None => {
            problems.push("job.service: add the service this job was, as a short id such as `hardwood-install`".into());
            String::new()
        }
        Some(value) => match normalize_service(value) {
            Ok(service) => service,
            Err(problem) => {
                problems.push(problem);
                value.to_ascii_lowercase()
            }
        },
    };

    let town = place_part(scalar("place.town"), "job.place.town", &mut problems);
    let region = place_part(scalar("place.region"), "job.place.region", &mut problems);

    let started = date_field(scalar("started"), "job.started", &mut problems);
    let finished = date_field(scalar("finished"), "job.finished", &mut problems);
    if let (Some((started_at, _)), Some((finished_at, _))) = (&started, &finished) {
        if finished_at < started_at {
            problems.push("job.finished: must be the same day as `started` or later".into());
        }
    }

    let duration_hours = scalar("durationHours").and_then(|value| match value.parse::<f64>() {
        Ok(hours) if hours.is_finite() && hours > 0.0 && hours <= MAX_HOURS => {
            Some(value.to_string())
        }
        _ => {
            problems.push(format!(
                "job.durationHours: `{value}` is not a number of hours greater than 0"
            ));
            None
        }
    });

    let materials = list("materials");
    if materials.len() > MAX_MATERIALS {
        problems.push(format!(
            "job.materials: list at most {MAX_MATERIALS} materials"
        ));
    }
    for material in &materials {
        if material.trim().is_empty()
            || material.chars().count() > MAX_MATERIAL
            || material.chars().any(char::is_control)
        {
            problems.push(format!(
                "job.materials: each material needs 1 to {MAX_MATERIAL} characters of plain text"
            ));
            break;
        }
    }

    let cost_band = scalar("costBand").and_then(|value| match CostBand::parse(value) {
        Some(band) => Some(band),
        None => {
            problems.push(format!(
                "job.costBand: `{value}` is not a cost band; use one of {}",
                CostBand::ALL.map(CostBand::as_str).join(", ")
            ));
            None
        }
    });

    let before = media_list(&list("media.before"), "job.media.before", &mut problems);
    let after = media_list(&list("media.after"), "job.media.after", &mut problems);

    let review = scalar("review").and_then(|value| {
        let valid = value.len() <= 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
        if valid {
            Some(value.to_string())
        } else {
            problems.push(
                "job.review: use the id of a saved review, with letters, digits, `-` and `_` only"
                    .into(),
            );
            None
        }
    });

    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(JobMetadata {
        trade,
        service,
        town,
        region,
        started: started.map(|(_, day)| day).unwrap_or_default(),
        finished: finished.map(|(_, day)| day).unwrap_or_default(),
        duration_hours,
        materials,
        cost_band,
        before,
        after,
        review,
    })
}

pub(crate) fn is_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 60
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Towns only, never addresses (ADR 0285): digits and commas are what a street
/// address or postal code adds, so they are refused.
fn place_part(value: Option<&str>, field: &str, problems: &mut Vec<String>) -> String {
    let Some(value) = value else {
        problems.push(format!(
            "{field}: add the town or region name; never a street address"
        ));
        return String::new();
    };
    if value.chars().count() > MAX_TEXT
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_ascii_digit() || ch == ',')
    {
        problems.push(format!(
            "{field}: `{value}` should be a plain name of a town or region, not an address or postal code"
        ));
    }
    value.to_string()
}

fn date_field(
    value: Option<&str>,
    field: &str,
    problems: &mut Vec<String>,
) -> Option<(DateTime, String)> {
    let Some(value) = value else {
        problems.push(format!("{field}: add a date such as 2026-10-21"));
        return None;
    };
    let parsed = (value.len() == 10)
        .then(|| DateTime::parse(value))
        .flatten();
    match parsed {
        Some(date) => Some((date, date.ymd())),
        None => {
            problems.push(format!(
                "{field}: `{value}` is not a date; write it as YYYY-MM-DD"
            ));
            None
        }
    }
}

fn media_list(items: &[String], field: &str, problems: &mut Vec<String>) -> Vec<String> {
    if items.len() > MAX_MEDIA {
        problems.push(format!("{field}: list at most {MAX_MEDIA} images"));
    }
    for item in items {
        if !is_image_reference(item) {
            problems.push(format!(
                "{field}: `{item}` is not an image reference; use a site path or https URL ending in {}",
                IMAGE_EXTENSIONS.join(", ")
            ));
        }
    }
    items.iter().map(|item| item.trim().to_string()).collect()
}

fn is_image_reference(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_REF
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if lower.contains("://") && !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return false;
    }
    if lower.starts_with("//") || lower.contains("javascript:") || lower.contains("data:") {
        return false;
    }
    let path = lower.split(['?', '#']).next().unwrap_or("");
    if path.split('/').any(|segment| segment == "..") {
        return false;
    }
    path.rsplit_once('.')
        .is_some_and(|(_, extension)| IMAGE_EXTENSIONS.contains(&extension))
}
