//! Offline review of an opted-in post's citations (ADR 0050).
//!
//! Four classes of finding stay apart, so an author can tell what kind of
//! problem each one is and who can fix it:
//!
//! 1. **Syntax** (`citation-syntax`): a `[@...]` the scanner cannot read.
//! 2. **Resolution** (`citation-unresolved`, `citation-identifier-unpublished`):
//!    a key with no source in the library, a locator that does not fit the
//!    kind of source, or a public identifier in a form readers cannot follow,
//!    which is left out of the note.
//! 3. **Completeness** (`citation-reference-incomplete`): a cited reference
//!    without a detail its kind usually has (title, creator, date, container,
//!    publisher, web address). Only explicit authored data is read; nothing is
//!    ever filled in.
//! 4. **Location review** (`citation-location-review`): a citation that gives
//!    a page or other location. open.blog checks only that the locator is well
//!    formed and fits the source; whether the passage is really there is for a
//!    person to check against the source.
//!
//! Every check is deterministic and reads only the post and the source
//! library: nothing is looked up online, and no finding says whether a source
//! is true, relevant, authoritative or supports a claim. Findings are author
//! guidance for `openblog check`, builds and Evidence Studio; they never reach
//! a public page.

use crate::citations::{
    format_citation, public_identifier, resolve_citations, scan_citations, Citation,
    CitationDiagnostic, CitationDiagnosticCode, PublicReference,
};
use crate::research::{EvidenceCode, EvidenceFinding, EvidenceOutcome, EvidenceSource};
use crate::source_library::SourceLibrary;

/// CSL types whose items normally sit inside a container (a journal, a book,
/// proceedings, a site).
const CONTAINED_TYPES: &[&str] = &[
    "article",
    "article-journal",
    "article-magazine",
    "article-newspaper",
    "chapter",
    "entry",
    "entry-dictionary",
    "entry-encyclopedia",
    "paper-conference",
    "post-weblog",
];
/// CSL types whose items normally name a publisher or institution.
const PUBLISHED_TYPES: &[&str] = &["book", "report", "thesis"];
/// CSL types whose items are normally found by their web address.
const WEB_TYPES: &[&str] = &["post", "post-weblog", "webpage"];

/// Review the citations of one post's Markdown. `path` and `body_line` place
/// findings in the source file. `library` is called only when the post cites
/// something; when it fails or there is no library, only syntax is reviewed
/// (publication reports the missing library itself).
pub fn review_citations<'l>(
    path: &str,
    markdown: &str,
    body_line: usize,
    library: impl FnOnce() -> Result<Option<&'l SourceLibrary>, String>,
) -> Vec<EvidenceFinding> {
    let file_line = |line: Option<usize>| line.map(|line| line + body_line.max(1) - 1);
    let finding = |code, outcome, line: Option<usize>, field: Option<String>, message, repair| {
        EvidenceFinding {
            code,
            outcome,
            source: EvidenceSource {
                path: path.to_string(),
                line: file_line(line),
                column: None,
                field,
            },
            message,
            repair,
            object: None,
            facts: Vec::new(),
        }
    };
    let scan = scan_citations(markdown);
    let mut findings: Vec<EvidenceFinding> = scan
        .diagnostics
        .iter()
        .map(|found| {
            finding(
                EvidenceCode::CitationSyntax,
                EvidenceOutcome::Detected,
                found.line,
                None,
                diagnostic_message(found),
                syntax_repair(found.code).into(),
            )
            .with_facts(diagnostic_facts(found))
        })
        .collect();
    if scan.mentions.is_empty() {
        return findings;
    }
    let Ok(Some(library)) = library() else {
        return findings;
    };
    let resolved = resolve_citations(&scan.mentions, library);
    for found in &resolved.diagnostics {
        let repair = match found.code {
            CitationDiagnosticCode::AmbiguousLocator => {
                "Cite the edition, translation or witness the location belongs to, or use a canonical locator."
            }
            _ => "Add the source to the library or correct the key; write `\\[@` for literal text.",
        };
        findings.push(
            finding(
                EvidenceCode::CitationUnresolved,
                EvidenceOutcome::Detected,
                found.line,
                None,
                diagnostic_message(found),
                repair.into(),
            )
            .with_facts(diagnostic_facts(found)),
        );
    }

    // Where each reference is first cited, to place reference-level findings.
    let first_line = |key: &str| {
        scan.mentions
            .iter()
            .find(|mention| mention.citation.key == key)
            .map(|mention| mention.line)
    };
    for reference in &resolved.references {
        let line = first_line(&reference.key);
        if let Some(record) = library.get(&reference.key) {
            for identifier in &record.identifiers {
                if matches!(identifier.scheme.as_str(), "pmid" | "pmcid")
                    && !public_identifier(&identifier.scheme, &identifier.value)
                {
                    findings.push(finding(
                        EvidenceCode::CitationIdentifierUnpublished,
                        EvidenceOutcome::Potential,
                        line,
                        Some("identifiers".into()),
                        format!(
                            "Source `{}` has a `{}` identifier that is not in its standard form, so the note and exports leave it out.",
                            reference.key, identifier.scheme
                        ),
                        if identifier.scheme == "pmid" {
                            "Write a PMID as its digits only, such as `12345678`, in Admin's Sources view."
                        } else {
                            "Write a PMCID as `PMC` and its digits, such as `PMC1234567`, in Admin's Sources view."
                        }
                        .into(),
                    )
                    .with_facts([
                        reference.key.as_str(),
                        identifier.scheme.as_str(),
                        identifier.value.as_str(),
                    ]));
                }
                // A web address the publication boundary withholds (ADR 0125).
                if let Some(problem) = (identifier.scheme == "url")
                    .then(|| crate::citations::public_url_problem(&identifier.value))
                    .flatten()
                {
                    findings.push(
                        finding(
                            EvidenceCode::CitationIdentifierUnpublished,
                            EvidenceOutcome::Potential,
                            line,
                            Some("identifiers".into()),
                            format!(
                                "Source `{}` has a web address that is not published because {problem}, so the note and exports leave it out.",
                                reference.key
                            ),
                            "Give the source an address readers can reach, without a key, token or signature, in Admin's Sources view.".into(),
                        )
                        .with_facts([
                            reference.key.as_str(),
                            identifier.scheme.as_str(),
                            identifier.value.as_str(),
                        ]),
                    );
                }
            }
        }
        for (field, consequence) in missing_details(reference) {
            findings.push(finding(
                EvidenceCode::CitationReferenceIncomplete,
                EvidenceOutcome::Potential,
                line,
                Some(field.into()),
                format!("Source `{}` has no {consequence}", reference.key),
                format!(
                    "If the source has one, add it to `{}` in Admin's Sources view or in your reference manager and import again; open.blog never fills in missing details.",
                    reference.key
                ),
            )
            .with_facts([reference.key.as_str()]));
        }
    }

    // One finding per post for every resolved citation that gives a location.
    let unresolved: Vec<(Option<usize>, Option<&str>)> = resolved
        .diagnostics
        .iter()
        .map(|found| (found.line, found.key.as_deref()))
        .collect();
    let located_mentions: Vec<_> = scan
        .mentions
        .iter()
        .filter(|mention| !mention.citation.locators.is_empty())
        .filter(|mention| {
            !unresolved.contains(&(Some(mention.line), Some(mention.citation.key.as_str())))
        })
        .collect();
    let located: Vec<usize> = located_mentions
        .iter()
        .filter_map(|mention| file_line(Some(mention.line)))
        .collect();
    if let Some(&first) = located.first() {
        let mut lines: Vec<String> = located.iter().map(usize::to_string).collect();
        lines.dedup();
        findings.push(EvidenceFinding {
            code: EvidenceCode::CitationLocationReview,
            outcome: EvidenceOutcome::NeedsReview,
            source: EvidenceSource {
                path: path.to_string(),
                line: Some(first),
                column: None,
                field: None,
            },
            message: format!(
                "{} citation{} give{} a location (line{} {}). open.blog checked only that each locator is well formed and fits the kind of source; whether the passage is at that location is for a person to check.",
                located.len(),
                if located.len() == 1 { "" } else { "s" },
                if located.len() == 1 { "s" } else { "" },
                if lines.len() == 1 { "" } else { "s" },
                lines.join(", ")
            ),
            repair: "Compare each location with the source itself, for example with a notebook passage captured there.".into(),
            object: None,
            // Each located citation's key and locators, in reading order:
            // what the prompt is about, without the lines it names.
            facts: located_mentions
                .iter()
                .map(|mention| citation_fact(&mention.citation))
                .collect(),
        });
    }
    findings
}

