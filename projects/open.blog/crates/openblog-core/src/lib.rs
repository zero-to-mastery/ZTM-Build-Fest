//! # openblog-core
//!
//! Everything that turns a folder of Markdown into a blog, with no file or
//! network access so the same code runs natively (the `openblog` CLI) and in
//! the browser (the `openblog-wasm` package):
//!
//! - [`frontmatter`]: a small YAML-subset parser for post metadata
//! - [`markdown`]: CommonMark + GFM rendering with heading ids, reading time, excerpts
//! - [`model`]: posts, series, tags, and pages
//! - [`theme`]: design tokens in JSON, emitted as CSS custom properties, with inheritance
//! - [`render`]: semantic HTML pages built from native elements and web components
//! - [`feeds`]: RSS 2.0, JSON Feed, sitemap, and the latest-posts snapshot
//! - [`search`]: a small ranked search over a JSON index
//! - [`source_library`]: private research sources with stable, versioned identities
//! - [`research_notes`]: private passages and research notes that point into the source library
//! - [`research_bundle`]: versioned portable export and dry-run import of that notebook, and the structural check build guards use
//! - [`research_search`]: deterministic search, filters and backlinks over that private notebook
//! - [`source_interchange`]: dry-run CSL JSON import and deterministic CSL JSON / BibTeX export
//! - [`citations`]: the opt-in `[@key, locator]` syntax, its resolver and CSL citation items
//! - [`bibliography`]: opt-in publication of citations as numbered notes or a bibliography
//! - [`citation_review`]: offline syntax, resolution, completeness and location checks of citations
//! - [`research_completeness`]: the one finding contract and matrix every research check maps into, with acknowledgements that never resolve a finding
//! - [`source_review`]: offline identifier, version, quotation-location and citation-consistency diagnostics over posts, the source library and the notebook
//! - [`claims`]: private claims in draft posts and the author's evidence links to sources and passages
//! - [`claim_publication`]: the one public projection of approved claims and evidence, with revision notes
//! - [`knowledge_atlas`]: the private Knowledge Atlas of entries and attributed relationships
//! - [`chronology`]: uncertain, attributed and cited datings of atlas entries and relationships
//! - [`chronology_index`]: deterministic chronology indexes and structural prompts to check datings
//! - [`atlas_publication`]: the one public projection of its approved items, for pages and `atlas.json`
//! - [`concept_links`]: an author's explicit `atlas:` links, resolved at build time against the public atlas alone
//! - [`atlas_query`]: the bounded query projection derived from the public atlas, for components and search
//! - [`scholarly_comparison`]: attributed interpretation comparisons and author-approved audience explanations that never rule on which reading is right
//! - [`reading_path`]: author-curated reading paths of published steps with author-written transitions, resolved against what a build publishes
//! - [`comparison_publication`]: the one public projection of approved passage alignments, rights-gated, for pages and `comparisons.json`
//! - [`curated_selection`]: the author's explicit, revision-aware selection of already-publishable research context for readers
//! - [`passage_target`]: stable passage targets in published text, resolved as current, re-anchored or stale
//! - [`feedback_provenance`]: which revision a reader's feedback was about and when, with consent-gated attribution
//! - [`scholarly_feedback`]: typed reader questions, suggested sources and corrections and other interpretations, as submitted and as received
//! - [`evidence_submission`]: suggested sources and corrections with the published claim, citation and source a reader names, never verified
//! - [`correction_decision`]: the author's correction decision on an evidence submission, the only thing that labels a correction
//! - [`participation`]: the closed registry of participation kinds and their site and post modes
//! - [`moderation`]: the one moderation state machine, roles, audit events and retention for them
//! - [`moderation_inbox`]: the one moderation inbox over every hosted participation store
//! - [`third_perspective`]: a reader's consented, moderated reflection on a published work, and its one public form
//! - [`perspective_publication`]: approved Third Perspectives as the site publishes and its canonical pages show them
//! - [`attributed_perspective`]: stable targets at one author's section of a shared reflection, and who may answer a Third Perspective about it
//! - [`future_suggestion`]: a reader's question or source suggestion for future work, kept private to the editors, never entering the Source Library by itself
//! - [`community_feature`]: a reader's separate, revision-bound consent to feature an approved reflection on its page, and the editorial selection that is never a vote or a consensus
//! - [`continuation`]: typed links from an approved question, reflection or source suggestion to the later work that takes it up, and the optional, consented, link-only-by-default update subscription
//! - [`subscription`]: the pluggable, double opt-in service behind a continuation's optional update subscription, with no provider as its baseline
//! - [`author_response`]: an author's answer to a Third Perspective as the hosted store keeps it, the request that stores it and the checks that it still belongs under its parent

