//! The `services/` collection: one offering a business sells, described once
//! (ADR 0311). Pure validation of front matter and of the references jobs make
//! to a service; nothing here reads a file, a clock or the network.
//!
//! A service is `services/<name>.md`: front matter, then a Markdown body.
//! `faq` is a list of question and answer pairs, which the front matter parser
//! flattens to `faq.<n>.question` and `faq.<n>.answer`. Keys this version does
//! not know stay in the file untouched.

use std::collections::BTreeMap;

use crate::frontmatter::{FrontMatter, Value};
use crate::job::CostBand;
use crate::job_archive::{JobArchive, JobArchiveKind};
use crate::model::{Service, Site};
use serde_json::{json, Map, Value as Json};

/// The content folder a service lives in, and the first segment of its address.
pub const SERVICES_DIR: &str = "services";
/// The address of the services index.
pub const SERVICES_URL: &str = "/services/";
/// The only front matter version this release reads or writes.
pub const SERVICE_VERSION: u64 = 1;

pub const MAX_NAME: usize = 120;
pub const MAX_SUMMARY: usize = 300;
pub const MAX_INCLUDES: usize = 30;
pub const MAX_INCLUDE: usize = 160;
pub const MAX_TIMELINE: usize = 80;
pub const MAX_FAQ: usize = 20;
pub const MAX_QUESTION: usize = 200;
pub const MAX_ANSWER: usize = 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaqEntry {
    pub question: String,
    pub answer: String,
}

/// What a service's front matter says, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceMetadata {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub includes: Vec<String>,
    pub price_band: Option<CostBand>,
    pub typical_timeline: Option<String>,
    pub faq: Vec<FaqEntry>,
}

/// Whether a file under `services/` is a service at all: its front matter
/// declares `version` or `id`. A Markdown file there without either is a
/// legacy file from before services existed and is left out of the build, as
/// if it were not content, so no existing site starts failing or loses the
/// `services` address (ADR 0311).
pub fn declares_service(contents: &str) -> bool {
    crate::frontmatter::parse(contents).is_ok_and(|document| {
        let declared = |key: &str| {
            document
                .front_matter
                .get(key)
                .is_some_and(|value| !value.trim().is_empty())
        };
        declared("version") || declared("id")
    })
}

/// Read and validate a service's front matter. Every problem is a sentence
/// naming the field; all of them are returned, not only the first.
pub fn from_front_matter(fm: &FrontMatter) -> Result<ServiceMetadata, Vec<String>> {
    let mut problems = Vec::new();
    let scalar = |key: &str| fm.get(key).map(str::trim).filter(|value| !value.is_empty());

    match scalar("version") {
        None => {}
        Some(value) if value.parse::<u64>() == Ok(SERVICE_VERSION) => {}
        Some(value) => problems.push(format!(
            "version: `{value}` is not a version this release reads; use {SERVICE_VERSION}, or update open.blog if the file came from a newer one"
        )),
    }

    let id = match scalar("id") {
        None => {
            problems.push(
                "id: add a short id for the service, such as `hardwood-install`; jobs name it in `job.service`"
                    .into(),
            );
            String::new()
        }
        Some(value) => match check_id(value) {
            Ok(()) => value.to_string(),
            Err(problem) => {
                problems.push(problem);
                value.to_string()
            }
        },
    };
    let name = text_field(scalar("name"), "name", MAX_NAME, &mut problems);
    let summary = text_field(scalar("summary"), "summary", MAX_SUMMARY, &mut problems);

    let includes = fm.get_list("includes");
    if includes.len() > MAX_INCLUDES {
        problems.push(format!(
            "includes: list at most {MAX_INCLUDES} things the service includes"
        ));
    }
    if includes
        .iter()
        .any(|item| !plain(item) || item.chars().count() > MAX_INCLUDE)
    {
        problems.push(format!(
            "includes: each item needs 1 to {MAX_INCLUDE} characters of plain text"
        ));
    }

    let price_band = scalar("priceBand").and_then(|value| match CostBand::parse(value) {
        Some(band) => Some(band),
        None => {
            problems.push(format!(
                "priceBand: `{value}` is not a price band; use one of {}",
                CostBand::ALL.map(CostBand::as_str).join(", ")
            ));
            None
        }
    });

    let typical_timeline = scalar("typicalTimeline").and_then(|value| {
        if plain(value) && value.chars().count() <= MAX_TIMELINE {
            Some(value.to_string())
        } else {
            problems.push(format!(
                "typicalTimeline: use 1 to {MAX_TIMELINE} characters of plain text, such as `2 to 3 days`"
            ));
            None
        }
    });

    let faq = faq_entries(fm, &mut problems);

    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(ServiceMetadata {
        id,
        name,
        summary,
        includes,
        price_band,
        typical_timeline,
        faq,
    })
}

