//! The research readiness report (#194, ADR 0150): one report of what every
//! research check says about the site as the next build would publish it,
//! shown the same way by Admin, `openblog check`, `openblog build` and the
//! preview that serves a build.
//!
//! Nothing here checks anything. [`gather`] reads the findings each owning
//! validator already reports, through the same loaders the build and the
//! review before publication use ([`crate::research_review`]), and hands
//! them to the one contract, [`openblog_core::research_completeness`]. The
//! report is the contract's own: the codes, the order, the groups, the counts
//! and the acknowledgements are the contract's, so a finding reads the same in
//! Admin, in the terminal and in machine-readable output.
//!
//! It is a report of prompts, never a verdict. It has no score, no total and
//! no pass or fail: outcomes are counted apart, only a failure of a private
//! file the build reads blocks the next build, and acknowledging a finding
//! keeps it listed and counted. It reads only: no file is written, repaired or
//! replaced, and a sentence the validators state names ids, fields and stated
//! values, never a statement, note, excerpt or label.

use std::path::Path;

use openblog_core::context_links;
use openblog_core::frontmatter;
use openblog_core::publication_review::{PublicationReview, ReviewFinding, ReviewScope};
use openblog_core::research_completeness::CompletenessReport;
use openblog_core::Site;
use serde_json::Value;

use crate::research_review::{self, Gathered, NotReviewed};
use crate::{alignment_store, atlas_store, claims_store, notebook_store, source_store};

/// The acknowledgements file as a report read it: its revision for the next
/// change to name, or why it could not be read. Never repaired.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Acknowledgements {
    pub revision: Option<String>,
    pub error: Option<String>,
}

/// The report of one site.
#[derive(Debug)]
pub struct Readiness {
    pub applies: bool,
    pub review: PublicationReview,
    pub not_reviewed: Vec<NotReviewed>,
    pub acknowledgements: Acknowledgements,
    /// The posts a production build publishes, when the terminal text is for
    /// one: a finding about any other post (a draft, a post waiting for its
    /// date) is counted, never printed, so a build log does not name them.
    /// `None` lists every finding, as `check`, Admin and `serve --drafts` do.
    published: Option<std::collections::BTreeSet<String>>,
}

impl Readiness {
    /// The report of a site that could not be loaded: nothing found, nothing
    /// reviewed, in the same shape as any other.
    pub fn empty() -> Self {
        Readiness {
            applies: false,
            review: PublicationReview::scoped(
                CompletenessReport::new(Vec::new(), &[]),
                ReviewScope::Site,
            ),
            not_reviewed: Vec::new(),
            acknowledgements: Acknowledgements::default(),
            published: None,
        }
    }

    /// Print findings about posts outside `published` as a count only, so a
    /// production build's log never names a draft or a scheduled post. The
    /// report itself, `check`, Admin and `serve --drafts` keep every finding.
    pub fn limit_text_to_published(&mut self, published: std::collections::BTreeSet<String>) {
        self.published = Some(published);
    }

    /// How many findings block the next build: a failure of a private file it
    /// reads, which it refuses. Nothing else blocks.
    pub fn blocking(&self) -> usize {
        self.review.blocking()
    }

    /// The report as machine-readable JSON, exactly as Admin receives it:
    /// the contract's findings in the contract's order, their groups and
    /// counts, and what could not be reviewed.
    pub fn view(&self) -> Value {
        research_review::view(
            &self.review,
            self.applies,
            &self.not_reviewed,
            &self.acknowledgements,
        )
    }

    /// Deterministic, pretty-printed JSON with a trailing newline.
    #[cfg(test)]
    pub fn json(&self) -> String {
        let mut json = serde_json::to_string_pretty(&self.view()).unwrap_or_default();
        json.push('\n');
        json
    }

    /// The findings, one line each in Admin's order, then the counts, then
    /// what was not reviewed. Empty when the report has nothing to say, so a
    /// site without research output reads exactly as before.
    pub fn text(&self) -> String {
        self.text_after(false)
    }

