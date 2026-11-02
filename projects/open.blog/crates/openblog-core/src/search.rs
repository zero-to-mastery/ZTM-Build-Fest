//! A small client-side search index. The build writes `search.json`; the
//! WebAssembly module runs `query` over it in the browser.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IndexEntry {
    pub title: String,
    pub url: String,
    pub date: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub series: Option<String>,
    #[serde(default)]
    pub description: String,
    /// Lower-cased body text, truncated at build time.
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Index {
    pub version: u32,
    pub entries: Vec<IndexEntry>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub date: String,
    pub description: String,
    pub tags: Vec<String>,
    pub series: Option<String>,
    pub score: u32,
    /// A short body fragment around the first match, if any.
    pub snippet: String,
}

pub const INDEX_VERSION: u32 = 1;

/// Rank entries against a free-text query. Every term must appear somewhere;
/// title and tag matches weigh more than body matches.
pub fn query(index: &Index, raw: &str, limit: usize) -> Vec<Hit> {
    let terms: Vec<String> = raw
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2)
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<Hit> = index
        .entries
        .iter()
        .filter_map(|entry| {
            let title = entry.title.to_lowercase();
            let description = entry.description.to_lowercase();
            let tags: Vec<String> = entry.tags.iter().map(|t| t.to_lowercase()).collect();
            let series = entry.series.as_deref().unwrap_or("").to_lowercase();
            let mut score = 0u32;
            let mut first_body_match: Option<usize> = None;
            for term in &terms {
                let mut term_score = 0u32;
                if title.contains(term.as_str()) {
                    term_score += if title.starts_with(term.as_str()) {
                        12
                    } else {
                        8
                    };
                }
                if tags.iter().any(|t| t.contains(term.as_str())) {
                    term_score += 6;
                }
                if series.contains(term.as_str()) {
                    term_score += 4;
                }
                if description.contains(term.as_str()) {
                    term_score += 3;
                }
                if let Some(pos) = entry.text.find(term.as_str()) {
                    term_score +=
                        1 + (entry.text.matches(term.as_str()).count().min(10) as u32) / 2;
                    first_body_match = Some(first_body_match.map_or(pos, |p: usize| p.min(pos)));
                }
                if term_score == 0 {
                    return None;
                }
                score += term_score;
            }
            Some(Hit {
                title: entry.title.clone(),
                url: entry.url.clone(),
                date: entry.date.clone(),
                description: entry.description.clone(),
                tags: entry.tags.clone(),
                series: entry.series.clone(),
                score,
                snippet: first_body_match
                    .map(|pos| snippet(&entry.text, pos))
                    .unwrap_or_default(),
            })
        })
        .collect();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| b.date.cmp(&a.date)));
    hits.truncate(limit);
    hits
}

fn snippet(text: &str, pos: usize) -> String {
    let start = text[..pos]
        .char_indices()
        .rev()
        .nth(60)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let end = text[pos..]
        .char_indices()
        .nth(120)
        .map(|(i, _)| pos + i)
        .unwrap_or(text.len());
    let mut s = String::new();
    if start > 0 {
        s.push('…');
    }
    s.push_str(text[start..end].trim());
    if end < text.len() {
        s.push('…');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> Index {
        Index {
            version: INDEX_VERSION,
            entries: vec![
                IndexEntry {
                    title: "Rust enums".into(),
                    url: "/rust-enums/".into(),
                    date: "2026-10-21".into(),
                    tags: vec!["rust".into()],
                    series: Some("Rustbound".into()),
                    description: "Learn enums".into(),
                    text: "our player earns gold now. enums are great".into(),
                },
                IndexEntry {
                    title: "Web Components".into(),
                    url: "/wc/".into(),
                    date: "2025-04-20".into(),
                    tags: vec!["javascript".into()],
                    series: None,
                    description: "".into(),
                    text: "custom elements and shadow dom; rust is mentioned once".into(),
                },
            ],
        }
    }

    #[test]
    fn ranks_title_matches_first_and_requires_all_terms() {
        let hits = query(&index(), "rust", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "/rust-enums/");
        assert!(hits[1].snippet.contains("rust"));
        assert!(query(&index(), "rust shadow", 10)
            .iter()
            .all(|h| h.url == "/wc/"));
        assert!(query(&index(), "x", 10).is_empty());
    }
}