/// A service id: the same short id a job's `service` uses.
pub fn check_id(value: &str) -> Result<(), String> {
    if crate::job::is_slug(value) && value != crate::job::RESERVED {
        Ok(())
    } else {
        Err(format!(
            "id: `{value}` is not a service id; use lowercase letters, digits and hyphens (and not `page`)"
        ))
    }
}

/// The sentence a job gets when its `service` is not one of the site's
/// services, with the known ids listed. `None` when the site has no services
/// (so a site without the collection behaves as it always did) or the id is
/// known.
pub fn unknown_service_problem(known: &[&str], service: &str) -> Option<String> {
    if known.is_empty() || known.contains(&service) {
        return None;
    }
    Some(format!(
        "job.service: `{service}` is not one of this site's services; known service ids are {}",
        known.join(", ")
    ))
}

fn plain(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(char::is_control)
}

fn text_field(value: Option<&str>, field: &str, max: usize, problems: &mut Vec<String>) -> String {
    match value {
        None => {
            problems.push(format!("{field}: add the service's {field}"));
            String::new()
        }
        Some(value) if !plain(value) || value.chars().count() > max => {
            problems.push(format!(
                "{field}: use 1 to {max} characters of plain text on one line"
            ));
            value.to_string()
        }
        Some(value) => value.to_string(),
    }
}

fn faq_entries(fm: &FrontMatter, problems: &mut Vec<String>) -> Vec<FaqEntry> {
    if fm.fields.get("faq").is_some_and(|value| match value {
        Value::Scalar(text) => !text.trim().is_empty(),
        Value::List(items) => !items.is_empty(),
    }) {
        problems
            .push("faq: write each entry as `- question: ...` followed by `answer: ...`".into());
    }
    let mut numbered: BTreeMap<usize, (Option<&str>, Option<&str>)> = BTreeMap::new();
    for (key, value) in &fm.fields {
        let Some(rest) = key.strip_prefix("faq.") else {
            continue;
        };
        let Some((number, field)) = rest.split_once('.') else {
            continue;
        };
        let (Ok(number), Value::Scalar(text)) = (number.parse::<usize>(), value) else {
            continue;
        };
        let entry = numbered.entry(number).or_default();
        match field {
            "question" => entry.0 = Some(text.trim()),
            "answer" => entry.1 = Some(text.trim()),
            _ => {}
        }
    }
    if numbered.len() > MAX_FAQ {
        problems.push(format!("faq: list at most {MAX_FAQ} questions"));
    }
    let mut entries = Vec::new();
    for (position, (_, (question, answer))) in numbered.into_iter().enumerate() {
        let at = position + 1;
        let question = question.filter(|text| !text.is_empty());
        let answer = answer.filter(|text| !text.is_empty());
        match (question, answer) {
            (Some(question), Some(answer)) => {
                if !plain(question) || question.chars().count() > MAX_QUESTION {
                    problems.push(format!(
                        "faq entry {at}: the question needs 1 to {MAX_QUESTION} characters of plain text"
                    ));
                }
                if !plain(answer) || answer.chars().count() > MAX_ANSWER {
                    problems.push(format!(
                        "faq entry {at}: the answer needs 1 to {MAX_ANSWER} characters of plain text"
                    ));
                }
                entries.push(FaqEntry {
                    question: question.to_string(),
                    answer: answer.to_string(),
                });
            }
            (Some(_), None) => problems.push(format!("faq entry {at}: add an answer")),
            (None, Some(_)) => problems.push(format!("faq entry {at}: add a question")),
            (None, None) => problems.push(format!(
                "faq entry {at}: add a question and an answer, or remove the entry"
            )),
        }
    }
    entries
}