    /// [`Readiness::text`] for output that follows other checks: when they
    /// failed, an empty report is silent rather than saying there is nothing
    /// to review beside a failure.
    pub fn text_after(&self, checks_failed: bool) -> String {
        let mut text = match &self.published {
            None => self.review.text(),
            Some(published) => self.review.text_hiding(|entry| {
                let scope = &entry.finding.scope;
                scope.object == openblog_core::publication_review::ObjectKind::Post
                    && scope
                        .path
                        .as_ref()
                        .is_some_and(|path| !published.contains(path))
            }),
        };
        if text.is_empty() && self.applies && self.not_reviewed.is_empty() && !checks_failed {
            // A research site that raised nothing says so, rather than nothing.
            text.push_str("Research checks: nothing to review\n");
        }
        for item in &self.not_reviewed {
            text.push_str(&format!("research not reviewed: {}\n", item.message));
        }
        if let Some(error) = &self.acknowledgements.error {
            if !text.is_empty() {
                text.push_str(&format!(
                    "research acknowledgements unavailable, so none are shown or saved: {error}\n"
                ));
            }
        }
        text
    }
}

/// Whether the site has any research for the report to be about: a post on
/// the Research profile or that publishes citations, a stored private
/// research file, or a finding. A site without any is not reported on, so its
/// `check` and `build` output stays byte for byte what it was.
pub fn applies(root: &Path, site: &Site) -> bool {
    !site.evidence.is_empty()
        || !site.source_review.is_empty()
        || site
            .posts
            .iter()
            .any(|post| post.research.is_some() || post.citations().is_some())
        || [
            source_store::LIBRARY_FILE,
            notebook_store::NOTEBOOK_FILE,
            atlas_store::ATLAS_FILE,
            claims_store::CLAIMS_FILE,
            alignment_store::ALIGNMENTS_FILE,
        ]
        .iter()
        .any(|file| std::fs::symlink_metadata(root.join(file)).is_ok())
}

/// The report of the site, from one fixed set of posts: every saved post,
/// whatever the load that is building, serving or checking holds back. A
/// draft or a post waiting for its date is warn-only in a site report
/// (`ReviewScope::Site`), so reading it changes no outcome of the build, and
/// Admin, `check`, `check --json`, `build` and `serve` all list the same
/// codes in the same order whether or not they include drafts.
///
/// A site with no research anywhere, saved posts included, is reported
/// without loading anything again. Otherwise, when `site` was loaded without
/// every saved post, they are read once more, and that load is kept for as
/// long as the saved files stay as they are, so a rebuild of unchanged
/// content or a second reader pays nothing again. Reads only; nothing is
/// written.
pub fn report(root: &Path, site: &Site) -> Readiness {
    report_of_held(root, site, false, None)
}

/// [`report`] for a caller that knows more about `site`: that it holds every
/// saved post (`every_post`, so it is reported as it stands) and whether any
/// saved post at all is a research post or cites (`research_in_posts`, `None`
/// when the caller has not looked, and the content folder is read for it).
pub fn report_of_held(
    root: &Path,
    site: &Site,
    every_post: bool,
    research_in_posts: Option<bool>,
) -> Readiness {
    if every_post {
        return report_of_all(root, site);
    }
    let may_apply = applies(root, site)
        || research_in_posts.unwrap_or_else(|| research_in_saved_posts(root, site));
    if !may_apply {
        // Nothing to report: the other saved posts add none.
        return report_of_all(root, site);
    }
    match saved_site(root) {
        Ok(all) => report_of_all(root, &all),
        Err(_) => report_of_all(root, site),
    }
}

/// Whether a saved post's front matter makes it a research post or publishes
/// citations, as far as its text can tell. It leans toward yes: a post it
/// cannot read the front matter of counts, since the answer only decides
/// whether the report loads the site.
pub fn is_research_source(source: &str) -> bool {
    match frontmatter::parse(source) {
        Ok(document) => {
            openblog_core::profile::resolve(&document.front_matter).behavior
                == openblog_core::profile::ProfileBehavior::Research
                || document.front_matter.get("citations").is_some()
        }
        Err(_) => true,
    }
}

