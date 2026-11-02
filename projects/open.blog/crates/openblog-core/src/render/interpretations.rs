//! The interpretation comparison pages (ADR 0232, #90).
//!
//! Every page is complete HTML rendered from the one public value
//! ([`PublicInterpretations`]). The interpretations come first, each with who
//! advances it, its statement in the author's words, its uncertainty and its
//! evidence. The relations between them follow, and the explanation levels
//! come last as supplements: every level is a static section a reader can
//! reach by link without JavaScript. `<ob-explanation-levels>` only adds a
//! level selector over those sections. A level never contains, replaces or
//! changes the interpretations or their evidence above it.

use crate::escape::{attr, text};
use crate::interpretation_publication::{
    PublicInterpretations, PublicLink, PublishedComparison, INTERPRETATIONS_URL,
};
use crate::scholarly_comparison::{
    Level, PublicAttribution, PublicEvidence, PublicExplanation, PublicInterpretation,
    PublicProvenance, RelationKind,
};
use crate::theme::Theme;

use super::Renderer;

/// What the index says before any comparison.
const LEDE: &str = "Attributed readings of one subject, set side by side, with the evidence each cites. Nothing here rules between them, ranks them or says which scholars agree.";
/// What a comparison page says about itself.
const NOTE: &str = "Each interpretation is the reading of the person or work it is attributed to, in the author's summary. The page does not say which is right, and an explanation below is a supplement to the interpretations: it never replaces them or changes their evidence.";

pub(crate) fn relation_label(kind: RelationKind) -> &'static str {
    match kind {
        RelationKind::DiffersFrom => "differs from",
        RelationKind::AgreesWith => "agrees with",
        RelationKind::BuildsOn => "builds on",
        RelationKind::RespondsTo => "responds to",
    }
}

pub(crate) fn level_label(level: Level) -> &'static str {
    match level {
        Level::Beginner => "Beginner",
        Level::Student => "Student",
        Level::Scholarly => "Scholarly",
    }
}

/// A short phrase for how firmly the author attributes the reading.
pub(crate) fn certainty_label(value: &str) -> &'static str {
    match value {
        "stated" => "the person or work states this reading",
        "attributed" => "traditionally attributed to them",
        "uncertain" => "attribution uncertain",
        _ => "attribution disputed",
    }
}

fn paragraphs(value: &str) -> String {
    value
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| format!("<p dir=\"auto\">{}</p>\n", text(p)))
        .collect()
}

