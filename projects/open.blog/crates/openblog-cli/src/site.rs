//! Reading a project from disk and writing the built site back out.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use openblog_core::accessibility::AccessibilityFinding;
use openblog_core::research::EvidenceFinding;
use openblog_core::theme::{ThemeFile, ThemeSet};
use openblog_core::{generate, DateTime, LoadOptions, Site, SiteConfig, SourceFile, Sources};

use crate::fsutil;

pub const CONFIG_FILE: &str = "openblog.json";

/// Front-end files compiled into the binary so `openblog init` works in an
/// empty folder. A copy on disk under `web/` always wins, so they stay editable.
pub const EMBEDDED_WEB: &[(&str, &str)] = &[
    ("base.css", include_str!("../../../web/base.css")),
    ("openblog.js", include_str!("../../../web/openblog.js")),
    (
        "components/ob-theme-toggle.js",
        include_str!("../../../web/components/ob-theme-toggle.js"),
    ),
    (
        "components/ob-code.js",
        include_str!("../../../web/components/ob-code.js"),
    ),
    (
        "components/ob-rust-playground.js",
        include_str!("../../../web/components/ob-rust-playground.js"),
    ),
    (
        "components/ob-rust-runner.js",
        include_str!("../../../web/components/ob-rust-runner.js"),
    ),
    (
        "components/ob-rust-check-model.js",
        include_str!("../../../web/components/ob-rust-check-model.js"),
    ),
    (
        "components/ob-code-editor.js",
        include_str!("../../../web/components/ob-code-editor.js"),
    ),
    (
        "components/ob-code-runner.js",
        include_str!("../../../web/components/ob-code-runner.js"),
    ),
    (
        "components/ob-code-runner-client.js",
        include_str!("../../../web/components/ob-code-runner-client.js"),
    ),
    (
        "components/ob-code-runner-language.js",
        include_str!("../../../web/components/ob-code-runner-language.js"),
    ),
    (
        "components/ob-web-sandbox.js",
        include_str!("../../../web/components/ob-web-sandbox.js"),
    ),
    (
        "components/ob-git-sandbox.js",
        include_str!("../../../web/components/ob-git-sandbox.js"),
    ),
    (
        "components/ob-git-model.js",
        include_str!("../../../web/components/ob-git-model.js"),
    ),
    (
        "components/ob-practice-lab.js",
        include_str!("../../../web/components/ob-practice-lab.js"),
    ),
    (
        "components/ob-practice-model.js",
        include_str!("../../../web/components/ob-practice-model.js"),
    ),
    (
        "components/ob-fetch-lab.js",
        include_str!("../../../web/components/ob-fetch-lab.js"),
    ),
    (
        "components/ob-fetch-model.js",
        include_str!("../../../web/components/ob-fetch-model.js"),
    ),
    (
        "components/ob-lab.js",
        include_str!("../../../web/components/ob-lab.js"),
    ),
    (
        "components/ob-component-lab.js",
        include_str!("../../../web/components/ob-component-lab.js"),
    ),
    (
        "components/ob-component-model.js",
        include_str!("../../../web/components/ob-component-model.js"),
    ),
    (
        "components/ob-evolution-lab.js",
        include_str!("../../../web/components/ob-evolution-lab.js"),
    ),
    (
        "components/ob-evolution-model.js",
        include_str!("../../../web/components/ob-evolution-model.js"),
    ),
    (
        "components/ob-audio-lab.js",
        include_str!("../../../web/components/ob-audio-lab.js"),
    ),
    (
        "components/ob-audio-core.js",
        include_str!("../../../web/components/ob-audio-core.js"),
    ),
    (
        "components/ob-native-lab.js",
        include_str!("../../../web/components/ob-native-lab.js"),
    ),
    (
        "components/ob-native-model.js",
        include_str!("../../../web/components/ob-native-model.js"),
    ),
    (
        "components/ob-highlight.js",
        include_str!("../../../web/components/ob-highlight.js"),
    ),
    (
        "components/ob-recipe.js",
        include_str!("../../../web/components/ob-recipe.js"),
    ),
    (
        "components/ob-quiz.js",
        include_str!("../../../web/components/ob-quiz.js"),
    ),
    (
        "components/ob-compare.js",
        include_str!("../../../web/components/ob-compare.js"),
    ),
    (
        "components/ob-compare-model.js",
        include_str!("../../../web/components/ob-compare-model.js"),
    ),
    (
        "components/ob-reading-modes.js",
        include_str!("../../../web/components/ob-reading-modes.js"),
    ),
    (
        "components/reading-modes.js",
        include_str!("../../../web/components/reading-modes.js"),
    ),
    (
        "components/ob-quantity.js",
        include_str!("../../../web/components/ob-quantity.js"),
    ),
    (
        "components/ob-back-to-top.js",
        include_str!("../../../web/components/ob-back-to-top.js"),
    ),
    (
        "components/ob-search.js",
        include_str!("../../../web/components/ob-search.js"),
    ),
    (
        "components/ob-share.js",
        include_str!("../../../web/components/ob-share.js"),
    ),
    (
        "components/ob-views.js",
        include_str!("../../../web/components/ob-views.js"),
    ),
    (
        "components/comment-captcha.js",
        include_str!("../../../web/components/comment-captcha.js"),
    ),
    (
        "components/ob-comments.js",
        include_str!("../../../web/components/ob-comments.js"),
    ),
    (
        "components/ob-citation-previews.js",
        include_str!("../../../web/components/ob-citation-previews.js"),
    ),
    (
        "components/ob-atlas-timeline.js",
        include_str!("../../../web/components/ob-atlas-timeline.js"),
    ),
    (
        "components/ob-atlas-trail.js",
        include_str!("../../../web/components/ob-atlas-trail.js"),
    ),
    (
        "components/ob-reading-path.js",
        include_str!("../../../web/components/ob-reading-path.js"),
    ),
    (
        "components/ob-explanation-levels.js",
        include_str!("../../../web/components/ob-explanation-levels.js"),
    ),
    (
        "components/ob-concept-previews.js",
        include_str!("../../../web/components/ob-concept-previews.js"),
    ),
    (
        "components/ob-passage-feedback.js",
        include_str!("../../../web/components/ob-passage-feedback.js"),
    ),
    (
        "components/ob-annotations.js",
        include_str!("../../../web/components/ob-annotations.js"),
    ),
    (
        "components/ob-reflection-history.js",
        include_str!("../../../web/components/ob-reflection-history.js"),
    ),
    (
        "components/reader-reflections.js",
        include_str!("../../../web/components/reader-reflections.js"),
    ),
    (
        "components/ob-reading-trail.js",
        include_str!("../../../web/components/ob-reading-trail.js"),
    ),
    (
        "components/passage-selection.js",
        include_str!("../../../web/components/passage-selection.js"),
    ),
    (
        "components/reader-annotations.js",
        include_str!("../../../web/components/reader-annotations.js"),
    ),
    (
        "components/reader-annotations-store.js",
        include_str!("../../../web/components/reader-annotations-store.js"),
    ),
    (
        "components/reader-annotations-transfer.js",
        include_str!("../../../web/components/reader-annotations-transfer.js"),
    ),
    (
        "components/passage-feedback.js",
        include_str!("../../../web/components/passage-feedback.js"),
    ),
    (
        "components/passage-target.js",
        include_str!("../../../web/components/passage-target.js"),
    ),
    (
        "components/feedback-receipt.js",
        include_str!("../../../web/components/feedback-receipt.js"),
    ),
    (
        "components/ob-abuse-report.js",
        include_str!("../../../web/components/ob-abuse-report.js"),
    ),
    (
        "components/ob-conversation.js",
        include_str!("../../../web/components/ob-conversation.js"),
    ),
    (
        "components/ob-third-perspective.js",
        include_str!("../../../web/components/ob-third-perspective.js"),
    ),
    (
        "components/third-perspective.js",
        include_str!("../../../web/components/third-perspective.js"),
    ),
    (
        "components/ob-future-suggestion.js",
        include_str!("../../../web/components/ob-future-suggestion.js"),
    ),
    (
        "components/future-suggestion.js",
        include_str!("../../../web/components/future-suggestion.js"),
    ),
    (
        "components/public-url.js",
        include_str!("../../../web/components/public-url.js"),
    ),
];

/// The admin editor. Served only by `serve --admin`, never copied into the
/// public site. A copy under `web/admin/` overrides the embedded one.
pub const EMBEDDED_ADMIN: &[(&str, &str)] = &[
    ("index.html", include_str!("../../../web/admin/index.html")),
    ("admin.js", include_str!("../../../web/admin/admin.js")),
    (
        "block-forms.js",
        include_str!("../../../web/admin/block-forms.js"),
    ),
    ("admin.css", include_str!("../../../web/admin/admin.css")),
    ("landing.js", include_str!("../../../web/admin/landing.js")),
    ("look.js", include_str!("../../../web/admin/look.js")),
    (
        "business.js",
        include_str!("../../../web/admin/business.js"),
    ),
    (
        "services.js",
        include_str!("../../../web/admin/services.js"),
    ),
    ("paste.js", include_str!("../../../web/admin/paste.js")),
    (
        "landing-history.js",
        include_str!("../../../web/admin/landing-history.js"),
    ),
    ("checks.js", include_str!("../../../web/admin/checks.js")),
    ("voice.js", include_str!("../../../web/admin/voice.js")),
    (
        "voice-session.js",
        include_str!("../../../web/admin/voice-session.js"),
    ),
    ("social.js", include_str!("../../../web/admin/social.js")),
    (
        "voice-library.js",
        include_str!("../../../web/admin/voice-library.js"),
    ),
    (
        "announcements.js",
        include_str!("../../../web/admin/announcements.js"),
    ),
    (
        "voice-polished.js",
        include_str!("../../../web/admin/voice-polished.js"),
    ),
    (
        "checks-panel.js",
        include_str!("../../../web/admin/checks-panel.js"),
    ),
    (
        "job-form.js",
        include_str!("../../../web/admin/job-form.js"),
    ),
    (
        "job-capture.js",
        include_str!("../../../web/admin/job-capture.js"),
    ),
    (
        "capture-queue.js",
        include_str!("../../../web/admin/capture-queue.js"),
    ),
    (
        "capture-recorder.js",
        include_str!("../../../web/admin/capture-recorder.js"),
    ),
    (
        "capture-assistant.js",
        include_str!("../../../web/admin/capture-assistant.js"),
    ),
];

pub const EMBEDDED_BASE_THEME: &str = include_str!("../../../themes/base/theme.json");

/// The search engine compiled to WebAssembly, so a blog created with
/// `openblog init` gets search without a Rust workspace or wasm-pack.
/// Rebuild with `openblog build-wasm` in the engine repository after changing
/// openblog-core, and commit the result.
pub const EMBEDDED_WEB_BINARY: &[(&str, &[u8])] = &[
    // Official, unmodified ORCID unauthenticated icon colorways. The public
    // component crops the green first panel at display time.
    // Source: https://info.orcid.org/wp-content/uploads/2024/11/orcid-unauthenticated-id-icon.png
    (
        "orcid-unauthenticated-id-icons.png",
        include_bytes!("../../../web/orcid-unauthenticated-id-icons.png"),
    ),
    (
        "wasm/openblog_wasm.js",
        include_bytes!("../../../web/wasm/openblog_wasm.js"),
    ),
    (
        "wasm/openblog_wasm_bg.wasm",
        include_bytes!("../../../web/wasm/openblog_wasm_bg.wasm"),
    ),
];

/// Example themes written by `openblog init`, so the docs' examples exist in
/// every new blog.
pub const EMBEDDED_THEMES: &[(&str, &str)] = &[
    (
        "demo/theme.json",
        include_str!("../../../themes/demo/theme.json"),
    ),
    (
        "demo/reveal.js",
        include_str!("../../../themes/demo/reveal.js"),
    ),
    (
        "demo/theme.css",
        include_str!("../../../themes/demo/theme.css"),
    ),
    (
        "paper/theme.json",
        include_str!("../../../themes/paper/theme.json"),
    ),
];

/// A GitHub Pages workflow for a blog in its own repository.
pub const PAGES_WORKFLOW: &str = include_str!("../templates/pages.yml");

/// A view counter for Cloudflare Workers, written by `openblog analytics worker`.
pub const COUNTER_WORKER: &str = include_str!("../templates/counter-worker.js");
pub const COUNTER_WRANGLER: &str = include_str!("../templates/wrangler.toml");

/// A view counter as a Node + MongoDB web service (Render blueprint included),
/// written by `openblog analytics service`.
pub const COUNTER_SERVICE: &[(&str, &str)] = &[
    (
        "server.js",
        include_str!("../templates/counter-service/server.js"),
    ),
    (
        "package.json",
        include_str!("../templates/counter-service/package.json"),
    ),
    (
        "render.yaml",
        include_str!("../templates/counter-service/render.yaml"),
    ),
    // keep-awake.yml goes into the blog's own .github/workflows/, see KEEP_AWAKE_WORKFLOW.
    (
        "README.md",
        include_str!("../templates/counter-service/README.md"),
    ),
];

/// A workflow that pings the counter so a free Render service never sleeps.
pub const KEEP_AWAKE_WORKFLOW: &str = include_str!("../templates/counter-service/keep-awake.yml");

pub struct BuildOptions {
    /// Include drafts and scheduled posts (a preview build).
    pub include_drafts: bool,
    pub out_override: Option<PathBuf>,
    /// The current time; posts dated later are held back as scheduled.
    pub now: Option<DateTime>,
}

pub struct BuildReport {
    pub posts: usize,
    pub series: usize,
    pub tags: usize,
    pub pages: usize,
    pub files: usize,
    pub scheduled: usize,
    /// When the next scheduled post goes live.
    pub next_due: Option<DateTime>,
    pub out_dir: PathBuf,
    pub warnings: Vec<String>,
    pub accessibility: Vec<AccessibilityFinding>,
    pub evidence: Vec<EvidenceFinding>,
    /// Source-review findings about the sources posts cite (ADR 0148).
    pub source_review: Vec<openblog_core::source_review::SourceReviewFinding>,
    /// What the research projections published and withheld (ADR 0125).
    pub boundary: openblog_core::publication_boundary::BoundaryManifest,
    /// The research readiness report the build was checked against (ADR 0150),
    /// when the site has research to report on; `None` for a site without any.
    pub readiness: Option<crate::readiness::Readiness>,
}

pub fn load_config(root: &Path) -> Result<SiteConfig, String> {
    let path = root.join(CONFIG_FILE);
    let json = fs::read_to_string(&path).map_err(|e| {
        format!(
            "cannot read {} ({e}). Run `openblog init` to create a project, or `--root <dir>` to point at one.",
            path.display()
        )
    })?;
    let mut config = SiteConfig::from_json(&json)?;
    // Containers and PaaS hosts always sit behind an HTTPS proxy whose address
    // is not known in advance; one variable sets both proxy-related options.
    if std::env::var("OPENBLOG_BEHIND_PROXY")
        .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
        .unwrap_or(false)
    {
        config.admin.secure_cookies = true;
        config.admin.trusted_proxies = vec!["*".to_string()];
    }
    Ok(config)
}

pub fn read_sources(root: &Path, config: &SiteConfig) -> Result<Sources, String> {
    read_sources_excluding(root, config, None)
}

/// Whether a file under the content folder (its `/`-separated path relative
/// to that folder) is left out of the build whatever its kind: a README
/// anywhere, and any file or folder whose name starts with `_`. Everything
/// that must agree with the build about which posts exist uses this together
/// with [`openblog_core::classify_source`].
pub fn not_content(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower == "readme.md"
        || lower.ends_with("/readme.md")
        || rel.split('/').any(|part| part.starts_with('_'))
}