/// Whether any saved post in the content folder is a research post or cites,
/// from the first bytes of each file only, so no post is rendered.
fn research_in_saved_posts(root: &Path, site: &Site) -> bool {
    use std::io::Read;
    let content = root.join(&site.config.paths.content);
    let Ok(files) = crate::site::content_files(&content) else {
        return true;
    };
    for file in files {
        let rel = crate::fsutil::relative(&content, &file);
        if crate::site::not_content(&rel)
            || openblog_core::classify_source(&rel) != Some(openblog_core::SourceKind::Post)
        {
            continue;
        }
        let mut head = Vec::new();
        let read = std::fs::File::open(&file).and_then(|handle| {
            handle
                .take(FRONT_MATTER_BYTES as u64)
                .read_to_end(&mut head)
        });
        if read.is_err() {
            return true;
        }
        let text = String::from_utf8_lossy(&head);
        // Front matter that runs past the part read cannot be told apart.
        let closed = text.matches("---").count() >= 2;
        let cut_short = head.len() == FRONT_MATTER_BYTES;
        if (cut_short && !closed && text.starts_with("---")) || is_research_source(&text) {
            return true;
        }
    }
    false
}

const FRONT_MATTER_BYTES: usize = 8 * 1024;

/// [`report`] for a site that already holds every saved post: one loaded
/// with drafts and no clock, as `openblog check` does.
pub fn report_of_all(root: &Path, site: &Site) -> Readiness {
    let applies = applies(root, site);
    let gathered = if applies {
        gather(root, site)
    } else {
        Gathered::default()
    };
    let (acknowledgements, info) = research_review::acknowledgements(root);
    let review = PublicationReview::scoped(
        CompletenessReport::new(gathered.findings, &acknowledgements),
        ReviewScope::Site,
    );
    let mut not_reviewed = gathered.not_reviewed;
    not_reviewed.sort_by(|a, b| (a.part, &a.message).cmp(&(b.part, &b.message)));
    not_reviewed.dedup();
    Readiness {
        applies,
        review,
        not_reviewed,
        acknowledgements: info,
        published: None,
    }
}

/// A build error with the research report beside it, for a site that has
/// research, so the findings behind a refusal are listed with the same codes
/// and order `check` and Admin show (ADR 0150). The error is unchanged, and
/// a site without research gets exactly the error it always got.
pub fn alongside(root: &Path, site: &Site, error: String) -> String {
    let mut report = report(root, site);
    report.limit_text_to_published(site.posts.iter().map(|post| post.source.clone()).collect());
    let text = report.text();
    if !report.applies || (report.review.findings.is_empty() && report.not_reviewed.is_empty()) {
        return error;
    }
    format!("{error}\n{}", text.trim_end())
}