/// A diagnostic as a sentence with its code, naming the key but nothing else
/// from the library or the notebook.
fn diagnostic_message(found: &CitationDiagnostic) -> String {
    let code = code_name(found.code);
    match &found.key {
        Some(key) => format!("Citation `{key}`: {} ({code}).", found.message),
        None => format!("{} ({code}).", found.message),
    }
}

fn code_name(code: CitationDiagnosticCode) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// A diagnostic's code and key, without its line.
fn diagnostic_facts(found: &CitationDiagnostic) -> Vec<String> {
    let mut facts = vec![code_name(found.code)];
    facts.extend(found.key.clone());
    facts
}

/// A citation's key and locators in its canonical `[@key, ...]` form.
fn citation_fact(citation: &Citation) -> String {
    format_citation(citation).unwrap_or_else(|_| citation.key.clone())
}

fn syntax_repair(code: CitationDiagnosticCode) -> &'static str {
    match code {
        CitationDiagnosticCode::TooLarge | CitationDiagnosticCode::TooManyCitations => {
            "Split the post."
        }
        _ => "Correct the citation, or write `\\[@` for literal text.",
    }
}

/// The details a cited reference lacks that its kind usually has, as `(field,
/// what readers miss)`. Only the public description is read, and an absent
/// detail is reported, never guessed.
pub fn missing_details(reference: &PublicReference) -> Vec<(&'static str, &'static str)> {
    let csl_type = reference.csl.get("type").map(String::as_str);
    let is = |types: &[&str]| csl_type.is_some_and(|kind| types.contains(&kind));
    let mut missing = Vec::new();
    if reference.title.is_none() {
        missing.push(("title", "title, so the note shows only its key."));
    }
    if reference.creators.is_empty() && matches!(reference.kind, "work" | "edition" | "translation")
    {
        missing.push((
            "creators",
            "author, editor or translator, so the note names no one.",
        ));
    }
    if reference.issued.is_none()
        && (csl_type.is_some() || matches!(reference.kind, "edition" | "translation"))
    {
        missing.push((
            "issued",
            "date, so readers cannot tell which version it is.",
        ));
    }
    if is(CONTAINED_TYPES) && !reference.csl.contains_key("container-title") {
        missing.push((
            "container-title",
            "container title (journal, book or site), which readers need to find it.",
        ));
    }
    let publisher_expected =
        is(PUBLISHED_TYPES) || (csl_type.is_none() && reference.kind == "edition");
    if publisher_expected && !reference.csl.contains_key("publisher") {
        missing.push(("publisher", "publisher, which readers need to find it."));
    }
    if is(WEB_TYPES)
        && !reference
            .identifiers
            .iter()
            .any(|(scheme, _)| scheme == "url")
    {
        missing.push(("url", "web address, which readers need to find it."));
    }
    missing
}
