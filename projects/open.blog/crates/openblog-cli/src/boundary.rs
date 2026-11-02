//! The private-to-public research boundary at build time and in the Admin
//! preview (#63, ADR 0125).
//!
//! [`project`] attaches the research projections to a loaded site exactly as
//! a build does; [`manifest`] then says what they publish and why everything
//! else is withheld, from those same values, so the preview Admin shows and
//! the output a build writes come from one projection. [`check_output`] is the
//! build's last guard. It refuses when a page or JSON artifact names an item that
//! no approved projection publishes, and when private research text is in a
//! projection's machine data (the atlas, comparisons and claim-evidence JSON,
//! and a page's reference data). Private text anywhere else (pages, feeds,
//! search, static, theme and front-end files, a portable Markdown export) is a
//! `boundary:` warning, because the text match is a heuristic and the file is
//! one the author placed or wrote. A refusal or a warning names the output,
//! the private file, the record and the field, never the text.

use std::cell::OnceCell;
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::Path;

use openblog_core::comparison_publication::{stale_approvals, ComparisonInputs};
use openblog_core::contributor::Contributor;
use openblog_core::model::Post;
use openblog_core::publication_boundary::{
    BoundaryInputs, BoundaryManifest, ItemKind, Leak, PrivateText, Projection, Store, Switches,
    Unavailable,
};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{OutputFile, Site};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::{
    alignment_store, atlas_store, claims_store, fsutil, notebook_store, research_review,
    source_store,
};

/// The largest private file the text guard reads.
const MAX_GUARDED_FILE: u64 = 16 * 1024 * 1024;
/// The largest public input file the guard reads to allow its text.
const MAX_ALLOWED_FILE: u64 = 8 * 1024 * 1024;
/// How many leaks a refusal names before it counts the rest.
const NAMED_LEAKS: usize = 5;

/// Why a projection could not be attached, as the build would refuse it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Blocked {
    pub atlas: Option<String>,
    pub comparisons: Option<String>,
    pub claims: Option<String>,
}

/// Attach the atlas and comparison projections to the site exactly as a
/// build does, over the research read once into `shared`. A projection that
/// cannot be built is reported, not attached.
pub fn project_with(root: &Path, site: &mut Site, shared: &Shared) -> Blocked {
    let mut blocked = Blocked::default();
    let config = site.config.clone();
    let projected = match shared.atlas(root) {
        Some(loaded) => {
            crate::site::published_atlas_from(&config, loaded.as_ref(), &mut site.warnings)
        }
        None => crate::site::published_atlas(root, &config, &mut site.warnings),
    };
    match projected {
        Ok(atlas) => site.atlas = atlas,
        Err(error) => blocked.atlas = Some(error),
    }
    let projected = match shared.alignments(root) {
        Some(loaded) => {
            crate::site::published_comparisons_from(&config, loaded.as_ref(), &mut site.warnings)
        }
        None => crate::site::published_comparisons(root, &config, &mut site.warnings),
    };
    match projected {
        Ok(comparisons) => site.comparisons = comparisons,
        Err(error) => blocked.comparisons = Some(error),
    }
    blocked.claims = site.claim_evidence_error.clone();
    attach_reading_paths(root, site);
    attach_interpretations(root, site);
    // The public curated context, resolved against exactly what this build
    // publishes (the atlas and comparisons just attached, the posts, the
    // sources they cite), so the pages and curated-context.json read the one
    // public value the boundary manifest lists. Only while the site publishes
    // curated context and its selections can be read; otherwise nothing is
    // attached and every output is what it was.
    site.set_curation(None);
    if shared.curated {
        let stores = Stores::read(root, shared);
        if let Some(set) = &stores.selections {
            let owned = CurationBasis::of(site, &stores);
            let resolution =
                openblog_core::curated_selection::resolve(set, &owned.basis(site, &stores));
            site.set_curation(Some(resolution.curation));
        }
    }
    // The posts' concept links (ADR 0172) resolve against the atlas just
    // attached, and against nothing when it is not published or not readable.
    site.link_concepts();
    blocked
}

/// Attach the public reading paths (ADR 0212, #78), only while the site
/// publishes them. They are resolved against exactly what this build
/// publishes (the posts and the atlas just attached), so a path never names
/// what production would not show. A file that does not parse, a step that is
/// not published and a path that is withheld are warned about to the author
/// (naming the path and step, never a value) and leave the other paths and
/// every other output as they were. Off means the folder is never read.
fn attach_reading_paths(root: &Path, site: &mut Site) {
    site.reading_paths = None;
    if !site.config.reading_paths.publish {
        return;
    }
    let stored = match crate::reading_path_store::list(root, &site.config.paths.content) {
        Ok(stored) => stored,
        Err(error) => {
            site.warnings
                .push(format!("reading paths: no path is published: {error}"));
            return;
        }
    };
    let mut paths = Vec::new();
    for file in stored {
        match file.parsed {
            Ok(path) => paths.push(path),
            Err(problems) => {
                for problem in problems {
                    site.warnings.push(problem.to_string());
                }
            }
        }
    }
    let targets = openblog_core::reading_path::PublishedTargets::from_site(site);
    let resolution = openblog_core::reading_path::PublicPaths::resolve(&paths, &targets);
    for diagnostic in &resolution.diagnostics {
        site.warnings.push(diagnostic.to_string());
    }
    site.reading_paths = Some(resolution.paths);
}

/// Attach the public interpretation comparisons (ADR 0232, #90), only while
/// the site publishes them. Each stored comparison is projected by
/// `PublicComparison::project` against the sources and evidence links this
/// build publishes (approved links of approved claims, and only while
/// `claimEvidence.publish` is on), so a page never names a private source,
/// link or unapproved text. A file that does not parse and an item that is
/// left out are warned about to the author by comparison and item id, never
/// by value, and leave every other output as it was. Off means the folder is
/// never read.
fn attach_interpretations(root: &Path, site: &mut Site) {
    site.interpretations = None;
    if !site.config.interpretations.publish {
        return;
    }
    let stored = match crate::comparison_store::list(root, &site.config.paths.content) {
        Ok(stored) => stored,
        Err(error) => {
            site.warnings.push(format!(
                "interpretation comparisons: none is published: {error}"
            ));
            return;
        }
    };
    let mut comparisons = Vec::new();
    for file in stored {
        match file.parsed {
            Ok(comparison) => comparisons.push(comparison),
            Err(problems) => {
                for problem in problems {
                    site.warnings.push(problem.to_string());
                }
            }
        }
    }
    let (refs, sources, links) =
        match crate::claims_store::load_for_build(root, &site.config.contributors) {
            Ok(snapshot) if site.config.claim_evidence.publish && snapshot.stored => {
                openblog_core::interpretation_publication::PublicInterpretations::publishable(
                    &snapshot.claims,
                    &snapshot.library,
                    true,
                )
            }
            Ok(_) => Default::default(),
            Err(error) => {
                if site.config.claim_evidence.publish {
                    site.warnings.push(format!(
                        "interpretation comparisons: no evidence is shown: {error}"
                    ));
                }
                Default::default()
            }
        };
    let resolution = openblog_core::interpretation_publication::PublicInterpretations::resolve(
        &comparisons,
        &refs,
        sources,
        links,
    );
    site.warnings.extend(resolution.diagnostics);
    site.interpretations = Some(resolution.public);
}

/// The source library and notebook, and the atlas and alignments read
/// against them, read once and shared by the projections, the manifest and
/// the preview of one build or one Admin request, instead of once by each.
/// Nothing is read until something asks, and nothing is written.
pub struct Shared {
    contributors: BTreeMap<String, Contributor>,
    library: Option<SourceLibrary>,
    library_error: Option<String>,
    notebook: Option<Notebook>,
    notebook_error: Option<String>,
    atlas: OnceCell<Result<atlas_store::Snapshot, String>>,
    alignments: OnceCell<Result<alignment_store::Snapshot, String>>,
    /// Whether the site publishes curated context: only then are the
    /// selections read, resolved, listed or allowed to stop a build.
    curated: bool,
}

impl Shared {
    /// Read the library and the notebook, as a build reads them, when any
    /// private research file is stored.
    pub fn read(root: &Path, config: &openblog_core::SiteConfig) -> Self {
        let mut shared = Self {
            contributors: config.contributors.clone(),
            library: None,
            library_error: None,
            notebook: None,
            notebook_error: None,
            atlas: OnceCell::new(),
            alignments: OnceCell::new(),
            curated: config.curated_context.publish,
        };
        let any_research = reads_research(root, shared.curated);
        if !any_research {
            return shared;
        }
        match source_store::load_for_build(root, &shared.contributors) {
            Ok(snapshot) => shared.library = Some(snapshot.library),
            Err(error) => {
                shared.library_error = Some(error.to_string());
                return shared;
            }
        }
        if let Some(library) = shared.library.clone() {
            match notebook_store::read(root, library) {
                Ok(snapshot) => shared.notebook = Some(snapshot.notebook),
                Err(error) => shared.notebook_error = Some(error.to_string()),
            }
        }
        shared
    }

    fn both(&self) -> Option<(&SourceLibrary, &Notebook)> {
        Some((self.library.as_ref()?, self.notebook.as_ref()?))
    }

    /// The atlas, read once, or `None` when the library or notebook it is
    /// read against could not be, so the caller reads and reports it itself.
    fn atlas(&self, root: &Path) -> Option<&Result<atlas_store::Snapshot, String>> {
        let (library, notebook) = self.both()?;
        Some(self.atlas.get_or_init(|| {
            atlas_store::from_parts(root, library.clone(), notebook.clone())
                .map_err(|error| error.to_string())
        }))
    }

    /// The alignments, read once as a build reads them.
    fn alignments(&self, root: &Path) -> Option<&Result<alignment_store::Snapshot, String>> {
        let (library, notebook) = self.both()?;
        Some(self.alignments.get_or_init(|| {
            alignment_store::load_for_build_with(
                root,
                &self.contributors,
                library.clone(),
                notebook.clone(),
            )
        }))
    }
}

/// The private research files, read on their own so one that cannot be read
/// is named and the others still explain what they withhold.
pub struct Stores<'a> {
    library: Option<&'a SourceLibrary>,
    notebook: Option<&'a Notebook>,
    atlas: Option<&'a openblog_core::knowledge_atlas::Atlas>,
    claims: Option<openblog_core::claims::ClaimSet>,
    alignments: Option<&'a alignment_store::Snapshot>,
    acknowledgements: Option<usize>,
    selections: Option<openblog_core::curated_selection::SelectionSet>,
    unavailable: Vec<Unavailable>,
}

fn stored(root: &Path, store: Store) -> bool {
    fs::symlink_metadata(root.join(store.file())).is_ok()
}

/// Whether any private research file that a build can read is stored. The
/// review acknowledgements are never read by a build, and the curated
/// selections only while the site publishes curated context.
fn reads_research(root: &Path, curated: bool) -> bool {
    Store::ALL.iter().any(|&store| match store {
        Store::Acknowledgements => false,
        Store::Selections => curated && stored(root, store),
        _ => stored(root, store),
    })
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().to_string()
}

impl<'a> Stores<'a> {
    /// Every private research file that is stored, over the research read
    /// once into `shared`. Nothing is written.
    pub fn read(root: &Path, shared: &'a Shared) -> Self {
        let mut unavailable = Vec::new();
        let mut fail = |store: Store, message: String| {
            unavailable.push(Unavailable {
                store,
                file: store.file(),
                message: first_line(&message),
            });
        };
        if let Some(error) = &shared.library_error {
            fail(Store::SourceLibrary, error.clone());
        }
        let library = shared.library.as_ref();
        let mut notebook = None;
        if library.is_some() && stored(root, Store::Notebook) {
            match (&shared.notebook, &shared.notebook_error) {
                (Some(read), _) => notebook = Some(read),
                (None, Some(error)) => fail(Store::Notebook, error.clone()),
                (None, None) => {}
            }
        }
        let ready = library.is_some() && (notebook.is_some() || !stored(root, Store::Notebook));
        let mut atlas = None;
        if ready && stored(root, Store::Atlas) {
            match shared.atlas(root) {
                Some(Ok(snapshot)) => atlas = Some(&snapshot.atlas),
                Some(Err(error)) => fail(Store::Atlas, error.clone()),
                None => {}
            }
        }
        let mut claims = None;
        if ready && stored(root, Store::Claims) {
            if let Some((library, notebook)) = shared.both() {
                match claims_store::from_parts(root, library.clone(), notebook.clone()) {
                    Ok(snapshot) => claims = Some(snapshot.claims),
                    Err(error) => fail(Store::Claims, error.to_string()),
                }
            }
        }
        let mut alignments = None;
        if ready && stored(root, Store::Alignments) {
            match shared.alignments(root) {
                Some(Ok(snapshot)) => alignments = Some(snapshot),
                Some(Err(error)) => fail(Store::Alignments, error.clone()),
                None => {}
            }
        }
        let mut acknowledgements = None;
        if stored(root, Store::Acknowledgements) {
            match research_review::load(root) {
                Ok(snapshot) => acknowledgements = Some(snapshot.set.acknowledgements.len()),
                Err(error) => fail(Store::Acknowledgements, error.to_string()),
            }
        }
        let mut selections = None;
        if shared.curated && stored(root, Store::Selections) {
            let parsed = read_capped(&root.join(Store::Selections.file()), MAX_GUARDED_FILE)
                .ok_or_else(|| "the file cannot be read".to_string())
                .and_then(|bytes| {
                    openblog_core::curated_selection::SelectionSet::parse(&String::from_utf8_lossy(
                        &bytes,
                    ))
                    .map_err(|problems| {
                        problems
                            .first()
                            .map(|problem| problem.message.clone())
                            .unwrap_or_default()
                    })
                });
            match parsed {
                Ok(set) => selections = Some(set),
                Err(message) => fail(Store::Selections, message),
            }
        }
        Self {
            library,
            notebook,
            atlas,
            claims,
            alignments,
            acknowledgements,
            selections,
            unavailable,
        }
    }
}

