//! Portable copies of a published interpretation comparison (ADR 0236, #220).
//!
//! A feed reader, a cross-post or a printout cannot run the level selector, so
//! each copy is static: every approved explanation level is a labelled
//! supplemental section after the interpretations, with its authors,
//! prerequisite, language, revision, AI provenance and the author's approval
//! statement, and a link back to the canonical page. The copies are built from
//! the one public value ([`PublishedComparison`]) and nothing else, so a draft,
//! an unapproved or withdrawn explanation, an approver's login or a ranking has
//! no path in.
//!
//! [`portable_comparison`] returns the HTML fragment, the Markdown and the plain
//! text together with portability diagnostics. The diagnostics combine what the
//! build already guarantees (#91: every approved level present, AI provenance
//! kept, nothing scripted or private) by checking the finished copies against
//! the public value, so a regression is an error here and not a surprise in a
//! reader.

use crate::capability::PortabilityLevel;
use crate::escape::{attr, text};
use crate::interpretation_publication::{PublicInterpretations, PublishedComparison};
use crate::portability::{DiagnosticContext, DiagnosticSeverity, PortabilityDiagnostic};
use crate::render::interpretations::{
    attribution_name, certainty_label, level_label, locator_text, provenance_label, relation_label,
};
use crate::scholarly_comparison::{
    Level, PublicAttribution, PublicEvidence, PublicExplanation, PublicInterpretation,
};

/// What every copy says about the explanations.
const EXPLANATIONS_NOTE: &str = "The author's own supplements for different readers. They sit beside the interpretations above and do not replace them. Every approved level is included here.";

/// The three portable representations of one comparison, and what is lost or
/// wrong in them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortableComparison {
    /// A semantic HTML fragment: no script, no custom element, no inline style.
    pub html: String,
    pub markdown: String,
    pub text: String,
    pub diagnostics: Vec<PortabilityDiagnostic>,
}

impl PortableComparison {
    /// True when no diagnostic is an error.
    pub fn is_sound(&self) -> bool {
        self.diagnostics
            .iter()
            .all(|d| d.severity != DiagnosticSeverity::Error)
    }
}

/// Build the portable copies of `published`. `canonical_base` is the site's
/// absolute URL (`SiteConfig::url`); the copies link to the comparison page
/// and to each level on it.
pub fn portable_comparison(
    public: &PublicInterpretations,
    published: &PublishedComparison,
    canonical_base: &str,
) -> PortableComparison {
    let canonical = format!("{}{}", canonical_base.trim_end_matches('/'), published.url);
    let model = Model::new(public, published, canonical);
    let mut out = PortableComparison {
        html: model.html(),
        markdown: model.markdown(),
        text: model.text(),
        diagnostics: Vec::new(),
    };
    out.diagnostics = diagnose(&model, &out);
    out
}

/// Check any copy (for example one an exporter changed) against the public
/// value it must carry. [`portable_comparison`] already does this to its own
/// output; the diagnostics are the same.
pub fn check_portable(
    public: &PublicInterpretations,
    published: &PublishedComparison,
    canonical_base: &str,
    copy: &PortableComparison,
) -> Vec<PortabilityDiagnostic> {
    let canonical = format!("{}{}", canonical_base.trim_end_matches('/'), published.url);
    diagnose(&Model::new(public, published, canonical), copy)
}

/// Remove the controls that reorder surrounding text (embeddings, overrides
/// and isolates). A copy has no `<bdi>` to contain them, so an unbalanced one
/// in an author's name could reorder a line it is not part of.
fn clean(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(*c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\r'))
        .collect()
}

struct Model<'a> {
    public: &'a PublicInterpretations,
    published: &'a PublishedComparison,
    canonical: String,
    /// Levels with at least one explanation, in order.
    levels: Vec<Level>,
}

