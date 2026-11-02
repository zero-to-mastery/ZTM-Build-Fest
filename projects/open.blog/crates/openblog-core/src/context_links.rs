//! Context links in a post (ADR 0122, ADR 0123): links to an atlas entry's
//! page (`/atlas/<id>/`) or a comparison's page (`/comparisons/<id>/`), and
//! whether the next build publishes the page each one names.
//!
//! This is the `context-link` check of the pre-publication review. It reads
//! only the post's Markdown and a lookup of what the next build publishes; it
//! never reads private research itself, and its messages name the address
//! and the id the link carries, never a label, note or excerpt. A link to a
//! page that will not exist is a gap to repair, not a privacy failure: the
//! address is the author's own text in the post, so nothing here refuses.

use pulldown_cmark::{Event, LinkType, Parser, Tag};

use crate::atlas_publication::ATLAS_URL;
use crate::comparison_publication::COMPARISONS_URL;

/// What kind of page a context link names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ContextKind {
    /// An atlas entry's page, `/atlas/<id>/`.
    AtlasEntry,
    /// A comparison's page, `/comparisons/<id>/`.
    Comparison,
}

/// What a context link is written as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkForm {
    /// A link with a label, `[label](address)` in any of its forms.
    Link,
    /// An autolink, `<atlas:id>`: it has no label.
    Autolink,
    /// An image, `![alt](atlas:id)`.
    Image,
}

/// One link in the post to a context page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextLink {
    pub kind: ContextKind,
    /// The entry or alignment id the address names.
    pub id: String,
    /// The address exactly as written in the post.
    pub href: String,
    /// One-based line of the link in the post's source document.
    pub line: usize,
    /// What it is written as.
    pub form: LinkForm,
    /// Whether the build shows it as a link to its page: a root-relative
    /// address always is; an `atlas:` link is only when it is a labelled
    /// link written with the scheme in lowercase. An image, an autolink and
    /// a scheme in capitals are never shown as links.
    pub linked: bool,
}

/// Why the next build does not publish the page a context link names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextGap {
    /// The site does not publish its Knowledge Atlas or its comparisons.
    NotPublishing,
    /// No atlas entry or alignment has the id.
    Unknown,
    /// The entry or alignment exists but is not approved.
    NotApproved,
    /// The alignment is approved, but the comparison projection refuses it as it stands.
    NotProjected,
    /// The build never shows this `atlas:` form as a link, whatever the entry:
    /// an image, an autolink, or a scheme not written in lowercase.
    NeverLinked,
}

/// A context link whose page the next build does not publish.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextLinkFinding {
    pub link: ContextLink,
    pub gap: ContextGap,
    pub message: String,
    pub repair: String,
}

/// The id a root-relative context address, or an `atlas:<id>` concept link,
/// names, without any query or
/// fragment, or `None` for any other address. Only one plain path segment of
/// lowercase letters, digits and hyphens is an id.
pub fn parse_context_href(href: &str) -> Option<(ContextKind, String)> {
    // The author's explicit concept link, `atlas:<id>` (ADR 0172), in any
    // letter case and with the padding a browser ignores, as the build reads it.
    if let Some((id, _)) = crate::concept_links::atlas_destination(href) {
        return crate::knowledge_atlas::valid_id(&id).then_some((ContextKind::AtlasEntry, id));
    }
    let path = href.split(['#', '?']).next().unwrap_or_default();
    let (kind, rest) = if let Some(rest) = path.strip_prefix(ATLAS_URL) {
        (ContextKind::AtlasEntry, rest)
    } else {
        let rest = path.strip_prefix(COMPARISONS_URL)?;
        (ContextKind::Comparison, rest)
    };
    let id = rest.strip_suffix('/').unwrap_or(rest);
    let valid = !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !id.starts_with('-')
        && !id.ends_with('-');
    valid.then(|| (kind, id.to_string()))
}