/// What the research projections attached to `site` publish, and why
/// everything else is withheld: for the whole site, or for one post.
pub fn manifest(
    site: &Site,
    stores: &Stores<'_>,
    blocked: &Blocked,
    post: Option<&Post>,
) -> BoundaryManifest {
    let contributors = &site.config.contributors;
    let stale = stores.alignments.map(|snapshot| {
        stale_approvals(
            &snapshot.alignments,
            ComparisonInputs {
                library: &snapshot.library,
                notebook: &snapshot.notebook,
                contributors,
            },
        )
    });
    // Selections resolve against what the build publishes, never against
    // the private files; those only tell a deleted item from an unapproved one.
    let owned = CurationBasis::of(site, stores);
    let resolution = stores
        .selections
        .as_ref()
        .map(|set| openblog_core::curated_selection::resolve(set, &owned.basis(site, stores)));
    let curation = stores
        .selections
        .as_ref()
        .zip(resolution.as_ref())
        .map(
            |(set, resolution)| openblog_core::publication_boundary::CurationInput {
                set,
                resolution,
            },
        );
    let base_path = site.config.base_path();
    let inputs = BoundaryInputs {
        switches: Switches::of(&site.config),
        posts: &site.posts,
        public_atlas: site.atlas.as_ref(),
        atlas_blocked: blocked.atlas.as_deref(),
        public_comparisons: site.comparisons.as_ref(),
        comparisons_blocked: blocked.comparisons.as_deref(),
        public_paths: site.reading_paths.as_ref(),
        public_interpretations: site.interpretations.as_ref(),
        claims_blocked: blocked.claims.as_deref(),
        library: stores.library,
        notebook: stores.notebook,
        atlas: stores.atlas,
        claims: stores.claims.as_ref(),
        alignments: stores.alignments.map(|snapshot| &snapshot.alignments),
        stale_comparisons: stale.as_ref(),
        acknowledgements: stores.acknowledgements,
        curation: curation.as_ref(),
        unavailable: &stores.unavailable,
        author: &site.config.author.name,
        base_path: &base_path,
    };
    match post {
        Some(post) => BoundaryManifest::post(&inputs, post),
        None => BoundaryManifest::site(&inputs),
    }
}

/// The values selections are resolved against that are computed from the
/// site and the stores rather than held by them: which private items exist,
/// which sources are already public, and which posts the build publishes.
pub struct CurationBasis {
    existing: openblog_core::curated_selection::Existing,
    public_sources: BTreeSet<String>,
    posts: BTreeSet<String>,
}

impl CurationBasis {
    pub fn of(site: &Site, stores: &Stores<'_>) -> Self {
        Self {
            existing: openblog_core::curated_selection::Existing::of(
                stores.atlas,
                stores.alignments.map(|snapshot| &snapshot.alignments),
            ),
            public_sources: public_sources(site),
            posts: site.posts.iter().map(|p| p.slug.clone()).collect(),
        }
    }

    /// Add one post to the published set, for a preview that shows what its
    /// readers get once it is published. Returns whether it was not already
    /// published. The build never does this.
    pub fn assume_published(&mut self, slug: &str) -> bool {
        self.posts.insert(slug.to_string())
    }

    /// The basis a selection is resolved or selected against: only what the
    /// build publishes (the projections attached to `site`, the source
    /// library's public descriptions) and the ids that tell a deleted item
    /// from an unapproved one.
    pub fn basis<'a>(
        &'a self,
        site: &'a Site,
        stores: &'a Stores<'_>,
    ) -> openblog_core::curated_selection::Basis<'a> {
        openblog_core::curated_selection::Basis {
            atlas: site.atlas.as_ref(),
            comparisons: site.comparisons.as_ref(),
            library: stores.library,
            existing: Some(&self.existing),
            public_sources: Some(&self.public_sources),
            posts: Some(&self.posts),
        }
    }
}

/// The sources that are already public: cited by a published post, or
/// published by the atlas or a comparison. A curated reference or source
/// annotation may select only these.
pub fn public_sources(site: &Site) -> BTreeSet<String> {
    let mut sources: BTreeSet<String> = site
        .posts
        .iter()
        .filter_map(|post| post.citations())
        .flat_map(|summary| summary.references.iter().map(|r| r.key.clone()))
        .collect();
    if let Some(atlas) = &site.atlas {
        sources.extend(atlas.sources.iter().map(|s| s.reference.key.clone()));
    }
    if let Some(comparisons) = &site.comparisons {
        sources.extend(comparisons.sources.iter().map(|s| s.reference.key.clone()));
    }
    sources
}

/// Why the curated selections cannot be published, when the site publishes
/// them and the file cannot be read: a full build or `check` refuses, as for
/// a damaged claims file, so a build never silently drops the author's
/// curation. An Admin save or preview is not stopped by it.
pub fn selections_error(site: &Site, stores: &Stores<'_>) -> Option<String> {
    if !site.config.curated_context.publish {
        return None;
    }
    stores
        .unavailable
        .iter()
        .find(|item| item.store == Store::Selections)
        .map(|item| {
            format!(
                "refusing to build: the curated selections cannot be read ({}). Repair {} or turn `curatedContext.publish` off. Nothing was written.",
                item.message,
                Store::Selections.file()
            )
        })
}

/// Attach the public curated value to `site` exactly as a build does, while
/// the site publishes curated context, so a portable export or a syndicated
/// copy carries the research context (ADR 0202). Nothing but the value the
/// build lists is attached, and nothing is written. A selections file that
/// cannot be read refuses, as a build does, rather than leaving the author's
/// curation out of a copy that looks complete. With the switch off nothing is
/// read at all.
pub fn attach_public_curation(root: &Path, site: &mut Site) -> Result<(), String> {
    if !site.config.curated_context.publish {
        return Ok(());
    }
    let shared = Shared::read(root, &site.config);
    project_with(root, site, &shared);
    let stores = Stores::read(root, &shared);
    match selections_error(site, &stores) {
        Some(error) => Err(error
            .replace("refusing to build", "refusing to export")
            .replace("Nothing was written", "No file was written")),
        None => Ok(()),
    }
}

/// The site-wide manifest a build of the saved files would publish, for the
/// Admin preview: the same load, projections and manifest as `generate_site`,
/// with a projection that cannot be built reported instead of refusing.
pub fn site_preview(root: &Path, site: &mut Site, shared: &Shared) -> BoundaryManifest {
    let blocked = project_with(root, site, shared);
    let stores = Stores::read(root, shared);
    manifest(site, &stores, &blocked, None)
}

fn read_capped(path: &Path, cap: u64) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > cap {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(cap)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}

/// How much of a file is read to tell text from binary.
const SNIFF_BYTES: usize = 8 * 1024;

/// Whether the start of a file reads as text: no NUL byte and valid UTF-8
/// (a character the sniff cut in two does not count against it).
fn looks_like_text(head: &[u8]) -> bool {
    if head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none() && head.len() >= SNIFF_BYTES,
    }
}

fn allow_file(guard: &mut PrivateText, path: &Path) {
    if let Some(bytes) = read_capped(path, MAX_ALLOWED_FILE) {
        guard.allow_output(&String::from_utf8_lossy(&bytes));
    }
}

/// The front-matter fields a build renders as text, whichever name the author
/// gave them.
const RENDERED_FIELDS: &[&str] = &[
    "title",
    "name",
    "subtitle",
    "subheading",
    "dek",
    "description",
    "summary",
    "brief",
    "excerpt",
    "coverAlt",
    "imageAlt",
    "cover_alt",
    "series",
    "tags",
    "categories",
    "canonical",
    "canonicalUrl",
    "canonical_url",
    "sourceUrl",
    "source_url",
    "hashnodeUrl",
    "originalUrl",
];

/// Allow what a content file publishes: its body and the front-matter fields
/// the build renders, read as the build reads them. A field the build does
/// not render (an author's private memo kept in the front matter) is not
/// public input, and does not make text public that it happens to hold.
fn allow_source(guard: &mut PrivateText, path: &Path) {
    let Some(bytes) = read_capped(path, MAX_ALLOWED_FILE) else {
        return;
    };
    let source = String::from_utf8_lossy(&bytes);
    let Ok(document) = openblog_core::frontmatter::parse(&source) else {
        return;
    };
    guard.allow_text(&document.body);
    for field in RENDERED_FIELDS {
        match document.front_matter.fields.get(*field) {
            Some(openblog_core::frontmatter::Value::Scalar(text)) => guard.allow_text(text),
            Some(openblog_core::frontmatter::Value::List(items)) => {
                for item in items {
                    guard.allow_text(item);
                }
            }
            None => {}
        }
    }
}

/// The guard for this site: every private research file's text, less what
/// THIS build publishes (ADR 0125): the text of the published posts and
/// pages, the published reader feedback file, the site's own configuration,
/// the approved projections and the descriptions of the sources they publish.
/// Drafts, held-back posts, other content files and the static and theme
/// files are not public input: the static and theme files are copied out, so
/// they are scanned like any other output. `pages` lists the generated pages,
/// whose own addresses a note may paste.
fn guard(root: &Path, site: &Site, pages: &[&str]) -> PrivateText {
    let mut guard = PrivateText::new();
    for store in Store::ALL {
        if let Some(bytes) = read_capped(&root.join(store.file()), MAX_GUARDED_FILE) {
            guard.add_file(store, &bytes);
        }
    }
    if guard.is_empty() {
        return guard;
    }
    let config = &site.config;
    // The author's own configuration: the site's title, navigation, authors.
    allow_file(&mut guard, &root.join("openblog.json"));
    let content = root.join(&config.paths.content);
    allow_file(
        &mut guard,
        &content.join(openblog_core::feedback_publication::READER_FEEDBACK_FILE),
    );
    // The published posts, as written and as rendered.
    for post in &site.posts {
        for text in [
            post.title.as_str(),
            post.description.as_str(),
            post.cover_alt.as_str(),
            post.text.as_str(),
            post.publication_markdown(),
        ] {
            guard.allow_text(text);
        }
        if let Some(subtitle) = &post.subtitle {
            guard.allow_text(subtitle);
        }
        guard.allow_output(&post.html);
        for tag in &post.tags {
            guard.allow_text(&tag.name);
        }
        if let Some(attribution) = &post.shared_attribution {
            if let Some(question) = &attribution.question {
                guard.allow_text(question);
            }
            if let Some(source) = &attribution.source {
                guard.allow_text(&source.title);
            }
        }
        allow_source(&mut guard, &content.join(&post.source));
        // A source's public description is the citation allowlist (ADR 0044),
        // published with the post that cites it.
        if let Some(citations) = post.citations() {
            for reference in &citations.references {
                allow_reference(&mut guard, reference);
            }
        }
        // The theme sets these strings side by side (table of contents,
        // series list, related posts): cut the output at their edges.
        guard.cut_at(&post.title);
        if let Some(subtitle) = &post.subtitle {
            guard.cut_at(subtitle);
        }
        for heading in &post.headings {
            guard.cut_at(&heading.text);
        }
        for tag in &post.tags {
            guard.cut_at(&tag.name);
        }
    }
    // The site's own addresses, which every page, feed and sitemap repeats:
    // a note that merely pastes a link to a public page is not a leak.
    let base = config.url.trim_end_matches('/');
    for url in site
        .posts
        .iter()
        .map(|post| &post.url)
        .chain(site.pages.iter().map(|page| &page.url))
        .chain(site.tags.iter().map(|tag| &tag.url))
        .chain(site.series.iter().map(|series| &series.url))
    {
        guard.allow_text(&format!("{base}{url}"));
    }
    // And the address of every page the build generates: atlas, comparisons,
    // archive, feeds, pagination.
    for path in pages {
        for url in generated_urls(path) {
            guard.allow_text(&format!("{base}{url}"));
        }
    }
    for page in &site.pages {
        guard.allow_text(&page.title);
        guard.allow_text(&page.description);
        guard.allow_text(&page.text);
        guard.allow_output(&page.html);
        allow_source(&mut guard, &content.join(&page.source));
        guard.cut_at(&page.title);
        for heading in &page.headings {
            guard.cut_at(&heading.text);
        }
    }
    for series in &site.series {
        guard.allow_text(&series.name);
        guard.allow_text(&series.description_text);
        guard.allow_output(&series.description_html);
        if let Some(source) = &series.source {
            allow_source(&mut guard, &content.join(source));
        }
        guard.cut_at(&series.name);
        for heading in openblog_core::shingles::headings(&series.description_html) {
            guard.cut_at(&heading);
        }
    }
    for tag in &site.tags {
        guard.allow_text(&tag.name);
        guard.cut_at(&tag.name);
    }
    for link in config.nav.iter().chain(&config.social) {
        guard.cut_at(&link.label);
    }
    // Approved projections, as the build renders them.
    if let Some(atlas) = &site.atlas {
        guard.allow_output(&atlas.to_json());
    }
    if let Some(comparisons) = &site.comparisons {
        guard.allow_output(&comparisons.to_json());
    }
    guard.allow_output(
        &openblog_core::claim_publication::PublicClaimEvidence::of(&site.posts).to_json(),
    );
    // The curated context as the build renders it, and nothing else of the
    // selections file: the words of a selection the build publishes (its
    // content, the author's attributed comment, the context it brings) are
    // public where the pages and curated-context.json carry them. A withheld,
    // stale, withdrawn or unselected one is not in this value, so its text
    // (and any other private store's) is still found wherever it appears.
    if let Some(curation) = &site.curation {
        if let Ok(json) = serde_json::to_string(curation) {
            guard.allow_output(&json);
        }
    }
    guard
}