impl<'a> Model<'a> {
    fn new(
        public: &'a PublicInterpretations,
        published: &'a PublishedComparison,
        canonical: String,
    ) -> Self {
        let c = &published.comparison;
        let levels = Level::ALL
            .into_iter()
            .filter(|l| c.explanations.iter().any(|x| x.level == *l))
            .collect();
        Self {
            public,
            published,
            canonical,
            levels,
        }
    }

    fn name(&self, i: &PublicInterpretation) -> String {
        clean(&attribution_name(self.public, i))
    }

    fn about(&self, x: &PublicExplanation) -> String {
        let c = &self.published.comparison;
        match &x.about {
            None => "About the whole comparison".to_string(),
            Some(id) => c
                .interpretations
                .iter()
                .position(|i| &i.id == id)
                .map(|p| {
                    format!(
                        "About interpretation {}, {}",
                        p + 1,
                        self.name(&c.interpretations[p])
                    )
                })
                .unwrap_or_else(|| "About an interpretation".to_string()),
        }
    }

    fn who(&self, i: &PublicInterpretation) -> String {
        let name = self.name(i);
        let (how, certainty) = match &i.attribution {
            PublicAttribution::Named { certainty, .. } => {
                (format!("Advanced by {name}"), certainty)
            }
            PublicAttribution::Source { certainty, .. } => {
                (format!("Advanced in {name}"), certainty)
            }
            PublicAttribution::Anonymous { certainty, .. } => {
                (format!("Advanced by an unknown author: {name}"), certainty)
            }
        };
        match certainty {
            Some(c) => format!("{how} ({})", certainty_label(c.value())),
            None => how,
        }
    }

    /// Plain-text evidence lines for a list of public evidence.
    fn evidence(&self, evidence: &[PublicEvidence]) -> Vec<String> {
        let mut out = Vec::new();
        for e in evidence {
            match e {
                PublicEvidence::Link { link } => {
                    let Some(found) = self.public.links.get(link) else {
                        continue;
                    };
                    let source = self
                        .public
                        .sources
                        .get(&found.source)
                        .cloned()
                        .unwrap_or_default();
                    let place = locator_text(found);
                    let mut line = format!(
                        "The author's evidence {} the claim \"{}\": {}",
                        found.relation, found.claim, source
                    );
                    if !place.is_empty() {
                        line.push_str(&format!(", {place}"));
                    }
                    out.push(clean(&line));
                }
                PublicEvidence::Source { source, locator } => {
                    let Some(reference) = self.public.sources.get(source) else {
                        continue;
                    };
                    let mut line = reference.clone();
                    if let Some(l) = locator {
                        line.push_str(&format!(", {l}"));
                    }
                    out.push(clean(&line));
                }
            }
        }
        out
    }