/// The jobs archives that cover one service, one per trade that has done it,
/// in the archive plan's order (ADR 0286).
pub fn job_archives<'a>(plan: &'a [JobArchive], id: &str) -> Vec<&'a JobArchive> {
    plan.iter()
        .filter(|archive| {
            archive.kind == JobArchiveKind::Service && archive.service.as_deref() == Some(id)
        })
        .collect()
}

/// Indices into `Site::posts` of the newest jobs done for a service, newest
/// first, at most `limit`. A smaller index is a newer post.
pub fn recent_jobs(plan: &[JobArchive], id: &str, limit: usize) -> Vec<usize> {
    let mut all: Vec<usize> = job_archives(plan, id)
        .into_iter()
        .flat_map(|archive| archive.posts.iter().copied())
        .collect();
    all.sort_unstable();
    all.dedup();
    all.truncate(limit);
    all
}

/// `Service` structured data for a service's page, with a `FAQPage` beside it
/// only when it has questions (ADR 0312). Built from what the service file
/// says and nothing else; the keys are written in a fixed order, so the same
/// site always gives the same text. The caller escapes it for a `<script>`.
pub fn json_ld(site: &Site, service: &Service) -> String {
    let c = &site.config;
    let url = c.absolute(&service.url);
    let provider = if c.business.has_public_facts() {
        let name = if c.business.name().is_empty() {
            c.title.as_str()
        } else {
            c.business.name()
        };
        json!({ "@type": c.business.schema_type(), "@id": c.absolute("/#business"), "name": name })
    } else {
        json!({ "@type": "Organization", "name": c.title })
    };
    let mut node = Map::new();
    node.insert("@type".into(), "Service".into());
    node.insert("@id".into(), format!("{url}#service").into());
    node.insert("name".into(), service.name.clone().into());
    node.insert("description".into(), service.summary.clone().into());
    node.insert("url".into(), url.clone().into());
    node.insert("provider".into(), provider);
    if !service.includes.is_empty() {
        let items: Vec<Json> = service
            .includes
            .iter()
            .map(|item| json!({ "@type": "Offer", "itemOffered": { "@type": "Service", "name": item } }))
            .collect();
        node.insert(
            "hasOfferCatalog".into(),
            json!({ "@type": "OfferCatalog", "name": "What is included", "itemListElement": items }),
        );
    }
    if let Some(band) = service.price_band {
        node.insert(
            "offers".into(),
            json!({ "@type": "Offer", "description": format!("Price band: {}", band.label()) }),
        );
    }
    let mut graph = vec![Json::Object(node)];
    if !service.faq.is_empty() {
        let questions: Vec<Json> = service
            .faq
            .iter()
            .map(|entry| {
                json!({
                    "@type": "Question",
                    "name": entry.question,
                    "acceptedAnswer": { "@type": "Answer", "text": entry.answer },
                })
            })
            .collect();
        graph.push(json!({
            "@type": "FAQPage",
            "@id": format!("{url}#faq"),
            "mainEntity": questions,
        }));
    }
    json!({ "@context": "https://schema.org", "@graph": graph }).to_string()
}