/// The addresses a generated file is served at: `index.html` is its folder.
fn generated_urls(path: &str) -> Vec<String> {
    let mut urls = vec![format!("/{path}")];
    if let Some(folder) = path.strip_suffix("index.html") {
        urls.push(format!("/{folder}"));
        let bare = folder.trim_end_matches('/');
        if !bare.is_empty() {
            urls.push(format!("/{bare}"));
        }
    }
    urls
}

fn allow_reference(guard: &mut PrivateText, reference: &openblog_core::citations::PublicReference) {
    if let Ok(json) = serde_json::to_string(reference) {
        guard.allow_output(&json);
    }
    guard.allow_text(&openblog_core::citations::format_reference(reference));
}

/// The static, theme and front-end asset files a build copies out, as
/// `(output path, bytes)`: the files the guard scans because nothing allows
/// their text, and a notice for each text file too large to scan. A file is
/// text when its first 8 KiB hold no NUL byte and are valid UTF-8, whatever
/// its extension (`.bib`, `.ris`, `.vtt`, `.tex`, `CNAME`).
struct Copied {
    files: Vec<(String, Vec<u8>)>,
    notices: Vec<String>,
}

fn copied_files(root: &Path, config: &openblog_core::SiteConfig) -> Copied {
    let private = fsutil::PrivateState::of(root);
    let mut copied = Copied {
        files: Vec::new(),
        notices: Vec::new(),
    };
    let mut take = |output: String, file: &Path| {
        let Ok(metadata) = fs::symlink_metadata(file) else {
            return;
        };
        if !metadata.is_file() {
            return;
        }
        let mut head = Vec::with_capacity(SNIFF_BYTES);
        let Ok(opened) = fs::File::open(file) else {
            return;
        };
        if opened
            .take(SNIFF_BYTES as u64)
            .read_to_end(&mut head)
            .is_err()
            || !looks_like_text(&head)
        {
            return;
        }
        if metadata.len() > MAX_ALLOWED_FILE {
            copied.notices.push(format!(
                "boundary: `{output}` is a text file larger than {} MiB, so it was not scanned for text from private research. Check it yourself, or keep it small enough to scan.",
                MAX_ALLOWED_FILE / (1024 * 1024)
            ));
        } else if let Some(bytes) = read_capped(file, MAX_ALLOWED_FILE) {
            copied.files.push((output, bytes));
        }
    };
    for (dir, prefix) in [
        (&config.paths.static_dir, ""),
        (&config.paths.themes, "themes/"),
    ] {
        let base = root.join(dir);
        for file in fsutil::walk(&base) {
            if private.contains(&file) {
                continue;
            }
            take(format!("{prefix}{}", fsutil::relative(&base, &file)), &file);
        }
    }
    // The site's own front-end assets, which a build writes under `assets/`.
    let web = root.join(&config.paths.web);
    for rel in crate::site::web_dir_assets(root, config) {
        take(format!("assets/{rel}"), &web.join(&rel));
    }
    copied
}

fn ids_at(value: &Value, list: &str) -> Vec<String> {
    value[list]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str().map(str::to_string))
        .collect()
}

/// Items a public artifact or page names that the manifest does not publish.
fn unlisted(manifest: &BoundaryManifest, site: &Site, files: &[OutputFile]) -> Vec<String> {
    let mut problems = Vec::new();
    let atlas_entries = manifest.published_ids(Projection::Atlas, ItemKind::Entry);
    let relationships = manifest.published_ids(Projection::Atlas, ItemKind::Relationship);
    let datings = manifest.published_ids(Projection::Datings, ItemKind::Dating);
    let query_entries = manifest.published_ids(Projection::AtlasQuery, ItemKind::Entry);
    let query_edges = manifest.published_ids(Projection::AtlasQuery, ItemKind::Relationship);
    let query_sources = manifest.published_ids(Projection::AtlasQuery, ItemKind::Source);
    let comparisons = manifest.published_ids(Projection::Comparisons, ItemKind::Comparison);
    let claims = manifest.published_ids(Projection::ClaimEvidence, ItemKind::Claim);
    let selections = manifest.published_ids(Projection::Curated, ItemKind::Selection);
    let curated_entries = manifest.published_ids(Projection::Curated, ItemKind::Entry);
    let curated_edges = manifest.published_ids(Projection::Curated, ItemKind::Relationship);
    let curated_sources = manifest.published_ids(Projection::Curated, ItemKind::Source);
    let file_listed = manifest.published_ids(Projection::CuratedContext, ItemKind::CuratedContext);
    let paths = manifest.published_ids(Projection::ReadingPaths, ItemKind::Path);
    let interpretations =
        manifest.published_ids(Projection::Interpretations, ItemKind::Interpretation);
    let post_slugs: BTreeSet<&str> = site.posts.iter().map(|post| post.slug.as_str()).collect();
    // A post's address as the file carries it: the base path in front.
    let base_path = site.config.base_path();
    let post_url_strings: Vec<String> = site
        .posts
        .iter()
        .flat_map(|post| {
            [
                post.url.clone(),
                format!("{}{}", base_path.trim_end_matches('/'), post.url),
            ]
        })
        .collect();
    let post_urls: BTreeSet<&str> = post_url_strings.iter().map(String::as_str).collect();
    let mut check = |file: &str, kind: &str, id: &str, known: &BTreeSet<&str>| {
        if !known.contains(id) {
            problems.push(format!(
                "`{file}` names the {kind} `{id}`, which no approved projection publishes"
            ));
        }
    };
    for file in files {
        let segments: Vec<&str> = file.path.split('/').collect();
        if let [segment, id, name] = segments.as_slice() {
            let page = *name == "index.html";
            // The static copies of a comparison's explanation levels sit beside
            // its page and name the same comparison (ADR 0236).
            let portable = matches!(*name, "portable.html" | "portable.md" | "portable.txt");
            if *segment == "atlas" && page && site.atlas.is_some() {
                check(&file.path, "atlas entry", id, &atlas_entries);
            }
            if *segment == openblog_core::comparison_publication::COMPARISONS_SEGMENT
                && page
                && site.comparisons.is_some()
            {
                check(&file.path, "comparison", id, &comparisons);
            }
            if *segment == openblog_core::interpretation_publication::INTERPRETATIONS_SEGMENT
                && (page || portable)
                && site.interpretations.is_some()
            {
                check(
                    &file.path,
                    "interpretation comparison",
                    id,
                    &interpretations,
                );
            }
        }
        let json = || serde_json::from_str::<Value>(&file.contents).unwrap_or(Value::Null);
        if file.path == openblog_core::atlas_publication::ATLAS_JSON_FILE {
            let value = json();
            for id in ids_at(&value, "entries") {
                check(&file.path, "atlas entry", &id, &atlas_entries);
            }
            for id in ids_at(&value, "relationships") {
                check(&file.path, "relationship", &id, &relationships);
            }
            for id in ids_at(&value, "datings") {
                check(&file.path, "dating", &id, &datings);
            }
        } else if file.path == openblog_core::atlas_query::ATLAS_QUERY_JSON_FILE {
            // The query file may only name what both the atlas and the query
            // projection publish.
            let value = json();
            for id in ids_at(&value, "entries") {
                check(&file.path, "atlas entry", &id, &atlas_entries);
                check(&file.path, "atlas query entry", &id, &query_entries);
            }
            for id in ids_at(&value, "edges") {
                check(&file.path, "relationship", &id, &relationships);
                check(&file.path, "atlas query relationship", &id, &query_edges);
            }
            // Everything the file points at must be one of the items above,
            // not only the items it lists itself.
            for edge in value["edges"].as_array().into_iter().flatten() {
                for end in ["from", "to"] {
                    if let Some(id) = edge[end].as_str() {
                        check(&file.path, "atlas query entry", id, &query_entries);
                    }
                }
                for evidence in edge["evidence"].as_array().into_iter().flatten() {
                    if let Some(id) = evidence["source"].as_str() {
                        check(&file.path, "atlas query source", id, &query_sources);
                    }
                }
                if let Some(id) = edge["assertedBy"]["source"].as_str() {
                    check(&file.path, "atlas query source", id, &query_sources);
                }
            }
            for entry in value["entries"].as_array().into_iter().flatten() {
                if let Some(id) = entry["source"].as_str() {
                    check(&file.path, "atlas query source", id, &query_sources);
                }
            }
            for term in value["terms"].as_array().into_iter().flatten() {
                for id in term["entries"].as_array().into_iter().flatten() {
                    if let Some(id) = id.as_str() {
                        check(&file.path, "atlas query entry", id, &query_entries);
                    }
                }
            }
            for id in ids_at(&value, "sources") {
                check(&file.path, "atlas query source", &id, &query_sources);
            }
        } else if file.path == openblog_core::reading_path::PATHS_JSON_FILE {
            // The paths file may only name paths the manifest publishes, over
            // posts this build publishes and public atlas entries.
            let value = json();
            for path in value["paths"].as_array().into_iter().flatten() {
                if let Some(slug) = path["slug"].as_str() {
                    check(&file.path, "reading path", slug, &paths);
                }
                for step in path["steps"].as_array().into_iter().flatten() {
                    let Some(target) = step["target"].as_str() else {
                        continue;
                    };
                    match step["kind"].as_str() {
                        Some("post") => check(&file.path, "published post", target, &post_slugs),
                        Some("atlas") => check(&file.path, "atlas entry", target, &atlas_entries),
                        _ => check(&file.path, "step kind", "unknown", &BTreeSet::new()),
                    }
                }
            }
        } else if file.path == openblog_core::curated_context::CURATED_CONTEXT_JSON_FILE {
            // The curated context file may only name what the curated
            // projection publishes (and what its own projection publishes
            // beneath it), over the posts this build publishes.
            check(&file.path, "curated file", "curated-context", &file_listed);
            let value = json();
            for id in ids_at(&value, "items") {
                check(&file.path, "curated selection", &id, &selections);
            }
            // What an item points at: the posts it is scoped to, the posts
            // whose order it has a place in, and the items it requires.
            for item in value["items"].as_array().into_iter().flatten() {
                for slug in item["posts"].as_array().into_iter().flatten() {
                    if let Some(slug) = slug.as_str() {
                        check(&file.path, "published post", slug, &post_slugs);
                    }
                }
                for slug in item["positions"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(slug, _)| slug)
                {
                    check(&file.path, "published post", slug, &post_slugs);
                }
                for id in item["requires"].as_array().into_iter().flatten() {
                    if let Some(id) = id.as_str() {
                        check(&file.path, "curated selection", id, &selections);
                    }
                }
            }
            for context in value["context"].as_array().into_iter().flatten() {
                for id in context["via"].as_array().into_iter().flatten() {
                    if let Some(id) = id.as_str() {
                        check(&file.path, "curated selection", id, &selections);
                    }
                }
                let Some(id) = context["id"].as_str() else {
                    continue;
                };
                match context["kind"].as_str() {
                    Some("entry") => {
                        check(&file.path, "curated entry", id, &curated_entries);
                        check(&file.path, "atlas entry", id, &atlas_entries);
                    }
                    Some("relationship") => {
                        check(&file.path, "curated relationship", id, &curated_edges);
                        check(&file.path, "relationship", id, &relationships);
                    }
                    Some("source") => check(&file.path, "curated source", id, &curated_sources),
                    _ => check(
                        &file.path,
                        "context of a kind no projection publishes",
                        id,
                        &BTreeSet::new(),
                    ),
                }
            }
            for post in value["posts"].as_array().into_iter().flatten() {
                if let Some(slug) = post["post"].as_str() {
                    check(&file.path, "published post", slug, &post_slugs);
                }
                // The address of a post and of each item's anchor on it must
                // be a published post's address and that item's own fragment.
                if let Some(url) = post["url"].as_str() {
                    check(&file.path, "post address", url, &post_urls);
                }
                for item in post["items"].as_array().into_iter().flatten() {
                    if let Some(id) = item["id"].as_str() {
                        check(&file.path, "curated selection", id, &selections);
                    }
                    if let Some(url) = item["url"].as_str() {
                        let (page, fragment) = url.split_once('#').unwrap_or((url, ""));
                        check(&file.path, "post address", page, &post_urls);
                        let expected: Vec<String> = item["id"]
                            .as_str()
                            .map(|id| {
                                format!("{}{id}", openblog_core::curated_context::ANCHOR_PREFIX)
                            })
                            .into_iter()
                            .collect();
                        let expected: BTreeSet<&str> =
                            expected.iter().map(String::as_str).collect();
                        check(&file.path, "item anchor", fragment, &expected);
                    }
                }
            }
        } else if file.path == openblog_core::comparison_publication::COMPARISONS_JSON_FILE {
            for id in ids_at(&json(), "comparisons") {
                check(&file.path, "comparison", &id, &comparisons);
            }
        } else if file.path == openblog_core::claim_publication::CLAIM_EVIDENCE_JSON_FILE {
            let value = json();
            for post in value["posts"].as_array().into_iter().flatten() {
                for id in ids_at(post, "claims") {
                    check(&file.path, "claim", &id, &claims);
                }
            }
        }
    }
    problems
}