    fn explanation_facts(&self, x: &PublicExplanation) -> Vec<String> {
        let mut facts = Vec::new();
        if let Some(p) = &x.prerequisite {
            facts.push(format!(
                "Helpful to know first: {}. You can read the article without it.",
                clean(p)
            ));
        }
        if !x.authors.is_empty() {
            facts.push(format!(
                "Written by {}.",
                x.authors
                    .iter()
                    .map(|a| clean(a))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if let Some(l) = &x.language {
            facts.push(format!("Language: {}.", clean(l)));
        }
        if let Some(original) = &x.translation_of {
            let n = self
                .published
                .comparison
                .explanations
                .iter()
                .position(|o| &o.id == original);
            facts.push(match n {
                Some(_) => "A translation of another explanation in this comparison.".to_string(),
                None => "A translation of an explanation on the canonical page.".to_string(),
            });
        }
        if let Some(r) = x.revision {
            facts.push(format!("Revision {r}."));
        }
        if let Some(label) = provenance_label(&x.provenance) {
            facts.push(label);
        }
        facts
    }

    fn relation_lines(&self) -> Vec<String> {
        let c = &self.published.comparison;
        let find = |id: &str| {
            c.interpretations
                .iter()
                .position(|i| i.id == id)
                .map(|p| (p + 1, self.name(&c.interpretations[p])))
        };
        c.relations
            .iter()
            .filter_map(|r| {
                let (a, an) = find(&r.from)?;
                let (b, bn) = find(&r.to)?;
                let mut line = format!(
                    "Interpretation {a}, {an} {} interpretation {b}, {bn}",
                    relation_label(r.kind)
                );
                if let Some(note) = &r.note {
                    line.push_str(&format!(": {}", clean(note)));
                }
                Some(line)
            })
            .collect()
    }

    fn paragraphs(value: &str) -> Vec<String> {
        clean(value)
            .split("\n\n")
            .map(|p| p.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|p| !p.is_empty())
            .collect()
    }

    // ---- HTML -------------------------------------------------------------

    fn html(&self) -> String {
        let c = &self.published.comparison;
        let mut h = String::new();
        h.push_str("<article class=\"ob-portable-comparison\">\n");
        h.push_str(&format!(
            "<h1 dir=\"auto\">{}</h1>\n",
            text(&clean(&c.title))
        ));
        h.push_str(&format!(
            "<p dir=\"auto\">{}</p>\n",
            text(&clean(&c.subject))
        ));
        h.push_str(&format!(
            "<p>Canonical page: <a href=\"{0}\">{1}</a></p>\n",
            attr(&self.canonical),
            text(&self.canonical)
        ));
        h.push_str("<nav aria-label=\"On this page\">\n<ul>\n<li><a href=\"#interpretations\">Interpretations</a></li>\n");
        if !c.relations.is_empty() {
            h.push_str("<li><a href=\"#relations\">How they relate</a></li>\n");
        }
        for level in &self.levels {
            h.push_str(&format!(
                "<li><a href=\"#level-{}\">Explanation: {}</a></li>\n",
                level.value(),
                level_label(*level)
            ));
        }
        h.push_str("</ul>\n</nav>\n");

        h.push_str("<section id=\"interpretations\" aria-labelledby=\"interpretations-heading\">\n<h2 id=\"interpretations-heading\">Interpretations</h2>\n<ol>\n");
        for (n, i) in c.interpretations.iter().enumerate() {
            h.push_str(&format!(
                "<li id=\"i-{}\">\n<h3 dir=\"auto\">Interpretation {}. {}</h3>\n<p dir=\"auto\">{}</p>\n",
                attr(&i.id),
                n + 1,
                text(&self.name(i)),
                text(&self.who(i))
            ));
            let lang = i
                .language
                .as_deref()
                .map(|l| format!(" lang=\"{}\"", attr(&clean(l))))
                .unwrap_or_default();
            h.push_str(&format!("<div{lang} dir=\"auto\">\n"));
            for p in Self::paragraphs(&i.statement) {
                h.push_str(&format!("<p>{}</p>\n", text(&p)));
            }
            h.push_str("</div>\n");
            if let Some(u) = &i.uncertainty {
                h.push_str(&format!(
                    "<p dir=\"auto\"><em>What is uncertain:</em> {}</p>\n",
                    text(&clean(u))
                ));
            }
            if let Some(label) = provenance_label(&i.provenance) {
                h.push_str(&format!("<p>{}</p>\n", text(&label)));
            }
            let evidence = self.evidence(&i.evidence);
            if !evidence.is_empty() {
                h.push_str("<p><strong>Evidence cited</strong></p>\n<ul>\n");
                for e in evidence {
                    h.push_str(&format!("<li dir=\"auto\">{}</li>\n", text(&e)));
                }
                h.push_str("</ul>\n");
            }
            h.push_str("</li>\n");
        }
        h.push_str("</ol>\n</section>\n");

        let relations = self.relation_lines();
        if !relations.is_empty() {
            h.push_str("<section id=\"relations\" aria-labelledby=\"relations-heading\">\n<h2 id=\"relations-heading\">How they relate</h2>\n<p>These are the author's descriptions of how the readings relate. None says that one is better than another.</p>\n<ul>\n");
            for r in relations {
                h.push_str(&format!("<li dir=\"auto\">{}</li>\n", text(&r)));
            }
            h.push_str("</ul>\n</section>\n");
        }

        if !self.levels.is_empty() {
            h.push_str(&format!(
                "<section id=\"explanations\" aria-labelledby=\"explanations-heading\">\n<h2 id=\"explanations-heading\">Explanations by level</h2>\n<p>{}</p>\n",
                text(EXPLANATIONS_NOTE)
            ));
            for level in &self.levels {
                h.push_str(&format!(
                    "<section id=\"level-{0}\" aria-labelledby=\"level-{0}-heading\">\n<h3 id=\"level-{0}-heading\">{1}</h3>\n<p><a href=\"{2}#level-{0}\">This level on the canonical page</a></p>\n",
                    level.value(),
                    level_label(*level),
                    attr(&self.canonical)
                ));
                for x in c.explanations.iter().filter(|x| x.level == *level) {
                    let lang = x
                        .language
                        .as_deref()
                        .map(|l| format!(" lang=\"{}\"", attr(&clean(l))))
                        .unwrap_or_default();
                    h.push_str(&format!(
                        "<div id=\"x-{}\"{lang} dir=\"auto\">\n<h4>{}</h4>\n",
                        attr(&x.id),
                        text(&self.about(x))
                    ));
                    for p in Self::paragraphs(&x.text) {
                        h.push_str(&format!("<p>{}</p>\n", text(&p)));
                    }
                    for fact in self.explanation_facts(x) {
                        h.push_str(&format!("<p>{}</p>\n", text(&fact)));
                    }
                    h.push_str("</div>\n");
                }
                h.push_str("</section>\n");
            }
            h.push_str("</section>\n");
        }
        h.push_str("</article>\n");
        h
    }

    // ---- Markdown ---------------------------------------------------------

    fn markdown(&self) -> String {
        let c = &self.published.comparison;
        let mut m = String::new();
        m.push_str(&format!(
            "# {}\n\n{}\n\n",
            md_line(&c.title),
            md_line(&c.subject)
        ));
        m.push_str(&format!(
            "Canonical page: <{}>\n\n",
            self.canonical.replace('>', "%3E").replace(' ', "%20")
        ));
        m.push_str("## Interpretations\n\n");
        for (n, i) in c.interpretations.iter().enumerate() {
            m.push_str(&format!(
                "### Interpretation {}. {}\n\n{}\n\n",
                n + 1,
                md_line(&self.name(i)),
                md_line(&self.who(i))
            ));
            if let Some(l) = &i.language {
                m.push_str(&format!("Language: {}.\n\n", md_line(l)));
            }
            for p in Self::paragraphs(&i.statement) {
                m.push_str(&format!("{}\n\n", md_line(&p)));
            }
            if let Some(u) = &i.uncertainty {
                m.push_str(&format!("*What is uncertain:* {}\n\n", md_line(u)));
            }
            if let Some(label) = provenance_label(&i.provenance) {
                m.push_str(&format!("{}\n\n", md_line(&label)));
            }
            let evidence = self.evidence(&i.evidence);
            if !evidence.is_empty() {
                m.push_str("**Evidence cited**\n\n");
                for e in evidence {
                    m.push_str(&format!("- {}\n", md_line(&e)));
                }
                m.push('\n');
            }
        }
        let relations = self.relation_lines();
        if !relations.is_empty() {
            m.push_str("## How they relate\n\nThese are the author's descriptions of how the readings relate. None says that one is better than another.\n\n");
            for r in relations {
                m.push_str(&format!("- {}\n", md_line(&r)));
            }
            m.push('\n');
        }
        if !self.levels.is_empty() {
            m.push_str(&format!(
                "## Explanations by level\n\n{EXPLANATIONS_NOTE}\n\n"
            ));
            for level in &self.levels {
                m.push_str(&format!(
                    "### {}\n\n[This level on the canonical page](<{}#level-{}>)\n\n",
                    level_label(*level),
                    self.canonical.replace('>', "%3E").replace(' ', "%20"),
                    level.value()
                ));
                for x in c.explanations.iter().filter(|x| x.level == *level) {
                    m.push_str(&format!("#### {}\n\n", md_line(&self.about(x))));
                    for p in Self::paragraphs(&x.text) {
                        m.push_str(&format!("{}\n\n", md_line(&p)));
                    }
                    for fact in self.explanation_facts(x) {
                        m.push_str(&format!("{}\n\n", md_line(&fact)));
                    }
                }
            }
        }
        m
    }

    // ---- Plain text -------------------------------------------------------

    fn text(&self) -> String {
        let c = &self.published.comparison;
        let mut t = String::new();
        t.push_str(&format!("{}\n\n{}\n\n", clean(&c.title), clean(&c.subject)));
        t.push_str(&format!("Canonical page: {}\n\n", self.canonical));
        t.push_str("INTERPRETATIONS\n\n");
        for (n, i) in c.interpretations.iter().enumerate() {
            t.push_str(&format!(
                "Interpretation {}. {}\n{}\n\n",
                n + 1,
                self.name(i),
                self.who(i)
            ));
            if let Some(l) = &i.language {
                t.push_str(&format!("Language: {}.\n\n", clean(l)));
            }
            for p in Self::paragraphs(&i.statement) {
                t.push_str(&format!("{p}\n\n"));
            }
            if let Some(u) = &i.uncertainty {
                t.push_str(&format!("What is uncertain: {}\n\n", clean(u)));
            }
            if let Some(label) = provenance_label(&i.provenance) {
                t.push_str(&format!("{label}\n\n"));
            }
            let evidence = self.evidence(&i.evidence);
            if !evidence.is_empty() {
                t.push_str("Evidence cited:\n");
                for e in evidence {
                    t.push_str(&format!("- {e}\n"));
                }
                t.push('\n');
            }
        }
        let relations = self.relation_lines();
        if !relations.is_empty() {
            t.push_str("HOW THEY RELATE\n\nThese are the author's descriptions of how the readings relate. None says that one is better than another.\n\n");
            for r in relations {
                t.push_str(&format!("- {r}\n"));
            }
            t.push('\n');
        }
        if !self.levels.is_empty() {
            t.push_str(&format!("EXPLANATIONS BY LEVEL\n\n{EXPLANATIONS_NOTE}\n\n"));
            for level in &self.levels {
                t.push_str(&format!(
                    "{}\nThis level on the canonical page: {}#level-{}\n\n",
                    level_label(*level).to_uppercase(),
                    self.canonical,
                    level.value()
                ));
                for x in c.explanations.iter().filter(|x| x.level == *level) {
                    t.push_str(&format!("{}\n\n", self.about(x)));
                    for p in Self::paragraphs(&x.text) {
                        t.push_str(&format!("{p}\n\n"));
                    }
                    for fact in self.explanation_facts(x) {
                        t.push_str(&format!("{fact}\n\n"));
                    }
                }
            }
        }
        t
    }
}

/// One line of author text as Markdown that cannot become markup: HTML, links,
/// emphasis, code and block syntax are all neutralised.
fn md_line(value: &str) -> String {
    let cleaned: String = clean(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = String::with_capacity(cleaned.len());
    for (index, ch) in cleaned.chars().enumerate() {
        match ch {
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '&' | '|' | '~' | '!' => {
                out.push('\\');
                out.push(ch);
            }
            '#' | '-' | '+' | '=' if index == 0 => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    // A leading "1." or "1)" would start a list.
    let digits = out.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && matches!(out.chars().nth(digits), Some('.' | ')')) {
        out.insert(digits, '\\');
    }
    out
}

fn diagnostic(
    code: &str,
    severity: DiagnosticSeverity,
    slug: &str,
    representation: &str,
    message: String,
    action: &str,
    level: Option<PortabilityLevel>,
) -> PortabilityDiagnostic {
    PortabilityDiagnostic {
        code: code.into(),
        severity,
        source_path: format!("comparisons/{slug}.json"),
        capability_id: Some("explanation-levels".into()),
        message,
        recommended_action: action.into(),
        context: DiagnosticContext {
            representation: Some(representation.into()),
            destination: None,
            portability_level: level,
            affected_semantics: Some("audience-explanations".into()),
            source_range: None,
        },
    }
}

/// Check the finished copies against the public value. Messages name ids and
/// counts, never authored text.
fn diagnose(model: &Model<'_>, out: &PortableComparison) -> Vec<PortabilityDiagnostic> {
    use DiagnosticSeverity::{Error, Info};
    let c = &model.published.comparison;
    let slug = c.slug.as_str();
    let mut found = Vec::new();

    if !c.explanations.is_empty() {
        found.push(diagnostic(
            "explanation-levels-static",
            Info,
            slug,
            "html",
            format!(
                "The level selector became {} labelled sections; modes and the stored choice do not travel, so every approved explanation is shown.",
                model.levels.len()
            ),
            "Read the canonical page to filter explanations by reading mode.",
            Some(PortabilityLevel::GracefullyTransformed),
        ));
    }

    for (representation, body) in [
        ("html", &out.html),
        ("markdown", &out.markdown),
        ("text", &out.text),
    ] {
        for x in &c.explanations {
            // The body is compared as the copy writes it: whitespace
            // collapsed and the representation's own escaping removed.
            let wanted = Model::paragraphs(&x.text);
            let flat = flatten(representation, body);
            if wanted
                .iter()
                .any(|p| !flat.contains(&flatten(representation, &escape_for(representation, p))))
            {
                found.push(diagnostic(
                    "explanation-missing",
                    Error,
                    slug,
                    representation,
                    format!(
                        "Approved explanation `{}` is missing from the {representation} copy.",
                        x.id
                    ),
                    "Do not publish this copy; report the build as faulty.",
                    None,
                ));
            }
            if let Some(label) = provenance_label(&x.provenance) {
                let wanted = escape_for(representation, &label);
                if !flatten(representation, body).contains(&flatten(representation, &wanted)) {
                    found.push(diagnostic(
                        "explanation-provenance-lost",
                        Error,
                        slug,
                        representation,
                        format!("Explanation `{}` was drafted with AI but the {representation} copy does not say so.", x.id),
                        "Do not publish this copy; AI provenance and the author's approval must travel with the text.",
                        None,
                    ));
                }
            }
        }
        if !body.contains(&model.canonical)
            && !body.contains(&model.canonical.replace('&', "&amp;"))
        {
            found.push(diagnostic(
                "canonical-link-missing",
                Error,
                slug,
                representation,
                format!("The {representation} copy does not link to the canonical page."),
                "Do not publish this copy.",
                None,
            ));
        }
    }

    let lower = out.html.to_lowercase();
    if lower.contains("<script")
        || lower.contains("<ob-")
        || lower.contains(" style=")
        || lower.contains("<style")
        || lower.contains("<iframe")
    {
        found.push(diagnostic(
            "scripted-markup",
            Error,
            slug,
            "html",
            "The HTML copy contains script, a custom element, inline style or a frame.".into(),
            "Do not publish this copy; a portable copy is static content.",
            None,
        ));
    }
    found
}

fn escape_for(representation: &str, value: &str) -> String {
    let value = &clean(value);
    match representation {
        "html" => text(value),
        "markdown" => md_line(value),
        _ => value.to_string(),
    }
}

fn flatten(_representation: &str, value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