/// Everything the research checks say about the site: each owning validator's
/// findings, in the contract's shape. The order is the contract's, whatever
/// order they are gathered in.
pub fn gather(root: &Path, site: &Site) -> Gathered {
    let config = &site.config;
    let contributors = &config.contributors;
    let mut gathered = Gathered::default();
    gathered
        .findings
        .extend(site.evidence.iter().map(ReviewFinding::from_evidence));
    gathered.findings.extend(
        site.source_review
            .iter()
            .map(ReviewFinding::from_source_review),
    );

    // What the build reads, once and on its own: the finding of a file it
    // cannot read is scoped to that file and blocks the build.
    let published = research_review::read_published(root, config, &mut gathered, true);
    let reads_atlas = config.knowledge_atlas.publish;
    let reads_comparisons = config.comparisons.publish;
    let reads_claims = config.claim_evidence.publish;

    // The library and notebook the stored research is reviewed against.
    let library = source_store::load(root, contributors);
    let notebook = notebook_store::load(root, contributors);
    match (&library, &notebook) {
        (Ok(library), Ok(notebook)) => {
            if library.stored {
                gathered.findings.extend(
                    openblog_core::source_review::review_library(
                        &library.library,
                        &notebook.notebook,
                    )
                    .iter()
                    .map(ReviewFinding::from_source_review),
                );
            }
        }
        // When the build reads research and cannot read these files, the
        // finding of why is already in the report, scoped to the file. When it
        // read them, because it reads less than a full check does (it never
        // reads an interpretation it does not publish), the part that could
        // not run is stated rather than dropped.
        _ if !published.ready
            && (reads_atlas || reads_comparisons || (reads_claims && published.claims_stored)) => {}
        _ if !exists(root, source_store::LIBRARY_FILE) && !exists(root, notebook_store::NOTEBOOK_FILE) => {}
        _ => gathered.not_reviewed.push(NotReviewed {
            part: "source-review",
            message: format!(
                "The library and notebook were not reviewed because one of them cannot be read. Repair {} or {} by hand.",
                source_store::LIBRARY_FILE,
                notebook_store::NOTEBOOK_FILE
            ),
        }),
    }

    // The atlas: its projection notices and its chronology prompts.
    match atlas_store::load(root, contributors) {
        Ok(snapshot) if snapshot.stored => {
            gathered.findings.extend(
                snapshot
                    .atlas
                    .notices()
                    .iter()
                    .map(ReviewFinding::from_atlas_diagnostic),
            );
            gathered.findings.extend(
                openblog_core::chronology_index::ChronologyIndex::of(&snapshot.atlas)
                    .prompts
                    .iter()
                    .map(ReviewFinding::from_chronology_prompt),
            );
        }
        Ok(_) => {}
        Err(error) => unread(
            root,
            &mut gathered,
            reads_atlas,
            "atlas",
            atlas_store::ATLAS_FILE,
            &error.to_string(),
        ),
    }

    // The claims file: its evidence review of the saved drafts, and its
    // projection notices.
    match claims_store::load(root, contributors) {
        Ok(snapshot) if snapshot.stored => {
            gathered.findings.extend(
                claims_store::review(&snapshot, root, &config.paths.content)
                    .iter()
                    .map(ReviewFinding::from_evidence),
            );
            gathered.findings.extend(
                snapshot
                    .claims
                    .notices()
                    .iter()
                    .map(ReviewFinding::from_atlas_diagnostic),
            );
        }
        Ok(_) => {}
        Err(error) => unread(
            root,
            &mut gathered,
            reads_claims,
            "claims",
            claims_store::CLAIMS_FILE,
            &error.to_string(),
        ),
    }

    // The alignments file: its place notices, and the wording a published
    // comparison leaves out.
    match alignment_store::load(root, contributors) {
        Ok(snapshot) if snapshot.stored => {
            gathered.findings.extend(
                snapshot
                    .alignments
                    .notices(openblog_core::knowledge_atlas::Links {
                        library: &snapshot.library,
                        notebook: &snapshot.notebook,
                    })
                    .iter()
                    .map(ReviewFinding::from_atlas_diagnostic),
            );
        }
        Ok(_) => {}
        Err(error) => unread(
            root,
            &mut gathered,
            reads_comparisons,
            "alignments",
            alignment_store::ALIGNMENTS_FILE,
            &error.to_string(),
        ),
    }
    if let Some(projection) = &published.comparisons {
        for comparison in &projection.comparisons {
            gathered
                .findings
                .extend(ReviewFinding::from_comparison(comparison));
        }
    }

    // The context links of every post the site holds.
    let held: std::collections::BTreeSet<&str> =
        site.posts.iter().map(|post| post.source.as_str()).collect();
    for (path, source) in claims_store::saved_post_sources(root, &config.paths.content) {
        if !held.contains(path.as_str()) {
            continue;
        }
        let Ok(document) = frontmatter::parse(&source) else {
            continue;
        };
        let links = context_links::find_context_links(&document.body, document.body_line);
        gathered.findings.extend(research_review::link_findings(
            &path, &links, config, &published,
        ));
    }
    gathered
}

/// A stored file that cannot be read. When the build reads it, the finding of
/// why is already in the report; otherwise the report says it was not
/// reviewed, and nothing is repaired.
fn unread(
    root: &Path,
    gathered: &mut Gathered,
    reads: bool,
    part: &'static str,
    file: &str,
    error: &str,
) {
    // A file that is not there is not unreadable: there is nothing to review.
    if reads || std::fs::symlink_metadata(root.join(file)).is_err() {
        return;
    }
    gathered.not_reviewed.push(NotReviewed {
        part,
        message: format!(
            "{file} was not reviewed because it cannot be read ({}). Repair it by hand.",
            research_review::first_line(error)
        ),
    });
}