/// Read content while optionally replacing one source in memory. Admin uses
/// this to validate a repair for a malformed credit sidecar without first
/// having to parse the broken file from disk.
pub fn read_sources_excluding(
    root: &Path,
    config: &SiteConfig,
    excluded: Option<&str>,
) -> Result<Sources, String> {
    let content_dir = root.join(&config.paths.content);
    let mut sources = Sources::default();
    for path in content_files(&content_dir)? {
        let rel = fsutil::relative(&content_dir, &path);
        if excluded.is_some_and(|excluded| excluded == rel) {
            continue;
        }
        if not_content(&rel) {
            continue;
        }
        let Some(source_kind) = openblog_core::classify_source(&rel) else {
            continue;
        };
        let bytes = fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let contents = match String::from_utf8(bytes) {
            Ok(contents) => contents,
            Err(_) if source_kind == openblog_core::SourceKind::PostCredits => {
                // Preserve the sidecar in the source index so callers can
                // report a document-scoped credit error instead of losing the
                // entire listing. The Admin GET path reads the original bytes
                // separately and reports the precise UTF-8 failure.
                "<invalid UTF-8 credit sidecar>".into()
            }
            Err(_) => return Err(format!("{rel} is not valid UTF-8")),
        };
        sources.add(SourceFile {
            path: rel,
            contents,
        });
    }
    // A deferred read: the load reads the library only when an opted-in post
    // cites something; see `Site::load`.
    sources.source_library = Some(crate::source_store::read_for_build(root));
    // Approved reader feedback the site publishes (ADR 0083), a versioned
    // file beside the posts.
    sources.reader_feedback = read_reader_feedback(root, config)?;
    // Approved Third Perspectives the site publishes (ADR 0115), the same way.
    sources.third_perspectives = read_content_file(
        root,
        config,
        openblog_core::perspective_publication::THIRD_PERSPECTIVES_FILE,
    )?;
    // Featured reflections (ADR 0181), the same way.
    sources.community_features = read_content_file(
        root,
        config,
        openblog_core::community_feature::COMMUNITY_FEATURES_FILE,
    )?;
    // The landing page (ADR 0245), the same way. A file that cannot be used
    // is a build warning, never an error (ADR 0246).
    sources.landing = read_content_file(root, config, openblog_core::landing::LANDING_FILE)?;
    // Continuation links (ADR 0219), the same way.
    sources.continuations = read_content_file(
        root,
        config,
        openblog_core::continuation::CONTINUATIONS_FILE,
    )?;
    // Claim evidence is read only while the site publishes it (ADR 0075).
    if config.claim_evidence.publish {
        sources.claim_evidence = Some(crate::claims_store::evidence_for_build(
            root,
            &config.contributors,
        ));
    }
    Ok(sources)
}

/// The published reader feedback file (`reader-feedback.json` in the content
/// folder), when it exists. Its contents are checked by the site load.
pub fn read_reader_feedback(
    root: &Path,
    config: &SiteConfig,
) -> Result<Option<SourceFile>, String> {
    read_content_file(
        root,
        config,
        openblog_core::feedback_publication::READER_FEEDBACK_FILE,
    )
}

/// A versioned file the site publishes from, beside the posts in the content
/// folder, when it exists. Its contents are checked by the site load.
pub fn read_content_file(
    root: &Path,
    config: &SiteConfig,
    name: &str,
) -> Result<Option<SourceFile>, String> {
    let path = root.join(&config.paths.content).join(name);
    let display = format!(
        "{}/{name}",
        config.paths.content.trim_end_matches(['/', '\\'])
    );
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {display}: {error}")),
        Ok(metadata) if !metadata.is_file() => {
            return Err(format!("{display} must be a regular file"))
        }
        Ok(_) => {}
    }
    let bytes = fs::read(&path).map_err(|error| format!("cannot read {display}: {error}"))?;
    let contents = String::from_utf8(bytes).unwrap_or_else(|_| "not UTF-8".into());
    Ok(Some(SourceFile {
        path: display,
        contents,
    }))
}

/// Walk content deterministically without descending through an unchecked
/// directory symlink. Canonical directories are remembered so symlink cycles
/// fail instead of recursing forever.
pub(crate) fn content_files(content_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let canonical_content = match fs::canonicalize(content_dir) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!("cannot resolve {}: {error}", content_dir.display()));
        }
    };
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    visit_content_dir(content_dir, &canonical_content, &mut visited, &mut files)?;
    files.sort();
    Ok(files)
}