impl Renderer<'_> {
    pub(super) fn interpretations_index(
        &self,
        theme: &Theme,
        public: &PublicInterpretations,
    ) -> String {
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<section class=\"ob-section ob-interpretations\">\n",
        );
        body.push_str(&self.heading(theme, 1, "Interpretations", "ob-section-heading"));
        body.push_str(&format!("\n<p class=\"ob-lede\">{}</p>\n", text(LEDE)));
        body.push_str("<ul class=\"ob-archive\">\n");
        for published in &public.comparisons {
            let c = &published.comparison;
            let count = c.interpretations.len();
            body.push_str(&format!(
                "<li><a href=\"{}\"><bdi>{}</bdi></a> <span class=\"ob-meta\">{count} interpretations</span><br><span dir=\"auto\">{}</span></li>\n",
                attr(&published.url),
                text(&c.title),
                text(&c.subject)
            ));
        }
        body.push_str("</ul>\n</section>\n</div>");
        self.simple(
            theme,
            "Interpretations",
            "Attributed readings of one subject, side by side, with their evidence.",
            INTERPRETATIONS_URL,
            &body,
        )
    }

    pub(super) fn interpretation_page(
        &self,
        theme: &Theme,
        public: &PublicInterpretations,
        published: &PublishedComparison,
    ) -> String {
        let c = &published.comparison;
        let mut body = String::from(
            "<div class=\"ob-container ob-container-reading\">\n<article class=\"ob-page ob-interpretation-comparison\">\n",
        );
        body.push_str(&format!(
            "<p class=\"ob-eyebrow\"><a href=\"{INTERPRETATIONS_URL}\">Interpretations</a></p>\n"
        ));
        body.push_str(&self.heading(theme, 1, &c.title, "ob-post-title"));
        body.push_str("\n<div class=\"ob-prose\">\n");
        body.push_str(&format!(
            "<p class=\"ob-lede\" dir=\"auto\">{}</p>\n<p class=\"ob-meta\">{} interpretations. {}</p>\n",
            text(&c.subject),
            c.interpretations.len(),
            text(NOTE)
        ));
        // The contents: every part of the page by link, so the page reads and
        // navigates the same with or without JavaScript.
        body.push_str("<nav class=\"ob-interp-contents\" aria-label=\"On this page\">\n<ul>\n");
        body.push_str("<li><a href=\"#interpretations\">Interpretations</a></li>\n");
        if !c.relations.is_empty() {
            body.push_str("<li><a href=\"#relations\">How they relate</a></li>\n");
        }
        if !c.explanations.is_empty() {
            body.push_str("<li><a href=\"#explanations\">Explanations by level</a></li>\n");
        }
        body.push_str("</ul>\n</nav>\n");

        body.push_str("<section id=\"interpretations\" class=\"ob-interp-section\" aria-labelledby=\"interpretations-heading\">\n<h2 id=\"interpretations-heading\">Interpretations</h2>\n<ol class=\"ob-interp-list\">\n");
        for (index, i) in c.interpretations.iter().enumerate() {
            self.interpretation_item(&mut body, public, index + 1, i);
        }
        body.push_str("</ol>\n</section>\n");

        if !c.relations.is_empty() {
            body.push_str("<section id=\"relations\" class=\"ob-interp-section\" aria-labelledby=\"relations-heading\">\n<h2 id=\"relations-heading\">How they relate</h2>\n<p class=\"ob-meta\">These are the author's descriptions of how the readings relate. None says that one is better than another.</p>\n<ul class=\"ob-interp-relations\">\n");
            for r in &c.relations {
                let name = |id: &str| {
                    c.interpretations
                        .iter()
                        .position(|i| i.id == id)
                        .map(|p| (p + 1, attribution_name(public, &c.interpretations[p])))
                };
                let (Some((from_n, from)), Some((to_n, to))) = (name(&r.from), name(&r.to)) else {
                    continue;
                };
                body.push_str(&format!(
                    "<li><a href=\"#i-{}\">Interpretation {from_n}, <bdi>{}</bdi></a> <strong>{}</strong> <a href=\"#i-{}\">interpretation {to_n}, <bdi>{}</bdi></a>",
                    attr(&r.from),
                    text(&from),
                    relation_label(r.kind),
                    attr(&r.to),
                    text(&to)
                ));
                if let Some(note) = &r.note {
                    body.push_str(&format!(": <span dir=\"auto\">{}</span>", text(note)));
                }
                body.push_str("</li>\n");
            }
            body.push_str("</ul>\n</section>\n");
        }

        if !c.explanations.is_empty() {
            self.explanations_section(&mut body, public, c);
        }
        body.push_str("</div>\n</article>\n</div>");
        let mut meta = self.meta_simple(theme, &c.title, &c.subject, &published.url);
        meta.interpretation_levels = !c.explanations.is_empty();
        self.document(&meta, &body)
    }

    fn interpretation_item(
        &self,
        body: &mut String,
        public: &PublicInterpretations,
        number: usize,
        i: &PublicInterpretation,
    ) {
        let name = attribution_name(public, i);
        body.push_str(&format!(
            "<li id=\"i-{}\" class=\"ob-interp\">\n<h3 class=\"ob-interp-title\"><span class=\"ob-interp-number\">Interpretation {number}.</span> <bdi>{}</bdi></h3>\n",
            attr(&i.id),
            text(&name)
        ));
        let (how, certainty) = match &i.attribution {
            PublicAttribution::Named { certainty, .. } => ("Advanced by", certainty),
            PublicAttribution::Source { certainty, .. } => ("Advanced in", certainty),
            PublicAttribution::Anonymous { certainty, .. } => {
                ("Advanced by an unknown author", certainty)
            }
        };
        let mut who = format!("{how} <bdi>{}</bdi>", text(&name));
        if matches!(i.attribution, PublicAttribution::Anonymous { .. }) {
            who = format!("{how}: <bdi>{}</bdi>", text(&name));
        }
        if let Some(certainty) = certainty {
            who.push_str(&format!(" ({})", certainty_label(certainty.value())));
        }
        body.push_str(&format!("<p class=\"ob-interp-who\">{who}</p>\n"));
        let lang = i
            .language
            .as_deref()
            .map(|l| format!(" lang=\"{}\"", attr(l)))
            .unwrap_or_default();
        body.push_str(&format!(
            "<div class=\"ob-interp-statement\"{lang} dir=\"auto\">\n{}</div>\n",
            paragraphs(&i.statement)
        ));
        if let Some(original) = &i.translation_of {
            body.push_str(&format!(
                "<p class=\"ob-meta\">A translation of <a href=\"#i-{}\">another interpretation on this page</a>.</p>\n",
                attr(original)
            ));
        }
        if let Some(uncertainty) = &i.uncertainty {
            body.push_str(&format!(
                "<p class=\"ob-interp-uncertainty\"><em>What is uncertain:</em> <span dir=\"auto\">{}</span></p>\n",
                text(uncertainty)
            ));
        }
        if let Some(label) = provenance_label(&i.provenance) {
            body.push_str(&format!(
                "<p class=\"ob-interp-provenance\">{}</p>\n",
                text(&label)
            ));
        }
        evidence_list(body, public, &i.evidence, "Evidence cited");
        body.push_str("</li>\n");
    }

    fn explanations_section(
        &self,
        body: &mut String,
        public: &PublicInterpretations,
        c: &crate::scholarly_comparison::PublicComparison,
    ) {
        body.push_str("<section id=\"explanations\" class=\"ob-interp-section\" aria-labelledby=\"explanations-heading\">\n<h2 id=\"explanations-heading\">Explanations by level</h2>\n<p class=\"ob-meta\">The author's own supplements for different readers. They sit beside the interpretations above and do not replace them. Every level is on this page.</p>\n");
        let levels: Vec<Level> = Level::ALL
            .into_iter()
            .filter(|level| c.explanations.iter().any(|x| x.level == *level))
            .collect();
        let base = self.site.config.base_path();
        let scope = if base.is_empty() {
            String::new()
        } else {
            format!(" data-ob-base=\"{}\"", attr(&base))
        };
        body.push_str(&format!("<ob-explanation-levels{scope}>\n"));
        body.push_str("<nav class=\"ob-level-links\" aria-label=\"Explanation levels\">\n<ul>\n");
        for level in &levels {
            body.push_str(&format!(
                "<li><a href=\"#level-{0}\">{1}</a></li>\n",
                level.value(),
                level_label(*level)
            ));
        }
        body.push_str("</ul>\n</nav>\n");
        for level in &levels {
            body.push_str(&format!(
                "<section id=\"level-{0}\" class=\"ob-level\" data-level=\"{0}\" aria-labelledby=\"level-{0}-heading\">\n<h3 id=\"level-{0}-heading\">{1}</h3>\n",
                level.value(),
                level_label(*level)
            ));
            for x in c.explanations.iter().filter(|x| x.level == *level) {
                explanation_item(body, public, c, x);
            }
            body.push_str("</section>\n");
        }
        body.push_str("</ob-explanation-levels>\n</section>\n");
    }
}

