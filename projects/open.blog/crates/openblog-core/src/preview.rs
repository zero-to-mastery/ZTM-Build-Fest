//! The approval-aware combined review preview of a shared publication.
//!
//! One side-effect-free function assembles what a signed-in author may review: every author's
//! section in participant order at its exact current revision, each author's approval state, and
//! a self-contained HTML document that cannot be mistaken for published output. It reads drafts
//! and approvals and writes nothing, so a failure leaves canonical content untouched.
//!
//! A section is rendered only when the requester is entitled to the author's *latest* revision,
//! decided by [`DraftSet::view`] alone: their own, or one revealed to them. An older revealed
//! revision is not shown, so the preview never presents a piece that differs from what an approval
//! would cover. Everything else is one uniform placeholder: an unshared draft, an unrevealed
//! newer revision, a withdrawn draft and an author who has written nothing look the same, and
//! nothing about their prose, revision numbers or digests is returned.
//!
//! The document is built to run without JavaScript: its policy forbids scripts, frames, forms,
//! images and every network fetch, and the caller shows it in a sandboxed frame. Prose goes
//! through the production Markdown renderer with the site's own options, so the preview matches
//! what posts publish; the policy, not the options, stops images, embeds and runners from loading.

use serde::Serialize;

use crate::approval::{
    describe_policy, ApprovalPolicy, ApprovalRequirement, ApprovalSet, ApprovalState, Readiness,
    Section,
};
use crate::assembly::display_names;
use crate::collaboration::AuthorizationRole;
use crate::collaboration::SharedPublication;
use crate::draft::DraftSet;
use crate::escape;
use crate::markdown::{self, RenderOptions};
use crate::media_moment::{Moment, MomentSet, Quotation, RIGHTS_STATEMENT};
use crate::published_moment::{moment_markdown, PublicMoment};
use crate::reflection::{compose, strip_part_markers, ComposedTurn, ReflectionStructure};
use crate::shared_source::SharedAttribution;
use crate::synthesis::{SynthesisKind, SynthesisSet};

/// The policy the preview document carries. Nothing loads, nothing runs.
pub const PREVIEW_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; \
form-action 'none'; frame-ancestors 'self'";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewError {
    /// The requester is not a current author of this publication.
    Denied,
}

impl std::fmt::Display for PreviewError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("preview access denied")
    }
}

impl std::error::Error for PreviewError {}

/// One author's place in the combined piece.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSection {
    pub participant_id: String,
    pub display_name: String,
    /// Whether this author's section is rendered in the document for the requester.
    pub shown: bool,
    /// The exact revision rendered; absent whenever the section is not shown.
    pub revision: Option<u64>,
    pub approval: ApprovalState,
    /// Whether the approval policy needs this author's approval.
    pub required: bool,
    /// Content problems the renderer found in a shown section.
    pub errors: Vec<String>,
}

/// One synthesis item's approval standing, for an author of the piece.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub id: String,
    pub kind: SynthesisKind,
    pub revision: u64,
    /// Display names of the authors the item speaks for, in attribution order.
    pub authors: Vec<String>,
    pub approved: Vec<String>,
    pub awaiting: Vec<String>,
    /// Whether the requester is named on the item.
    pub mine: bool,
}

fn preview_items(
    record: &SharedPublication,
    synthesis: &SynthesisSet,
    requester: &str,
) -> Vec<PreviewItem> {
    let names = |ids: Vec<&str>| display_names(record, ids);
    synthesis
        .items()
        .iter()
        .map(|item| PreviewItem {
            id: item.id().to_string(),
            kind: item.kind(),
            revision: item.revision(),
            authors: names(item.contributors().iter().map(String::as_str).collect()),
            approved: names(item.approved_by()),
            awaiting: names(item.awaiting()),
            mine: item.contributors().iter().any(|c| c == requester),
        })
        .collect()
}

/// The approval rule the piece is reviewed under. It is part of what every approval binds to, so
/// it is shown with the piece like everything else that binds (ADR 0052).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRule {
    pub policy: ApprovalPolicy,
    /// Advances with every real policy change; approvals given before it no longer count.
    pub revision: u64,
    /// The rule as a plain sentence.
    pub summary: String,
    /// Display names of participants the rule needs who are no longer authors.
    pub unmet_named: Vec<String>,
    /// Roles the rule lists that no current author holds.
    pub unmet_roles: Vec<AuthorizationRole>,
}