/// Every context link in `markdown`, in reading order. `first_line` is the
/// one-based line of the source document where `markdown` begins, so lines
/// match the post's file. Links inside code are not links and are skipped.
pub fn find_context_links(markdown: &str, first_line: usize) -> Vec<ContextLink> {
    let parser = Parser::new_ext(markdown, crate::markdown::parser_options(false));
    let mut links = Vec::new();
    for (event, range) in parser.into_offset_iter() {
        let (dest_url, form) = match event {
            Event::Start(Tag::Link {
                dest_url,
                link_type: LinkType::Autolink | LinkType::Email,
                ..
            }) => (dest_url, LinkForm::Autolink),
            Event::Start(Tag::Link { dest_url, .. }) => (dest_url, LinkForm::Link),
            // Only an `atlas:` image is a context link: an ordinary image
            // of a page address is a picture.
            Event::Start(Tag::Image { dest_url, .. })
                if crate::concept_links::atlas_destination(&dest_url).is_some() =>
            {
                (dest_url, LinkForm::Image)
            }
            _ => continue,
        };
        let Some((kind, id)) = parse_context_href(&dest_url) else {
            continue;
        };
        let linked = match crate::concept_links::atlas_destination(&dest_url) {
            Some((_, canonical)) => canonical && form == LinkForm::Link,
            None => true,
        };
        let line = first_line + markdown[..range.start].matches('\n').count();
        links.push(ContextLink {
            kind,
            id,
            href: dest_url.to_string(),
            line,
            form,
            linked,
        });
    }
    links
}