/// What the text guard found in a build's outputs.
#[derive(Debug, Default)]
pub struct TextCheck {
    /// Private text inside the machine-data outputs the build generates from
    /// the projections: the build refuses.
    pub refusals: Vec<Leak>,
    /// `boundary:` warnings for private text elsewhere, and for text files too
    /// large to scan: the build goes on.
    pub warnings: Vec<String>,
}

/// The generated machine-data outputs of the projections, which carry only
/// what a projection approved: the atlas, comparison and claim-evidence JSON.
fn projection_data(path: &str) -> bool {
    [
        openblog_core::atlas_publication::ATLAS_JSON_FILE,
        openblog_core::atlas_query::ATLAS_QUERY_JSON_FILE,
        openblog_core::comparison_publication::COMPARISONS_JSON_FILE,
        openblog_core::claim_publication::CLAIM_EVIDENCE_JSON_FILE,
        openblog_core::curated_context::CURATED_CONTEXT_JSON_FILE,
    ]
    .contains(&path)
}

/// A page's reader reference data (`<script type="application/json"
/// id="ob-references">`), when it has any, and the page without it.
fn split_reference_data(page: &str) -> (Option<&str>, String) {
    let marker = format!(
        "id=\"{}\">",
        openblog_core::reader_references::READER_REFERENCES_ELEMENT_ID
    );
    let Some(at) = page.find(&marker) else {
        return (None, page.to_string());
    };
    let from = at + marker.len();
    let Some(length) = page[from..].find("</script>") else {
        return (None, page.to_string());
    };
    let data = &page[from..from + length];
    let rest = format!("{}{}", &page[..from], &page[from + length..]);
    (Some(data), rest)
}

/// Scan generated and copied files (ADR 0125). Private text in a projection's
/// machine data (the atlas, comparisons and claim-evidence JSON, and a page's
/// reader reference data), read field by field, is a refusal. Everywhere else
/// (pages, feeds, search, llms, static, theme and front-end files) a match is
/// a text comparison against what the author placed or wrote, so it is a
/// warning naming the output, the file, the record and the field.
fn scan_text(root: &Path, site: &Site, files: &[OutputFile]) -> TextCheck {
    let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    let guard = guard(root, site, &paths);
    let mut check = TextCheck::default();
    if guard.is_empty() {
        return check;
    }
    let mut warn = |leaks: Vec<Leak>| {
        for leak in leaks {
            check.warnings.push(format!(
                "boundary: {leak}. The text is in a public file you placed or wrote (a post, a page, a static or theme file, a template or the configuration): remove it there, or keep it if it is meant to be public. The build is not stopped, and a note or passage is never published by itself."
            ));
        }
    };
    let mut refused = Vec::new();
    let mut warned = Vec::new();
    for file in files {
        let path = file.path.as_str();
        if projection_data(path) {
            refused.extend(guard.find_all(path, file.contents.as_bytes(), NAMED_LEAKS));
            continue;
        }
        let (data, rest) = if path.ends_with(".html") {
            split_reference_data(&file.contents)
        } else {
            (None, file.contents.clone())
        };
        if let Some(data) = data {
            refused.extend(guard.find_all(path, data.as_bytes(), NAMED_LEAKS));
        }
        warned.extend(guard.find_all(path, rest.as_bytes(), NAMED_LEAKS));
    }
    let copied = copied_files(root, &site.config);
    for (path, bytes) in &copied.files {
        warned.extend(guard.find_all(path, bytes, NAMED_LEAKS));
    }
    warn(warned);
    check.refusals = refused;
    check.warnings.extend(copied.notices);
    check.warnings.sort();
    check.warnings.dedup();
    check
}

/// The build's last boundary check, before anything is written: refuse when
/// generated output names an item no approved projection publishes, or a
/// projection's machine data carries text from a private research file that no
/// approved projection holds. Returns the `boundary:` warnings for private
/// text found anywhere else.
pub fn check_output(
    root: &Path,
    site: &Site,
    manifest: &BoundaryManifest,
    files: &[OutputFile],
) -> Result<Vec<String>, String> {
    let problems = unlisted(manifest, site, files);
    if !problems.is_empty() {
        return Err(format!(
            "refusing to build: {}. Nothing was written.",
            problems.join("; ")
        ));
    }
    let check = scan_text(root, site, files);
    if !check.refusals.is_empty() {
        return Err(leak_refusal(&check.refusals));
    }
    Ok(check.warnings)
}

/// What the Admin preview adds to the manifest: the `boundary:` warnings a
/// build of the saved files would print for text matches, and the refusal it
/// would make, if any. Nothing is generated for a site without private
/// research.
pub fn preview_text(
    root: &Path,
    site: &Site,
    themes: &openblog_core::theme::ThemeSet,
) -> (Vec<String>, Option<String>) {
    if !reads_research(root, site.config.curated_context.publish) {
        return (Vec::new(), None);
    }
    let Ok(files) = openblog_core::render::generate(site, themes) else {
        return (Vec::new(), None);
    };
    let check = scan_text(root, site, &files);
    let refusal = (!check.refusals.is_empty()).then(|| leak_refusal(&check.refusals));
    (check.warnings, refusal)
}

fn leak_refusal(leaks: &[Leak]) -> String {
    let named: Vec<String> = leaks
        .iter()
        .take(NAMED_LEAKS)
        .map(ToString::to_string)
        .collect();
    let more = leaks.len().saturating_sub(NAMED_LEAKS);
    format!(
        "refusing to build: private research would be published: {}{}. That text appears in machine data a projection generates (the atlas, comparisons or claim-evidence JSON, or a page's reference data) but no approved projection holds it, so nothing was written. Approve the item through its projection, or take the text out of the record that carries it. A note or passage is never published by itself.",
        named.join("; "),
        if more > 0 {
            format!(" and {more} more")
        } else {
            String::new()
        }
    )
}