fn explanation_item(
    body: &mut String,
    public: &PublicInterpretations,
    c: &crate::scholarly_comparison::PublicComparison,
    x: &PublicExplanation,
) {
    // The modes an author named travel as data; the page shows the explanation
    // in every mode until script narrows it (ADR 0235).
    let modes = if x.modes.is_empty() {
        String::new()
    } else {
        format!(
            " data-modes=\"{}\"",
            x.modes
                .iter()
                .map(|m| m.value())
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    let lang = x
        .language
        .as_deref()
        .map(|l| format!(" lang=\"{}\"", attr(l)))
        .unwrap_or_default();
    body.push_str(&format!(
        "<div id=\"x-{}\" class=\"ob-explanation\"{modes}{lang}>\n",
        attr(&x.id)
    ));
    let about = match &x.about {
        None => "About the whole comparison".to_string(),
        Some(id) => c
            .interpretations
            .iter()
            .position(|i| &i.id == id)
            .map(|p| {
                format!(
                    "About interpretation {}, {}",
                    p + 1,
                    attribution_name(public, &c.interpretations[p])
                )
            })
            .unwrap_or_else(|| "About an interpretation".to_string()),
    };
    match &x.about {
        Some(id) => body.push_str(&format!(
            "<h4 class=\"ob-explanation-about\"><a href=\"#i-{}\"><bdi>{}</bdi></a></h4>\n",
            attr(id),
            text(&about)
        )),
        None => body.push_str(&format!(
            "<h4 class=\"ob-explanation-about\">{}</h4>\n",
            text(&about)
        )),
    }
    if let Some(p) = &x.prerequisite {
        body.push_str(&format!(
            "<p class=\"ob-explanation-prerequisite\">Helpful to know first: {}. You can read the article without it.</p>
",
            text(p)
        ));
    }
    body.push_str(&paragraphs(&x.text));
    if !x.authors.is_empty() {
        body.push_str(&format!(
            "<p class=\"ob-explanation-authors\">Written by {}.</p>
",
            x.authors
                .iter()
                .map(|a| text(a))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(original) = &x.translation_of {
        body.push_str(&format!(
            "<p class=\"ob-meta ob-explanation-translation\">A translation of <a href=\"#x-{}\">another explanation on this page</a>.</p>\n",
            attr(original)
        ));
    }
    if let Some(revision) = x.revision {
        body.push_str(&format!(
            "<p class=\"ob-meta ob-explanation-revision\">Revision {revision}.</p>\n"
        ));
    }
    if let Some(label) = provenance_label(&x.provenance) {
        body.push_str(&format!(
            "<p class=\"ob-interp-provenance\">{}</p>\n",
            text(&label)
        ));
    }
    body.push_str("</div>\n");
}

/// The words that say who wrote the text, shown only when an AI drafted it.
/// An author's own text carries no label.
pub(crate) fn provenance_label(provenance: &PublicProvenance) -> Option<String> {
    match provenance {
        PublicProvenance::Author => None,
        PublicProvenance::AiDraft { tool } => Some(format!(
            "Drafted with AI ({tool}); the exact text was approved by the author."
        )),
    }
}

/// Who advances the reading, in words: a name, a described unknown author, or
/// the formatted reference of a public source.
pub(crate) fn attribution_name(public: &PublicInterpretations, i: &PublicInterpretation) -> String {
    match &i.attribution {
        PublicAttribution::Named { name, .. } => name.clone(),
        PublicAttribution::Anonymous { description, .. } => description.clone(),
        // The projection withholds an interpretation attributed to a source
        // that is not public, so the reference is found; the id is never shown.
        PublicAttribution::Source { source, .. } => public
            .sources
            .get(source)
            .cloned()
            .unwrap_or_else(|| "a published source".to_string()),
    }
}

pub(crate) fn locator_text(link: &PublicLink) -> String {
    link.locators
        .iter()
        .map(|l| match &l.to {
            Some(to) => format!("{} {}-{}", l.kind, l.value, to),
            None => format!("{} {}", l.kind, l.value),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn evidence_list(
    body: &mut String,
    public: &PublicInterpretations,
    evidence: &[PublicEvidence],
    label: &str,
) {
    let mut items = String::new();
    for e in evidence {
        match e {
            PublicEvidence::Link { link } => {
                let Some(found) = public.links.get(link) else {
                    continue;
                };
                let source = public
                    .sources
                    .get(&found.source)
                    .cloned()
                    .unwrap_or_default();
                let place = locator_text(found);
                items.push_str(&format!(
                    "<li><span class=\"ob-meta\">The author's evidence {} the claim</span> <q dir=\"auto\">{}</q>: <span dir=\"auto\">{}</span>{}</li>\n",
                    text(found.relation),
                    text(&found.claim),
                    text(&source),
                    if place.is_empty() {
                        String::new()
                    } else {
                        format!(", {}", text(&place))
                    }
                ));
            }
            PublicEvidence::Source { source, locator } => {
                let Some(reference) = public.sources.get(source) else {
                    continue;
                };
                items.push_str(&format!(
                    "<li><span dir=\"auto\">{}</span>{}</li>\n",
                    text(reference),
                    locator
                        .as_deref()
                        .map(|l| format!(", {}", text(l)))
                        .unwrap_or_default()
                ));
            }
        }
    }
    if items.is_empty() {
        return;
    }
    body.push_str(&format!(
        "<p class=\"ob-interp-evidence-label\"><strong>{}</strong></p>\n<ul class=\"ob-interp-evidence\">\n{items}</ul>\n",
        text(label)
    ));
}