/// Review each context link against `gap`, which says why the next build
/// does not publish the page a link names, or `None` when it does.
pub fn review_context_links(
    links: &[ContextLink],
    gap: impl Fn(ContextKind, &str) -> Option<ContextGap>,
) -> Vec<ContextLinkFinding> {
    links
        .iter()
        .filter_map(|link| {
            let gap = if link.linked {
                gap(link.kind, &link.id)?
            } else {
                ContextGap::NeverLinked
            };
            let (thing, switch) = match link.kind {
                ContextKind::AtlasEntry => ("atlas entry", "`knowledgeAtlas.publish`"),
                ContextKind::Comparison => ("comparison", "`comparisons.publish`"),
            };
            let reason = match gap {
                ContextGap::NotPublishing => {
                    format!("the site does not publish these pages ({switch} is off)")
                }
                ContextGap::Unknown => format!("no {thing} has the id `{}`", link.id),
                ContextGap::NotApproved => format!("the {thing} `{}` is not approved", link.id),
                ContextGap::NotProjected => format!(
                    "the comparison `{}` is approved, but cannot be published as it stands",
                    link.id
                ),
                ContextGap::NeverLinked => match link.form {
                    LinkForm::Image => "an image cannot have an `atlas:` address".to_string(),
                    LinkForm::Autolink => "an autolink has no label, so it shows nothing".to_string(),
                    LinkForm::Link => "the scheme must be written `atlas:`, in lowercase".to_string(),
                },
            };
            let repair = match gap {
                ContextGap::NotPublishing => {
                    format!("Turn on {switch} to publish the page, or remove the link.")
                }
                ContextGap::Unknown => "Correct the address, or remove the link.".to_string(),
                ContextGap::NotApproved => {
                    format!("Approve the {thing} if it is ready to be public, or remove the link.")
                }
                ContextGap::NotProjected => {
                    "Open the comparison to see what stops it, or remove the link.".to_string()
                }
                ContextGap::NeverLinked => "Write `[label](atlas:id)`, or remove it.".to_string(),
            };
            let concept = crate::concept_links::atlas_destination(&link.href).is_some();
            Some(ContextLinkFinding {
                link: link.clone(),
                gap,
                message: if concept && gap == ContextGap::NeverLinked {
                    // Said as the build says it: an autolink or an image is
                    // not shown at all, any other form shows its words.
                    let shown = if link.form == LinkForm::Link {
                        "is shown as plain text"
                    } else {
                        "is not shown"
                    };
                    format!("The concept link {} {shown}: {reason}.", link.href)
                } else if concept {
                    format!(
                        "The concept link {} is shown as plain text, because the next build does not publish the entry: {reason}.",
                        link.href
                    )
                } else {
                    format!(
                        "The link to {} names a page the next build does not publish: {reason}.",
                        link.href
                    )
                },
                repair,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_context_addresses_are_context_links() {
        assert_eq!(
            parse_context_href("/atlas/plato/"),
            Some((ContextKind::AtlasEntry, "plato".into()))
        );
        assert_eq!(
            parse_context_href("/comparisons/cave-places/#members"),
            Some((ContextKind::Comparison, "cave-places".into()))
        );
        for other in [
            "/atlas/",
            "/atlas/a/b/",
            "/atlas/Plato/",
            "/atlas/../x/",
            "https://example.com/atlas/plato/",
            "/posts/atlas/",
            "/atlas/-x/",
        ] {
            assert_eq!(parse_context_href(other), None, "{other}");
        }
    }

    #[test]
    fn an_author_written_concept_link_names_its_entry_too() {
        assert_eq!(
            parse_context_href("atlas:plato"),
            Some((ContextKind::AtlasEntry, "plato".into()))
        );
        assert_eq!(parse_context_href("atlas:Plato"), None);
        // As the build reads it: any letter case, and the padding a browser drops.
        assert_eq!(
            parse_context_href(" ATLAS:plato"),
            Some((ContextKind::AtlasEntry, "plato".into()))
        );
        let links = find_context_links("A [word](atlas:plato) and `[x](atlas:code)`.", 3);
        assert_eq!(links.len(), 1);
        assert_eq!(
            (links[0].id.as_str(), links[0].href.as_str(), links[0].line),
            ("plato", "atlas:plato", 3)
        );
        let findings = review_context_links(&links, |_, _| Some(ContextGap::NotApproved));
        assert!(findings[0]
            .message
            .starts_with("The concept link atlas:plato is shown as plain text"));
    }

    #[test]
    fn every_atlas_form_is_found_and_the_ones_the_build_never_links_say_so() {
        let markdown = "A [a](ATLAS:alpha), <atlas:beta>, ![c](atlas:gamma), [d][r] and [e](atlas:delta).\n\n![pic](/pic.png)\n\n[r]: atlas:epsilon\n";
        let links = find_context_links(markdown, 1);
        let seen: Vec<_> = links
            .iter()
            .map(|link| (link.id.as_str(), link.form, link.linked))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("alpha", LinkForm::Link, false),
                ("beta", LinkForm::Autolink, false),
                ("gamma", LinkForm::Image, false),
                ("epsilon", LinkForm::Link, true),
                ("delta", LinkForm::Link, true),
            ]
        );
        // A published entry still gets a finding for the forms that are never shown.
        let findings = review_context_links(&links, |_, _| None);
        let messages: Vec<_> = findings.iter().map(|f| f.message.as_str()).collect();
        assert_eq!(messages.len(), 3, "{messages:?}");
        assert!(messages[0].starts_with("The concept link ATLAS:alpha is shown as plain text"));
        assert!(
            messages[1].starts_with("The concept link atlas:beta is not shown"),
            "{}",
            messages[1]
        );
        assert!(
            messages[2].starts_with("The concept link atlas:gamma is not shown"),
            "{}",
            messages[2]
        );
        assert!(findings.iter().all(|f| f.gap == ContextGap::NeverLinked));
    }

    #[test]
    fn links_are_found_with_their_source_lines_and_never_inside_code() {
        let markdown = "Intro [Plato](/atlas/plato/).\n\n`[x](/atlas/hidden/)`\n\n```\n[y](/comparisons/z/)\n```\n\nSee [the places](/comparisons/cave/).\n";
        let links = find_context_links(markdown, 5);
        assert_eq!(
            links
                .iter()
                .map(|link| (link.kind, link.id.as_str(), link.line))
                .collect::<Vec<_>>(),
            vec![
                (ContextKind::AtlasEntry, "plato", 5),
                (ContextKind::Comparison, "cave", 13)
            ]
        );
    }

    #[test]
    fn a_finding_names_the_address_and_id_and_never_judges_the_page() {
        let links = find_context_links("[a](/atlas/a/) [b](/atlas/b/) [c](/comparisons/c/)", 1);
        let findings = review_context_links(&links, |kind, id| match (kind, id) {
            (ContextKind::AtlasEntry, "a") => None,
            (ContextKind::AtlasEntry, _) => Some(ContextGap::NotApproved),
            (ContextKind::Comparison, _) => Some(ContextGap::NotPublishing),
        });
        assert_eq!(findings.len(), 2);
        assert_eq!(
            findings[0].message,
            "The link to /atlas/b/ names a page the next build does not publish: the atlas entry `b` is not approved."
        );
        assert!(findings[1].message.contains("`comparisons.publish` is off"));
        for finding in &findings {
            assert!(!finding.message.to_lowercase().contains("wrong"));
        }
    }
}