/// The site with every saved post, kept per project while its saved files
/// are unchanged.
pub fn saved_site(root: &Path) -> Result<std::sync::Arc<Site>, String> {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    type Kept = HashMap<std::path::PathBuf, (u64, Arc<Site>)>;
    static KEPT: OnceLock<Mutex<Kept>> = OnceLock::new();
    let kept = KEPT.get_or_init(|| Mutex::new(HashMap::new()));
    let revision = content_revision(root);
    if let (Some(revision), Ok(kept)) = (revision, kept.lock()) {
        if let Some((held, site)) = kept.get(root) {
            if *held == revision {
                return Ok(Arc::clone(site));
            }
        }
    }
    #[cfg(test)]
    loads::note(root);
    let (site, _) = crate::site::load_site(root, true, None)?;
    let site = Arc::new(site);
    if let (Some(revision), Ok(mut kept)) = (revision, kept.lock()) {
        if kept.len() >= 8 {
            kept.clear();
        }
        kept.insert(root.to_path_buf(), (revision, Arc::clone(&site)));
    }
    Ok(site)
}

/// A fingerprint of every saved file a site load reads for the research
/// report: the configuration, the content folder and the private research
/// files. Each file's path, length and modification time, so nothing is read
/// to tell whether it changed, and no link is followed: a link is told apart
/// by its own path, length and time.
fn content_revision(root: &Path) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let config = crate::site::load_config(root).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut files = vec![root.join("openblog.json")];
    files.extend(files_without_links(&root.join(&config.paths.content)));
    files.extend(files_without_links(&root.join(".openblog").join("private")));
    for file in files {
        file.strip_prefix(root).unwrap_or(&file).hash(&mut hasher);
        match std::fs::symlink_metadata(&file) {
            Ok(metadata) => {
                metadata.len().hash(&mut hasher);
                metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_nanos())
                    .hash(&mut hasher);
            }
            Err(_) => 0u8.hash(&mut hasher),
        }
    }
    Some(hasher.finish())
}

/// Every file under `dir`, sorted, descending into real folders only: a link
/// is listed as itself and never followed.
fn files_without_links(dir: &Path) -> Vec<std::path::PathBuf> {
    fn visit(dir: &Path, into: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => visit(&path, into),
                _ => into.push(path),
            }
        }
    }
    let mut files = Vec::new();
    visit(dir, &mut files);
    files.sort();
    files
}

/// The projects whose saved posts were loaded again, so a test can show that
/// a report loaded nothing more than it had to.
#[cfg(test)]
pub(crate) mod loads {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    static LOADED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

    pub fn note(root: &Path) {
        LOADED.lock().unwrap().push(root.to_path_buf());
    }

    pub fn of(root: &Path) -> usize {
        LOADED.lock().unwrap().iter().filter(|r| *r == root).count()
    }
}

