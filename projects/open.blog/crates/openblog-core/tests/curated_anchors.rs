//! The anchors of the research-context section are in a reserved family no
//! heading id can take (ADR 0198).

use openblog_core::curated_context::{ANCHOR_PREFIX, SECTION_ID};

fn heading_ids(markdown: &str) -> Vec<String> {
    let html = openblog_core::markdown::render(markdown, Default::default()).html;
    html.match_indices("<h")
        .filter_map(|(at, _)| {
            let tag = &html[at..];
            let id = tag.split("id=\"").nth(1)?.split('"').next()?;
            Some(id.to_string())
        })
        .collect()
}

#[test]
fn the_section_and_item_anchors_are_in_the_reserved_ob_family() {
    assert!(SECTION_ID.starts_with("ob-"));
    assert!(ANCHOR_PREFIX.starts_with("ob-"));
}

#[test]
fn a_research_context_heading_keeps_its_slug_and_never_takes_the_sections_anchor() {
    let ids = heading_ids("## Research context\n\ntext\n");
    assert_eq!(ids, ["research-context"]);
    assert_ne!(ids[0], SECTION_ID);
}

#[test]
fn no_heading_can_take_a_reserved_curated_anchor() {
    // Generated slugs of "OB research context" and "OB curated x".
    let generated =
        heading_ids("## OB research context\n\n## OB curated x\n\n## OB research context title\n");
    assert!(
        generated
            .iter()
            .all(|id| !id.starts_with(SECTION_ID) && !id.starts_with(ANCHOR_PREFIX)),
        "{generated:?}"
    );
    // An id the author writes in the reserved space is not honoured either.
    let written = heading_ids(
        "## A {#ob-curated-x}\n\n## B {#ob-research-context}\n\n## C {#ob-research-context-title}\n\n## D {#plain}\n",
    );
    assert!(
        written
            .iter()
            .all(|id| !id.starts_with(SECTION_ID) && !id.starts_with(ANCHOR_PREFIX)),
        "{written:?}"
    );
    assert_eq!(written[3], "plain");
    let unique: std::collections::BTreeSet<_> = written.iter().collect();
    assert_eq!(unique.len(), written.len());
    // Ordinary headings are untouched.
    assert_eq!(heading_ids("## Obey the tide\n"), ["obey-the-tide"]);
}