fn visit_content_dir(
    directory: &Path,
    canonical_content: &Path,
    visited: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let canonical_directory = fs::canonicalize(directory)
        .map_err(|error| format!("cannot resolve {}: {error}", directory.display()))?;
    if !canonical_directory.starts_with(canonical_content) {
        return Err(format!(
            "{} resolves outside the content directory",
            directory.display()
        ));
    }
    if !visited.insert(canonical_directory) {
        return Err(format!(
            "{} creates a directory symlink cycle",
            directory.display()
        ));
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("cannot read {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read {}: {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let canonical = fs::canonicalize(&path)
            .map_err(|error| format!("cannot resolve {}: {error}", path.display()))?;
        if !canonical.starts_with(canonical_content) {
            return Err(format!(
                "{} resolves outside the content directory",
                path.display()
            ));
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
        if metadata.is_dir() {
            visit_content_dir(&path, canonical_content, visited, files)?;
        } else if metadata.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

pub fn load_themes(root: &Path, config: &SiteConfig) -> Result<ThemeSet, String> {
    let themes_dir = root.join(&config.paths.themes);
    let mut set = ThemeSet::new();
    let Ok(entries) = fs::read_dir(&themes_dir) else {
        return Ok(set);
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let name = dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let file = dir.join("theme.json");
        if !file.exists() {
            continue;
        }
        let json = fs::read_to_string(&file)
            .map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        let theme = ThemeFile::from_json(&json).map_err(|e| format!("{}: {e}", file.display()))?;
        set.insert(&name, theme);
    }
    Ok(set)
}

/// When a CDN is configured without an explicit version, derive one from the
/// asset files so a changed stylesheet, script, font, or image gets a new URL
/// and old cached copies are never served.
pub fn with_asset_version(root: &Path, mut config: SiteConfig) -> SiteConfig {
    // Always version asset URLs, CDN or not: a changed file gets a new URL, so
    // browsers and caches may keep assets without ever serving a stale one.
    if !config.cdn.version.trim().is_empty() {
        return config;
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    // Private project state never feeds the public version, or a private edit
    // would change every public asset URL.
    let private = fsutil::PrivateState::of(root).withhold(&comparison_files(root, &config));
    for dir in [
        &config.paths.web,
        &config.paths.themes,
        &config.paths.static_dir,
    ] {
        let base = root.join(dir);
        for file in fsutil::walk(&base) {
            if private.contains(&file) {
                continue;
            }
            mix(fsutil::relative(&base, &file).as_bytes());
            // Text assets by content; everything else (images, fonts) by size, which is
            // cheap and changes whenever the file is replaced.
            let is_text = file
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| matches!(e, "css" | "js" | "mjs" | "json"));
            if is_text {
                if let Ok(bytes) = fs::read(&file) {
                    mix(&bytes);
                }
            } else if let Ok(meta) = fs::metadata(&file) {
                mix(&meta.len().to_le_bytes());
            }
        }
    }
    for (_, embedded) in EMBEDDED_WEB {
        mix(embedded.as_bytes());
    }
    config.cdn.version = format!("{:08x}", (h >> 32) as u32 ^ h as u32);
    config
}

/// View totals known at build time: the local analytics store if present,
/// otherwise the copy on the analytics branch (what a CI build sees).
pub fn view_counts(root: &Path, config: &SiteConfig) -> std::collections::BTreeMap<String, u64> {
    if !config.analytics.bake_counts {
        return Default::default();
    }
    let local = root.join(".openblog").join("analytics.json");
    if local.exists() {
        return crate::analytics::Store::load(&local, config.analytics.retention_days).all_totals();
    }
    let branch = config.analytics.branch.trim();
    if branch.is_empty() {
        return Default::default();
    }
    let git = crate::git::Git::new(root);
    let from_branch = git
        .read_file(branch, "analytics.json")
        .or_else(|| git.read_file(&format!("origin/{branch}"), "analytics.json"));
    match from_branch {
        Some(json) => {
            let mut store = crate::analytics::Store::load(
                Path::new("/nonexistent"),
                config.analytics.retention_days,
            );
            if store.restore_from_json(&json).is_ok() {
                return store.all_totals();
            }
            Default::default()
        }
        None => Default::default(),
    }
}

pub fn load_site(
    root: &Path,
    include_drafts: bool,
    now: Option<DateTime>,
) -> Result<(Site, ThemeSet), String> {
    let config = load_config(root)?;
    let sources = read_sources(root, &config)?;
    load_site_from_sources(
        root,
        config,
        sources,
        LoadOptions {
            include_drafts,
            now,
            preview_source: None,
        },
    )
}

/// Load a production-faithful site after a caller has substituted in-memory
/// sources, as the admin preview does for an unsaved document.
pub fn load_site_from_sources(
    root: &Path,
    config: SiteConfig,
    sources: Sources,
    options: LoadOptions,
) -> Result<(Site, ThemeSet), String> {
    load_site_from_sources_listing(root, config, sources, options)
        .map_err(|errors| content_problems(&errors))
}

/// The problems of a failed site load as one message.
pub fn content_problems(errors: &[String]) -> String {
    format!(
        "{} problem(s) in your content:\n  - {}",
        errors.len(),
        errors.join("\n  - ")
    )
}

/// [`load_site_from_sources`], keeping each content problem apart so a caller
/// such as the Admin preview can report only those of one document.
pub fn load_site_from_sources_listing(
    root: &Path,
    config: SiteConfig,
    sources: Sources,
    options: LoadOptions,
) -> Result<(Site, ThemeSet), Vec<String>> {
    let config = with_asset_version(root, config);
    let counts = view_counts(root, &config);
    let themes = load_themes(root, &config).map_err(|error| vec![error])?;
    let mut site = Site::load(config, sources, options)?;
    site.view_counts = counts;
    Ok((site, themes))
}

/// An admin UI file: from `web/admin/` if present, else the embedded copy.
pub fn admin_file(root: &Path, config: &SiteConfig, rel: &str) -> Option<Vec<u8>> {
    if let Ok(bytes) = fs::read(root.join(&config.paths.web).join("admin").join(rel)) {
        return Some(bytes);
    }
    EMBEDDED_ADMIN
        .iter()
        .find(|(p, _)| *p == rel)
        .map(|(_, c)| c.as_bytes().to_vec())
}

/// The front-end assets the site's own `paths.web` folder adds to (or
/// overrides in) the embedded ones, as paths under `assets/`: stylesheets,
/// scripts and the WebAssembly build, never the Admin's.
pub(crate) fn web_dir_assets(root: &Path, config: &SiteConfig) -> Vec<String> {
    let web_dir = root.join(&config.paths.web);
    let mut found = Vec::new();
    for file in fsutil::walk(&web_dir) {
        let rel = fsutil::relative(&web_dir, &file);
        if rel.starts_with("admin/") {
            continue;
        }
        let is_asset = rel.ends_with(".css") || rel.ends_with(".js") || rel.ends_with(".mjs");
        let is_wasm = rel.starts_with("wasm/") && (rel.ends_with(".js") || rel.ends_with(".wasm"));
        if is_asset || is_wasm {
            found.push(rel);
        }
    }
    found
}

pub fn web_file(root: &Path, config: &SiteConfig, rel: &str) -> Option<Vec<u8>> {
    let on_disk = root.join(&config.paths.web).join(rel);
    if let Ok(bytes) = fs::read(&on_disk) {
        return Some(bytes);
    }
    if let Some((_, c)) = EMBEDDED_WEB.iter().find(|(p, _)| *p == rel) {
        return Some(c.as_bytes().to_vec());
    }
    EMBEDDED_WEB_BINARY
        .iter()
        .find(|(p, _)| *p == rel)
        .map(|(_, c)| c.to_vec())
}

/// The public Knowledge Atlas projection, when the site opts in to publishing
/// it (ADR 0058). A site that does not never reads the private atlas. The atlas
/// is read and validated against the library and notebook exactly as Admin
/// reads it, and a problem refuses the build before anything is written,
/// naming the file and ids only.
///
/// The atlas is private and Git-ignored, so a build from a clone (CI, a static
/// host) finds none and would publish an empty atlas: that build is warned in
/// `warnings`, which `build` and `check` both report.
pub fn published_atlas(
    root: &Path,
    config: &SiteConfig,
    warnings: &mut Vec<String>,
) -> Result<Option<openblog_core::atlas_publication::PublicAtlas>, String> {
    if !config.knowledge_atlas.publish {
        return Ok(None);
    }
    let loaded = crate::atlas_store::load_for_build(root, &config.contributors)
        .map_err(|error| error.to_string());
    published_atlas_from(config, loaded.as_ref(), warnings)
}

/// [`published_atlas`] over an atlas snapshot already read (or the reason it
/// could not be), so one read serves the build, the preview and the guard.
pub fn published_atlas_from(
    config: &SiteConfig,
    loaded: Result<&crate::atlas_store::Snapshot, &String>,
    warnings: &mut Vec<String>,
) -> Result<Option<openblog_core::atlas_publication::PublicAtlas>, String> {
    if !config.knowledge_atlas.publish {
        return Ok(None);
    }
    let unpublishable = |error: String| {
        format!(
            "the Knowledge Atlas cannot be published ({error}); run `openblog check` and repair it, or set `knowledgeAtlas.publish` to false. Nothing was written."
        )
    };
    let snapshot = loaded.map_err(|error| unpublishable(error.clone()))?;
    if !snapshot.stored {
        warnings.push(unstored_atlas_warning());
    }
    let undated = snapshot.atlas.entries_with_unpublished_datings();
    if !undated.is_empty() {
        warnings.push(unpublished_datings_warning(&undated));
    }
    openblog_core::atlas_publication::PublicAtlas::project(&snapshot.atlas, &snapshot.library)
        .map(Some)
        .map_err(unpublishable)
}

/// The most entries [`unpublished_datings_warning`] names before it counts
/// the rest.
const NAMED_UNDATED_ENTRIES: usize = 20;

/// What `build` and `check` say when approved entries carry datings none of
/// which may be published, so their years are missing from /atlas/ and
/// atlas.json. An uncited date is never published; the warning only says so,
/// naming ids and counts.
fn unpublished_datings_warning(
    undated: &[(usize, &openblog_core::knowledge_atlas::Entry)],
) -> String {
    let mut named: Vec<String> = undated
        .iter()
        .take(NAMED_UNDATED_ENTRIES)
        .map(|(_, entry)| {
            let count = entry.dates.len();
            format!(
                "`{}` ({count} dating{})",
                entry.id,
                if count == 1 { "" } else { "s" }
            )
        })
        .collect();
    if undated.len() > NAMED_UNDATED_ENTRIES {
        named.push(format!(
            "and {} more",
            undated.len() - NAMED_UNDATED_ENTRIES
        ));
    }
    format!(
        "{} approved Knowledge Atlas entr{} no years on /atlas/ or in atlas.json, because none of {} datings can be published: {}. Only cited, approved datings of published items, relative only to approved entries, are published, and years from version 1 `bounds` became private, unsourced datings. `openblog check` gives each dating's reason.",
        undated.len(),
        if undated.len() == 1 {
            "y shows"
        } else {
            "ies show"
        },
        if undated.len() == 1 { "its" } else { "their" },
        named.join(", ")
    )
}

/// What `build` and `check` say when the site publishes its atlas but this
/// build cannot read one.
fn unstored_atlas_warning() -> String {
    format!(
        "`knowledgeAtlas.publish` is on, but no Knowledge Atlas is stored at {}, so /atlas/ and atlas.json are published empty. The atlas is private and Git-ignored: only a build that can read it publishes it (`openblog serve` and Admin, or a local `openblog build` you then upload). A CI or static-host build from the repository cannot.",
        crate::atlas_store::ATLAS_FILE
    )
}

/// The public comparison projection, when the site opts in to publishing
/// comparisons (ADR 0092). A site that does not never reads the private
/// alignments file. The file is read and validated against the library and
/// the notebook, and of the library's interpretations only those an approved
/// alignment publishes are validated (ADR 0087); a problem refuses the build
/// before anything is written, naming the file and ids only. An Admin save,
/// which only loads content, is never stopped by it.
///
/// The alignments file is private and Git-ignored, so a build from a clone
/// finds none and publishes no comparisons: that build is warned in
/// `warnings`, which `build` and `check` both report.
pub fn published_comparisons(
    root: &Path,
    config: &SiteConfig,
    warnings: &mut Vec<String>,
) -> Result<Option<openblog_core::comparison_publication::PublicComparisons>, String> {
    if !config.comparisons.publish {
        return Ok(None);
    }
    let loaded = crate::alignment_store::load_for_build(root, &config.contributors);
    published_comparisons_from(config, loaded.as_ref(), warnings)
}

/// [`published_comparisons`] over an alignments snapshot already read (or
/// the reason it could not be).
pub fn published_comparisons_from(
    config: &SiteConfig,
    loaded: Result<&crate::alignment_store::Snapshot, &String>,
    warnings: &mut Vec<String>,
) -> Result<Option<openblog_core::comparison_publication::PublicComparisons>, String> {
    if !config.comparisons.publish {
        return Ok(None);
    }
    let unpublishable = |error: String| {
        format!(
            "passage comparisons cannot be published ({error}); run `openblog check` and repair it, or set `comparisons.publish` to false. Nothing was written."
        )
    };
    let snapshot = loaded.map_err(|error| unpublishable(error.clone()))?;
    if !snapshot.stored {
        warnings.push(unstored_comparisons_warning());
    }
    openblog_core::comparison_publication::PublicComparisons::project(
        &snapshot.alignments,
        openblog_core::comparison_publication::ComparisonInputs {
            library: &snapshot.library,
            notebook: &snapshot.notebook,
            contributors: &config.contributors,
        },
    )
    .map(Some)
    .map_err(unpublishable)
}

/// What `build` and `check` say when the site publishes comparisons but this
/// build cannot read the alignments file.
fn unstored_comparisons_warning() -> String {
    format!(
        "`comparisons.publish` is on, but no alignments file is stored at {}, so /comparisons/ and comparisons.json are published empty. Alignments are private and Git-ignored: only a build that can read them publishes comparisons (`openblog serve` and Admin, or a local `openblog build` you then upload). A CI or static-host build from the repository cannot.",
        crate::alignment_store::ALIGNMENTS_FILE
    )
}

/// Everything a full build or `check` generates, after the guards that keep
/// private research out of public inputs and generated output.
pub fn generate_site(
    root: &Path,
    site: &mut Site,
    themes: &ThemeSet,
) -> Result<Vec<openblog_core::OutputFile>, String> {
    generate_site_with_boundary(root, site, themes).map(|(files, _)| files)
}

/// [`generate_site`], with the publication boundary manifest the output was
/// checked against (ADR 0125).
pub fn generate_site_with_boundary(
    root: &Path,
    site: &mut Site,
    themes: &ThemeSet,
) -> Result<
    (
        Vec<openblog_core::OutputFile>,
        openblog_core::publication_boundary::BoundaryManifest,
    ),
    String,
> {
    // Private research must never ride into a public folder (an export saved
    // into static/, a copied notebook): refuse before anything is generated.
    crate::private_guard::refuse_private_research_in_public_inputs(root, &site.config)?;
    // The research projections, attached exactly as the Admin preview of the
    // boundary attaches them (ADR 0125); here a projection that cannot be
    // built refuses the output.
    let shared = crate::boundary::Shared::read(root, &site.config);
    let blocked = crate::boundary::project_with(root, site, &shared);
    if let Some(error) = blocked.atlas.as_ref().or(blocked.comparisons.as_ref()) {
        return Err(error.clone());
    }
    // Published claim evidence that cannot be read refuses the whole output
    // rather than publishing posts without it, as a damaged atlas does
    // (ADR 0075). Only here: an Admin save's validation render is not stopped.
    if let Some(error) = &site.claim_evidence_error {
        return Err(error.clone());
    }
    // Published reader feedback that cannot be read refuses the output the
    // same way, rather than dropping notes the author published (ADR 0083).
    if let Some(error) = &site.reader_feedback_error {
        return Err(error.clone());
    }
    // And published Third Perspectives, rather than dropping reflections a
    // moderator approved (ADR 0115).
    if let Some(error) = &site.third_perspectives_error {
        return Err(error.clone());
    }
    // And featured reflections (ADR 0181).
    if let Some(error) = &site.community_features_error {
        return Err(error.clone());
    }
    // And continuation links (ADR 0219).
    if let Some(error) = &site.continuations_error {
        return Err(error.clone());
    }
    // What the projections publish and withhold; a stale approval or an
    // unsafe web address withholds only what it affects, and is named.
    let stores = crate::boundary::Stores::read(root, &shared);
    // The author's curated selections that cannot be read refuse the output
    // rather than publishing the site without them, as a damaged claims file
    // does. Only here: an Admin save's validation render is not stopped.
    if let Some(error) = crate::boundary::selections_error(site, &stores) {
        return Err(error);
    }
    let mut manifest = crate::boundary::manifest(site, &stores, &blocked, None);
    site.warnings.extend(manifest.build_warnings());
    // Required destinations (including full-content feeds) must succeed before
    // generated output or stale files are changed.
    let files = generate(site, themes)?;
    site.warnings
        .extend(openblog_core::render::atlas_trail_warning(site));
    crate::private_guard::refuse_private_research_in_output(&files)?;
    // Private text found outside a projection's machine data only warns.
    let text_matches = crate::boundary::check_output(root, site, &manifest, &files)?;
    manifest.text_matches.clone_from(&text_matches);
    site.warnings.extend(text_matches);
    Ok((files, manifest))
}

pub fn build(root: &Path, options: &BuildOptions) -> Result<BuildReport, String> {
    let config = load_config(root)?;
    let sources = read_sources(root, &config)?;
    // Evidence gaps in the private claims file, for the author only: printed
    // with the other evidence findings, never written to the output. They are
    // reviewed against the posts this build read, before the load takes them.
    let claim_findings = crate::claims_store::build_findings(root, &config.contributors, &sources);
    // What the research report needs to know without loading the site again:
    // how many posts there are to hold, and whether any is a research post.
    let saved_posts = sources.posts.len();
    let research_in_posts = sources
        .posts
        .iter()
        .any(|post| crate::readiness::is_research_source(&post.contents));
    let (mut site, themes) = load_site_from_sources(
        root,
        config,
        sources,
        LoadOptions {
            include_drafts: options.include_drafts,
            now: options.now,
            preview_source: None,
        },
    )?;
    let (files, boundary) = generate_site_with_boundary(root, &mut site, &themes)
        .map_err(|error| crate::readiness::alongside(root, &site, error))?;
    // The one research report, read before anything is written: a failure of a
    // private file the build reads refuses the build while the output folder is
    // still exactly as it was (ADR 0150). Every other finding is for the
    // author to decide and never stops anything.
    let every_post = site.posts.len() == saved_posts;
    let mut readiness =
        crate::readiness::report_of_held(root, &site, every_post, Some(research_in_posts));
    // A production build's log counts the findings about posts it does not
    // publish and never names them; `check` and Admin list each one.
    readiness.limit_text_to_published(site.posts.iter().map(|post| post.source.clone()).collect());
    if readiness.blocking() > 0 {
        return Err(format!(
            "research readiness: {} finding(s) refuse this build. Nothing was written.\n{}",
            readiness.blocking(),
            readiness.text().trim_end()
        ));
    }
    let readiness = readiness.applies.then_some(readiness);
    let config = &site.config;
    let mut warnings = site.warnings.clone();
    warnings.extend(
        crate::portable_export::build_diagnostics(&site)?
            .into_iter()
            .map(|warning| format!("portability: {warning}")),
    );
    let mut evidence = site.evidence.clone();
    match claim_findings {
        Ok(found) => evidence.extend(found),
        Err(warning) => warnings.push(warning),
    }
    let out_dir = options
        .out_override
        .clone()
        .unwrap_or_else(|| root.join(&config.paths.output));
    fsutil::guard_output_dir(root, &out_dir)?;
    // Claim the directory first, so a build that fails midway never leaves an
    // unmarked folder that every later build would refuse to touch.
    fsutil::write_file(
        &out_dir.join(fsutil::MARKER),
        b"Generated by open.blog. Safe to delete.\n",
    )?;

    let mut written: HashSet<String> = HashSet::new();
    let mut put = |rel: String, bytes: &[u8]| -> Result<(), String> {
        fsutil::write_file(&out_dir.join(&rel), bytes)?;
        written.insert(rel);
        Ok(())
    };

    // Private project state (logins, analytics, research) is never copied,
    // even when a static or theme directory is configured to contain it.
    let private = fsutil::PrivateState::of(root).withhold(&comparison_files(root, config));

    // 1. Static files (images, favicon, CNAME, ...) at the site root.
    let static_dir = root.join(&config.paths.static_dir);
    for file in fsutil::walk(&static_dir) {
        if private.contains(&file) {
            continue;
        }
        let rel = fsutil::relative(&static_dir, &file);
        let bytes = fs::read(&file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        put(rel, &bytes)?;
    }

    // 2. Front-end assets: base.css, the web components, and the WebAssembly build.
    let mut asset_names: Vec<String> = EMBEDDED_WEB
        .iter()
        .map(|(p, _)| p.to_string())
        .chain(EMBEDDED_WEB_BINARY.iter().map(|(p, _)| p.to_string()))
        .collect();
    for rel in web_dir_assets(root, config) {
        if !asset_names.contains(&rel) {
            asset_names.push(rel);
        }
    }
    for rel in asset_names {
        if let Some(bytes) = web_file(root, config, &rel) {
            put(format!("assets/{rel}"), &bytes)?;
        }
    }

    // 3. Theme directories (fonts, images, theme.css). Generated tokens come next and win.
    let themes_dir = root.join(&config.paths.themes);
    for file in fsutil::walk(&themes_dir) {
        if private.contains(&file) {
            continue;
        }
        let rel = fsutil::relative(&themes_dir, &file);
        let bytes = fs::read(&file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        put(format!("themes/{rel}"), &bytes)?;
    }

    // 4. Generated pages, feeds, and tokens.
    let count = files.len();
    for f in files {
        put(f.path, f.contents.as_bytes())?;
    }

    fsutil::remove_stale(&out_dir, &written);

    Ok(BuildReport {
        posts: site.posts.len(),
        series: site.series.len(),
        tags: site.tags.len(),
        pages: site.pages.len(),
        files: count,
        scheduled: site.scheduled.len(),
        next_due: site.next_scheduled(),
        out_dir,
        warnings,
        accessibility: site.accessibility.clone(),
        evidence,
        source_review: site.source_review.clone(),
        boundary,
        readiness,
    })
}

/// Paths whose changes should trigger a rebuild while serving.
pub fn watched_paths(root: &Path, config: &SiteConfig) -> Vec<PathBuf> {
    vec![
        root.join(CONFIG_FILE),
        root.join(&config.paths.content),
        root.join(&config.paths.static_dir),
        root.join(&config.paths.themes),
        root.join(&config.paths.web),
    ]
}

/// Where the interpretation comparison files are stored. They hold drafts and
/// unapproved AI text beside what is approved, so a configured static or theme
/// folder that contains them (a `static` of `.`) must never copy them raw: a
/// comparison reaches a page only through its projection (ADR 0232).
fn comparison_files(root: &Path, config: &SiteConfig) -> PathBuf {
    root.join(&config.paths.content)
        .join(openblog_core::scholarly_comparison::COMPARISONS_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "openblog-site-{tag}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn review_regression_summary_build_reports_portable_failure_without_failing_native_output() {
        let root = temp_root("portable-failure");
        fs::create_dir_all(root.join("content/posts")).unwrap();
        fs::write(
            root.join("openblog.json"),
            r#"{"url":"https://example.test","feeds":{"fullContent":false}}"#,
        )
        .unwrap();
        fs::write(
            root.join("content/posts/work.md"),
            "---\ntitle: Work\ndate: 2020-01-01\n---\n[Legacy](javascript:alert(1))\n",
        )
        .unwrap();
        let report = build(
            &root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .unwrap();
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("posts/work.md") && warning.contains("portable")));
        assert!(report.files > 0);
        let marker = fs::read(report.out_dir.join(fsutil::MARKER)).unwrap();
        let index = fs::read(report.out_dir.join("index.html")).unwrap();
        fs::write(
            report.out_dir.join("stale.txt"),
            "keep on preflight failure",
        )
        .unwrap();
        fs::write(
            root.join("openblog.json"),
            r#"{"url":"https://example.test","feeds":{"fullContent":true}}"#,
        )
        .unwrap();
        let error = build(
            &root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .err()
        .unwrap();
        assert!(error.contains("link must use"), "{error}");
        assert_eq!(
            fs::read(report.out_dir.join(fsutil::MARKER)).unwrap(),
            marker
        );
        assert_eq!(fs::read(report.out_dir.join("index.html")).unwrap(), index);
        assert_eq!(
            fs::read_to_string(report.out_dir.join("stale.txt")).unwrap(),
            "keep on preflight failure"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_relative_script_import_is_embedded() {
        // A built site without a local `web/` copy uses only these files; one
        // missing module makes the browser reject the whole openblog.js graph.
        let embedded: HashSet<&str> = EMBEDDED_WEB.iter().map(|(path, _)| *path).collect();
        let mut missing = Vec::new();
        for (path, contents) in EMBEDDED_WEB
            .iter()
            .filter(|(path, _)| path.ends_with(".js"))
        {
            let dir = Path::new(path).parent().unwrap_or(Path::new(""));
            for line in contents.lines() {
                let line = line.trim_start();
                if !line.starts_with("import ") {
                    continue;
                }
                let Some(spec) = line.split(['"', '\'']).nth(1) else {
                    continue;
                };
                let Some(relative) = spec.strip_prefix("./") else {
                    continue;
                };
                let target = dir.join(relative).to_string_lossy().replace('\\', "/");
                if !embedded.contains(target.as_str()) {
                    missing.push(format!("{path} imports {spec}"));
                }
            }
        }
        assert!(missing.is_empty(), "not embedded: {missing:?}");
    }

    #[test]
    fn missing_content_directory_is_an_empty_source_set() {
        let root = temp_root("missing-content");
        fs::create_dir_all(&root).unwrap();
        let sources = read_sources(&root, &SiteConfig::default()).unwrap();
        assert!(sources.posts.is_empty());
        assert!(sources.credits.is_empty());
        assert!(sources.series.is_empty());
        assert!(sources.pages.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn content_walk_rejects_external_directory_symlinks_before_descent() {
        use std::os::unix::fs::symlink;

        let root = temp_root("external-link");
        let content = root.join("content");
        let outside = root.join("outside");
        fs::create_dir_all(content.join("posts")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("external.md"), "external").unwrap();
        symlink(&outside, content.join("posts/external")).unwrap();

        let error = read_sources(&root, &SiteConfig::default()).unwrap_err();
        assert!(error.contains("outside the content directory"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn content_walk_rejects_directory_symlink_cycles() {
        use std::os::unix::fs::symlink;

        let root = temp_root("link-cycle");
        let content = root.join("content");
        fs::create_dir_all(content.join("posts")).unwrap();
        symlink(&content, content.join("posts/cycle")).unwrap();

        let error = read_sources(&root, &SiteConfig::default()).unwrap_err();
        assert!(error.contains("symlink cycle"));
        fs::remove_dir_all(root).unwrap();
    }

    const PRIVATE_MARKER: &str = "ob-private-source-7f3a";
    const NOTEBOOK_MARKER: &str = "ob-private-notebook-9d21";
    const ATLAS_MARKER: &str = "ob-private-atlas-3c58";

    /// A project with one public post and a private source library whose
    /// every field carries a marker that must never be published.
    fn project_with_private_library(tag: &str, config: &str) -> PathBuf {
        let root = temp_root(tag);
        fs::create_dir_all(root.join("content/posts")).unwrap();
        fs::write(root.join(CONFIG_FILE), config).unwrap();
        fs::write(
            root.join("content/posts/2026-01-05-hello.md"),
            "---\ntitle: Hello\ndate: 2026-01-05\nprofile: research\n---\n\nA public post.\n",
        )
        .unwrap();
        let library = format!(
            r#"{{"version":1,"sources":[{{"id":"{PRIVATE_MARKER}","kind":"work","title":"{PRIVATE_MARKER} title","notes":"{PRIVATE_MARKER} note"}}]}}"#
        );
        let path = root.join(crate::source_store::LIBRARY_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, library).unwrap();
        let notebook = format!(
            r#"{{"version":1,"passages":[{{"id":"p-leak","source":"{PRIVATE_MARKER}","excerpt":{{"text":"{NOTEBOOK_MARKER} quoted"}},"locators":[{{"kind":"page","value":"{NOTEBOOK_MARKER}"}}]}}],"notes":[{{"id":"n-leak","kind":"question","text":"{NOTEBOOK_MARKER} noted","passages":["p-leak"],"concepts":["{NOTEBOOK_MARKER}"]}}]}}"#
        );
        fs::write(root.join(crate::notebook_store::NOTEBOOK_FILE), notebook).unwrap();
        let atlas = format!(
            r#"{{"version":1,"entries":[{{"id":"{ATLAS_MARKER}","kind":"concept","label":"{ATLAS_MARKER} label","summary":"{ATLAS_MARKER} summary","visibility":"approved"}},{{"id":"w","kind":"work","label":"W","source":"{PRIVATE_MARKER}","visibility":"approved"}}],"relationships":[{{"id":"r","kind":"discusses","from":"w","to":"{ATLAS_MARKER}","assertedBy":{{"kind":"author"}},"evidence":[{{"source":"{PRIVATE_MARKER}","locators":[{{"kind":"section","value":"{ATLAS_MARKER}"}}],"margin":"{ATLAS_MARKER} evidence extra"}}],"uncertainty":"{ATLAS_MARKER} doubt","contestedBy":[{{"by":{{"kind":"named","name":"{ATLAS_MARKER} dissenter"}},"note":"{ATLAS_MARKER} dissent note"}}],"shelf":"{ATLAS_MARKER} relationship extra"}}],"workspace":"{ATLAS_MARKER} top-level extra"}}"#
        );
        // Positive control: the seeded file really is an atlas.
        assert!(openblog_core::research_bundle::looks_like_private_research(
            atlas.as_bytes()
        ));
        fs::write(root.join(crate::atlas_store::ATLAS_FILE), atlas).unwrap();
        root
    }

    fn assert_no_private_output(root: &Path) {
        let output = root.join("dist");
        let files = fsutil::walk(&output);
        assert!(!files.is_empty(), "the build wrote nothing");
        for file in files {
            let rel = fsutil::relative(&output, &file);
            let bytes = fs::read(&file).unwrap();
            assert!(
                !String::from_utf8_lossy(&bytes).contains(PRIVATE_MARKER)
                    && !String::from_utf8_lossy(&bytes).contains(NOTEBOOK_MARKER)
                    && !String::from_utf8_lossy(&bytes).contains(ATLAS_MARKER)
                    && !rel.contains("sources.json")
                    && !rel.contains("notebook.json")
                    && !rel.contains("atlas.json")
                    && !rel.contains(".openblog/private"),
                "{rel} exposes private source-library data"
            );
        }
    }

    fn production_build(root: &Path) -> BuildReport {
        build(
            root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .unwrap()
    }

    fn reading_path_project(tag: &str, config: &str) -> PathBuf {
        let root = temp_root(tag);
        fs::create_dir_all(root.join("content/posts")).unwrap();
        fs::create_dir_all(root.join("content/paths")).unwrap();
        fs::write(root.join(CONFIG_FILE), config).unwrap();
        for (slug, extra) in [
            ("one", ""),
            ("two", ""),
            (
                "secret",
                "draft: true
",
            ),
        ] {
            fs::write(
                root.join(format!("content/posts/2026-01-05-{slug}.md")),
                format!(
                    "---
title: Post {slug}
date: 2026-01-05
{extra}---

Body.
"
                ),
            )
            .unwrap();
        }
        let step = |id: &str, slug: &str, transition: bool| {
            let mut step = serde_json::json!({"id": id, "target": {"kind": "post", "slug": slug}});
            if transition {
                step["transition"] =
                    serde_json::json!({"relationship": "builds-on", "why": "Because."});
            }
            step
        };
        let path = serde_json::json!({
            "format": "openblog-reading-path", "version": 1, "title": "Route",
            "status": "published",
            "steps": [step("a", "one", false), step("b", "two", true), step("c", "secret", true)]
        });
        fs::write(root.join("content/paths/route.json"), path.to_string()).unwrap();
        // A damaged file never stops the others or the build.
        fs::write(root.join("content/paths/broken.json"), "{ not json").unwrap();
        root
    }

    #[test]
    fn interpretation_comparisons_publish_only_their_projection() {
        const SECRET: &str = "secret-source-marker";
        const DRAFT: &str = "DRAFT-COMPARISON-MARKER";
        let config = r#"{"interpretations":{"publish":true},"claimEvidence":{"publish":true},"paths":{"static":"."}}"#;
        let root = temp_root("interpretations");
        fs::create_dir_all(root.join("content/posts")).unwrap();
        fs::create_dir_all(root.join("content/comparisons")).unwrap();
        fs::write(root.join(CONFIG_FILE), config).unwrap();
        fs::write(
            root.join("content/posts/2026-01-07-cave.md"),
            "---\ntitle: Cave\ndate: 2026-01-07\n---\n\nThe cave educates.\n",
        )
        .unwrap();
        let library = format!(
            r#"{{"version":1,"sources":[{{"id":"plato","kind":"work","title":"Politeia","issued":"2003"}},{{"id":"{SECRET}","kind":"work","title":"{SECRET} title"}}]}}"#
        );
        let library_path = root.join(crate::source_store::LIBRARY_FILE);
        fs::create_dir_all(library_path.parent().unwrap()).unwrap();
        fs::write(&library_path, library).unwrap();
        let claims = serde_json::json!({"version": 1,
            "claims": [{"id": "c1", "post": "cave", "statement": "The cave educates.", "visibility": "approved"}],
            "links": [
                {"id": "l1", "claim": "c1", "relation": "supports", "visibility": "approved",
                 "evidence": {"source": "plato"}},
                {"id": "l2", "claim": "c1", "relation": "contextualizes",
                 "evidence": {"source": SECRET}}]})
        .to_string();
        fs::write(root.join(crate::claims_store::CLAIMS_FILE), claims).unwrap();
        let comparison = serde_json::json!({
            "format": "openblog-interpretation-comparison", "version": 1,
            "title": "What the cave stands for", "subject": "Readings of the cave.",
            "status": "published",
            "interpretations": [
                {"id": "a", "attribution": {"kind": "named", "name": "A school"},
                 "statement": "A city.", "evidence": [{"link": "l1"}, {"link": "l2"}, {"source": SECRET}]},
                {"id": "b", "attribution": {"kind": "source", "source": "plato"}, "statement": "A mind."},
                {"id": "c", "attribution": {"kind": "source", "source": SECRET}, "statement": "A third."}
            ]
        });
        fs::write(
            root.join("content/comparisons/cave.json"),
            comparison.to_string(),
        )
        .unwrap();
        let mut draft = comparison.clone();
        draft["status"] = serde_json::json!("draft");
        draft["title"] = serde_json::json!(format!("{DRAFT} title"));
        fs::write(
            root.join("content/comparisons/draft.json"),
            draft.to_string(),
        )
        .unwrap();
        // A damaged file never stops the others or the build.
        fs::write(root.join("content/comparisons/broken.json"), "{ not json").unwrap();

        production_build(&root);
        let on = dist_bytes(&root);
        let page = String::from_utf8(on["interpretations/cave/index.html"].clone()).unwrap();
        assert!(
            page.contains("The cave educates.") && page.contains("Politeia"),
            "{page}"
        );
        assert!(page.contains("A school") && !page.contains("id=\"i-c\""));
        assert!(!on.contains_key("interpretations/draft/index.html"));
        assert!(!on.contains_key("interpretations/broken/index.html"));
        // No output carries a private source or a draft, and the comparison
        // files are not copied raw even though the static folder is the root.
        for (path, bytes) in &on {
            let text = String::from_utf8_lossy(bytes);
            assert!(!text.contains(SECRET), "{path}");
            assert!(!text.contains(DRAFT), "{path}");
        }
        // Positive control: the static folder really is the project root.
        assert!(on.contains_key("content/posts/2026-01-07-cave.md"));
        assert!(
            on.keys()
                .all(|path| !path.starts_with("content/comparisons/")),
            "{:?}",
            on.keys()
                .filter(|p| p.contains("comparisons"))
                .collect::<Vec<_>>()
        );

        // Off, nothing is written and the folder is never read.
        fs::write(root.join(CONFIG_FILE), r#"{"paths":{"static":"."}}"#).unwrap();
        production_build(&root);
        let off = dist_bytes(&root);
        assert!(off.keys().all(|path| !path.starts_with("interpretations/")));
        fs::remove_dir_all(root).unwrap();
    }
    /// Approval of the exact text, revocation, a private note and hostile
    /// metadata through the whole build (#91): the page shows an approved AI
    /// explanation labelled as an AI draft, and no output holds the text again
    /// once the approval is removed or the text is edited after approval.
    #[test]
    fn an_ai_explanation_publishes_only_while_its_approval_matches_and_private_notes_never_do() {
        use openblog_core::scholarly_comparison::{Explanation, Level};
        const NOTE: &str = "PRIVATE-NOTE-MARKER";
        const AI_TEXT: &str = "AI-EXPLANATION-MARKER for beginners.";
        let root = temp_root("interpretation-approval");
        fs::create_dir_all(root.join("content/posts")).unwrap();
        fs::create_dir_all(root.join("content/comparisons")).unwrap();
        fs::write(
            root.join(CONFIG_FILE),
            r#"{"interpretations":{"publish":true}}"#,
        )
        .unwrap();
        fs::write(
            root.join("content/posts/2026-01-07-cave.md"),
            "---
title: Cave
date: 2026-01-07
---

The cave educates.
",
        )
        .unwrap();
        let digest = Explanation::new("e1", Level::Beginner, AI_TEXT).digest();
        let write = |text: &str, approval: Option<&str>| {
            let mut explanation = serde_json::json!({
                "id": "e1", "level": "beginner", "text": text,
                "origin": {"kind": "ai-draft", "tool": "A helper"}});
            if let Some(by) = approval {
                explanation["approval"] =
                    serde_json::json!({"by": by, "at": "2026-10-27", "digest": digest});
            }
            let comparison = serde_json::json!({
                "format": "openblog-interpretation-comparison", "version": 1,
                "title": "The cave <script>alert(1)</script>", "subject": "Readings.",
                "status": "published", "privateNote": NOTE,
                "interpretations": [
                    {"id": "a", "attribution": {"kind": "named", "name": "A school"},
                     "statement": "A city.", "privateNote": NOTE},
                    {"id": "b", "attribution": {"kind": "anonymous", "description": "A commentator"},
                     "statement": "A mind."}],
                "explanations": [explanation]});
            fs::write(
                root.join("content/comparisons/cave.json"),
                comparison.to_string(),
            )
            .unwrap();
        };
        let build_text = || {
            production_build(&root);
            dist_bytes(&root)
        };

        // Approved: the text shows, labelled as an AI draft a person approved.
        write(AI_TEXT, Some("Dana"));
        let on = build_text();
        let page = String::from_utf8(on["interpretations/cave/index.html"].clone()).unwrap();
        for (path, bytes) in &on {
            assert!(
                !String::from_utf8_lossy(bytes).contains("Dana"),
                "an approver's login reached {path}"
            );
        }
        assert!(page.contains("AI-EXPLANATION-MARKER"), "{page}");
        assert!(page.contains("approved by the author") && !page.contains("<script>alert(1)"));
        // The static copies sit beside the page, hold the approved explanation
        // with its AI label, link to the canonical page and hold nothing else.
        for name in ["portable.html", "portable.md", "portable.txt"] {
            let copy = String::from_utf8(on[&format!("interpretations/cave/{name}")].clone())
                .unwrap_or_default();
            assert!(copy.contains("AI-EXPLANATION-MARKER"), "{name}: {copy}");
            assert!(copy.contains("/interpretations/cave/"), "{name}: {copy}");
            // Text is plain text; the HTML copy must never hold the markup.
            assert!(
                name != "portable.html" || !copy.contains("<script"),
                "{copy}"
            );
        }
        assert!(!page.to_lowercase().contains("verified"), "{page}");
        // Search finds the comparison by its approved interpretation text.
        let search = String::from_utf8(on["search.json"].clone()).unwrap();
        assert!(search.contains("/interpretations/cave/") && search.contains("a city."));
        assert!(!search.contains("ai-explanation-marker"));
        for (path, bytes) in &on {
            assert!(
                !String::from_utf8_lossy(bytes).contains(NOTE),
                "a private note reached {path}"
            );
        }

        // Unapproved, or approval removed: the text is in no output, and the
        // file, which would publish an unapproved draft, publishes nothing.
        write(AI_TEXT, None);
        // Edited after approval: the old approval no longer matches.
        let edited = format!("{AI_TEXT} Edited later.");
        for off in [build_text(), {
            write(&edited, Some("Dana"));
            build_text()
        }] {
            for (path, bytes) in &off {
                assert!(
                    !String::from_utf8_lossy(bytes).contains("AI-EXPLANATION-MARKER"),
                    "an unapproved AI draft reached {path}"
                );
            }
            // A published file holding such text fails validation as a
            // whole, so the comparison has no page at all.
            assert!(!off.contains_key("interpretations/cave/index.html"));
            assert!(off
                .keys()
                .all(|path| !path.starts_with("interpretations/cave/")));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_landing_page_file_changes_only_the_home_page_and_leaves_drafts_out() {
        let root = reading_path_project("landing-build", "{}");
        production_build(&root);
        let before = dist_bytes(&root);
        fs::write(
            root.join("content/landing.json"),
            r#"{"format":"openblog-landing","version":1,"sections":[
                {"id":"hi","type":"welcome","heading":"Hello from the landing page"},
                {"id":"pick","type":"featured-post","post":"secret","heading":"Draft"},
                {"id":"new","type":"latest-posts","heading":"Latest"}]}"#,
        )
        .unwrap();
        production_build(&root);
        let after = dist_bytes(&root);
        let home = String::from_utf8(after["index.html"].clone()).unwrap();
        assert!(home.contains("Hello from the landing page"));
        assert!(home.contains("Post one"));
        assert!(!home.contains("Post secret"), "a draft is never featured");
        // The landing file itself is not published, and no other page changes.
        assert!(!after.contains_key("landing.json"));
        for (path, bytes) in &before {
            if path == "index.html" || path == "search.json" {
                continue;
            }
            assert_eq!(after.get(path), Some(bytes), "{path} changed");
        }
        fs::remove_file(root.join("content/landing.json")).unwrap();
        production_build(&root);
        assert_eq!(
            dist_bytes(&root),
            before,
            "removing the file restores the site"
        );
    }

    #[test]
    fn reading_paths_are_built_only_while_published_and_never_show_a_draft_step() {
        let root = reading_path_project("reading-paths", "{}");
        production_build(&root);
        let off = dist_bytes(&root);
        assert!(off.keys().all(|path| !path.starts_with("paths/")));
        // Only the shipped component and stylesheet carry the name; no page loads it.
        assert!(off
            .iter()
            .filter(|(path, _)| !path.starts_with("assets/"))
            .all(|(_, bytes)| !String::from_utf8_lossy(bytes).contains("ob-reading-path")));

        fs::write(
            root.join(CONFIG_FILE),
            r#"{"readingPaths":{"publish":true}}"#,
        )
        .unwrap();
        production_build(&root);
        let on = dist_bytes(&root);
        let page = String::from_utf8(on["paths/route/index.html"].clone()).unwrap();
        assert!(page.contains("Post one") && page.contains("Post two"));
        assert!(!page.contains("Post secret") && !page.contains("secret"));
        assert!(on.contains_key("paths/index.html"));
        assert!(!on.contains_key("paths/broken/index.html"));
        // Everything outside the path pages, the sitemap and the stylesheet is what it was.
        for (path, bytes) in &off {
            if path.starts_with("assets/") || path == "sitemap.xml" || path == "search.json" {
                continue;
            }
            // A post that is a step of a listed path gains one link section (ADR 0216).
            let page = String::from_utf8_lossy(&on[path]).into_owned();
            if path.starts_with("posts/") && page.contains("ob-in-paths") {
                let start = page.find("<section class=\"ob-in-paths\"").unwrap();
                let end = start
                    + page[start..]
                        .find(
                            "</section>
",
                        )
                        .unwrap()
                    + "</section>
"
                    .len();
                let stripped = format!("{}{}", &page[..start], &page[end..]);
                assert_eq!(stripped.as_bytes(), bytes.as_slice(), "{path}");
                continue;
            }
            assert_eq!(on.get(path), Some(bytes), "{path}");
        }
        assert!(on.contains_key("paths.json") && !off.contains_key("paths.json"));
        assert!(!String::from_utf8_lossy(&on["paths.json"]).contains("secret"));
        assert!(String::from_utf8_lossy(&on["search.json"]).contains("/paths/route/"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_normal_build_emits_no_private_source_library_data() {
        let root = project_with_private_library("private-library", "{}");
        let report = production_build(&root);
        assert_eq!(report.posts, 1);
        assert_no_private_output(&root);
        let search = fs::read_to_string(root.join("dist/search.json")).unwrap();
        assert!(!search.contains(NOTEBOOK_MARKER) && !search.contains(ATLAS_MARKER));
        assert!(
            search.contains("Hello"),
            "the public search index is still built"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn static_files_never_copy_private_project_state() {
        // A misconfigured project whose static directory is the project root.
        let root = project_with_private_library("private-static", r#"{"paths":{"static":"."}}"#);
        fs::write(root.join("public-note.txt"), "copied").unwrap();
        production_build(&root);
        assert_no_private_output(&root);
        assert!(
            root.join("dist/public-note.txt").exists(),
            "other static files still copy"
        );
        fs::remove_dir_all(root).unwrap();

        // Nor do private bytes feed the public asset version: editing the
        // library must not change a single `?v=` asset URL.
        let root =
            project_with_private_library("private-static-version", r#"{"paths":{"static":"."}}"#);
        let version = |root: &Path| {
            let config = load_config(root).unwrap();
            with_asset_version(root, config).cdn.version
        };
        let before = version(&root);
        fs::write(
            root.join(crate::source_store::LIBRARY_FILE),
            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"B"}]}"#,
        )
        .unwrap();
        assert_eq!(
            version(&root),
            before,
            "private edits changed the asset version"
        );
        fs::write(
            root.join(crate::notebook_store::NOTEBOOK_FILE),
            r#"{"version":1,"notes":[{"id":"n","kind":"question","text":"changed"}]}"#,
        )
        .unwrap();
        assert_eq!(
            version(&root),
            before,
            "private notebook edits changed the asset version"
        );
        fs::write(
            root.join(crate::atlas_store::ATLAS_FILE),
            r#"{"version":1,"entries":[{"id":"c","kind":"concept","label":"changed"}]}"#,
        )
        .unwrap();
        assert_eq!(
            version(&root),
            before,
            "private atlas edits changed the asset version"
        );
        fs::remove_dir_all(root).unwrap();

        // A static file that is a symlink into private storage.
        let root = project_with_private_library("private-static-link", "{}");
        fs::create_dir_all(root.join("static")).unwrap();
        let library = root.join(crate::source_store::LIBRARY_FILE);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&library, root.join("static/leak.json")).is_ok();
        #[cfg(windows)]
        let linked =
            std::os::windows::fs::symlink_file(&library, root.join("static/leak.json")).is_ok();
        if linked {
            production_build(&root);
            assert_no_private_output(&root);
            assert!(!root.join("dist/leak.json").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_build_publishes_only_the_public_description_of_cited_references() {
        let root = project_with_private_library("cited-build", "{}");
        let library = format!(
            r#"{{"version":1,"sources":[{{"id":"{PRIVATE_MARKER}","kind":"work","title":"{PRIVATE_MARKER} title"}},{{"id":"public-work","kind":"work","title":"A Public Title","issued":"2001","notes":"{PRIVATE_MARKER} note","identifiers":[{{"scheme":"my-drive","value":"{PRIVATE_MARKER}.pdf"}}]}}]}}"#
        );
        fs::write(root.join(crate::source_store::LIBRARY_FILE), library).unwrap();
        fs::write(
            root.join("content/posts/2026-01-06-cited.md"),
            "---\ntitle: Cited\ndate: 2026-01-06\ncitations: notes\n---\n\nA claim [@public-work, canonical 4].\n",
        )
        .unwrap();
        let report = production_build(&root);
        assert_eq!(report.posts, 2);
        assert_no_private_output(&root);
        let page = fs::read_to_string(root.join("dist/posts/cited/index.html"))
            .or_else(|_| fs::read_to_string(root.join("dist/cited/index.html")))
            .unwrap();
        assert!(page.contains("A Public Title. 2001, 4."), "{page}");
        assert!(page.contains("role=\"doc-noteref\""), "{page}");

        // An unknown key refuses the build before any output changes.
        let before = fs::read_to_string(root.join("dist/search.json")).unwrap();
        fs::write(
            root.join("content/posts/2026-01-06-cited.md"),
            "---\ntitle: Cited\ndate: 2026-01-06\ncitations: notes\n---\n\nA claim [@missing-work].\n",
        )
        .unwrap();
        let Err(error) = build(
            &root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        ) else {
            panic!("a build with an unknown citation key succeeded");
        };
        assert!(
            error.contains("posts/2026-01-06-cited.md: line 7: citation `missing-work`")
                && !error.contains(PRIVATE_MARKER),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(root.join("dist/search.json")).unwrap(),
            before
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn citations_and_claims_stay_separate() {
        let root = project_with_private_library("claims-citations", "{}");
        let library = r#"{"version":1,"sources":[{"id":"plato","kind":"work","title":"Politeia","issued":"2003"},{"id":"slings","kind":"edition","of":"plato","title":"Slings"}]}"#;
        fs::write(root.join(crate::source_store::LIBRARY_FILE), library).unwrap();
        fs::remove_file(root.join(crate::notebook_store::NOTEBOOK_FILE)).unwrap();
        fs::remove_file(root.join(crate::atlas_store::ATLAS_FILE)).unwrap();
        let post = "---\ntitle: Cave\ndate: 2026-01-07\ncitations: bibliography\n---\n\nThe cave educates [@slings, page 514].\n";
        let claims_file = root.join(crate::claims_store::CLAIMS_FILE);
        let options = BuildOptions {
            include_drafts: false,
            out_override: None,
            now: None,
        };
        // `p. 514` is not a locator kind: the citation check reports the same
        // problem whether or not a claims file exists, and never mentions it.
        let loose = post.replace("page 514", "p. 514");
        fs::write(root.join("content/posts/2026-01-07-cave.md"), &loose).unwrap();
        let refused = build(&root, &options).err().unwrap();
        fs::write(
            &claims_file,
            r#"{"version":1,"claims":[{"id":"c0","post":"cave","statement":"S"}]}"#,
        )
        .unwrap();
        assert_eq!(build(&root, &options).err().unwrap(), refused);
        assert!(!refused.contains("claim"), "{refused}");
        let loose_body = openblog_core::claims::anchor_text(&loose).unwrap();
        assert!(loose_body.contains("[@slings, p. 514]"));
        fs::remove_file(&claims_file).unwrap();
        fs::write(root.join("content/posts/2026-01-07-cave.md"), post).unwrap();

        // A citation with a locator is not a claim and asserts no relation.
        let body = openblog_core::claims::anchor_text(post).unwrap();
        let (library_set, notebook) = (
            openblog_core::source_library::SourceLibrary::parse(library, &Default::default())
                .unwrap(),
            openblog_core::research_notes::Notebook::default(),
        );
        let links = openblog_core::knowledge_atlas::Links {
            library: &library_set,
            notebook: &notebook,
        };
        let empty = openblog_core::claims::ClaimSet::default();
        assert!(empty.claims.is_empty() && empty.links.is_empty());
        assert_eq!(empty.counts("cave"), Default::default());

        production_build(&root);
        let without = dist_bytes(&root);
        let (mut site, themes) = load_site(&root, false, None).unwrap();
        generate_site(&root, &mut site, &themes).unwrap();
        let warnings = site.warnings.clone();

        // A claims file anchored on that very sentence, with approved support
        // and contradiction on the cited source, changes neither citation
        // resolution nor the bibliography.
        let start = body.find("The cave").unwrap();
        let text = "The cave educates";
        let claims = serde_json::json!({"version": 1,
            "claims": [{"id": "c1", "post": "cave", "statement": "The cave educates.",
                "anchor": {"start": start, "end": start + text.len(), "text": text},
                "visibility": "approved"}],
            "links": [
                {"id": "l1", "claim": "c1", "relation": "supports", "visibility": "approved",
                 "evidence": {"source": "slings", "locators": [{"kind": "page", "value": "514"}]}},
                {"id": "l2", "claim": "c1", "relation": "contradicts", "visibility": "approved",
                 "evidence": {"source": "plato"}}]})
        .to_string();
        let set = openblog_core::claims::ClaimSet::parse(&claims, links).unwrap();
        assert_eq!(
            set.claims[0].anchor.as_ref().unwrap().check(&body),
            openblog_core::claims::AnchorCheck::Verified
        );
        fs::write(&claims_file, &claims).unwrap();
        production_build(&root);
        assert_eq!(
            dist_bytes(&root),
            without,
            "a claims file changes no output"
        );
        let (mut site, themes) = load_site(&root, false, None).unwrap();
        generate_site(&root, &mut site, &themes).unwrap();
        assert_eq!(site.warnings, warnings);
        let page = without
            .iter()
            .find(|(path, _)| path.ends_with("cave/index.html"))
            .map(|(_, bytes)| String::from_utf8_lossy(bytes).into_owned())
            .unwrap();
        assert!(
            page.contains("Slings"),
            "the bibliography is unchanged: {page}"
        );
        assert!(!page.contains("The cave educates.") && !page.contains("contradicts"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_interpretation_naming_a_removed_contributor_never_breaks_a_build() {
        let root = project_with_private_library(
            "interpretation-build",
            r#"{"claimEvidence":{"publish":true}}"#,
        );
        // No contributor registry: `ada` was removed after she was named.
        let library = r#"{"version":1,"sources":[{"id":"plato","kind":"work","title":"Politeia"},{"id":"slings","kind":"edition","of":"plato","title":"Slings"}],"interpretations":[{"id":"cave-mine","kind":"reading","source":"slings","text":"ob-interpretation-secret","interpreters":[{"contributor":"ada"}]}]}"#;
        fs::write(root.join(crate::source_store::LIBRARY_FILE), library).unwrap();
        fs::remove_file(root.join(crate::notebook_store::NOTEBOOK_FILE)).unwrap();
        fs::remove_file(root.join(crate::atlas_store::ATLAS_FILE)).unwrap();
        fs::write(
            root.join("content/posts/2026-01-07-cave.md"),
            "---\ntitle: Cave\ndate: 2026-01-07\ncitations: bibliography\n---\n\nThe cave educates [@slings, page 514].\n",
        )
        .unwrap();
        fs::write(
            root.join(crate::claims_store::CLAIMS_FILE),
            r#"{"version":1,"claims":[{"id":"c0","post":"cave","statement":"S"}]}"#,
        )
        .unwrap();
        assert!(
            crate::source_store::load(&root, &Default::default()).is_err(),
            "Admin and check still report the unresolved interpreter"
        );
        let report = production_build(&root);
        assert_eq!(report.posts, 2);
        assert!(report
            .evidence
            .iter()
            .any(|f| f.code.to_string() == "claim-evidence-missing"));
        let page = dist_bytes(&root)
            .into_iter()
            .find(|(path, _)| path.ends_with("cave/index.html"))
            .map(|(_, bytes)| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap();
        assert!(page.contains("Slings"), "{page}");
        for (_, bytes) in dist_bytes(&root) {
            assert!(!String::from_utf8_lossy(&bytes).contains("ob-interpretation-secret"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_interpretation_naming_a_removed_contributor_never_breaks_an_atlas_build() {
        let root = project_with_private_library(
            "interpretation-atlas-build",
            r#"{"knowledgeAtlas":{"publish":true}}"#,
        );
        // No contributor registry: `ada` was removed after she was named.
        let library = r#"{"version":1,"sources":[{"id":"plato","kind":"work","title":"Politeia"},{"id":"slings","kind":"edition","of":"plato","title":"Slings"}],"interpretations":[{"id":"cave-mine","kind":"reading","source":"slings","text":"ob-interpretation-secret","interpreters":[{"contributor":"ada"}]}]}"#;
        fs::write(root.join(crate::source_store::LIBRARY_FILE), library).unwrap();
        fs::remove_file(root.join(crate::notebook_store::NOTEBOOK_FILE)).unwrap();
        fs::write(
            root.join(crate::atlas_store::ATLAS_FILE),
            r#"{"version":1,"entries":[{"id":"cave","kind":"concept","label":"The cave","visibility":"approved"},{"id":"politeia","kind":"work","label":"Politeia","source":"plato","visibility":"approved"}],"relationships":[]}"#,
        )
        .unwrap();
        assert!(
            crate::source_store::load(&root, &Default::default()).is_err(),
            "Admin and check still report the unresolved interpreter"
        );
        assert!(crate::atlas_store::load(&root, &Default::default()).is_err());
        production_build(&root);
        let dist = dist_bytes(&root);
        let atlas = dist
            .iter()
            .find(|(path, _)| path.ends_with("atlas.json"))
            .map(|(_, bytes)| String::from_utf8_lossy(bytes).into_owned())
            .expect("the atlas is published");
        assert!(atlas.contains("The cave"), "{atlas}");
        for (_, bytes) in dist {
            assert!(!String::from_utf8_lossy(&bytes).contains("ob-interpretation-secret"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    // ---- Knowledge Atlas publication (A5.4, ADR 0058) ---------------------------

    #[test]
    fn a_build_reports_claim_gaps_to_the_author_and_writes_nothing_from_them() {
        const SECRET: &str = "ob-claims-secret-5521";
        let root = project_with_private_library("claims-gaps", "{}");
        fs::write(
            root.join(crate::source_store::LIBRARY_FILE),
            r#"{"version":1,"sources":[{"id":"plato","kind":"work","title":"Politeia"}]}"#,
        )
        .unwrap();
        fs::remove_file(root.join(crate::notebook_store::NOTEBOOK_FILE)).unwrap();
        fs::remove_file(root.join(crate::atlas_store::ATLAS_FILE)).unwrap();
        fs::write(
            root.join("content/posts/2026-01-07-cave.md"),
            "---\ntitle: Cave\ndate: 2026-01-07\n---\n\nThe cave educates.\n",
        )
        .unwrap();
        let claim_codes = |report: &BuildReport| -> Vec<String> {
            report
                .evidence
                .iter()
                .map(|f| f.code.to_string())
                .filter(|code| code.starts_with("claim-"))
                .collect()
        };
        // No claims file (a CI or static-host build): nothing is reported.
        let without = production_build(&root);
        assert!(claim_codes(&without).is_empty());
        let output = dist_bytes(&root);
        let claims_file = root.join(crate::claims_store::CLAIMS_FILE);
        let claims = format!(
            r#"{{"version":1,"claims":[{{"id":"c1","post":"cave","statement":"{SECRET} statement","uncertainty":"{SECRET} doubt"}},{{"id":"c2","post":"cave","statement":"S"}}],"links":[{{"id":"l1","claim":"c1","relation":"supports","evidence":{{"source":"plato"}},"rationale":"{SECRET} why"}}]}}"#
        );
        fs::write(&claims_file, &claims).unwrap();
        let report = production_build(&root);
        assert_eq!(
            claim_codes(&report),
            [
                "claim-support-only",
                "claim-locator-missing",
                "claim-evidence-missing"
            ]
        );
        let found: Vec<_> = report
            .evidence
            .iter()
            .filter(|f| f.code.to_string().starts_with("claim-"))
            .collect();
        assert!(found
            .iter()
            .all(|f| f.source.path == "posts/2026-01-07-cave.md"));
        assert!(found
            .iter()
            .all(|f| !format!("{} {}", f.message, f.repair).contains(SECRET)));
        // The same findings as `openblog check` and Evidence Studio, in order.
        let snapshot = crate::claims_store::load(&root, &Default::default()).unwrap();
        let checked = crate::claims_store::review(&snapshot, &root, "content");
        assert_eq!(found, checked.iter().collect::<Vec<_>>());
        // Read only: the claims file is untouched and the output unchanged.
        assert_eq!(fs::read_to_string(&claims_file).unwrap(), claims);
        assert_eq!(dist_bytes(&root), output);

        // A claims file that cannot be read never stops the build: one
        // warning names the file and repeats nothing from it.
        let broken = claims.replace(r#""source":"plato""#, r#""source":"ob-claims-secret-gone""#);
        fs::write(&claims_file, &broken).unwrap();
        let report = production_build(&root);
        assert!(claim_codes(&report).is_empty());
        let warning = report
            .warnings
            .iter()
            .find(|w| w.contains(crate::claims_store::CLAIMS_FILE))
            .expect("a warning names the claims file");
        assert!(!warning.contains(SECRET) && !warning.contains("ob-claims-secret-gone"));
        assert_eq!(dist_bytes(&root), output);
        fs::remove_dir_all(root).unwrap();
    }

    // ---- Claim evidence publication (A4.4, ADR 0075) ---------------------------

    const CLAIM_MARKER: &str = "ob-private-claim-6604";

    /// A project that publishes claim evidence. Every value that may be
    /// published says PUBLIC; every value that may not carries a marker.
    fn project_publishing_claims(tag: &str) -> PathBuf {
        let root = project_with_private_library(tag, r#"{"claimEvidence":{"publish":true}}"#);
        let library = format!(
            r#"{{"version":1,"sources":[{{"id":"republic","kind":"work","title":"PUBLIC Republic","notes":"{PRIVATE_MARKER} note"}},{{"id":"slings","kind":"edition","of":"republic","title":"PUBLIC Slings","identifiers":[{{"scheme":"shelf","value":"{PRIVATE_MARKER}"}}]}},{{"id":"critic","kind":"work","title":"PUBLIC Critic"}}]}}"#
        );
        fs::write(root.join(crate::source_store::LIBRARY_FILE), library).unwrap();
        let notebook = format!(
            r#"{{"version":1,"passages":[{{"id":"p-{NOTEBOOK_MARKER}","source":"slings","excerpt":{{"text":"{NOTEBOOK_MARKER} quoted"}}}}]}}"#
        );
        fs::write(root.join(crate::notebook_store::NOTEBOOK_FILE), notebook).unwrap();
        fs::remove_file(root.join(crate::atlas_store::ATLAS_FILE)).unwrap();
        fs::write(
            root.join("content/posts/2026-01-07-cave.md"),
            "---\ntitle: Cave\ndate: 2026-01-07\nevidenceRevisions:\n  - \"2026-01-08 c1: PUBLIC revision note.\"\n---\n\nThe cave educates.\n",
        )
        .unwrap();
        let claims = format!(
            r#"{{"version":1,"claims":[
              {{"id":"c1","post":"cave","statement":"PUBLIC statement","uncertainty":"PUBLIC claim doubt","visibility":"approved","anchor":{{"start":0,"end":18,"text":"The cave educates."}},"recordedBy":{{"kind":"named","name":"{CLAIM_MARKER} recorder"}},"shelf":"{CLAIM_MARKER} claim extra"}},
              {{"id":"c-private","post":"cave","statement":"{CLAIM_MARKER} private statement","visibility":"private"}}],
             "links":[
              {{"id":"l-support","claim":"c1","relation":"supports","evidence":{{"source":"slings","locators":[{{"kind":"page","value":"514","hint":"{CLAIM_MARKER} locator extra"}}]}},"rationale":"PUBLIC support rationale","uncertainty":"PUBLIC support doubt","confidence":"plausible","visibility":"approved","tag":"{CLAIM_MARKER} link extra"}},
              {{"id":"l-contra","claim":"c1","relation":"contradicts","evidence":{{"source":"critic"}},"rationale":"PUBLIC contrary rationale","visibility":"approved"}},
              {{"id":"l-private","claim":"c1","relation":"contextualizes","evidence":{{"source":"slings","passage":"p-{NOTEBOOK_MARKER}"}},"rationale":"{CLAIM_MARKER} private rationale","visibility":"private"}},
              {{"id":"l-endpoint","claim":"c-private","relation":"supports","evidence":{{"source":"republic"}},"rationale":"{CLAIM_MARKER} private endpoint","visibility":"approved"}}],
             "workspace":"{CLAIM_MARKER} top-level extra"}}"#
        );
        let path = root.join(crate::claims_store::CLAIMS_FILE);
        fs::write(&path, claims).unwrap();
        root
    }

    fn assert_no_claim_leaks(built: &std::collections::BTreeMap<String, Vec<u8>>) {
        for (path, bytes) in built {
            let text = String::from_utf8_lossy(bytes);
            for marker in [
                PRIVATE_MARKER,
                NOTEBOOK_MARKER,
                CLAIM_MARKER,
                "c-private",
                "l-private",
                "l-endpoint",
            ] {
                assert!(!text.contains(marker), "dist/{path} exposes {marker}");
            }
            assert!(
                !openblog_core::research_bundle::looks_like_private_research(bytes),
                "dist/{path} carries a copy of private research"
            );
        }
    }

    #[test]
    fn published_claim_evidence_reaches_every_output_and_nothing_private_does() {
        let root = project_publishing_claims("claims-published");
        production_build(&root);
        let built = dist_bytes(&root);
        assert_no_claim_leaks(&built);
        let page = String::from_utf8_lossy(&built["posts/cave/index.html"]).to_string();
        for public in [
            "PUBLIC statement",
            "PUBLIC claim doubt",
            "PUBLIC Slings",
            "PUBLIC support rationale",
            "PUBLIC support doubt",
            "PUBLIC Critic",
            "PUBLIC contrary rationale",
            "PUBLIC revision note.",
            "<strong>Contested:</strong>",
            "Supporting evidence (1)",
            "Contradicting evidence (1)",
        ] {
            assert!(page.contains(public), "the post page lacks {public}");
        }
        for carrier in ["rss.xml", "feed.json", "claim-evidence.json"] {
            let text = String::from_utf8_lossy(&built[carrier]);
            assert!(text.contains("PUBLIC contrary rationale"), "{carrier}");
        }
        // The legacy post is byte for byte what a site that does not publish writes.
        let hello = built["posts/hello/index.html"].clone();
        fs::write(root.join(CONFIG_FILE), "{}").unwrap();
        production_build(&root);
        let off = dist_bytes(&root);
        assert_eq!(off["posts/hello/index.html"], hello);
        assert!(
            !off.contains_key("claim-evidence.json"),
            "the stale-file pass removes it"
        );
        assert!(off
            .values()
            .all(|bytes| !String::from_utf8_lossy(bytes).contains("PUBLIC statement")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn withdrawal_unstored_and_damaged_claims_files_each_change_the_next_build_safely() {
        let root = project_publishing_claims("claims-lifecycle");
        let first = production_build(&root);
        let before = dist_bytes(&root);
        // Deterministic: the same inputs build the same bytes.
        production_build(&root);
        assert_eq!(dist_bytes(&root), before);
        assert!(first
            .warnings
            .iter()
            .all(|w| !w.contains("claimEvidence.publish")));

        // Withdrawing the contradicting link withdraws the support beside it.
        let path = root.join(crate::claims_store::CLAIMS_FILE);
        let stored = fs::read_to_string(&path).unwrap();
        let withdrawn = stored.replacen(
            r#""rationale":"PUBLIC contrary rationale","visibility":"approved""#,
            r#""rationale":"PUBLIC contrary rationale","visibility":"private""#,
            1,
        );
        assert_ne!(withdrawn, stored);
        fs::write(&path, &withdrawn).unwrap();
        production_build(&root);
        let after = dist_bytes(&root);
        for gone in ["PUBLIC contrary rationale", "PUBLIC support rationale"] {
            assert!(
                after
                    .values()
                    .all(|b| !String::from_utf8_lossy(b).contains(gone)),
                "{gone} is withdrawn"
            );
        }
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            withdrawn,
            "the build never edits it"
        );

        // A damaged claims file refuses the build, names the file only, and
        // leaves the published site as it was.
        fs::write(
            &path,
            format!(r#"{{"version":1,"claims":[{{"id":"{CLAIM_MARKER}"#),
        )
        .unwrap();
        let error = build(
            &root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .err()
        .expect("a damaged claims file refuses the build");
        assert!(error.contains(crate::claims_store::CLAIMS_FILE), "{error}");
        assert!(error.contains("claimEvidence.publish"), "{error}");
        assert!(!error.contains(CLAIM_MARKER), "{error}");
        assert_eq!(dist_bytes(&root), after, "nothing was written");

        // Without a claims file (a CI build) the build warns, publishes no
        // evidence, and keeps the revision notes the post itself carries.
        fs::remove_file(&path).unwrap();
        let report = production_build(&root);
        let warning = report
            .warnings
            .iter()
            .find(|w| w.contains("claimEvidence.publish"))
            .expect("a warning names the switch");
        assert!(warning.contains(crate::claims_store::CLAIMS_FILE));
        let built = dist_bytes(&root);
        let page = String::from_utf8_lossy(&built["posts/cave/index.html"]).to_string();
        assert!(!page.contains("PUBLIC statement"));
        assert!(
            page.contains("2026-01-08: PUBLIC revision note."),
            "the note outlives the private file"
        );
        assert_no_claim_leaks(&built);
        fs::remove_dir_all(root).unwrap();
    }

    fn dist_bytes(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        let output = root.join("dist");
        fsutil::walk(&output)
            .into_iter()
            .map(|file| (fsutil::relative(&output, &file), fs::read(&file).unwrap()))
            .collect()
    }

    #[test]
    fn a_published_reader_feedback_file_that_cannot_be_read_refuses_the_build_and_writes_nothing() {
        let root = project_with_private_library("reader-feedback-broken", "{}");
        production_build(&root);
        let output = dist_bytes(&root);
        let file = root
            .join("content")
            .join(openblog_core::feedback_publication::READER_FEEDBACK_FILE);
        fs::write(
            &file,
            r#"{"version":1,"items":[{"id":"ob-reader-secret"}]}"#,
        )
        .unwrap();
        let error = build(
            &root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .err()
        .expect("the build is refused");
        assert!(
            error.starts_with("content/reader-feedback.json: item 1:"),
            "{error}"
        );
        assert!(!error.contains("ob-reader-secret"));
        assert_eq!(dist_bytes(&root), output, "nothing was written");
        // An empty file publishes nothing and the output is as before.
        fs::write(
            &file,
            "{\"version\":1,\"items\":[]}
",
        )
        .unwrap();
        production_build(&root);
        assert_eq!(dist_bytes(&root), output);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_site_that_does_not_publish_its_atlas_builds_byte_for_byte_as_without_one() {
        let root = project_with_private_library("atlas-legacy", "{}");
        let atlas = fs::read(root.join(crate::atlas_store::ATLAS_FILE)).unwrap();
        fs::remove_file(root.join(crate::atlas_store::ATLAS_FILE)).unwrap();
        production_build(&root);
        let without = dist_bytes(&root);

        fs::write(root.join(crate::atlas_store::ATLAS_FILE), &atlas).unwrap();
        production_build(&root);
        assert_eq!(
            dist_bytes(&root),
            without,
            "an unpublished atlas changes nothing"
        );

        // Off means never read: even a damaged atlas cannot affect the build.
        fs::write(root.join(crate::atlas_store::ATLAS_FILE), "{ not json").unwrap();
        production_build(&root);
        assert_eq!(dist_bytes(&root), without);
        // Only the timeline component, which ships with every site like any
        // other component, carries the word; no page loads it.
        assert!(without.keys().all(|path| !path.contains("atlas")
            || path == "assets/components/ob-atlas-timeline.js"
            || path == "assets/components/ob-atlas-trail.js"));
        assert!(without.values().all(|bytes| {
            let text = String::from_utf8_lossy(bytes);
            !text.contains("ob-atlas-timeline.js") && !text.contains("ob-atlas-trail.js")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_build_that_publishes_the_atlas_but_cannot_read_one_warns() {
        let root = project_with_private_library(
            "atlas-unstored",
            r#"{"knowledgeAtlas":{"publish":true}}"#,
        );
        fs::remove_file(root.join(crate::atlas_store::ATLAS_FILE)).unwrap();
        fs::remove_file(root.join(crate::notebook_store::NOTEBOOK_FILE)).unwrap();
        let report = production_build(&root);
        let warning = report
            .warnings
            .iter()
            .find(|warning| warning.contains("knowledgeAtlas.publish"))
            .expect("the build warns that it publishes an empty atlas");
        assert!(
            warning.contains(crate::atlas_store::ATLAS_FILE),
            "{warning}"
        );
        assert!(warning.contains("published empty"), "{warning}");
        assert!(warning.contains("openblog serve"), "{warning}");

        // `check` reads the same warnings from the generated site.
        let (mut site, themes) = load_site(&root, true, None).unwrap();
        generate_site(&root, &mut site, &themes).unwrap();
        assert!(site
            .warnings
            .iter()
            .any(|warning| warning.contains("knowledgeAtlas.publish")));

        // A stored atlas, even an empty one, is no surprise.
        fs::write(
            root.join(crate::atlas_store::ATLAS_FILE),
            r#"{"version":1,"entries":[],"relationships":[]}"#,
        )
        .unwrap();
        let report = production_build(&root);
        assert!(report
            .warnings
            .iter()
            .all(|warning| !warning.contains("knowledgeAtlas.publish")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_build_that_publishes_entries_whose_years_became_private_datings_warns() {
        let root =
            project_with_private_library("atlas-undated", r#"{"knowledgeAtlas":{"publish":true}}"#);
        fs::remove_file(root.join(crate::notebook_store::NOTEBOOK_FILE)).unwrap();
        fs::write(
            root.join(crate::source_store::LIBRARY_FILE),
            r#"{"version":1,"sources":[{"id":"apology","kind":"work","title":"Apology"}]}"#,
        )
        .unwrap();
        // Version 1: approved entries' years were published from `bounds`.
        // After the upgrade they are private, unsourced datings.
        fs::write(
            root.join(crate::atlas_store::ATLAS_FILE),
            r#"{"version":1,"entries":[
              {"id":"plato","kind":"person","label":"Plato","bounds":{"from":-428,"until":-348},"visibility":"approved"},
              {"id":"socrates","kind":"person","label":"Socrates","bounds":{"until":-399},"visibility":"approved"},
              {"id":"undated","kind":"concept","label":"Undated","visibility":"approved"},
              {"id":"hidden","kind":"person","label":"Hidden","bounds":{"from":-500}}]}"#,
        )
        .unwrap();
        let undated_warning = |warnings: &[String]| {
            warnings
                .iter()
                .find(|warning| warning.contains("no years on /atlas/"))
                .cloned()
        };
        let report = production_build(&root);
        let warning = undated_warning(&report.warnings)
            .expect("the build warns that published entries lost their years");
        assert!(
            warning.starts_with("2 approved Knowledge Atlas entries show no years"),
            "{warning}"
        );
        assert!(
            warning.contains("`plato` (1 dating), `socrates` (1 dating)"),
            "{warning}"
        );
        assert!(
            warning.contains("version 1 `bounds` became private, unsourced datings"),
            "{warning}"
        );
        assert!(
            warning.contains("`openblog check` gives each dating's reason"),
            "{warning}"
        );
        assert!(!warning.contains("cite and approve a dating"), "{warning}");
        assert!(
            warning.contains("Only cited, approved datings of published items, relative only to approved entries, are published"),
            "{warning}"
        );
        // Ids and counts only: neither labels nor years, and never the
        // private entry or the approved entry without datings.
        for absent in ["Plato", "428", "399", "hidden", "undated"] {
            assert!(!warning.contains(absent), "{absent}: {warning}");
        }
        // The years stay unpublished: an uncited date is never shown.
        let atlas_json = fs::read_to_string(root.join("dist/atlas.json")).unwrap();
        assert!(atlas_json.contains("\"plato\""), "{atlas_json}");
        assert!(!atlas_json.contains("428"), "{atlas_json}");

        // `check` reports the same warning, and Admin's notices name each entry.
        let (mut site, themes) = load_site(&root, true, None).unwrap();
        generate_site(&root, &mut site, &themes).unwrap();
        assert_eq!(undated_warning(&site.warnings), Some(warning));
        let snapshot = crate::atlas_store::load(&root, &std::collections::BTreeMap::new()).unwrap();
        let notices: Vec<_> = snapshot
            .atlas
            .notices()
            .into_iter()
            .filter(|notice| {
                notice.code
                    == openblog_core::knowledge_atlas::AtlasDiagnosticCode::UnpublishedDatings
            })
            .map(|notice| (notice.collection, notice.id, notice.field))
            .collect();
        assert_eq!(
            notices,
            [
                (Some("entries"), Some("plato".into()), Some("dates".into())),
                (
                    Some("entries"),
                    Some("socrates".into()),
                    Some("dates".into())
                ),
            ]
        );

        // Once a dating cites evidence and is approved, it is published and
        // the warning names only the entries still lacking one, whatever the
        // datings are called.
        fs::write(
            root.join(crate::atlas_store::ATLAS_FILE),
            r#"{"version":2,"entries":[
              {"id":"plato","kind":"person","label":"Plato","visibility":"approved","dates":[
                {"id":"plato-span","aspect":"span","date":{"from":{"year":-428},"to":{"year":-348}},"assertedBy":{"kind":"author"},"unsourced":true},
                {"id":"plato-death","aspect":"death","date":{"at":{"year":-348,"circa":true}},"assertedBy":{"kind":"source","source":"apology"},"evidence":[{"source":"apology"}],"visibility":"approved"}]},
              {"id":"socrates","kind":"person","label":"Socrates","visibility":"approved","dates":[
                {"id":"socrates-span","aspect":"span","date":{"to":{"year":-399}},"assertedBy":{"kind":"author"},"unsourced":true}]}]}"#,
        )
        .unwrap();
        let report = production_build(&root);
        let warning = undated_warning(&report.warnings)
            .unwrap_or_else(|| panic!("socrates still shows no years: {:?}", report.warnings));
        assert!(
            warning.starts_with("1 approved Knowledge Atlas entry shows no years"),
            "{warning}"
        );
        assert!(warning.contains("`socrates` (1 dating)"), "{warning}");
        assert!(!warning.contains("plato"), "{warning}");
        let atlas_json = fs::read_to_string(root.join("dist/atlas.json")).unwrap();
        assert!(atlas_json.contains("\"plato-death\""), "{atlas_json}");
        assert!(
            atlas_json.contains("\"text\":\"c. 348 BCE\""),
            "{atlas_json}"
        );
        assert!(!atlas_json.contains("plato-span"), "{atlas_json}");
        assert!(!atlas_json.contains("socrates-span"), "{atlas_json}");
        let page = fs::read_to_string(root.join("dist/atlas/plato/index.html")).unwrap();
        assert!(page.contains("<h2 id=\"atlas-section-dates\">Dates</h2>"));
        assert!(page.contains("<p class=\"ob-atlas-date\">c. 348 BCE</p>"));
        let index = fs::read_to_string(root.join("dist/atlas/index.html")).unwrap();
        assert!(index.contains("<h2 id=\"atlas-timeline\">Timeline</h2>"));
        assert!(index.contains("/assets/components/ob-atlas-timeline.js?v="));
        assert!(root
            .join("dist/assets/components/ob-atlas-timeline.js")
            .is_file());

        fs::write(
            root.join(crate::atlas_store::ATLAS_FILE),
            r#"{"version":2,"entries":[
              {"id":"plato","kind":"person","label":"Plato","visibility":"approved","dates":[
                {"id":"plato-death","aspect":"death","date":{"at":{"year":-348,"circa":true}},"assertedBy":{"kind":"source","source":"apology"},"evidence":[{"source":"apology"}],"visibility":"approved"}]}]}"#,
        )
        .unwrap();
        let report = production_build(&root);
        assert_eq!(
            undated_warning(&report.warnings),
            None,
            "{:?}",
            report.warnings
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// A project that publishes its atlas. Every value that may be published
    /// says PUBLIC; every value that may not carries a private marker.
    fn project_publishing_atlas(tag: &str) -> PathBuf {
        let root = project_with_private_library(tag, r#"{"knowledgeAtlas":{"publish":true}}"#);
        let library = format!(
            r#"{{"version":1,"sources":[{{"id":"republic","kind":"work","title":"PUBLIC Republic","notes":"{PRIVATE_MARKER} note"}},{{"id":"slings","kind":"edition","of":"republic","title":"PUBLIC Slings","identifiers":[{{"scheme":"shelf","value":"{PRIVATE_MARKER}"}}]}},{{"id":"unused","kind":"work","title":"{PRIVATE_MARKER} unused"}}]}}"#
        );
        fs::write(root.join(crate::source_store::LIBRARY_FILE), library).unwrap();
        let notebook = format!(
            r#"{{"version":1,"passages":[{{"id":"p-{NOTEBOOK_MARKER}","source":"slings","excerpt":{{"text":"{NOTEBOOK_MARKER} quoted"}}}}],"notes":[{{"id":"n-leak","kind":"question","text":"{NOTEBOOK_MARKER} noted","concepts":["the-good"]}}]}}"#
        );
        fs::write(root.join(crate::notebook_store::NOTEBOOK_FILE), notebook).unwrap();
        let atlas = format!(
            r#"{{"version":1,"entries":[
              {{"id":"plato","kind":"person","label":"PUBLIC Plato","aliases":["PUBLIC Aristocles"],"summary":"PUBLIC summary","visibility":"approved","shelf":"{ATLAS_MARKER} entry extra"}},
              {{"id":"politeia","kind":"work","label":"PUBLIC Politeia","source":"republic","visibility":"approved"}},
              {{"id":"the-good","kind":"concept","label":"PUBLIC The Good","visibility":"approved"}},
              {{"id":"hidden","kind":"concept","label":"{ATLAS_MARKER} private label","summary":"{ATLAS_MARKER} private summary","visibility":"private"}}],
             "relationships":[
              {{"id":"r-authored","kind":"authored","from":"plato","to":"politeia","assertedBy":{{"kind":"named","name":"PUBLIC Diogenes"}},"confidence":"plausible","evidence":[{{"source":"slings","locators":[{{"kind":"page","value":"514","hint":"{ATLAS_MARKER} locator extra"}}],"margin":"{ATLAS_MARKER} evidence extra"}}],"uncertainty":"PUBLIC doubt","contestedBy":[{{"by":{{"kind":"named","name":"PUBLIC Dissenter"}},"note":"PUBLIC dissent note","tag":"{ATLAS_MARKER} dissent extra"}}],"visibility":"approved","shelf":"{ATLAS_MARKER} relationship extra"}},
              {{"id":"r-discusses","kind":"discusses","from":"politeia","to":"the-good","assertedBy":{{"kind":"author"}},"evidence":[{{"source":"republic"}}],"visibility":"approved"}},
              {{"id":"r-hidden","kind":"discusses","from":"politeia","to":"hidden","assertedBy":{{"kind":"author"}},"evidence":[{{"source":"republic"}}],"uncertainty":"{ATLAS_MARKER} private endpoint","visibility":"approved"}},
              {{"id":"r-private","kind":"related-to","from":"plato","to":"the-good","assertedBy":{{"kind":"named","name":"{ATLAS_MARKER} party"}},"evidence":[{{"source":"slings","passage":"p-{NOTEBOOK_MARKER}"}}],"uncertainty":"{ATLAS_MARKER} private relationship","visibility":"private"}}],
             "workspace":"{ATLAS_MARKER} top-level extra"}}"#
        );
        fs::write(root.join(crate::atlas_store::ATLAS_FILE), atlas).unwrap();
        root
    }

    #[test]
    fn a_published_atlas_carries_only_approved_items_and_withdrawal_needs_no_other_edit() {
        let root = project_publishing_atlas("atlas-published");
        production_build(&root);
        let built = dist_bytes(&root);
        for path in [
            "atlas/index.html",
            "atlas/plato/index.html",
            "atlas/politeia/index.html",
            "atlas/the-good/index.html",
            "atlas.json",
        ] {
            assert!(built.contains_key(path), "{path}");
        }
        assert!(!built.contains_key("atlas/hidden/index.html"));
        for (path, bytes) in &built {
            let text = String::from_utf8_lossy(bytes);
            for marker in [PRIVATE_MARKER, NOTEBOOK_MARKER, ATLAS_MARKER] {
                assert!(!text.contains(marker), "dist/{path} exposes {marker}");
            }
            assert!(
                !openblog_core::research_bundle::looks_like_private_research(bytes),
                "dist/{path} carries a copy of private research"
            );
        }
        let json = String::from_utf8_lossy(&built["atlas.json"]).to_string();
        for public in [
            "PUBLIC Plato",
            "PUBLIC Aristocles",
            "PUBLIC summary",
            "PUBLIC Diogenes",
            "PUBLIC doubt",
            "PUBLIC Dissenter",
            "PUBLIC dissent note",
            "PUBLIC Republic",
            "PUBLIC Slings",
            r#""standing":"contested""#,
        ] {
            assert!(json.contains(public), "the artifact publishes {public}");
        }
        let plato = String::from_utf8_lossy(&built["atlas/plato/index.html"]).to_string();
        assert!(plato.contains("PUBLIC Dissenter: PUBLIC dissent note"));
        assert!(plato.contains("<strong>Contested:</strong>"));

        // Withdrawing approval is one value in the private file; the next build
        // drops the entry, every relationship touching it, and its page.
        let path = root.join(crate::atlas_store::ATLAS_FILE);
        let stored = fs::read_to_string(&path).unwrap();
        let withdrawn = stored.replacen(
            r#""label":"PUBLIC Plato","aliases":["PUBLIC Aristocles"],"summary":"PUBLIC summary","visibility":"approved""#,
            r#""label":"PUBLIC Plato","aliases":["PUBLIC Aristocles"],"summary":"PUBLIC summary","visibility":"private""#,
            1,
        );
        assert_ne!(withdrawn, stored);
        fs::write(&path, &withdrawn).unwrap();
        production_build(&root);
        let after = dist_bytes(&root);
        assert!(
            !after.contains_key("atlas/plato/index.html"),
            "the page is removed"
        );
        let json = String::from_utf8_lossy(&after["atlas.json"]).to_string();
        for gone in [
            "PUBLIC Plato",
            "PUBLIC Diogenes",
            "PUBLIC Dissenter",
            "PUBLIC Slings",
        ] {
            assert!(!json.contains(gone), "{gone} is withdrawn");
        }
        assert!(json.contains("PUBLIC Politeia") && json.contains("r-discusses"));
        assert!(after
            .values()
            .all(|bytes| !String::from_utf8_lossy(bytes).contains("PUBLIC Plato")));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            withdrawn,
            "the build never edits the private atlas"
        );

        // A damaged atlas refuses the build, names the file only, and leaves
        // the published site as it was.
        fs::write(
            &path,
            format!(r#"{{"version":1,"entries":[{{"id":"{ATLAS_MARKER}"#),
        )
        .unwrap();
        let error = build(
            &root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .err()
        .expect("a damaged published atlas refuses the build");
        assert!(
            error.contains(".openblog/private/research/atlas.json"),
            "{error}"
        );
        assert!(error.contains("knowledgeAtlas.publish"), "{error}");
        assert!(!error.contains(ATLAS_MARKER), "{error}");
        assert_eq!(dist_bytes(&root), after, "nothing was written");
        fs::remove_dir_all(root).unwrap();
    }

    const COMPARISON_MARKER: &str = "ob-private-comparison-61e4";
    /// Wording of exactly the excerpt limit, which is published, and of one
    /// character more, which never is; distinct letters keep one from being
    /// found inside the other.
    fn exact_excerpt() -> String {
        let lead = "PUBLIC exact ";
        let limit = openblog_core::comparison_publication::MAX_PUBLIC_EXCERPT_CHARS;
        format!("{lead}{}", "α".repeat(limit - lead.chars().count()))
    }

    fn over_excerpt() -> String {
        "ω".repeat(openblog_core::comparison_publication::MAX_PUBLIC_EXCERPT_CHARS + 1)
    }

    /// A project that publishes comparisons. Every value that may be published
    /// says PUBLIC; every value that may not carries a private marker, including
    /// the wording of versions whose rights are unknown or reserved.
    fn project_publishing_comparisons(tag: &str) -> PathBuf {
        let root = project_with_private_library(tag, r#"{"comparisons":{"publish":true}}"#);
        let library = format!(
            r#"{{"version":1,"sources":[
              {{"id":"republic","kind":"work","title":"PUBLIC Republic","notes":"{PRIVATE_MARKER} note"}},
              {{"id":"burnet","kind":"edition","of":"republic","title":"PUBLIC Burnet","language":"grc","creators":[{{"name":"PUBLIC John Burnet","role":"editor"}}],"rights":{{"status":"publicDomain","note":"{PRIVATE_MARKER} rights note"}},"identifiers":[{{"scheme":"shelf","value":"{PRIVATE_MARKER}"}}]}},
              {{"id":"grube","kind":"translation","of":"republic","language":"en","title":"PUBLIC Grube","rights":{{"status":"rightsReserved"}}}},
              {{"id":"hebrew","kind":"translation","of":"republic","language":"he","title":"PUBLIC המדינה","anonymous":true,"creators":[{{"name":"PUBLIC Ibn Tibbon","role":"translator","attribution":"disputed","note":"{PRIVATE_MARKER} who disputes it"}}],"rights":{{"status":"openLicense","license":"PUBLIC CC-BY-4.0"}}}},
              {{"id":"paris","kind":"witness","of":"republic","title":"PUBLIC Paris gr. 1807"}},
              {{"id":"exact","kind":"edition","of":"republic","title":"PUBLIC Exact","rights":{{"status":"ownWork"}}}},
              {{"id":"over","kind":"edition","of":"republic","title":"PUBLIC Over","rights":{{"status":"ownWork"}}}},
              {{"id":"unused","kind":"edition","of":"republic","title":"{PRIVATE_MARKER} unused"}}],
             "interpretations":[
              {{"id":"mine","kind":"rendering","source":"burnet","language":"en","locators":[{{"kind":"canonical","value":"514a"}}],"text":"PUBLIC rendering","interpreters":[{{"name":"PUBLIC Ada"}}],"rights":{{"status":"ownWork"}},"uncertainty":"{PRIVATE_MARKER} doubt"}}]}}"#
        );
        fs::write(root.join(crate::source_store::LIBRARY_FILE), library).unwrap();
        let (exact, over) = (exact_excerpt(), over_excerpt());
        assert_eq!(exact.chars().count(), 1000);
        assert_eq!(over.chars().count(), 1001);
        let notebook = format!(
            r#"{{"version":1,"passages":[
              {{"id":"p-{NOTEBOOK_MARKER}","source":"burnet","excerpt":{{"text":"PUBLIC μετὰ ταῦτα","language":"grc"}},"locators":[{{"kind":"canonical","value":"514a"}}]}},
              {{"id":"p-grube","source":"grube","excerpt":{{"text":"{NOTEBOOK_MARKER} reserved wording","language":"en"}},"locators":[{{"kind":"page","value":"186"}}]}},
              {{"id":"p-hebrew","source":"hebrew","excerpt":{{"text":"PUBLIC אחר כך <b>bold</b>","language":"he"}}}},
              {{"id":"p-paris","source":"paris","excerpt":{{"text":"{NOTEBOOK_MARKER} unknown-rights wording"}},"locators":[{{"kind":"folio","value":"12r"}}]}},
              {{"id":"p-exact","source":"exact","excerpt":{{"text":"{exact}"}}}},
              {{"id":"p-over","source":"over","excerpt":{{"text":"{over}"}}}}],
             "notes":[{{"id":"n-leak","kind":"question","text":"{NOTEBOOK_MARKER} noted","passages":["p-grube"]}}]}}"#
        );
        fs::write(root.join(crate::notebook_store::NOTEBOOK_FILE), notebook).unwrap();
        let alignments = format!(
            r#"{{"version":1,"alignments":[
              {{"id":"cave","label":"PUBLIC The cave","correspondence":"partial","visibility":"approved","members":[
                {{"source":"burnet","passage":"p-{NOTEBOOK_MARKER}","note":"{COMPARISON_MARKER} member note","normalized":{{"text":"PUBLIC normalization"}},"tag":"{COMPARISON_MARKER} member extra"}},
                {{"source":"grube","passage":"p-grube","normalized":{{"text":"{COMPARISON_MARKER} reserved normalization"}}}},
                {{"source":"hebrew","passage":"p-hebrew"}},
                {{"source":"paris","passage":"p-paris","normalized":{{"text":"{COMPARISON_MARKER} unknown normalization"}}}},
                {{"source":"exact","passage":"p-exact"}},
                {{"source":"over","passage":"p-over","normalized":{{"text":"{COMPARISON_MARKER} long normalization"}}}},
                {{"interpretation":"mine"}}],
               "publishNormalized":true,
               "rationale":"PUBLIC rationale","confidence":"plausible","uncertainty":"PUBLIC doubt",
               "recordedBy":{{"kind":"named","name":"PUBLIC Concordance"}},
               "evidence":[{{"source":"burnet","locators":[{{"kind":"page","value":"1"}}],"passage":"p-{NOTEBOOK_MARKER}"}}],
               "shelf":"{COMPARISON_MARKER} alignment extra"}},
              {{"id":"hidden","label":"{COMPARISON_MARKER} private label","members":[
                {{"source":"unused","locators":[{{"kind":"page","value":"1"}}]}},
                {{"source":"grube","absent":true}}]}}],
             "workspace":"{COMPARISON_MARKER} top-level extra"}}"#
        );
        fs::write(
            root.join(crate::alignment_store::ALIGNMENTS_FILE),
            alignments,
        )
        .unwrap();
        root
    }

    #[test]
    fn a_site_that_does_not_publish_comparisons_builds_byte_for_byte_as_without_alignments() {
        let root = project_publishing_comparisons("comparisons-legacy");
        fs::write(root.join(CONFIG_FILE), "{}").unwrap();
        let path = root.join(crate::alignment_store::ALIGNMENTS_FILE);
        let alignments = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        production_build(&root);
        let without = dist_bytes(&root);

        fs::write(&path, &alignments).unwrap();
        production_build(&root);
        assert_eq!(
            dist_bytes(&root),
            without,
            "unpublished alignments change nothing"
        );

        // Off means never read: even a damaged alignments file cannot affect the build.
        fs::write(&path, "{ not json").unwrap();
        production_build(&root);
        assert_eq!(dist_bytes(&root), without);
        assert!(without.keys().all(|path| !path.contains("comparison")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_build_that_publishes_comparisons_but_cannot_read_alignments_warns() {
        let root = project_publishing_comparisons("comparisons-unstored");
        fs::remove_file(root.join(crate::alignment_store::ALIGNMENTS_FILE)).unwrap();
        let report = production_build(&root);
        let warning = report
            .warnings
            .iter()
            .find(|warning| warning.contains("comparisons.publish"))
            .expect("the build warns that it publishes no comparisons");
        assert!(
            warning.contains(crate::alignment_store::ALIGNMENTS_FILE),
            "{warning}"
        );
        assert!(warning.contains("published empty") && warning.contains("openblog serve"));
        let built = dist_bytes(&root);
        assert!(
            built.contains_key("comparisons/index.html") && built.contains_key("comparisons.json")
        );

        // `check` reads the same warnings from the generated site.
        let (mut site, themes) = load_site(&root, true, None).unwrap();
        generate_site(&root, &mut site, &themes).unwrap();
        assert!(site
            .warnings
            .iter()
            .any(|w| w.contains("comparisons.publish")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn published_comparisons_carry_only_approved_identified_rights_gated_places() {
        let root = project_publishing_comparisons("comparisons-published");
        production_build(&root);
        let built = dist_bytes(&root);
        for path in [
            "comparisons/index.html",
            "comparisons/cave/index.html",
            "comparisons.json",
        ] {
            assert!(built.contains_key(path), "{path}");
        }
        assert!(!built.contains_key("comparisons/hidden/index.html"));
        for (path, bytes) in &built {
            let text = String::from_utf8_lossy(bytes);
            for marker in [
                PRIVATE_MARKER,
                NOTEBOOK_MARKER,
                ATLAS_MARKER,
                COMPARISON_MARKER,
            ] {
                assert!(!text.contains(marker), "dist/{path} exposes {marker}");
            }
            assert!(
                !openblog_core::research_bundle::looks_like_private_research(bytes),
                "dist/{path} carries a copy of private research"
            );
        }
        let json = String::from_utf8_lossy(&built["comparisons.json"]).to_string();
        for public in [
            "PUBLIC The cave",
            "PUBLIC μετὰ ταῦτα",
            "PUBLIC rationale",
            "PUBLIC doubt",
            "PUBLIC Concordance",
            "PUBLIC Burnet",
            "PUBLIC John Burnet",
            "PUBLIC Grube",
            "PUBLIC CC-BY-4.0",
            "PUBLIC rendering",
            "PUBLIC Ada",
            r#""withheld":"rights""#,
        ] {
            assert!(json.contains(public), "the artifact publishes {public}");
        }
        let page = String::from_utf8_lossy(&built["comparisons/cave/index.html"]).to_string();
        assert!(page.contains(
            "<blockquote lang=\"grc\" dir=\"ltr\"><p>PUBLIC μετὰ ταῦτα</p></blockquote>"
        ));
        assert!(page.contains("<blockquote lang=\"he\" dir=\"rtl\"><p>PUBLIC אחר כך &lt;b&gt;bold&lt;/b&gt;</p></blockquote>"));
        assert!(
            page.contains(
                "Wording not shown: the author states this version&#39;s text is under copyright"
            ) || page.contains(
                "Wording not shown: the author states this version's text is under copyright"
            )
        );
        assert!(page.contains("Rendering by PUBLIC Ada"));
        // Unknown rights withhold wording the place has, and say why.
        assert!(page.contains("PUBLIC Paris gr. 1807"));
        assert!(
            page.contains("Wording not shown: the author has not stated the rights in this version&#39;s text")
                || page.contains("Wording not shown: the author has not stated the rights in this version's text"),
            "{page}"
        );
        // Exactly the excerpt limit is quoted; one character more never is.
        let exact = exact_excerpt();
        assert!(page.contains(&exact) && json.contains(&exact));
        assert!(page.contains(
            "Wording not shown: it is longer than the 1000-character excerpt a comparison publishes."
        ));
        assert_eq!(json.matches(r#""withheld":"length""#).count(), 1);
        assert_eq!(json.matches(r#""withheld":"rights""#).count(), 2);
        // The author's normalizations publish only beside wording that is shown.
        assert!(page.contains("PUBLIC normalization") && json.contains("PUBLIC normalization"));
        for (path, bytes) in &built {
            let text = String::from_utf8_lossy(bytes);
            assert!(
                !text.contains("ωωωω"),
                "dist/{path} quotes over-long wording"
            );
            assert!(
                !text.contains("unknown-rights wording"),
                "dist/{path} quotes wording whose rights are unknown"
            );
        }
        // A version's makers read as interpreters do, with how firmly each is
        // attributed, and an anonymous version says so.
        assert!(
            page.contains(
                "<p class=\"ob-meta\">Translator: <bdi>PUBLIC Ibn Tibbon (disputed)</bdi></p>"
            ),
            "{page}"
        );
        assert!(page.contains("<p class=\"ob-meta\">Translation, language he, anonymous</p>"));
        assert!(json.contains(
            r#""makers":[{"name":"PUBLIC Ibn Tibbon","role":"translator","attribution":"disputed"}],"anonymous":true"#
        ));
        assert!(page.contains("It does not say they mean the same thing"));
        let article = &page[page
            .find("<article class=\"ob-page ob-comparison\">")
            .unwrap()..];
        let article = &article[..article.find("</article>").unwrap()];
        assert!(
            !article.contains("<script"),
            "the comparison needs no script"
        );
        assert!(article.contains("<section class=\"ob-comparison-version\""));
        let sitemap = String::from_utf8_lossy(&built["sitemap.xml"]).to_string();
        assert!(sitemap.contains("/comparisons/cave/"));
        for feed in ["rss.xml", "feed.json"] {
            if let Some(bytes) = built.get(feed) {
                assert!(
                    !String::from_utf8_lossy(bytes).contains("PUBLIC The cave"),
                    "{feed}"
                );
            }
        }

        // Withdrawing approval is one value in the private file; the next build
        // drops the comparison and its page.
        let path = root.join(crate::alignment_store::ALIGNMENTS_FILE);
        let stored = fs::read_to_string(&path).unwrap();
        let withdrawn =
            stored.replacen(r#""visibility":"approved""#, r#""visibility":"private""#, 1);
        assert_ne!(withdrawn, stored);
        fs::write(&path, &withdrawn).unwrap();
        production_build(&root);
        let after = dist_bytes(&root);
        assert!(
            !after.contains_key("comparisons/cave/index.html"),
            "the page is removed"
        );
        assert!(after
            .values()
            .all(|bytes| !String::from_utf8_lossy(bytes).contains("PUBLIC The cave")));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            withdrawn,
            "the build never edits alignments"
        );

        // A damaged alignments file refuses the build, names the file only, and
        // leaves the published site as it was; an Admin-style load is not stopped.
        fs::write(
            &path,
            format!(r#"{{"version":1,"alignments":[{{"id":"{COMPARISON_MARKER}"#),
        )
        .unwrap();
        let error = build(
            &root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .err()
        .expect("a damaged published alignments file refuses the build");
        assert!(
            error.contains(crate::alignment_store::ALIGNMENTS_FILE),
            "{error}"
        );
        assert!(error.contains("comparisons.publish"), "{error}");
        assert!(!error.contains(COMPARISON_MARKER), "{error}");
        assert_eq!(dist_bytes(&root), after, "nothing was written");
        assert!(
            load_site(&root, true, None).is_ok(),
            "loading content is not stopped"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_broken_interpretation_no_approved_comparison_publishes_never_stops_the_build() {
        let root = project_publishing_comparisons("comparisons-stray-interpretation");
        let path = root.join(crate::source_store::LIBRARY_FILE);
        let mut library: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        // An interpreter whose contributor was later removed by hand.
        library["interpretations"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "stray", "kind": "reading", "source": "grube",
                "text": format!("{PRIVATE_MARKER} stray reading"),
                "interpreters": [{"contributor": "removed"}]
            }));
        fs::write(&path, library.to_string()).unwrap();
        // An unapproved alignment may still name it.
        let alignments_path = root.join(crate::alignment_store::ALIGNMENTS_FILE);
        let alignments = fs::read_to_string(&alignments_path).unwrap().replacen(
            r#"{"source":"grube","absent":true}"#,
            r#"{"source":"grube","absent":true},{"interpretation":"stray"}"#,
            1,
        );
        assert!(alignments.contains(r#""interpretation":"stray""#));
        fs::write(&alignments_path, &alignments).unwrap();

        production_build(&root);
        let built = dist_bytes(&root);
        let page = String::from_utf8_lossy(&built["comparisons/cave/index.html"]).to_string();
        assert!(page.contains("PUBLIC μετὰ ταῦτα") && page.contains("Rendering by PUBLIC Ada"));
        assert!(built
            .values()
            .all(|bytes| !String::from_utf8_lossy(bytes).contains("stray reading")));

        // An interpretation an approved comparison publishes must be valid:
        // the build refuses, naming its id and the library, never its text.
        let after = dist_bytes(&root);
        library["interpretations"][0]["interpreters"] =
            serde_json::json!([{"contributor": "removed"}]);
        fs::write(&path, library.to_string()).unwrap();
        let error = build(
            &root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .err()
        .expect("a published interpretation that is invalid refuses the build");
        assert!(error.contains("interpretation `mine`"), "{error}");
        assert!(!error.contains("`stray`"), "{error}");
        assert!(error.contains(crate::source_store::LIBRARY_FILE), "{error}");
        assert!(error.contains("comparisons.publish"), "{error}");
        assert!(!error.contains("PUBLIC rendering") && !error.contains(PRIVATE_MARKER));
        assert_eq!(dist_bytes(&root), after, "nothing was written");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_comparisons_path_is_reserved_only_while_comparisons_are_published() {
        let root = project_publishing_comparisons("comparisons-reserved");
        fs::create_dir_all(root.join("content/pages")).unwrap();
        fs::write(
            root.join("content/pages/comparisons.md"),
            "---\ntitle: My comparisons\nslug: comparisons\n---\n\nAn older page.\n",
        )
        .unwrap();
        let error = build(
            &root,
            &BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .err()
        .expect("the page collides with published comparisons");
        assert!(error.contains("comparisons"), "{error}");
        fs::write(root.join(CONFIG_FILE), "{}").unwrap();
        production_build(&root);
        assert!(
            dist_bytes(&root).contains_key("comparisons/index.html"),
            "the page keeps working"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