/// The rule in words, for the preview and for the people who choose it.
pub fn rule_for(
    record: &SharedPublication,
    approvals: &ApprovalSet,
    subject: &crate::approval::ApprovalSubject<'_>,
) -> PreviewRule {
    let policy = approvals.policy().clone();
    let named = match &policy.requirement {
        ApprovalRequirement::NamedAuthors(named) => {
            display_names(record, named.iter().map(String::as_str))
        }
        _ => Vec::new(),
    };
    let gaps = approvals.gaps(subject);
    PreviewRule {
        summary: describe_policy(&policy, &named),
        revision: approvals.policy_revision(),
        unmet_named: display_names(record, gaps.named.iter().map(String::as_str)),
        unmet_roles: gaps.roles,
        policy,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombinedPreview {
    pub sections: Vec<PreviewSection>,
    /// The approval rule, shown because it is part of what every approval binds to.
    pub rule: PreviewRule,
    /// Every section that exists is shown to the requester. An author who wrote nothing has no
    /// section and does not block it.
    pub complete: bool,
    /// Complete, and the approval gate would pass for the piece as it is now.
    pub ready: bool,
    /// The token the requester's own approval would bind to; only issued for a complete piece.
    pub seen: Option<String>,
    /// The shared synthesis items with who has approved each. Prose is in `document` only.
    pub items: Vec<PreviewItem>,
    /// A self-contained, script-free HTML document marked as a preview.
    pub document: String,
}

/// Render one section's prose with the site's production Markdown options (see
/// [`crate::config::SiteConfig::render_options`]), the same ones `Site::load` uses for posts.
pub fn render_section(markdown_source: &str, options: RenderOptions<'_>) -> markdown::Rendered {
    markdown::render(markdown_source, options)
}

fn approval_label(state: ApprovalState) -> &'static str {
    match state {
        ApprovalState::Approved => "Approved",
        ApprovalState::Stale => "Approval out of date: the piece changed after it was given",
        ApprovalState::Awaiting => "Awaiting approval",
    }
}

/// Build the preview `requester` may see, from the active authors in participant order.
///
/// `active` are the participants who currently hold the draft grant; the requester must be one.
/// With a `structure` the piece is arranged in its reading order and layout, as the published Post
/// is (ADR 0030, 0031); without one the sections follow participant order.
/// `moments` are the publication's media moments: those proposed for the piece join the approval
/// binding and make their owners required approvers, exactly as at the publish gate (ADR 0063).
/// `show_synthesis` is true only when the requester holds `EditSynthesis`; otherwise the items and
/// the conversation section are left out (readiness still counts them).
/// `options` are the site's production Markdown options. Pure: it never writes drafts or
/// approvals.
#[allow(clippy::too_many_arguments)]
pub fn build(
    record: &SharedPublication,
    structure: Option<&ReflectionStructure>,
    drafts: &DraftSet,
    synthesis: &SynthesisSet,
    moments: &MomentSet,
    approvals: &ApprovalSet,
    requester: &str,
    active: &[&str],
    show_synthesis: bool,
    options: RenderOptions<'_>,
) -> Result<CombinedPreview, PreviewError> {
    if !active.contains(&requester) {
        return Err(PreviewError::Denied);
    }
    let authors: Vec<&crate::collaboration::Participant> = record
        .collaboration
        .participants
        .iter()
        .filter(|participant| active.contains(&participant.id.as_str()))
        .collect();

    // The piece as publication would assemble it now: each active author's latest revision.
    let stamps: Vec<_> = authors
        .iter()
        .map(|author| drafts.current_stamp(&author.id))
        .collect();
    let subject_sections: Vec<Section<'_>> = authors
        .iter()
        .zip(&stamps)
        .filter_map(|(author, stamp)| {
            let stamp = stamp.as_ref()?;
            Some(Section {
                contribution_id: &stamp.contribution_id,
                owner: &author.id,
                revision: stamp.number,
                digest: &stamp.digest,
            })
        })
        .collect();
    crate::assembly::with_subject(
        record,
        structure,
        drafts,
        synthesis,
        moments,
        active,
        |subject| {
            let mut sections = Vec::new();
            let mut rendered = Vec::new();
            // Moments proposed for the piece are part of their owner's contribution (ADR 0063,
            // 0064): another author sees them only sealed to the owner's latest revision that
            // author may read. Until then the owner's whole part is withheld, so nobody can be
            // handed an approval token for moments they have not seen.
            let mut withheld = false;
            let mut shown_moments: Vec<&Moment> = Vec::new();
            for (author, stamp) in authors.iter().zip(&stamps) {
                let entitled = stamp.as_ref().and_then(|stamp| {
                    let view = drafts.view(requester, &author.id, active).ok()?;
                    (view.stamp.number == stamp.number && view.stamp.digest == stamp.digest)
                        .then_some(view)
                });
                let readable = entitled.as_ref().map(|view| view.stamp.number);
                let proposed = moments
                    .publication_moments()
                    .iter()
                    .any(|moment| moment.participant() == author.id);
                let moments_shown = !proposed
                    || author.id == requester
                    || readable.is_some_and(|revision| moments.is_sealed(&author.id, revision));
                if !moments_shown {
                    withheld = true;
                } else if proposed {
                    let visible = moments
                        .revealed(requester, active, &author.id, readable)
                        .unwrap_or_default();
                    shown_moments.extend(visible);
                }
                let entitled = entitled.filter(|_| moments_shown);
                let prose = entitled
                    .as_ref()
                    .map(|view| render_section(&strip_part_markers(&view.markdown), options));
                sections.push(PreviewSection {
                    participant_id: author.id.clone(),
                    display_name: author.display_name.clone(),
                    shown: prose.is_some(),
                    revision: entitled.as_ref().map(|view| view.stamp.number),
                    approval: approvals.state(subject, &author.id),
                    required: approvals.is_required(subject, &author.id),
                    errors: prose.as_ref().map(|r| r.errors.clone()).unwrap_or_default(),
                });
                rendered.push(prose.map(|r| r.html));
            }

            // Complete means every section that exists is shown. An author who owns no section adds no
            // content to be missed, so they can still approve the whole piece (ADR 0020).
            let by_author: Vec<(&PreviewSection, bool)> = sections
                .iter()
                .zip(&stamps)
                .map(|(section, stamp)| (section, stamp.is_some()))
                .collect();
            let arranged = structure.map(|structure| {
                arrange(
                    record, structure, drafts, requester, active, &by_author, options,
                )
            });
            let complete = !subject_sections.is_empty()
                && !withheld
                && arranged.as_ref().is_none_or(|arranged| arranged.is_ok())
                && sections
                    .iter()
                    .zip(&stamps)
                    .all(|(section, stamp)| stamp.is_none() || section.shown);
            let items = preview_items(record, synthesis, requester);
            let ready = complete
                && approvals.evaluate(subject) == Ok(Readiness::Ready)
                && items.iter().all(|item| item.awaiting.is_empty());
            // Synthesis is for its authors only (EditSynthesis). Readiness above still counts every
            // item, but anyone who may not edit the synthesis sees neither its prose nor its names.
            let items = if show_synthesis { items } else { Vec::new() };
            let seen = if complete {
                approvals.binding_for(subject, requester).ok()
            } else {
                None
            };
            let rule = rule_for(record, approvals, subject);
            let document = document(
                record,
                &rule,
                &sections,
                &rendered,
                arranged.as_ref(),
                &moments_html(record, moments, &shown_moments, options),
                &conversation_html(record, &items, synthesis, options),
                complete,
                ready,
            );
            Ok(CombinedPreview {
                sections,
                rule,
                complete,
                ready,
                seen,
                items,
                document,
            })
        },
    )
}

/// The moments proposed for the piece that the requester may read, in the order the piece
/// publishes them. Each is rendered from its public projection by the one frame the published Post
/// carries ([`moment_markdown`]) through the production renderer, so the preview shows exactly the
/// markup readers get (ADR 0067). Under each quotation follow, for review only, its owner's rights
/// statement, guidance, rights note, provenance and warnings, which are never part of the published
/// piece (ADR 0065). Empty when there are none, so a piece without moments previews as before.
fn moments_html(
    record: &SharedPublication,
    moments: &MomentSet,
    shown: &[&Moment],
    options: RenderOptions<'_>,
) -> String {
    let ordered: Vec<&Moment> = moments
        .publication_moments()
        .into_iter()
        .filter(|moment| shown.iter().any(|seen| seen.id() == moment.id()))
        .collect();
    if ordered.is_empty() {
        return String::new();
    }
    let mut html = String::from(
        "<section class=\"ob-preview-section\" aria-labelledby=\"ob-preview-moments\">\n<h2 id=\"ob-preview-moments\">Moments in the sources</h2>\n<p class=\"ob-preview-status\">Proposed for the piece and published exactly as shown, after the rest of the piece. Every approval covers them as they are here. The rights details under a quotation are for the authors' review only and are never published.</p>\n",
    );
    for (index, moment) in ordered.iter().enumerate() {
        html.push_str("<div class=\"ob-preview-moment\">\n");
        match PublicMoment::from_moment(moment, record) {
            Some(public) => {
                html.push_str("<div class=\"ob-preview-prose\">\n");
                html.push_str(&render_section(&moment_markdown(&public, index + 1), options).html);
                html.push_str("</div>\n");
            }
            None => html.push_str(
                "<p class=\"ob-preview-status ob-preview-hidden\">This moment's source is no longer listed, so the piece cannot be published until its author edits the moment or keeps it private.</p>\n",
            ),
        }
        if let Some(quotation) = moment.quotation() {
            html.push_str(&rights_review_html(quotation));
        }
        html.push_str("</div>\n");
    }
    html.push_str("</section>\n");
    html
}

/// What co-authors review about a quotation besides its words and attribution: the owner's rights
/// statement with its neutral guidance, the rights note, where the words came from, and any
/// warnings. Everything is escaped text, and none of it is ever published.
fn rights_review_html(quotation: &Quotation) -> String {
    let mut html = format!(
        "<p class=\"ob-preview-rights\">Rights, as the author states them: {}. {} {}",
        escape::text(quotation.rights.label()),
        escape::text(quotation.rights.guidance()),
        escape::text(RIGHTS_STATEMENT)
    );
    if let Some(note) = &quotation.rights_note {
        html.push_str(&format!(" Rights note: {}", escape::text(note)));
    }
    html.push_str(&format!(
        " {}.</p>\n",
        escape::text(quotation.provenance.label())
    ));
    let notices = quotation.notices();
    if !notices.is_empty() {
        html.push_str(
            "<ul class=\"ob-preview-notices\" aria-label=\"Things to check in this quotation\">\n",
        );
        for notice in notices {
            html.push_str(&format!("<li>{}</li>\n", escape::text(notice.message())));
        }
        html.push_str("</ul>\n");
    }
    html
}

/// The conversation as the preview shows it. Approved items come first as the very Markdown the
/// Post publishes ([`crate::assembly::conversation_markdown`]) through the same renderer, so the
/// preview and the public page cannot drift. Items still awaiting approval follow in a separate,
/// plainly labelled block that is never published.
fn conversation_html(
    record: &SharedPublication,
    items: &[PreviewItem],
    synthesis: &SynthesisSet,
    options: RenderOptions<'_>,
) -> String {
    let mut html = String::new();
    if items.is_empty() {
        return html;
    }
    let published = crate::assembly::conversation_markdown(record, synthesis);
    if !published.is_empty() {
        html.push_str(
            "<p class=\"ob-preview-status\">Published exactly as shown in this section: items every author they speak for has approved.</p>\n",
        );
        html.push_str("<div class=\"ob-preview-prose\">\n");
        html.push_str(&render_section(&published, options).html);
        html.push_str("</div>\n");
    }
    let pending: Vec<_> = items
        .iter()
        .zip(synthesis.items())
        .filter(|(entry, _)| !entry.awaiting.is_empty())
        .collect();
    if !pending.is_empty() {
        html.push_str(
            "<section class=\"ob-preview-section\" aria-labelledby=\"ob-preview-pending\">\n<h2 id=\"ob-preview-pending\">Awaiting approval, not published</h2>\n",
        );
        for (entry, item) in pending {
            html.push_str(&format!(
                "<article class=\"ob-preview-item\">\n<p class=\"ob-preview-status\">{}, speaking for {}. Approved by: {}. Awaiting: {}.</p>\n",
                escape::text(kind_label(entry.kind)),
                escape::text(&entry.authors.join(", ")),
                escape::text(&list_or_none(&entry.approved)),
                escape::text(&list_or_none(&entry.awaiting)),
            ));
            html.push_str("<div class=\"ob-preview-prose\">\n");
            html.push_str(&render_section(item.markdown(), options).html);
            html.push_str("</div>\n</article>\n");
        }
        html.push_str("</section>\n");
    }
    html
}

/// The arranged markup of a preview: each turn in the structure's reading order, wrapped like the
/// published Post. A turn of an author whose latest revision the requester may not read is the
/// one uniform placeholder, so the arrangement never shows more than the sections do. `Err` means
/// the arrangement cannot be read against the drafts (a turn names a missing part or participant,
/// or an unsupported layout), so nothing is arranged and the piece is not complete.
fn arrange(
    record: &SharedPublication,
    structure: &ReflectionStructure,
    drafts: &DraftSet,
    requester: &str,
    active: &[&str],
    sections: &[(&PreviewSection, bool)],
    options: RenderOptions<'_>,
) -> Result<String, ()> {
    let order = structure
        .reading_order_for(&record.collaboration, drafts, requester, active)
        .map_err(|_| ())?;
    // Each active author's section and whether they have written anything.
    let section_of = |id: &str| sections.iter().find(|(s, _)| s.participant_id == id);
    let shown = |id: &str| section_of(id).map(|(s, _)| s.shown);
    let order: Vec<_> = order
        .into_iter()
        .filter(|entry| match shown(entry.participant_id) {
            None => false,
            Some(true) => entry.markdown.is_some(),
            // Assembly drops the turns (and credit) of an author with nothing written, so the
            // preview does too; only an author whose draft is withheld gets the placeholder.
            Some(false) => section_of(entry.participant_id).is_some_and(|(_, written)| *written),
        })
        .collect();
    let placements = ReflectionStructure::placements(structure.layout, &order);
    let turns: Vec<ComposedTurn<'_>> = order
        .iter()
        .zip(placements)
        .map(|(entry, placement)| {
            let body = match (shown(entry.participant_id), entry.markdown.as_deref()) {
                (Some(true), Some(text)) => render_section(text, options).html,
                _ => String::from(
                    "<p class=\"ob-preview-status ob-preview-hidden\">Not shared with you at its current revision.</p>"
                ),
            };
            ComposedTurn {
                round: entry.round,
                round_prompt: structure.rounds[entry.round].round_prompt.as_deref(),
                display_name: entry.display_name,
                label: entry.label,
                placement,
                body,
            }
        })
        .collect();
    Ok(compose(structure.layout, &turns))
}

#[allow(clippy::too_many_arguments)]
fn document(
    record: &SharedPublication,
    rule: &PreviewRule,
    sections: &[PreviewSection],
    rendered: &[Option<String>],
    arranged: Option<&Result<String, ()>>,
    moments: &str,
    conversation: &str,
    complete: bool,
    ready: bool,
) -> String {
    let title = record
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Untitled shared reflection");
    let mut html = String::new();
    html.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
    html.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    html.push_str("<meta name=\"robots\" content=\"noindex, nofollow\">\n");
    html.push_str("<meta name=\"referrer\" content=\"no-referrer\">\n");
    html.push_str(&format!(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">\n",
        escape::attr(PREVIEW_CSP)
    ));
    html.push_str(&format!(
        "<title>Preview, not published: {}</title>\n",
        escape::text(title)
    ));
    html.push_str(STYLE);
    html.push_str(&format!(
        "<style>\n{}</style>\n",
        crate::reflection::LAYOUT_CSS
    ));
    html.push_str("</head>\n<body>\n");
    html.push_str(
        "<p class=\"ob-preview-banner\" role=\"note\"><strong>Preview, not published.</strong> ",
    );
    html.push_str(
        "Only authors of this piece can see it. Nothing here is public until it is published. ",
    );
    html.push_str("Images and embeds are not loaded in this preview.</p>\n");
    html.push_str(&format!(
        "<p class=\"ob-preview-state\" role=\"status\">{}</p>\n",
        if ready {
            "Every required author has approved this exact piece."
        } else if complete {
            "Not ready to publish: approvals are missing or out of date."
        } else {
            "Incomplete: some sections are not shared with you at their current revision."
        }
    ));
    html.push_str(&format!("<h1>{}</h1>\n", escape::text(title)));
    if let Some(attribution) = SharedAttribution::from_record(record) {
        html.push_str(&attribution.html());
    }
    html.push_str(&format!(
        "<p class=\"ob-preview-rule\">Approval rule: {}</p>\n",
        escape::text(&rule.summary)
    ));
    if !rule.unmet_named.is_empty() || !rule.unmet_roles.is_empty() {
        let mut problems = Vec::new();
        if !rule.unmet_named.is_empty() {
            problems.push(format!(
                "{} can no longer approve",
                rule.unmet_named.join(", ")
            ));
        }
        for role in &rule.unmet_roles {
            problems.push(format!(
                "no author is {}",
                crate::approval::role_with_article(*role)
            ));
        }
        // Only a site owner can take a named person off the rule (ADR 0052); a coordinator can
        // change a role requirement.
        let mut remedies = Vec::new();
        if !rule.unmet_named.is_empty() {
            remedies
                .push("A site owner can take them off the rule, or their access can be restored.");
        }
        if !rule.unmet_roles.is_empty() {
            remedies
                .push("A coordinator can change the rule, or an author can be given that role.");
        }
        html.push_str(&format!(
            "<p class=\"ob-preview-status\" role=\"note\">This rule cannot be met as things stand: {}. {}</p>\n",
            escape::text(&problems.join("; ")),
            escape::text(&remedies.join(" "))
        ));
    }
    // The placement is public and bound into every approval (ADR 0038), so it is shown here.
    if let Some(placement) = &record.series {
        html.push_str(&format!(
            "<p class=\"ob-preview-series\"><strong>Series:</strong> {}</p>\n",
            escape::text(&placement.label())
        ));
    }
    html.push_str("<ol class=\"ob-preview-authors\" aria-label=\"Authors and approval\">\n");
    for section in sections {
        html.push_str(&format!(
            "<li>{}: {}</li>\n",
            escape::text(&section.display_name),
            escape::text(approval_label(section.approval))
        ));
    }
    html.push_str("</ol>\n");
    match arranged {
        Some(Ok(arranged)) => html.push_str(arranged),
        Some(Err(())) => html.push_str(
            "<p class=\"ob-preview-status ob-preview-hidden\">The arrangement of this piece does not match the drafts, so it cannot be shown or approved. Ask a coordinator to review the arrangement.</p>\n",
        ),
        None => {
        for (section, prose) in sections.iter().zip(rendered) {
            html.push_str("<section class=\"ob-preview-section\">\n");
            match (prose, section.revision) {
                (Some(prose), Some(revision)) => {
                    html.push_str(&format!(
                        "<p class=\"ob-preview-status\">{}, revision {}. {}</p>\n",
                        escape::text(&section.display_name),
                        revision,
                        escape::text(approval_label(section.approval))
                    ));
                    html.push_str("<div class=\"ob-preview-prose\">\n");
                    html.push_str(prose);
                    html.push_str("</div>\n");
                }
                _ => html.push_str(&format!(
                    "<p class=\"ob-preview-status ob-preview-hidden\">{}: not shared with you at its current revision.</p>\n",
                    escape::text(&section.display_name)
                )),
            }
            html.push_str("</section>\n");
        }
        }
    }
    html.push_str(moments);
    html.push_str(conversation);
    html.push_str("</body>\n</html>\n");
    html
}

fn list_or_none(names: &[String]) -> String {
    if names.is_empty() {
        "no one".to_string()
    } else {
        names.join(", ")
    }
}

fn kind_label(kind: SynthesisKind) -> &'static str {
    match kind {
        SynthesisKind::Agreement => "Agreement",
        SynthesisKind::Difference => "Difference",
        SynthesisKind::Question => "Question",
        SynthesisKind::Application => "Application",
        SynthesisKind::Uncertainty => "Uncertainty",
    }
}