pub mod accessibility;
pub mod alignment;
pub mod approval;
pub mod arrangement;
pub mod assembly;
pub mod assistant_guide;
pub mod atlas_publication;
pub mod atlas_query;
pub mod attributed_perspective;
pub mod author_response;
pub mod bibliography;
pub mod business;
pub mod capability;
pub mod capture;
pub mod chronology;
pub mod chronology_index;
pub mod citation_review;
pub mod citations;
pub mod claim_publication;
pub mod claim_review;
pub mod claims;
pub mod collaboration;
pub mod community_feature;
pub mod compare;
pub mod comparison_portable;
pub mod comparison_publication;
pub mod concept_links;
pub mod config;
pub mod context_links;
pub mod continuation;
pub mod contributor;
pub mod correction_decision;
pub mod curated_context;
pub mod curated_selection;
pub mod date;
pub mod draft;
pub mod embed;
pub mod escape;
pub mod evidence_submission;
pub mod feedback_moderation;
pub mod feedback_provenance;
pub mod feedback_publication;
pub mod feeds;
pub mod field_journal;
pub mod frontmatter;
pub mod future_suggestion;
pub mod interpretation;
pub mod interpretation_publication;
pub mod invitation;
pub mod job;
pub mod job_archive;
pub mod job_draft;
pub mod knowledge_atlas;
pub mod landing;
pub mod look;
pub mod look_contrast;
pub mod look_css;
pub mod look_presets;
pub mod markdown;
pub mod media_moment;
pub mod members;
pub mod model;
pub mod moderation;
pub mod moderation_inbox;
pub mod participation;
pub mod passage_target;
pub mod perspective_publication;
pub mod piece;
pub mod portability;
pub mod preview;
pub mod profile;
pub mod publication_boundary;
pub mod publication_review;
pub mod published_moment;
mod raw_html;
pub mod reader_references;
pub mod reading_depth;
pub mod reading_path;
pub mod reading_path_exchange;
pub mod recipe;
pub mod reflection;
pub mod render;
pub mod research;
pub mod research_bundle;
pub mod research_completeness;
pub mod research_notes;
pub mod research_search;
pub mod scholarly_comparison;
pub mod scholarly_feedback;
pub mod search;
pub mod service;
pub mod service_area;
pub mod shared_series;
pub mod shared_source;
pub mod shingles;
pub mod slug;
pub mod social_publishing;
pub mod social_schedule;
pub mod source_interchange;
pub mod source_library;
pub mod source_review;
pub mod subscription;
pub mod synthesis;
pub mod theme;
pub mod third_perspective;
pub mod video;
pub mod voice;

pub use config::SiteConfig;
pub use date::DateTime;
pub use model::{LoadOptions, Page, Post, Scheduled, Series, Site, SourceFile, Sources, Tag};
pub use render::{
    generate, generate_document, generate_home, social_metadata, OutputFile, SocialMetadata,
};
pub use theme::{Theme, ThemeFile, ThemeSet};

/// Classify a content file path into the source bucket it belongs to.
pub fn classify_source(relative_path: &str) -> Option<SourceKind> {
    let normalized = relative_path.replace('\\', "/");
    if normalized.ends_with(".credits.json") {
        let first = normalized.split('/').next()?;
        return match first {
            "posts" => Some(SourceKind::PostCredits),
            _ if !normalized.contains('/') => Some(SourceKind::PostCredits),
            _ => None,
        };
    }
    if !normalized.ends_with(".md") && !normalized.ends_with(".markdown") {
        return None;
    }
    let first = normalized.split('/').next()?;
    match first {
        "posts" => Some(SourceKind::Post),
        "series" => Some(SourceKind::Series),
        "pages" => Some(SourceKind::Page),
        "services" => Some(SourceKind::Service),
        // Loose Markdown files at the content root are posts, so a folder of
        // exported articles works with no restructuring.
        _ if !normalized.contains('/') => Some(SourceKind::Post),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Post,
    PostCredits,
    Series,
    Page,
    Service,
}

impl Sources {
    /// Add a file to the right bucket based on its path. Returns `false` for
    /// files that are not content (images, READMEs, nested folders).
    pub fn add(&mut self, file: SourceFile) -> bool {
        match classify_source(&file.path) {
            Some(SourceKind::Service) if !service::declares_service(&file.contents) => {
                return false
            }
            Some(SourceKind::Post) => self.posts.push(file),
            Some(SourceKind::PostCredits) => self.credits.push(file),
            Some(SourceKind::Series) => self.series.push(file),
            Some(SourceKind::Page) => self.pages.push(file),
            Some(SourceKind::Service) => self.services.push(file),
            None => return false,
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_paths() {
        assert_eq!(classify_source("posts/a.md"), Some(SourceKind::Post));
        assert_eq!(classify_source("posts\\deep\\a.md"), Some(SourceKind::Post));
        assert_eq!(classify_source("series/x.md"), Some(SourceKind::Series));
        assert_eq!(
            classify_source("pages/about.markdown"),
            Some(SourceKind::Page)
        );
        assert_eq!(classify_source("loose.md"), Some(SourceKind::Post));
        assert_eq!(
            classify_source("services/hardwood.md"),
            Some(SourceKind::Service)
        );
        assert_eq!(classify_source("services/a.credits.json"), None);
        assert_eq!(
            classify_source("posts/a.credits.json"),
            Some(SourceKind::PostCredits)
        );
        assert_eq!(classify_source("posts/a.portability.json"), None);
        assert_eq!(
            classify_source("loose.credits.json"),
            Some(SourceKind::PostCredits)
        );
        assert_eq!(classify_source("pages/a.credits.json"), None);
        assert_eq!(classify_source("posts/README.txt"), None);
        assert_eq!(classify_source("other/x.md"), None);
    }
}