fn exists(root: &Path, file: &str) -> bool {
    std::fs::symlink_metadata(root.join(file)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A plain project: one published article and one draft, no research.
    fn plain_project(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ob-readiness-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        copy_dir(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/portable-publishing"),
            &root,
        );
        std::fs::write(
            root.join("content/posts/portable-lesson.md"),
            "---
title: A plain post
date: 2026-10-24
---

Just an article.
",
        )
        .unwrap();
        std::fs::write(
            root.join("content/posts/wip.md"),
            "---
title: Work in progress
date: 2026-10-25
draft: true
---

Soon.
",
        )
        .unwrap();
        root
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    fn production(root: &Path) -> Site {
        crate::site::load_site(root, false, Some(crate::clock::now()))
            .unwrap()
            .0
    }

    #[test]
    fn a_site_without_research_is_reported_without_loading_every_post_again() {
        let root = plain_project("no-research");
        let site = production(&root);
        assert_eq!(site.posts.len(), 1, "the draft is held back");
        let report = report(&root, &site);
        assert!(!report.applies);
        assert_eq!(loads::of(&root), 0, "nothing was loaded a second time");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_draft_with_research_makes_the_site_load_every_post_once_and_keep_it() {
        let root = plain_project("draft-research");
        std::fs::write(
            root.join("content/posts/wip.md"),
            "---
title: Work in progress
date: 2026-10-25
profile: research
draft: true
---

Soon.
",
        )
        .unwrap();
        let site = production(&root);
        assert!(report(&root, &site).applies, "the saved draft is research");
        assert_eq!(loads::of(&root), 1);
        let _ = report(&root, &site);
        assert_eq!(loads::of(&root), 1, "an unchanged site is not loaded again");
        // A same-length edit changes the modification time, and is noticed.
        let file = root.join("content/posts/wip.md");
        let changed = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(changed)
            .unwrap();
        let _ = report(&root, &site);
        assert_eq!(loads::of(&root), 2, "a changed file is read again");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_build_that_holds_every_post_reports_without_a_second_load() {
        let root = plain_project("build-every");
        std::fs::remove_file(root.join("content/posts/wip.md")).unwrap();
        std::fs::write(
            root.join("content/posts/portable-lesson.md"),
            "---
title: Research
date: 2026-10-24
profile: research
---

Text.
",
        )
        .unwrap();
        let out = root.join("out-build");
        let built = crate::site::build(
            &root,
            &crate::site::BuildOptions {
                include_drafts: false,
                out_override: Some(out),
                now: Some(crate::clock::now()),
            },
        )
        .unwrap();
        assert!(built.readiness.is_some(), "a research site is reported");
        assert_eq!(loads::of(&root), 0, "the build's own site was reused");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_fingerprint_reads_no_file_and_follows_no_link() {
        let root = plain_project("fingerprint");
        let before = content_revision(&root).unwrap();
        assert_eq!(
            content_revision(&root),
            Some(before),
            "stable while unchanged"
        );
        let file = root.join("content/posts/wip.md");
        std::fs::write(
            &file,
            "---
title: Work in progress
date: 2026-10-25
draft: true
---

Late.
",
        )
        .unwrap();
        assert_ne!(content_revision(&root), Some(before), "a different length");

        // A link is listed as itself and never entered.
        let outside =
            std::env::temp_dir().join(format!("ob-readiness-outside-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "outside").unwrap();
        let link = root.join("content/posts/linked");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, &link).is_ok();
        if made {
            let files = files_without_links(&root.join("content"));
            assert!(files.contains(&link), "the link is listed as itself");
            assert!(
                !files.iter().any(|file| file.ends_with("secret.md")),
                "{files:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_report_is_silent_beside_a_failed_check() {
        let mut report = Readiness::empty();
        assert_eq!(report.text(), "", "a site without research stays silent");
        report.applies = true;
        assert_eq!(
            report.text(),
            "Research checks: nothing to review
"
        );
        assert_eq!(
            report.text_after(true),
            "",
            "never claims nothing to review beside a failure"
        );
    }

    #[test]
    fn a_file_is_reported_unread_only_when_it_exists() {
        let root = std::env::temp_dir().join(format!("ob-readiness-unread-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".openblog/private/research")).unwrap();
        let mut gathered = Gathered::default();
        unread(
            &root,
            &mut gathered,
            false,
            "atlas",
            atlas_store::ATLAS_FILE,
            "x",
        );
        assert!(gathered.not_reviewed.is_empty(), "nothing to review");
        std::fs::write(root.join(atlas_store::ATLAS_FILE), "{").unwrap();
        unread(
            &root,
            &mut gathered,
            false,
            "atlas",
            atlas_store::ATLAS_FILE,
            "x",
        );
        assert_eq!(gathered.not_reviewed.len(), 1);
        unread(
            &root,
            &mut gathered,
            true,
            "atlas",
            atlas_store::ATLAS_FILE,
            "x",
        );
        assert_eq!(
            gathered.not_reviewed.len(),
            1,
            "the build's own finding stands"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