/// The same text guard for a portable export of one post. A bibliography
/// export is reference data, so private text in it refuses; any other export
/// (the post's Markdown or HTML) only warns. Returns the warnings.
pub fn check_export(
    root: &Path,
    site: &Site,
    path: &str,
    text: &str,
    reference_data: bool,
) -> Result<Vec<String>, String> {
    let guard = guard(root, site, &[]);
    let leaks = guard.find_all(path, text.as_bytes(), NAMED_LEAKS);
    if leaks.is_empty() {
        return Ok(Vec::new());
    }
    if reference_data {
        return Err(leak_refusal(&leaks)
            .replace("refusing to build", "refusing to export")
            .replace("nothing was written", "no file was written"));
    }
    Ok(leaks
        .into_iter()
        .map(|leak| {
            format!(
                "boundary: {leak}. The text is in the post you are exporting, which you wrote: remove it there, or keep it if it is meant to be public. The export is not stopped."
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const NOTE: &str = "A private reading of the allegory that only the author has seen";

    fn project_with_note(tag: &str, config: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("openblog-boundary-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        crate::scaffold::init(&root, Some("Guard"), false).unwrap();
        if !config.is_empty() {
            let path = root.join("openblog.json");
            let mut value: Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            for (key, item) in
                serde_json::from_str::<serde_json::Map<String, Value>>(config).unwrap()
            {
                value[key] = item;
            }
            fs::write(&path, value.to_string()).unwrap();
        }
        let research = root.join(".openblog/private/research");
        fs::create_dir_all(&research).unwrap();
        fs::write(
            research.join("sources.json"),
            r#"{"version":1,"sources":[{"id":"plato","kind":"work","title":"Politeia"}]}"#,
        )
        .unwrap();
        fs::write(
            research.join("notebook.json"),
            format!(r#"{{"version":1,"passages":[],"notes":[{{"id":"n1","kind":"observation","text":"{NOTE}"}}]}}"#),
        )
        .unwrap();
        fs::write(
            research.join("atlas.json"),
            r#"{"version":2,"entries":[{"id":"plato-person","kind":"person","label":"Plato","visibility":"approved"},{"id":"secret","kind":"concept","label":"Secret"}],"relationships":[]}"#,
        )
        .unwrap();
        root
    }

    fn checked(root: &Path, files: &[OutputFile]) -> Result<Vec<String>, String> {
        let (mut site, _) = crate::site::load_site(root, false, None).unwrap();
        let shared = Shared::read(root, &site.config);
        let blocked = project_with(root, &mut site, &shared);
        let stores = Stores::read(root, &shared);
        let manifest = manifest(&site, &stores, &blocked, None);
        check_output(root, &site, &manifest, files)
    }

    fn page(path: &str, contents: &str) -> OutputFile {
        OutputFile {
            path: path.into(),
            contents: contents.into(),
        }
    }

    #[test]
    fn an_interpretation_page_may_only_be_one_the_manifest_publishes() {
        let root = project_with_note(
            "interpretation-pages",
            r#"{"interpretations":{"publish":true}}"#,
        );
        fs::create_dir_all(root.join("content/comparisons")).unwrap();
        let comparison = |status: &str| {
            serde_json::json!({
                "format": "openblog-interpretation-comparison", "version": 1,
                "title": "The cave", "subject": "Readings.", "status": status,
                "interpretations": [
                    {"id": "a", "attribution": {"kind": "named", "name": "A school"}, "statement": "A city."},
                    {"id": "b", "attribution": {"kind": "named", "name": "Another"}, "statement": "A mind."}]})
            .to_string()
        };
        fs::write(
            root.join("content/comparisons/cave.json"),
            comparison("published"),
        )
        .unwrap();
        fs::write(
            root.join("content/comparisons/draft.json"),
            comparison("draft"),
        )
        .unwrap();

        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let preview = site_preview(&root, &mut site, &shared);
        let published =
            preview.published_ids(Projection::Interpretations, ItemKind::Interpretation);
        assert_eq!(published, BTreeSet::from(["cave"]));
        assert_eq!(
            Projection::Interpretations.switch(),
            "interpretations.publish"
        );

        // A page for the published comparison passes; one for a draft is refused.
        assert!(checked(
            &root,
            &[page("interpretations/cave/index.html", "<p>x</p>")]
        )
        .is_ok());
        let error = checked(
            &root,
            &[page("interpretations/draft/index.html", "<p>x</p>")],
        )
        .unwrap_err();
        assert!(
            error.contains("interpretation comparison `draft`"),
            "{error}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_paths_file_may_only_name_published_paths_and_published_targets() {
        let root = project_with_note("paths-file", r#"{"readingPaths":{"publish":true}}"#);
        let named = |slug: &str, kind: &str, target: &str| {
            page(
                "paths.json",
                &serde_json::json!({"paths":[{"slug": slug, "steps":[{"kind": kind, "target": target}]}]})
                    .to_string(),
            )
        };
        // No path is published by this site, so any path the file names is refused.
        let error = checked(&root, &[named("ghost", "post", "ghost-post")]).unwrap_err();
        assert!(
            error.contains("`paths.json`") && error.contains("reading path `ghost`"),
            "{error}"
        );
        assert!(error.contains("published post `ghost-post`"), "{error}");
        let error = checked(&root, &[named("ghost", "atlas", "nobody")]).unwrap_err();
        assert!(error.contains("atlas entry `nobody`"), "{error}");
        assert!(checked(&root, &[page("paths.json", r#"{"paths":[]}"#)]).is_ok());
    }

    #[test]
    fn private_text_in_a_projection_data_file_refuses_the_build_naming_where_it_came_from() {
        let root = project_with_note("leak", r#"{"knowledgeAtlas":{"publish":true}}"#);
        let leaked = page(
            "atlas.json",
            &serde_json::json!({"entries":[{"id":"plato-person","label":format!("A PRIVATE reading of the allegory that only the author, {NOTE}")}]})
                .to_string(),
        );
        let error =
            checked(&root, &[page("index.html", "<p>Hello</p>"), leaked.clone()]).unwrap_err();
        for expected in [
            "refusing to build",
            "`atlas.json`",
            "the research notebook",
            ".openblog/private/research/notebook.json",
            "`n1`",
            "field `text`",
            "nothing was written",
        ] {
            assert!(error.contains(expected), "{expected}: {error}");
        }
        assert!(!error.to_lowercase().contains("allegory"), "{error}");
        // A reference data block on a page is machine data too.
        let page_with_data = page(
            "posts/a/index.html",
            &format!(
                "<p>Fine</p><script type=\"application/json\" id=\"ob-references\">{}</script>",
                serde_json::json!({"references":[{"title":NOTE}]})
            ),
        );
        let error = checked(&root, &[page_with_data]).unwrap_err();
        assert!(error.contains("`posts/a/index.html`"), "{error}");

        // The same words in a post are the author's own public text.
        fs::write(
            root.join("content/posts/2026-01-07-reading.md"),
            format!(
                "---
title: Reading
date: 2026-01-07
---

{NOTE}.
"
            ),
        )
        .unwrap();
        assert_eq!(checked(&root, &[leaked]), Ok(Vec::new()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn private_text_in_a_page_warns_naming_the_output_the_file_the_record_and_the_field() {
        let root = project_with_note("warn", "");
        let leaked = page(
            "about/index.html",
            "<p>&ldquo;A PRIVATE reading of the allegory that only the author&rdquo;</p>",
        );
        let warnings = checked(&root, &[page("index.html", "<p>Hello</p>"), leaked.clone()])
            .expect("a page only warns");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        let said = &warnings[0];
        for expected in [
            "boundary: ",
            "`about/index.html`",
            "the research notebook",
            ".openblog/private/research/notebook.json",
            "`n1`",
            "field `text`",
            "remove it there, or keep it",
        ] {
            assert!(said.contains(expected), "{expected}: {said}");
        }
        assert!(!said.to_lowercase().contains("allegory"), "{said}");
        // The same words in a post are the author's own public text.
        fs::write(
            root.join("content/posts/2026-01-07-reading.md"),
            format!(
                "---
title: Reading
date: 2026-01-07
---

{NOTE}.
"
            ),
        )
        .unwrap();
        assert_eq!(checked(&root, &[leaked]), Ok(Vec::new()));
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn a_page_or_artifact_for_an_unpublished_item_refuses_the_build() {
        let root = project_with_note("unlisted", r#"{"knowledgeAtlas":{"publish":true}}"#);
        assert_eq!(
            checked(
                &root,
                &[page("atlas/plato-person/index.html", "<p>Plato</p>")]
            ),
            Ok(Vec::new())
        );
        let error =
            checked(&root, &[page("atlas/secret/index.html", "<p>Secret</p>")]).unwrap_err();
        assert!(
            error.contains("`atlas/secret/index.html` names the atlas entry `secret`"),
            "{error}"
        );
        let error = checked(
            &root,
            &[page(
                "atlas.json",
                r#"{"entries":[{"id":"plato-person"},{"id":"secret"}]}"#,
            )],
        )
        .unwrap_err();
        assert!(
            error.contains("`atlas.json` names the atlas entry `secret`"),
            "{error}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_atlas_query_file_may_only_name_what_the_manifest_publishes() {
        let root = project_with_note("query-unlisted", r#"{"knowledgeAtlas":{"publish":true}}"#);
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let blocked = project_with(&root, &mut site, &shared);
        let stores = Stores::read(&root, &shared);
        let manifest = manifest(&site, &stores, &blocked, None);
        // The manifest lists what the query file publishes, by entry.
        assert_eq!(
            manifest.published_ids(Projection::AtlasQuery, ItemKind::Entry),
            std::collections::BTreeSet::from(["plato-person"])
        );
        let query = openblog_core::atlas_query::AtlasQuery::project(
            site.atlas.as_ref().unwrap(),
            &site.config.author.name,
            &site.config.base_path(),
        )
        .unwrap()
        .to_json();
        assert_eq!(
            check_output(&root, &site, &manifest, &[page("atlas-query.json", &query)]),
            Ok(Vec::new())
        );
        let error = check_output(
            &root,
            &site,
            &manifest,
            &[page(
                "atlas-query.json",
                r#"{"entries":[{"id":"plato-person"},{"id":"secret"}],"edges":[{"id":"r-hidden"}]}"#,
            )],
        )
        .unwrap_err();
        assert!(
            error.contains("`atlas-query.json` names the atlas entry `secret`")
                && error.contains("names the relationship `r-hidden`"),
            "{error}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_atlas_query_file_may_only_point_at_published_entries_and_sources() {
        let root = project_with_note("query-points", r#"{"knowledgeAtlas":{"publish":true}}"#);
        // A work whose own source is the only thing the file cites.
        fs::write(
            root.join(".openblog/private/research/atlas.json"),
            r#"{"version":2,"entries":[{"id":"republic","kind":"work","label":"Republic","source":"plato","visibility":"approved"}],"relationships":[]}"#,
        )
        .unwrap();
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let blocked = project_with(&root, &mut site, &shared);
        let stores = Stores::read(&root, &shared);
        let manifest = manifest(&site, &stores, &blocked, None);
        assert_eq!(
            manifest.published_ids(Projection::AtlasQuery, ItemKind::Source),
            std::collections::BTreeSet::from(["plato"]),
            "the report lists the sources the file cites"
        );
        let real = openblog_core::atlas_query::AtlasQuery::project(
            site.atlas.as_ref().unwrap(),
            &site.config.author.name,
            &site.config.base_path(),
        )
        .unwrap()
        .to_json();
        assert!(real.contains(r#""source":"plato""#), "{real}");
        assert_eq!(
            check_output(&root, &site, &manifest, &[page("atlas-query.json", &real)]),
            Ok(Vec::new()),
            "the real file passes"
        );
        // Ids the file points at, not only the ids it lists itself.
        let forged = serde_json::json!({
            "entries": [{"id": "republic", "source": "hidden-entry-source"}],
            "edges": [{"id": "r-x", "from": "republic", "to": "hidden-end",
                       "assertedBy": {"kind": "source", "source": "hidden-party"},
                       "evidence": [{"source": "hidden-evidence"}]}],
            "sources": [{"id": "hidden-listed"}],
            "terms": [{"term": "t", "entries": ["hidden-term-entry"]}]
        })
        .to_string();
        let error = check_output(
            &root,
            &site,
            &manifest,
            &[page("atlas-query.json", &forged)],
        )
        .unwrap_err();
        for expected in [
            "names the atlas query entry `hidden-end`",
            "names the atlas query entry `hidden-term-entry`",
            "names the atlas query source `hidden-evidence`",
            "names the atlas query source `hidden-party`",
            "names the atlas query source `hidden-entry-source`",
            "names the atlas query source `hidden-listed`",
        ] {
            assert!(error.contains(expected), "{expected}: {error}");
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn private_text_in_the_atlas_query_file_refuses_the_build() {
        let root = project_with_note("query-leak", r#"{"knowledgeAtlas":{"publish":true}}"#);
        let leaked = page(
            "atlas-query.json",
            &serde_json::json!({"entries":[{"id":"plato-person","preview":format!("A PRIVATE reading of the allegory that only the author, {NOTE}")}]})
                .to_string(),
        );
        let error = checked(&root, &[leaked]).unwrap_err();
        for expected in [
            "refusing to build",
            "`atlas-query.json`",
            "the research notebook",
            "`n1`",
            "nothing was written",
        ] {
            assert!(error.contains(expected), "{expected}: {error}");
        }
        assert!(!error.to_lowercase().contains("allegory"), "{error}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_build_links_published_concepts_and_warns_for_the_rest() {
        let root = project_with_note("concepts", r#"{"knowledgeAtlas":{"publish":true}}"#);
        write_post(
            &root,
            "cave",
            "",
            "A [philosopher](atlas:plato-person), a [hidden idea](atlas:secret) and a [typo](atlas:Nobody). Plato again, unlinked.",
        );
        let out = root.join("out-concepts");
        let report = build_into(&root, &out).unwrap();
        let page = fs::read_to_string(out.join("posts/cave/index.html")).unwrap();
        assert!(
            page.contains("<a class=\"ob-concept\" href=\"/atlas/plato-person/\""),
            "{page}"
        );
        assert!(page.contains("hidden idea") && page.contains("typo"));
        assert!(
            !page.contains("atlas:") && !page.contains("atlas/secret"),
            "{page}"
        );
        let concept: Vec<&String> = report
            .warnings
            .iter()
            .filter(|warning| warning.contains(": concept link `"))
            .collect();
        assert_eq!(concept.len(), 2, "{concept:?}");
        assert!(concept
            .iter()
            .any(|w| w.contains("posts/cave") && w.contains("`atlas:secret`")));
        assert!(concept.iter().any(|w| w.contains("`atlas:Nobody`")));
        assert!(concept
            .iter()
            .all(|w| !w.contains("`atlas:plato-person`") && !w.contains("Secret")));
        // The post's manifest lists what it links and what it could not.
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let blocked = project_with(&root, &mut site, &shared);
        let stores = Stores::read(&root, &shared);
        let post = site
            .posts
            .iter()
            .find(|p| p.slug == "cave")
            .unwrap()
            .clone();
        let manifest = manifest(&site, &stores, &blocked, Some(&post));
        assert_eq!(
            manifest.published_ids(Projection::ContextLinks, ItemKind::AtlasPage),
            std::collections::BTreeSet::from(["plato-person"])
        );
        // Building again gives the same bytes.
        let again = root.join("out-concepts-2");
        build_into(&root, &again).unwrap();
        assert_eq!(tree(&out), tree(&again));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_site_that_does_not_publish_its_atlas_lists_no_query_items() {
        let root = project_with_note("query-off", "");
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let blocked = project_with(&root, &mut site, &shared);
        let stores = Stores::read(&root, &shared);
        let manifest = manifest(&site, &stores, &blocked, None);
        let report = manifest
            .projections
            .iter()
            .find(|report| report.projection == Projection::AtlasQuery)
            .expect("the query projection is always listed");
        assert!(!report.enabled && report.published.is_empty());
        assert_eq!(report.switch, "knowledgeAtlas.publish");
        let _ = fs::remove_dir_all(root);
    }

    const PASSAGE: &str =
        "Plato's prisoners are not a metaphor for anything at all, really, said the reader.";
    const SHORT_NOTES: [&str; 2] = [
        "Check again: Smith (2003) disagrees, see p. 41; the 1987 letter is key.",
        "I'm not sure Plato's cave is meant literally - ask Dana before publishing.",
    ];

    /// A fresh site with a notebook of one passage and two short, punctuated
    /// notes, and no projection switched on.
    fn research_site(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("openblog-guard-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        crate::scaffold::init(&root, Some("Guard"), false).unwrap();
        let research = root.join(".openblog/private/research");
        fs::create_dir_all(&research).unwrap();
        fs::write(
            research.join("sources.json"),
            r#"{"version":1,"sources":[{"id":"plato","kind":"work","title":"Politeia"}]}"#,
        )
        .unwrap();
        let notebook = serde_json::json!({
            "version": 1,
            "passages": [{"id": "p1", "source": "plato", "excerpt": {"text": PASSAGE}}],
            "notes": [
                {"id": "n1", "kind": "observation", "text": SHORT_NOTES[0]},
                {"id": "n2", "kind": "question", "text": SHORT_NOTES[1]},
            ],
        });
        fs::write(research.join("notebook.json"), notebook.to_string()).unwrap();
        root
    }

    fn build_into(root: &Path, out: &Path) -> Result<crate::site::BuildReport, String> {
        crate::site::build(
            root,
            &crate::site::BuildOptions {
                include_drafts: false,
                out_override: Some(out.to_path_buf()),
                now: None,
            },
        )
    }

    fn write_post(root: &Path, name: &str, front: &str, body: &str) {
        fs::write(
            root.join(format!("content/posts/{name}.md")),
            format!("---\ntitle: {name}\ndate: 2026-01-07\n{front}---\n\n{body}\n"),
        )
        .unwrap();
    }

    fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
        fsutil::walk(dir)
            .into_iter()
            .map(|file| (fsutil::relative(dir, &file), fs::read(&file).unwrap()))
            .collect()
    }

    #[test]
    fn a_post_quoting_a_passage_builds_however_it_wraps_emphasises_or_links_it() {
        let root = research_site("quotes");
        write_post(
            &root,
            "wrapped",
            "",
            "> Plato's prisoners are not a metaphor\n> for anything at all, really,\n> said the reader.",
        );
        write_post(
            &root,
            "emphasis",
            "",
            "Plato's prisoners are **not** a metaphor for *anything* at all, really, said the reader.",
        );
        write_post(
            &root,
            "linked",
            "",
            "Plato's prisoners are not a [metaphor](https://example.org/metaphor) for anything at all, really, said the reader.",
        );
        write_post(
            &root,
            "described",
            &format!("description: {PASSAGE}\n"),
            "A post.",
        );
        let out = root.join("out");
        let report = build_into(&root, &out);
        assert!(report.is_ok(), "{:?}", report.err());
        // The quote reached the search index, llms.txt and the feeds, which
        // join its wrapped lines and strip its markup.
        let files = tree(&out);
        for path in ["search.json", "llms-full.txt", "rss.xml", "feed.json"] {
            let (_, bytes) = files.iter().find(|(file, _)| file == path).expect(path);
            let text = String::from_utf8_lossy(bytes).to_lowercase();
            assert!(text.contains("prisoners are not a metaphor"), "{path}");
        }
        let _ = fs::remove_dir_all(root);
    }

    /// Build `root` into its own `out` folder and return the `boundary:` warnings.
    fn warnings_of(root: &Path) -> Vec<String> {
        build_into(root, &root.join("out"))
            .unwrap_or_else(|error| panic!("the build refused: {error}"))
            .warnings
            .into_iter()
            .filter(|warning| warning.starts_with("boundary:"))
            .collect()
    }

    fn put(root: &Path, path: &str, contents: impl AsRef<[u8]>) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, contents).unwrap();
    }

    fn set_notes(root: &Path, notes: Value) {
        let path = root.join(".openblog/private/research/notebook.json");
        let mut notebook: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        notebook["notes"] = notes;
        fs::write(&path, notebook.to_string()).unwrap();
    }

    #[test]
    fn short_punctuated_notes_in_static_or_theme_files_warn_and_the_build_goes_on() {
        for (tag, path, shown, contents, id) in [
            (
                "static-note",
                "static/notes.txt",
                "notes.txt",
                format!("Reminder.\n\n{}\n", SHORT_NOTES[0]),
                "n1",
            ),
            (
                "static-page",
                "static/extra.html",
                "extra.html",
                format!(
                    "<meta name=\"description\" content=\"{}\">",
                    SHORT_NOTES[1].replace('\'', "&#39;")
                ),
                "n2",
            ),
            (
                "theme-file",
                "themes/mine/readme.txt",
                "themes/mine/readme.txt",
                SHORT_NOTES[1].replace(" - ", "\n- "),
                "n2",
            ),
        ] {
            let root = research_site(tag);
            put(&root, path, contents);
            let warnings = warnings_of(&root);
            assert_eq!(warnings.len(), 1, "{tag}: {warnings:?}");
            for expected in [
                &format!("`{shown}`"),
                "the research notebook",
                &format!("`{id}`"),
                "remove it there, or keep it",
            ] {
                assert!(
                    warnings[0].contains(expected),
                    "{tag}: {expected}: {warnings:?}"
                );
            }
            assert!(
                !warnings[0].contains("Smith") && !warnings[0].contains("Dana"),
                "{warnings:?}"
            );
            assert!(
                root.join("out/index.html").exists(),
                "{tag}: the build went on"
            );
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn a_note_listing_the_posts_own_headings_or_series_titles_or_an_atlas_address_warns_nothing() {
        // The theme sets headings side by side in its table of contents and
        // series titles in its series list: windows across them are no leak.
        let root = research_site("outline");
        write_post(
            &root,
            "plato",
            "",
            "Opening words.\n\n## Introduction\n\nText.\n\n## The cave\n\nText.\n\n## The divided line\n\nText.\n\n## The sun\n\nText.\n\n## Conclusion\n\nText.",
        );
        for (index, title) in ["The cave", "The divided line", "The sun"]
            .iter()
            .enumerate()
        {
            let part = index + 1;
            fs::write(
                root.join(format!("content/posts/p{part}.md")),
                format!(
                    "---\ntitle: {title}\ndate: 2026-01-0{part}\nseries: plato\nseriesOrder: {part}\n---\n\nBody text of part {part} about something else.\n"
                ),
            )
            .unwrap();
        }
        set_notes(
            &root,
            serde_json::json!([
                {"id": "n1", "kind": "observation", "text": "Outline: Introduction, The cave, The divided line, The sun, Conclusion"},
                {"id": "n2", "kind": "observation", "text": "Series plan: The cave; The divided line; The sun."},
                {"id": "n3", "kind": "observation", "text": "Entry is live at https://example.com/atlas/allegory-of-the-cave/ and https://example.com/archive/ and https://example.com/feed.json"},
            ]),
        );
        let config_path = root.join("openblog.json");
        let mut config: Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        config["knowledgeAtlas"] = serde_json::json!({"publish": true});
        config["url"] = serde_json::json!("https://example.com");
        fs::write(&config_path, config.to_string()).unwrap();
        put(
            &root,
            ".openblog/private/research/atlas.json",
            r#"{"version":2,"entries":[{"id":"allegory-of-the-cave","kind":"concept","label":"Allegory of the cave","visibility":"approved"}],"relationships":[]}"#,
        );
        let warnings = warnings_of(&root);
        assert!(warnings.is_empty(), "{warnings:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_note_with_markup_or_backslashes_is_found_as_the_output_writes_it() {
        let root = research_site("normalise");
        let tagged = "A <i>reading</i> of the <i>cave</i> that the <i>author</i> keeps <i>private</i> until <i>Dana</i> agrees to it";
        let tex =
            r"Set \theta to the new value before the next run, then copy C:\new\tmp\data back";
        set_notes(
            &root,
            serde_json::json!([
                {"id": "n1", "kind": "observation", "text": tagged},
                {"id": "n2", "kind": "observation", "text": tex},
            ]),
        );
        put(&root, "static/leak.html", format!("<p>{tagged}</p>"));
        put(
            &root,
            "static/leak.txt",
            "A reading of the cave that the author keeps private until Dana agrees to it",
        );
        put(&root, "static/tex.tex", tex);
        let warnings = warnings_of(&root);
        for (file, id) in [("leak.html", "n1"), ("leak.txt", "n1"), ("tex.tex", "n2")] {
            assert!(
                warnings
                    .iter()
                    .any(|w| w.contains(&format!("`{file}`")) && w.contains(&format!("`{id}`"))),
                "{file}: {warnings:?}"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn every_copied_text_file_is_scanned_whatever_its_extension_and_a_large_one_is_named() {
        let root = research_site("sniff");
        let note = SHORT_NOTES[0];
        for path in [
            "static/refs.bib",
            "static/x.ris",
            "static/talk.vtt",
            "static/notes.tex",
            "static/old.json.bak",
            "web/custom.js",
            "themes/mine/notes.rst",
        ] {
            put(&root, path, format!("// remember\n{note}\n"));
        }
        // A binary file that happens to hold the words is not text.
        let mut binary = vec![0u8, 159, 146, 150];
        binary.extend_from_slice(note.as_bytes());
        put(&root, "static/blob.dat", binary);
        let warnings = warnings_of(&root);
        for shown in [
            "refs.bib",
            "x.ris",
            "talk.vtt",
            "notes.tex",
            "old.json.bak",
            "assets/custom.js",
            "themes/mine/notes.rst",
        ] {
            assert!(
                warnings.iter().any(|w| w.contains(&format!("`{shown}`"))),
                "{shown}: {warnings:?}"
            );
        }
        assert!(
            !warnings.iter().any(|w| w.contains("blob.dat")),
            "{warnings:?}"
        );
        // A text file too large to scan is named, not skipped in silence.
        let mut large = "plain words\n".repeat(MAX_ALLOWED_FILE as usize / 12 + 10);
        large.push_str(note);
        put(&root, "static/big.csv", large);
        let warnings = warnings_of(&root);
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("`big.csv`") && w.contains("not scanned")),
            "{warnings:?}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_note_that_only_pastes_a_link_to_a_public_page_is_not_a_leak() {
        let root = research_site("links");
        write_post(&root, "linked-post", "", "A post.");
        let (site, _) = crate::site::load_site(&root, false, None).unwrap();
        let link = format!(
            "{}{}",
            site.config.url.trim_end_matches('/'),
            site.posts[0].url
        );
        let path = root.join(".openblog/private/research/notebook.json");
        let mut notebook: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        notebook["notes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id": "n3", "kind": "observation", "text": link}));
        fs::write(&path, notebook.to_string()).unwrap();
        let built = build_into(&root, &root.join("out"));
        assert!(built.is_ok(), "{link}: {:?}", built.err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_draft_or_unrelated_content_file_does_not_make_private_text_public() {
        let root = research_site("draft");
        // A draft quotes the note; the build does not publish the draft, so
        // its text is not an input that allows anything.
        write_post(&root, "draft-quote", "draft: true\n", SHORT_NOTES[0]);
        fs::write(root.join("static/notes.txt"), SHORT_NOTES[0]).unwrap();
        let warnings = warnings_of(&root);
        assert!(
            warnings.len() == 1
                && warnings[0].contains("`notes.txt`")
                && warnings[0].contains("`n1`"),
            "{warnings:?}"
        );
        // Published, the same quote is the author's own text.
        write_post(&root, "draft-quote", "", SHORT_NOTES[0]);
        assert_eq!(warnings_of(&root), Vec::<String>::new());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_note_kept_in_a_posts_front_matter_does_not_make_private_text_public() {
        let root = research_site("memo");
        // The front-matter field is not one the build renders, so the post
        // does not publish it, and the same words in a static file still warn.
        write_post(
            &root,
            "memo",
            &format!("memo: {}\n", SHORT_NOTES[0]),
            "A post that says something else.",
        );
        fs::write(root.join("static/notes.txt"), SHORT_NOTES[0]).unwrap();
        let warnings = warnings_of(&root);
        assert!(
            warnings.iter().any(|w| w.contains("`notes.txt`")),
            "{warnings:?}"
        );
        // A rendered field (the description) is public text.
        write_post(
            &root,
            "memo",
            &format!("description: {}\n", SHORT_NOTES[0]),
            "A post that says something else.",
        );
        assert_eq!(warnings_of(&root), Vec::<String>::new());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_refused_build_leaves_the_output_folder_as_it_was() {
        let root = research_site("rollback");
        let out = root.join("out");
        build_into(&root, &out).unwrap();
        let before = tree(&out);
        assert!(!before.is_empty());
        // A damaged atlas that the site publishes is a structural refusal.
        let config_path = root.join("openblog.json");
        let mut config: Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        config["knowledgeAtlas"] = serde_json::json!({"publish": true});
        fs::write(&config_path, config.to_string()).unwrap();
        fs::write(
            root.join(".openblog/private/research/atlas.json"),
            "{ not json",
        )
        .unwrap();
        write_post(
            &root,
            "later",
            "",
            "A new post that would have been written.",
        );
        assert!(build_into(&root, &out).is_err());
        assert_eq!(tree(&out), before, "nothing was written, nothing removed");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_bibliography_export_carrying_private_text_is_refused_and_other_exports_warn() {
        let root = research_site("export");
        write_post(&root, "quote", "", &format!("> {PASSAGE}"));
        let (site, _) = crate::site::load_site(&root, false, None).unwrap();
        assert_eq!(
            check_export(&root, &site, "quote.md", &format!("> {PASSAGE}"), false),
            Ok(Vec::new())
        );
        let said = format!("An export that also says: {}", SHORT_NOTES[0]);
        // Reference data is machine data: a refusal.
        let error = check_export(&root, &site, "quote.bib", &said, true).unwrap_err();
        for expected in [
            "refusing to export",
            "`quote.bib`",
            "`n1`",
            "no file was written",
        ] {
            assert!(error.contains(expected), "{expected}: {error}");
        }
        assert!(!error.contains("Smith"), "{error}");
        // The portable Markdown is the author's own text: a warning.
        let warnings = check_export(&root, &site, "quote.md", &said, false).unwrap();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].starts_with("boundary: ") && warnings[0].contains("`n1`"),
            "{warnings:?}"
        );
        assert!(!warnings[0].contains("Smith"), "{warnings:?}");
        let _ = fs::remove_dir_all(root);
    }

    /// The curated selections are one more projection of the same manifest,
    /// and a site that does not curate builds exactly what it built before.
    #[test]
    fn curated_selections_are_one_more_projection_and_off_changes_nothing() {
        let root = research_site("curated");
        let research = root.join(".openblog/private/research");
        fs::write(
            research.join("atlas.json"),
            serde_json::json!({"version": 2, "entries": [
                {"id": "plato", "kind": "person", "label": "Plato", "visibility": "approved"},
                {"id": "hidden", "kind": "person", "label": "Hidden", "visibility": "private"}
            ], "relationships": []})
            .to_string(),
        )
        .unwrap();
        let config = fs::read_to_string(root.join("openblog.json")).unwrap();
        let publishing = |on: bool| {
            let mut value: Value = serde_json::from_str(&config).unwrap();
            value["knowledgeAtlas"] = serde_json::json!({"publish": true});
            if on {
                value["curatedContext"] = serde_json::json!({"publish": true});
            }
            fs::write(root.join("openblog.json"), value.to_string()).unwrap();
        };
        publishing(false);
        let before = tempdir_build(&root, "before");

        // The selections file exists but the switch is off: same output.
        let selections = serde_json::json!({"version": 1, "selections": [
            {"id": "contextual-entry-plato", "kind": "contextual-entry", "target": "plato",
             "revision": "0000000000000000", "fields": []}
        ]});
        fs::write(research.join("selections.json"), selections.to_string()).unwrap();
        assert_eq!(
            before,
            tempdir_build(&root, "after"),
            "the switch off changes no output"
        );

        publishing(true);
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let manifest = site_preview(&root, &mut site, &shared);
        let curated = manifest
            .projections
            .iter()
            .find(|p| p.projection == Projection::Curated)
            .expect("the curated projection");
        assert!(curated.enabled && curated.published.is_empty());
        assert_eq!(curated.withheld.len(), 1, "{:?}", curated.withheld);
        assert_eq!(
            curated.withheld[0].reason,
            openblog_core::publication_boundary::Reason::StaleSelection
        );

        // A file that cannot be read is named, and nothing else changes.
        fs::write(research.join("selections.json"), "{ nope").unwrap();
        let shared = Shared::read(&root, &site.config);
        let manifest = site_preview(&root, &mut site, &shared);
        assert!(manifest
            .unavailable
            .iter()
            .any(|u| u.store == Store::Selections));
        let _ = fs::remove_dir_all(root);
    }

    /// A site that publishes the atlas and curated context, with two published
    /// datings of Plato's birth and a source library of two sources, one of
    /// which only the atlas's evidence makes public.
    fn curating_site(tag: &str) -> PathBuf {
        let root = research_site(tag);
        let research = root.join(".openblog/private/research");
        fs::write(
            research.join("sources.json"),
            r#"{"version":1,"sources":[{"id":"plato","kind":"work","title":"Politeia"},{"id":"diary","kind":"work","title":"A private diary"}]}"#,
        )
        .unwrap();
        let dating = |id: &str, year: i32| {
            serde_json::json!({"id": id, "aspect": "birth", "date": {"at": {"year": year}},
                "assertedBy": {"kind": "author"}, "evidence": [{"source": "plato"}],
                "visibility": "approved"})
        };
        fs::write(
            research.join("atlas.json"),
            serde_json::json!({"version": 2, "entries": [
                {"id": "plato-person", "kind": "person", "label": "Plato", "visibility": "approved",
                 "dates": [dating("born-a", -428), dating("born-b", -424)]}
            ], "relationships": []})
            .to_string(),
        )
        .unwrap();
        let mut config: Value =
            serde_json::from_str(&fs::read_to_string(root.join("openblog.json")).unwrap()).unwrap();
        config["knowledgeAtlas"] = serde_json::json!({"publish": true});
        config["curatedContext"] = serde_json::json!({"publish": true});
        fs::write(root.join("openblog.json"), config.to_string()).unwrap();
        root
    }

    /// Select through the same basis the build resolves against, so the
    /// revisions in the file are the ones the build computes.
    fn select_for_build(
        root: &Path,
        picks: Vec<openblog_core::curated_selection::NewSelection>,
    ) -> Vec<Result<String, Vec<openblog_core::curated_selection::Diagnostic>>> {
        let (mut site, _) = crate::site::load_site(root, false, None).unwrap();
        let shared = Shared::read(root, &site.config);
        project_with(root, &mut site, &shared);
        let stores = Stores::read(root, &shared);
        let owned = CurationBasis::of(&site, &stores);
        let mut set = openblog_core::curated_selection::SelectionSet::default();
        let results = picks
            .into_iter()
            .map(|pick| set.select(pick, &owned.basis(&site, &stores)))
            .collect();
        fs::write(root.join(Store::Selections.file()), set.to_json()).unwrap();
        results
    }

    fn pick(
        kind: openblog_core::curated_selection::SelectionKind,
        target: &str,
    ) -> openblog_core::curated_selection::NewSelection {
        openblog_core::curated_selection::NewSelection {
            kind: Some(kind),
            target: target.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_curated_reference_may_select_only_a_source_that_is_already_public() {
        use openblog_core::curated_selection::SelectionKind;
        let root = curating_site("curated-public-sources");
        let results = select_for_build(
            &root,
            vec![
                pick(SelectionKind::Reference, "plato"),
                pick(SelectionKind::Reference, "diary"),
            ],
        );
        assert!(results[0].is_ok(), "the atlas publishes plato: {results:?}");
        let refused = results[1].as_ref().unwrap_err();
        assert!(refused[0].message.contains("stays private"), "{refused:?}");
        // A post that cites it makes it public.
        write_post(&root, "cites", "citations: notes\n", "See [@diary].");
        let results = select_for_build(&root, vec![pick(SelectionKind::Reference, "diary")]);
        assert!(results[0].is_ok(), "{results:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_damaged_selections_file_refuses_a_build_only_while_the_site_publishes_it() {
        use openblog_core::curated_selection::SelectionKind;
        let root = curating_site("curated-damaged");
        select_for_build(&root, vec![pick(SelectionKind::Timeline, "born-a")]);
        let built = tempdir_build(&root, "good");
        assert!(!built.is_empty());
        let before = fs::read(root.join(Store::Selections.file())).unwrap();

        fs::write(root.join(Store::Selections.file()), "{ nope").unwrap();
        let out = root.join("out-refused");
        let error = build_into(&root, &out).err().expect("the build is refused");
        assert!(
            error.contains("curated selections cannot be read")
                && error.contains("curatedContext.publish"),
            "{error}"
        );
        assert!(!out.exists(), "nothing was written");
        // The Admin preview and a validating load are not stopped by it.
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let manifest = site_preview(&root, &mut site, &shared);
        assert!(manifest
            .unavailable
            .iter()
            .any(|u| u.store == Store::Selections));

        // Off, the file is never read: the same site builds as it did.
        let mut config: Value =
            serde_json::from_str(&fs::read_to_string(root.join("openblog.json")).unwrap()).unwrap();
        config["curatedContext"] = serde_json::json!({"publish": false});
        fs::write(root.join("openblog.json"), config.to_string()).unwrap();
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let manifest = site_preview(&root, &mut site, &shared);
        assert!(
            manifest.unavailable.is_empty(),
            "{:?}",
            manifest.unavailable
        );
        assert!(build_into(&root, &root.join("out-off")).is_ok());

        // The refusal never changed the file.
        fs::write(root.join(Store::Selections.file()), &before).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_selected_dating_with_an_unselected_rival_is_a_boundary_warning_and_a_caveat() {
        use openblog_core::curated_selection::SelectionKind;
        let root = curating_site("curated-competing");
        select_for_build(&root, vec![pick(SelectionKind::Timeline, "born-a")]);
        let report = build_into(&root, &root.join("out")).unwrap();
        assert!(
            report.warnings.iter().any(|w| w.starts_with("boundary: ")
                && w.contains("born-b")
                && w.contains("not selected")),
            "{:?}",
            report.warnings
        );
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let manifest = site_preview(&root, &mut site, &shared);
        let curated = manifest
            .projections
            .iter()
            .find(|p| p.projection == Projection::Curated)
            .unwrap();
        let item = curated
            .published
            .iter()
            .find(|i| i.kind == ItemKind::Selection)
            .unwrap();
        assert_eq!(item.notices.len(), 1, "{:?}", item.notices);
        let _ = fs::remove_dir_all(root);
    }

    /// The Admin preview scans for private text exactly when the build would: a site
    /// whose only research is its curated selections is scanned while it publishes them,
    /// and is not touched while it does not.
    #[test]
    fn the_text_preview_includes_the_curated_selections_only_while_they_are_published() {
        let root = std::env::temp_dir().join(format!(
            "openblog-guard-curated-only-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        crate::scaffold::init(&root, Some("Guard"), false).unwrap();
        let research = root.join(".openblog/private/research");
        fs::create_dir_all(&research).unwrap();
        let words = "ZqxCuratedOnly comment words that stay private until a projection allows them";
        fs::write(
            research.join("selections.json"),
            serde_json::json!({"version": 1, "selections": [
                {"id": "annotation-x", "kind": "source-annotation", "target": "plato",
                 "revision": "0000000000000000", "fields": ["by", "text"],
                 "by": "The author", "text": words}
            ]})
            .to_string(),
        )
        .unwrap();
        fs::create_dir_all(root.join("static")).unwrap();
        fs::write(root.join("static/leak.txt"), format!("{words}\n")).unwrap();
        let config = fs::read_to_string(root.join("openblog.json")).unwrap();
        let with_switch = |on: bool| {
            let mut value: Value = serde_json::from_str(&config).unwrap();
            if on {
                value["curatedContext"] = serde_json::json!({"publish": true});
            }
            fs::write(root.join("openblog.json"), value.to_string()).unwrap();
            crate::site::load_site(&root, false, None).unwrap()
        };
        let (site, themes) = with_switch(false);
        let (warnings, refusal) = preview_text(&root, &site, &themes);
        assert!(
            warnings.is_empty() && refusal.is_none(),
            "off: nothing is scanned"
        );
        let (site, themes) = with_switch(true);
        let (warnings, refusal) = preview_text(&root, &site, &themes);
        assert!(refusal.is_none());
        assert!(
            warnings.iter().any(|w| w.starts_with("boundary: ")
                && w.contains("`leak.txt`")
                && w.contains("annotation-x")),
            "{warnings:?}"
        );
        assert!(warnings.iter().all(|w| !w.contains("ZqxCuratedOnly")));
        let _ = fs::remove_dir_all(root);
    }

    fn tempdir_build(root: &Path, name: &str) -> Vec<(String, Vec<u8>)> {
        let out = root.join(format!("out-{name}"));
        build_into(root, &out).unwrap();
        tree(&out)
    }

    #[test]
    fn without_research_files_nothing_is_guarded_or_read() {
        let root =
            std::env::temp_dir().join(format!("openblog-boundary-none-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        crate::scaffold::init(&root, Some("Guard"), false).unwrap();
        let (site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let stores = Stores::read(&root, &shared);
        assert!(stores.library.is_none() && stores.unavailable.is_empty());
        let manifest = manifest(&site, &stores, &Blocked::default(), None);
        assert!(manifest.never.is_empty());
        assert_eq!(
            manifest.summary(),
            None,
            "the build prints what it printed before"
        );
        assert!(guard(&root, &site, &[]).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    // ---- the curated research-context projection (#197, ADR 0197) ---------------

    const APPROVED_WORDS: &str =
        "Plato taught at the Academy for forty years, and this is a comment by the author.";
    const WITHDRAWN_WORDS: &str =
        "A withdrawn comment that stays private to the author and must never be published.";

    /// A curating site with two published posts and four selections: an entry
    /// and a comment for `cave`, a whole-site dating, and a withdrawn comment.
    fn context_site(tag: &str) -> PathBuf {
        use openblog_core::curated_selection::{NewSelection, SelectionKind, SelectionSet};
        let root = curating_site(tag);
        write_post(&root, "cave", "", "The cave.");
        write_post(&root, "other", "", "Another post.");
        let results = select_for_build(
            &root,
            vec![
                NewSelection {
                    posts: Some(vec!["cave".into()]),
                    ..pick(SelectionKind::ContextualEntry, "plato-person")
                },
                NewSelection {
                    text: Some(APPROVED_WORDS.into()),
                    by: Some("The author".into()),
                    posts: Some(vec!["cave".into()]),
                    ..pick(SelectionKind::SourceAnnotation, "plato")
                },
                pick(SelectionKind::Timeline, "born-a"),
                NewSelection {
                    text: Some(WITHDRAWN_WORDS.into()),
                    by: Some("The author".into()),
                    ..pick(SelectionKind::Explanation, "plato-person")
                },
            ],
        );
        let ids: Vec<String> = results.into_iter().map(|r| r.unwrap()).collect();
        let file = root.join(Store::Selections.file());
        let mut set = SelectionSet::parse(&fs::read_to_string(&file).unwrap()).unwrap();
        assert!(set.withdraw(&ids[3], Some("not yet".into())));
        fs::write(&file, set.to_json()).unwrap();
        root
    }

    fn files_with(tree: &[(String, Vec<u8>)], words: &str) -> Vec<String> {
        tree.iter()
            .filter(|(_, bytes)| String::from_utf8_lossy(bytes).contains(words))
            .map(|(path, _)| path.clone())
            .collect()
    }

    fn file<'a>(tree: &'a [(String, Vec<u8>)], path: &str) -> Option<&'a Vec<u8>> {
        tree.iter().find(|(p, _)| p == path).map(|(_, bytes)| bytes)
    }

    fn set_switch(root: &Path, on: bool) {
        let mut config: Value =
            serde_json::from_str(&fs::read_to_string(root.join("openblog.json")).unwrap()).unwrap();
        config["curatedContext"] = serde_json::json!({ "publish": on });
        fs::write(root.join("openblog.json"), config.to_string()).unwrap();
    }

    #[test]
    fn a_build_writes_the_context_file_and_each_posts_section_from_the_public_value() {
        let root = context_site("context-build");
        let first = tempdir_build(&root, "first");
        let second = tempdir_build(&root, "second");
        assert_eq!(first, second, "the same site builds the same bytes");

        let json =
            String::from_utf8(file(&first, "curated-context.json").unwrap().clone()).unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["format"], "openblog-curated-context-file");
        assert_eq!(value["formatVersion"], 1);
        assert_eq!(value["items"].as_array().unwrap().len(), 3);
        assert!(json.contains(APPROVED_WORDS));
        assert!(!json.contains(WITHDRAWN_WORDS));
        // Where each post offers it, in order, with the canonical anchors.
        let posts = value["posts"].as_array().unwrap();
        let cave = posts.iter().find(|p| p["post"] == "cave").unwrap();
        assert_eq!(cave["items"].as_array().unwrap().len(), 3);
        let other = posts.iter().find(|p| p["post"] == "other").unwrap();
        assert_eq!(
            other["items"].as_array().unwrap().len(),
            1,
            "only the whole-site dating"
        );
        for post in posts {
            for item in post["items"].as_array().unwrap() {
                let url = item["url"].as_str().unwrap();
                let (page, fragment) = url.split_once('#').unwrap();
                let html = String::from_utf8(
                    file(
                        &first,
                        &format!("{}index.html", page.trim_start_matches('/')),
                    )
                    .unwrap()
                    .clone(),
                )
                .unwrap();
                assert!(html.contains(&format!("id=\"{fragment}\"")), "{url}");
            }
        }
        // The page carries the section without JavaScript; a post that is offered nothing is unchanged.
        let cave_page =
            String::from_utf8_lossy(file(&first, "posts/cave/index.html").unwrap()).to_string();
        assert!(cave_page.contains("id=\"ob-research-context\""));
        assert!(cave_page.contains("Plato taught at the Academy"));
        assert!(cave_page.contains("href=\"/curated-context.json\""));
        assert!(!cave_page.contains(WITHDRAWN_WORDS));
        // The approved words reach the context file, the one page that offers them, and the
        // portable copies of it that carry the context (the feeds and llms-full.txt), nowhere else.
        let mut with_words = files_with(&first, APPROVED_WORDS);
        with_words.sort();
        assert_eq!(
            with_words,
            [
                "curated-context.json",
                "feed.json",
                "llms-full.txt",
                "posts/cave/index.html",
                "rss.xml"
            ]
        );
        assert!(files_with(&first, WITHDRAWN_WORDS).is_empty());
        for gone in [PASSAGE, SHORT_NOTES[0], SHORT_NOTES[1]] {
            assert!(
                files_with(&first, gone).is_empty(),
                "{gone}: {:?}",
                files_with(&first, gone)
            );
        }
        // The manifest lists the file beside the selections.
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        let shared = Shared::read(&root, &site.config);
        let preview = site_preview(&root, &mut site, &shared);
        assert_eq!(
            preview
                .published_ids(Projection::CuratedContext, ItemKind::CuratedContext)
                .into_iter()
                .collect::<Vec<_>>(),
            ["curated-context"]
        );
        assert_eq!(
            preview
                .published_ids(Projection::Curated, ItemKind::Selection)
                .len(),
            3
        );
        // The atlas query file of B3 is the same with or without curation, and the atlas pages are untouched.
        set_switch(&root, false);
        let off = tempdir_build(&root, "off");
        assert_eq!(
            file(&first, "atlas-query.json"),
            file(&off, "atlas-query.json")
        );
        assert_eq!(file(&first, "atlas.json"), file(&off, "atlas.json"));
        for (path, bytes) in &off {
            if path.starts_with("atlas/") {
                assert_eq!(file(&first, path), Some(bytes), "{path}");
            }
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn with_the_switch_off_or_nothing_selected_the_build_is_byte_for_byte_the_legacy_build() {
        let root = context_site("context-legacy");
        let on = tempdir_build(&root, "on");
        assert!(file(&on, "curated-context.json").is_some());
        // Off, with the selections file stored: never read, nothing written.
        set_switch(&root, false);
        let off = tempdir_build(&root, "off");
        assert!(file(&off, "curated-context.json").is_none());
        assert!(files_with(&off, "ob-curated")
            .iter()
            .all(|path| path.starts_with("assets/")));
        assert!(files_with(&off, "research-context").is_empty());
        // On, with only a withdrawn selection: nothing is published, so nothing changes.
        let file = root.join(Store::Selections.file());
        let mut held = openblog_core::curated_selection::SelectionSet::parse(
            &fs::read_to_string(&file).unwrap(),
        )
        .unwrap();
        let ids: Vec<String> = held.selections.iter().map(|s| s.id.clone()).collect();
        for id in &ids {
            held.withdraw(id, None);
        }
        let original = fs::read(&file).unwrap();
        fs::write(&file, held.to_json()).unwrap();
        set_switch(&root, true);
        assert_eq!(tempdir_build(&root, "withdrawn"), off);
        fs::write(&file, original).unwrap();
        // On, with no selections file: the same bytes as off.
        fs::remove_file(root.join(Store::Selections.file())).unwrap();
        set_switch(&root, true);
        assert_eq!(tempdir_build(&root, "none"), off);
        // A site that never heard of the setting.
        let mut config: Value =
            serde_json::from_str(&fs::read_to_string(root.join("openblog.json")).unwrap()).unwrap();
        config.as_object_mut().unwrap().remove("curatedContext");
        fs::write(root.join("openblog.json"), config.to_string()).unwrap();
        assert_eq!(tempdir_build(&root, "legacy"), off);
        // A damaged file with the switch off changes nothing; with it on it refuses, as before.
        fs::write(root.join(Store::Selections.file()), "{ nope").unwrap();
        assert_eq!(tempdir_build(&root, "damaged-off"), off);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_text_guard_allows_the_published_curated_text_and_still_refuses_every_other_private_text()
    {
        let root = context_site("context-guard");
        let built = tempdir_build(&root, "legit");
        let legit =
            String::from_utf8(file(&built, "curated-context.json").unwrap().clone()).unwrap();
        let cave =
            String::from_utf8(file(&built, "posts/cave/index.html").unwrap().clone()).unwrap();
        // What the build writes passes its own guard: the approved words are public where the
        // projection carries them.
        let files = [
            page("curated-context.json", &legit),
            page("posts/cave/index.html", &cave),
        ];
        assert_eq!(checked(&root, &files), Ok(Vec::new()));
        // The same file with a private note's words in it is refused, naming the file and where
        // the text came from, and never the text.
        let mut value: Value = serde_json::from_str(&legit).unwrap();
        value["items"][0]["content"]["label"] = Value::String(PASSAGE.to_string());
        let error =
            checked(&root, &[page("curated-context.json", &value.to_string())]).unwrap_err();
        for expected in [
            "refusing to build",
            "`curated-context.json`",
            "the research notebook",
        ] {
            assert!(error.contains(expected), "{expected}: {error}");
        }
        assert!(!error.contains(PASSAGE));
        // So are the words of a selection the build does not publish: the guard allows only what the
        // public value carries, not the selections file.
        let mut value: Value = serde_json::from_str(&legit).unwrap();
        value["items"][0]["content"]["label"] = Value::String(WITHDRAWN_WORDS.to_string());
        let error =
            checked(&root, &[page("curated-context.json", &value.to_string())]).unwrap_err();
        assert!(error.contains("selections.json"), "{error}");
        assert!(!error.contains(WITHDRAWN_WORDS));
        // The same words in a page only warn, as for every other private text.
        let warnings = checked(
            &root,
            &[page(
                "posts/cave/index.html",
                &format!("<p>{WITHDRAWN_WORDS}</p>"),
            )],
        )
        .unwrap();
        assert!(
            warnings.iter().any(|w| w.contains("selections.json")),
            "{warnings:?}"
        );
        // The file may only name what the manifest publishes.
        let mut value: Value = serde_json::from_str(&legit).unwrap();
        value["items"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "id": "ghost-selection" }));
        let error =
            checked(&root, &[page("curated-context.json", &value.to_string())]).unwrap_err();
        assert!(
            error.contains("`curated-context.json` names the curated selection `ghost-selection`"),
            "{error}"
        );
        let mut value: Value = serde_json::from_str(&legit).unwrap();
        value["posts"][0]["post"] = Value::String("a-draft".into());
        let error =
            checked(&root, &[page("curated-context.json", &value.to_string())]).unwrap_err();
        assert!(
            error.contains("names the published post `a-draft`"),
            "{error}"
        );
        let mut value: Value = serde_json::from_str(&legit).unwrap();
        value["context"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "kind": "entry", "id": "secret", "via": [] }));
        let error =
            checked(&root, &[page("curated-context.json", &value.to_string())]).unwrap_err();
        assert!(
            error.contains("names the curated entry `secret`"),
            "{error}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_file_may_name_only_published_posts_selections_and_addresses_in_every_field() {
        let root = context_site("context-references");
        let built = tempdir_build(&root, "legit");
        let legit =
            String::from_utf8(file(&built, "curated-context.json").unwrap().clone()).unwrap();
        assert_eq!(
            checked(&root, &[page("curated-context.json", &legit)]),
            Ok(Vec::new())
        );
        let refused = |edit: &dyn Fn(&mut Value), expected: &str| {
            let mut value: Value = serde_json::from_str(&legit).unwrap();
            edit(&mut value);
            let error =
                checked(&root, &[page("curated-context.json", &value.to_string())]).unwrap_err();
            assert!(error.contains(expected), "{expected}: {error}");
        };
        refused(
            &|v| v["items"][0]["posts"] = serde_json::json!(["a-draft"]),
            "names the published post `a-draft`",
        );
        refused(
            &|v| v["items"][0]["positions"] = serde_json::json!({ "a-draft": 0 }),
            "names the published post `a-draft`",
        );
        refused(
            &|v| v["items"][0]["requires"] = serde_json::json!(["ghost-selection"]),
            "names the curated selection `ghost-selection`",
        );
        refused(
            &|v| v["context"][0]["via"] = serde_json::json!(["ghost-selection"]),
            "names the curated selection `ghost-selection`",
        );
        refused(
            &|v| v["posts"][0]["url"] = Value::String("/posts/a-draft/".into()),
            "names the post address `/posts/a-draft/`",
        );
        refused(
            &|v| {
                v["posts"][0]["items"][0]["url"] =
                    Value::String("/posts/a-draft/#ob-curated-x".into())
            },
            "names the post address `/posts/a-draft/`",
        );
        refused(
            &|v| {
                let url = v["posts"][0]["items"][0]["url"]
                    .as_str()
                    .unwrap()
                    .to_string();
                let page = url.split('#').next().unwrap().to_string();
                v["posts"][0]["items"][0]["url"] = Value::String(format!("{page}#a-heading"));
            },
            "names the item anchor `a-heading`",
        );
        let _ = fs::remove_dir_all(root);
    }

    // ---- portable copies of the curated context (#198, ADR 0202 to ADR 0206) ----------------

    fn export_to(root: &Path, slug: &str, name: &str) -> Result<String, String> {
        let out = root.join("exports").join(name);
        crate::portable_export::run(
            root,
            slug,
            crate::portable_export::Format::Markdown,
            Some(out.to_str().unwrap()),
            true,
            false,
        )?;
        Ok(fs::read_to_string(out).unwrap())
    }

    #[test]
    fn a_portable_export_and_a_syndicated_copy_carry_the_research_context_and_nothing_private() {
        let root = context_site("portable-copies");
        let exported = export_to(&root, "cave", "cave.md").unwrap();
        for expected in [
            "## Research context",
            APPROVED_WORDS,
            "#ob-research-context",
        ] {
            assert!(exported.contains(expected), "{expected}:\n{exported}");
        }
        assert!(!exported.contains(WITHDRAWN_WORDS));
        assert!(!exported.contains(PASSAGE) && !exported.contains(SHORT_NOTES[0]));

        // What a destination is sent carries it too, as a different revision, so a syndicated
        // copy is updated when its context first appears.
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        attach_public_curation(&root, &mut site).unwrap();
        let mut config = crate::site::load_config(&root).unwrap();
        config.url = "https://corpus.openblog.dev".into();
        let post = site.posts.iter().find(|post| post.slug == "cave").unwrap();
        let source = fs::read_to_string(root.join("content").join(&post.source)).unwrap();
        let sent = crate::syndication::syndication_post(
            post,
            &source,
            &config,
            None,
            site.curated_context_for(post),
        )
        .unwrap();
        let plain =
            crate::syndication::syndication_post(post, &source, &config, None, None).unwrap();
        for copy in [&sent.markdown, &sent.html] {
            assert!(copy.contains(APPROVED_WORDS) && copy.contains("#ob-research-context"));
            assert!(!copy.contains(WITHDRAWN_WORDS));
        }
        assert!(!plain.markdown.contains(APPROVED_WORDS));
        assert_ne!(sent.revision, plain.revision);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn with_the_switch_off_or_nothing_selected_a_portable_copy_is_byte_for_byte_the_legacy_copy() {
        let root = context_site("portable-legacy");
        set_switch(&root, false);
        let off = export_to(&root, "cave", "off.md").unwrap();
        assert!(!off.contains("Research context") && !off.contains(APPROVED_WORDS));
        // The switch on with nothing selected is the same copy, byte for byte.
        fs::remove_file(root.join(Store::Selections.file())).unwrap();
        set_switch(&root, true);
        assert_eq!(export_to(&root, "cave", "empty.md").unwrap(), off);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_selections_file_that_cannot_be_read_refuses_an_export_rather_than_leaving_the_context_out()
    {
        let root = context_site("portable-damaged");
        fs::write(root.join(Store::Selections.file()), "{ nope").unwrap();
        let error = export_to(&root, "cave", "damaged.md").unwrap_err();
        assert!(error.contains("refusing to export"), "{error}");
        assert!(
            !root.join("exports/damaged.md").exists(),
            "nothing was written"
        );
        // With the switch off the file is never read, and the export is what it was.
        set_switch(&root, false);
        assert!(export_to(&root, "cave", "off.md").is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_bibliography_carries_the_selected_reference_and_lists_the_items_it_has_no_place_for() {
        use crate::portable_export::{bibliography_export, Format};
        use openblog_core::curated_selection::{NewSelection, SelectionKind};
        let root = curating_site("portable-bibliography");
        write_post(&root, "cave", "", "The cave.");
        let results = select_for_build(
            &root,
            vec![
                NewSelection {
                    posts: Some(vec!["cave".into()]),
                    optional_fields: vec!["creators".into()],
                    ..pick(SelectionKind::Reference, "plato")
                },
                NewSelection {
                    text: Some(APPROVED_WORDS.into()),
                    by: Some("The author".into()),
                    posts: Some(vec!["cave".into()]),
                    ..pick(SelectionKind::Explanation, "plato-person")
                },
            ],
        );
        assert!(results.iter().all(Result::is_ok), "{results:?}");
        let (mut site, _) = crate::site::load_site(&root, false, None).unwrap();
        attach_public_curation(&root, &mut site).unwrap();
        let post = site.posts.iter().find(|post| post.slug == "cave").unwrap();
        let curated = site
            .curated_context_for(post)
            .and_then(|context| context.bibliography_for_post("cave"));
        let bibtex = bibliography_export(post, curated.clone(), Format::Bibtex).unwrap();
        assert!(
            bibtex.content.contains("@misc{plato,"),
            "{}",
            bibtex.content
        );
        assert!(bibtex.content.contains("Politeia"));
        // The private diary, a source nobody published, and the author's words are not in it.
        for private in ["A private diary", APPROVED_WORDS] {
            assert!(!bibtex.content.contains(private), "{private}");
        }
        // What a bibliography cannot carry is listed, not dropped without a word.
        assert!(
            bibtex
                .losses
                .iter()
                .any(|loss| loss.field == "explanation" && loss.reason.contains("no place")),
            "{:?}",
            bibtex.losses
        );
        let csl = bibliography_export(post, curated, Format::CslJson).unwrap();
        assert!(csl.content.contains("\"id\": \"plato\""), "{}", csl.content);
        // With no curated context the post has no citations and so nothing to export, as before.
        assert!(bibliography_export(post, None, Format::Bibtex).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