const STYLE: &str = "<style>\n\
:root { color-scheme: light dark; --ink: #1b1b1f; --paper: #fff; --line: #b8b8c0; --warn: #7a4a00; --warn-bg: #fff4d6; }\n\
@media (prefers-color-scheme: dark) { :root { --ink: #ececf0; --paper: #17171a; --line: #4a4a52; --warn: #ffd88a; --warn-bg: #3a2c0a; } }\n\
body { margin: 0 auto; max-width: 42rem; padding: 1rem; font: 1rem/1.6 system-ui, sans-serif; color: var(--ink); background: var(--paper); }\n\
.ob-preview-banner { border: 2px dashed var(--warn); background: var(--warn-bg); color: var(--warn); padding: .5rem .75rem; }\n\
.ob-preview-state { font-weight: 600; }\n\
.ob-preview-authors { padding-left: 1.25rem; }\n\
.ob-preview-section { border-top: 1px solid var(--line); margin-top: 1.5rem; padding-top: .5rem; }\n\
.ob-preview-status { font-size: .875rem; font-weight: 600; }\n\
.ob-preview-hidden { font-style: italic; }\n\
.ob-preview-moment { margin-top: 1rem; }\n\
.ob-moment-quotation { margin: .5rem 0; padding-left: .75rem; border-left: 3px solid var(--line); }\n\
.ob-moment-quotation blockquote { margin: 0; }\n\
.ob-moment-quotation figcaption { font-size: .875rem; }\n\
.ob-preview-rights { font-size: .875rem; }\n\
.ob-preview-notices { font-size: .875rem; color: var(--warn); }\n\
img { max-width: 100%; }\n\
</style>\n";
