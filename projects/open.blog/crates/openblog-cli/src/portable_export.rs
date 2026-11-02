use std::path::{Path, PathBuf};

use openblog_core::curated_context::BibliographyContext;
use openblog_core::model::Post;
use openblog_core::portability::PortableProjection;
use openblog_core::source_interchange::{self, Export, ExportLoss};
use openblog_core::Site;

use crate::{clock, fsutil, site};

/// What `openblog export` writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// The portable Markdown article.
    Markdown,
    /// The post's cited references as CSL JSON (ADR 0050).
    CslJson,
    /// The post's cited references as BibTeX (ADR 0050).
    Bibtex,
}

impl Format {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "markdown" => Some(Self::Markdown),
            "csl-json" => Some(Self::CslJson),
            "bibtex" => Some(Self::Bibtex),
            _ => None,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Markdown => "portable-markdown",
            Self::CslJson => "csl-json",
            Self::Bibtex => "bibtex",
        }
    }
}

pub fn run(
    root: &Path,
    slug: &str,
    format: Format,
    output: Option<&str>,
    write: bool,
    json: bool,
) -> Result<(), String> {
    if json && write {
        return Err("--json is available for dry runs only; no files were changed".into());
    }
    if output.is_some_and(str::is_empty) {
        return Err("--out must name a file; no files were changed".into());
    }
    let destination = output.map(|output| output_path(root, output)).transpose()?;
    if !write && !json && output.is_some() {
        println!("Dry run: no files will be written. Re-run with --write to create the export.");
    }

    let (mut site, _) = site::load_site(root, false, Some(clock::now()))?;
    // The public curated context, while the site publishes it (ADR 0202).
    crate::boundary::attach_public_curation(root, &mut site)?;
    let post = site
        .posts
        .iter()
        .find(|post| post.slug == slug)
        .ok_or_else(|| format!("published post `{slug}` was not found"))?;
    if format != Format::Markdown {
        let export = bibliography_export(post, curated_references(&site, post), format)?;
        for warning in crate::boundary::check_export(
            root,
            &site,
            &format!("the {} export of `{slug}`", format.key()),
            &export.content,
            true,
        )? {
            eprintln!("warning: {warning}");
        }
        return run_bibliography(post, &site, format, destination.as_deref(), write, json);
    }
    let projection = PortableProjection::for_site(&site, post)?;
    let markdown = projection.portable_markdown()?;
    let portable = projection.portable_html()?;
    // The publication boundary (ADR 0125): no private research text leaves
    // in an export that nothing public holds.
    for warning in crate::boundary::check_export(
        root,
        &site,
        &format!("the portable Markdown of `{slug}`"),
        &markdown,
        false,
    )? {
        eprintln!("warning: {warning}");
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&export_plan(
                &projection,
                &markdown,
                &portable,
                destination.as_deref(),
            )?)
            .map_err(|error| format!("cannot serialize export plan: {error}"))?
        );
        return Ok(());
    }
    for capability in &portable.capabilities {
        println!(
            "capability: {} [{}] {:?}",
            post.source, capability.id, capability.portability
        );
    }
    for diagnostic in portable.diagnostics {
        println!(
            "warning: {} [{}] {} Action: {}",
            diagnostic.source_path,
            diagnostic.code,
            diagnostic.message,
            diagnostic.recommended_action
        );
    }

    if write {
        let destination =
            destination.ok_or("--write requires --out <path>; no files were changed")?;
        refuse_existing(&destination)?;
        fsutil::write_new_atomic(&destination, markdown.as_bytes())?;
        println!("Portable Markdown written to {}", destination.display());
    } else {
        if let Some(destination) = destination {
            println!("Would write portable Markdown to {}", destination.display());
        } else {
            println!(
                "Portable Markdown preview for `{}` ({})",
                post.title,
                projection.canonical_url()
            );
        }
        print!("{markdown}");
    }
    Ok(())
}

/// A post's cited references in a bibliography format. They come from the
/// post as the site load published it, so the file holds exactly the public
/// description its notes show (the one publication projection, ADR 0048 and
/// ADR 0050), and every detail the format cannot carry is listed.
pub fn bibliography_export(
    post: &Post,
    curated: Option<BibliographyContext>,
    format: Format,
) -> Result<Export, String> {
    let cited = post
        .citations()
        .map(|summary| summary.references.as_slice())
        .unwrap_or_default();
    // The references the author selected for readers of this post join the
    // cited ones, after them, once each (ADR 0205). Anything else they
    // selected has no place in a bibliography, and the export says so.
    let mut references = cited.to_vec();
    let mut not_carried = Vec::new();
    if let Some(curated) = curated {
        for reference in curated.references {
            if !references.iter().any(|known| known.key == reference.key) {
                references.push(reference);
            }
        }
        not_carried = curated.not_carried;
    }
    if references.is_empty() {
        return Err(format!(
            "`{}` publishes no citations, so there are no references to export; add `citations: notes` or `citations: bibliography` and cite a source. No files were changed.",
            post.source
        ));
    }
    let mut export = match format {
        Format::Bibtex => source_interchange::export_cited_bibtex(&references),
        _ => source_interchange::export_cited_csl_json(&references),
    };
    for (id, kind) in not_carried {
        export.losses.push(ExportLoss {
            source_id: id,
            field: kind.to_string(),
            reason: format!(
                "a bibliography has no place for a {kind} the author selected for readers; it is in the portable article and on the canonical page"
            ),
        });
    }
    Ok(export)
}

/// What the post's curated context holds for a bibliography, when the site
/// publishes one and offers the post something.
fn curated_references(site: &Site, post: &Post) -> Option<BibliographyContext> {
    site.curated_context_for(post)?
        .bibliography_for_post(&post.slug)
}

fn run_bibliography(
    post: &Post,
    site: &Site,
    format: Format,
    destination: Option<&Path>,
    write: bool,
    json: bool,
) -> Result<(), String> {
    let export = bibliography_export(post, curated_references(site, post), format)?;
    let label = if format == Format::Bibtex {
        "BibTeX"
    } else {
        "CSL JSON"
    };
    if json {
        let plan = serde_json::json!({
            "version": 1,
            "sourcePath": post.source,
            "canonicalUrl": format!("{}{}", site.config.url.trim_end_matches('/'), post.url),
            "representation": format.key(),
            "outputFile": destination,
            "bytes": export.content.len(),
            "count": export.count,
            "writeRequested": false,
            "offline": true,
            "omissions": export.losses,
            "content": export.content,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&plan)
                .map_err(|error| format!("cannot serialize export plan: {error}"))?
        );
        return Ok(());
    }
    for loss in &export.losses {
        println!(
            "omitted: {} [{}] {}: {}",
            post.source, loss.source_id, loss.field, loss.reason
        );
    }
    if write {
        let destination =
            destination.ok_or("--write requires --out <path>; no files were changed")?;
        refuse_existing(destination)?;
        fsutil::write_new_atomic(destination, export.content.as_bytes())?;
        println!(
            "{label} of {} cited reference(s) written to {}",
            export.count,
            destination.display()
        );
    } else {
        match destination {
            Some(destination) => println!("Would write {label} to {}", destination.display()),
            None => println!(
                "{label} preview of the {} reference(s) `{}` cites (public description only)",
                export.count, post.title
            ),
        }
        print!("{}", export.content);
    }
    Ok(())
}

fn refuse_existing(destination: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(destination) {
        Ok(_) => Err(format!(
            "refusing to overwrite existing export {}; choose a new path",
            destination.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "cannot inspect export destination {}: {error}",
            destination.display()
        )),
    }
}

fn export_plan(
    projection: &PortableProjection<'_>,
    markdown: &str,
    portable: &openblog_core::portability::PortableHtmlOutput,
    destination: Option<&Path>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "version": 1,
        "sourcePath": projection.source_path(),
        "sourceRevision": projection.source_revision()?,
        "canonicalUrl": projection.canonical_url(),
        "representation": "portable-markdown",
        "outputFile": destination,
        "bytes": markdown.len(),
        "writeRequested": false,
        "capabilities": portable.capabilities,
        "diagnostics": portable.diagnostics.iter().map(|diagnostic| diagnostic.scoped("portable-markdown", "portable-export")).collect::<Vec<_>>(),
        "content": markdown,
    }))
}

pub fn diagnostics(site: &Site) -> Result<Vec<String>, String> {
    collect_diagnostics(site, false)
}

pub fn build_diagnostics(site: &Site) -> Result<Vec<String>, String> {
    collect_diagnostics(site, true)
}

/// Interactive blocks always export as their documented static fallback, so the
/// site-wide build and check report only problems. `export` and syndication
/// dry runs still list these for the post being published.
const EXPECTED_FALLBACKS: [&str; 2] = ["graceful-transformation", "canonical-only-interaction"];

fn collect_diagnostics(site: &Site, optional: bool) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    for post in site.posts.iter().filter(|post| !post.draft) {
        let portable = PortableProjection::for_site(site, post)
            .and_then(|projection| projection.portable_html());
        let portable = match portable {
            Ok(portable) => portable,
            Err(error) if optional => {
                warnings.push(format!("portable HTML unavailable: {error}. Native output is unaffected; repair this source before using portable destinations."));
                continue;
            }
            Err(error) => return Err(error),
        };
        for diagnostic in portable.diagnostics {
            if EXPECTED_FALLBACKS.contains(&diagnostic.code.as_str()) {
                continue;
            }
            warnings.push(format!(
                "{} [{}] {} Action: {}",
                diagnostic.source_path,
                diagnostic.code,
                diagnostic.message,
                diagnostic.recommended_action
            ));
        }
    }
    Ok(warnings)
}

pub(crate) fn output_path(root: &Path, output: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(output);
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
        || path.file_name().is_none()
    {
        return Err("export path must name a file without `..`; no files were changed".into());
    }
    let destination = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    for ancestor in destination.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "export path contains a symlink: {}",
                    ancestor.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "cannot inspect export path {}: {error}",
                    ancestor.display()
                ))
            }
        }
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_manifest_is_deterministic_and_reports_exact_artifact_and_capability_levels() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("examples")
            .join("portable-publishing");
        let (site, _) = site::load_site(&root, false, Some(clock::now())).unwrap();
        let post = site
            .posts
            .iter()
            .find(|post| post.slug == "portable-lesson")
            .unwrap();
        let projection = PortableProjection::from_post(post, &site.config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        let portable = projection.portable_html().unwrap();
        let destination = root.join("exports").join("lesson.md");
        let plan = export_plan(&projection, &markdown, &portable, Some(&destination)).unwrap();
        assert_eq!(
            plan,
            export_plan(&projection, &markdown, &portable, Some(&destination)).unwrap()
        );
        assert_eq!(plan["version"], 1);
        assert_eq!(plan["sourcePath"], "posts/portable-lesson.md");
        assert_eq!(plan["bytes"], markdown.len());
        assert_eq!(plan["content"], markdown);
        assert_eq!(plan["writeRequested"], false);
        assert!(plan["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|capability| {
                capability["id"] == "knowledge-check"
                    && capability["portability"] == "gracefully-transformed"
            }));
        assert!(!plan["diagnostics"].as_array().unwrap().is_empty());
        assert!(!destination.exists());
        assert!(run(
            &root,
            "portable-lesson",
            Format::Markdown,
            Some(destination.to_str().unwrap()),
            true,
            true
        )
        .unwrap_err()
        .contains("dry runs only"));
        assert!(!destination.exists());
        for path in ["../escape.md", "exports/../../escape.md", "exports/.."] {
            assert!(output_path(&root, path)
                .unwrap_err()
                .contains("without `..`"));
        }
    }

    #[test]
    fn site_wide_diagnostics_skip_expected_fallbacks_but_keep_them_in_the_export() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("examples")
            .join("portable-publishing");
        let (site, _) = site::load_site(&root, false, Some(clock::now())).unwrap();
        let warnings = diagnostics(&site).unwrap();
        assert!(warnings
            .iter()
            .all(|warning| !warning.contains("[graceful-transformation]")
                && !warning.contains("[canonical-only-interaction]")));
        let post = site
            .posts
            .iter()
            .find(|post| post.slug == "portable-lesson")
            .unwrap();
        let portable = PortableProjection::from_post(post, &site.config)
            .unwrap()
            .portable_html()
            .unwrap();
        assert!(portable
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "graceful-transformation"));
    }

    #[test]
    fn atomic_export_never_replaces_a_concurrent_destination_and_cleans_staging_files() {
        let directory = std::env::temp_dir().join(format!(
            "openblog-export-atomic-{}-{}",
            std::process::id(),
            crate::auth::random_token().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let destination = directory.join("lesson.md");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let writers = [b"first".to_vec(), b"second".to_vec()].map(|contents| {
            let barrier = barrier.clone();
            let destination = destination.clone();
            std::thread::spawn(move || {
                barrier.wait();
                fsutil::write_new_atomic(&destination, &contents)
            })
        });
        let outcomes = writers.map(|writer| writer.join().unwrap());
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        let written = std::fs::read(&destination).unwrap();
        assert!(written == b"first" || written == b"second");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        let error =
            fsutil::write_new_atomic(&directory, b"cannot replace a directory").unwrap_err();
        assert!(error.contains("cannot publish export"));
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_file(destination).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_symlinked_destinations_without_touching_the_target() {
        let directory = std::env::temp_dir().join(format!(
            "openblog-export-symlink-{}",
            crate::auth::random_token().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), directory.join("redirect")).unwrap();
        let error = output_path(&directory, "redirect/lesson.md").unwrap_err();
        assert!(error.contains("symlink"));
        std::fs::remove_file(directory.join("redirect")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn export_rejects_drafts_scheduled_posts_and_invalid_projections_without_writes() {
        let directory = std::env::temp_dir().join(format!(
            "openblog-export-private-{}",
            crate::auth::random_token().unwrap()
        ));
        let posts = directory.join("documents/posts");
        std::fs::create_dir_all(&posts).unwrap();
        std::fs::write(
            directory.join("openblog.json"),
            r#"{"url":"https://portable.example.org","paths":{"content":"documents"}}"#,
        )
        .unwrap();
        let destination = directory.join("exports/lesson.md");
        for (metadata, body) in [
            ("draft: true\ndate: 2020-01-01", "PRIVATE"),
            ("date: 2099-01-01", "SCHEDULED"),
            ("date: 2020-01-01", "[unsafe](javascript:alert(1))"),
        ] {
            let source = format!("---\ntitle: Lesson\nslug: lesson\n{metadata}\n---\n{body}\n");
            std::fs::write(posts.join("lesson.md"), &source).unwrap();
            assert!(run(
                &directory,
                "lesson",
                Format::Markdown,
                Some(destination.to_str().unwrap()),
                true,
                false
            )
            .is_err());
            assert!(!destination.exists());
            assert!(!destination.parent().unwrap().exists());
            assert_eq!(
                std::fs::read_to_string(posts.join("lesson.md")).unwrap(),
                source
            );
        }
        std::fs::remove_file(posts.join("lesson.md")).unwrap();
        std::fs::remove_dir(&posts).unwrap();
        std::fs::remove_dir(directory.join("documents")).unwrap();
        std::fs::remove_file(directory.join("openblog.json")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn an_export_of_a_collaborative_series_part_links_its_canonical_series() {
        let directory = std::env::temp_dir().join(format!(
            "openblog-export-series-{}",
            crate::auth::random_token().unwrap()
        ));
        let posts = directory.join("content/posts");
        std::fs::create_dir_all(&posts).unwrap();
        std::fs::write(
            directory.join("openblog.json"),
            r#"{"url":"https://portable.example.org","author":{"name":"Site Owner"},
              "contributors":{"ann":{"name":"Ann"},"bo":{"name":"Bo"}}}"#,
        )
        .unwrap();
        std::fs::write(
            posts.join("one.md"),
            "---\ntitle: One\nslug: one\ndate: 2020-01-01\nseries: notes\nseriesOrder: 1\n---\nFirst.\n",
        )
        .unwrap();
        std::fs::write(
            posts.join("two.md"),
            "---\ntitle: Two\nslug: two\ndate: 2020-02-01\nseries: notes\nseriesOrder: 2\n---\nSecond.\n",
        )
        .unwrap();
        std::fs::write(
            posts.join("two.credits.json"),
            r#"{"version":1,"credits":[
              {"contributor":"ann","roles":[{"vocabulary":"crossref","role":"author"}]},
              {"contributor":"bo","roles":[{"vocabulary":"crossref","role":"author"}]}]}"#,
        )
        .unwrap();
        for (slug, expected) in [
            ("one", "## Series\n\nPart 1 in the series [Notes](https://portable.example.org/series/notes/). This part is by Site Owner. Series contributors: Site Owner, Ann, and Bo.\n"),
            ("two", "## Series\n\nPart 2 in the series [Notes](https://portable.example.org/series/notes/). This part is by Ann and Bo. Series contributors: Site Owner, Ann, and Bo.\n"),
        ] {
            let destination = directory.join(format!("exports/{slug}.md"));
            run(&directory, slug, Format::Markdown, Some(destination.to_str().unwrap()), true, false).unwrap();
            let exported = std::fs::read_to_string(&destination).unwrap();
            assert!(exported.contains(expected), "{exported}");
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// A site of two series parts with a private notebook holding `note`.
    fn export_site_with_note(tag: &str, note: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "openblog-export-{tag}-{}",
            crate::auth::random_token().unwrap()
        ));
        let posts = directory.join("content/posts");
        std::fs::create_dir_all(&posts).unwrap();
        std::fs::write(
            directory.join("openblog.json"),
            r#"{"url":"https://portable.example.org","author":{"name":"Site Owner"},
              "contributors":{"ann":{"name":"Ann"},"bo":{"name":"Bo"}}}"#,
        )
        .unwrap();
        for (slug, number) in [("one", 1), ("two", 2)] {
            std::fs::write(
                posts.join(format!("{slug}.md")),
                format!("---\ntitle: {slug}\nslug: {slug}\ndate: 2020-0{number}-01\nseries: notes\nseriesOrder: {number}\n---\nFirst.\n"),
            )
            .unwrap();
        }
        let research = directory.join(".openblog/private/research");
        std::fs::create_dir_all(&research).unwrap();
        std::fs::write(
            research.join("sources.json"),
            r#"{"version":1,"sources":[{"id":"plato","kind":"work","title":"Politeia"}]}"#,
        )
        .unwrap();
        std::fs::write(
            research.join("notebook.json"),
            serde_json::json!({"version": 1, "passages": [], "notes": [{"id": "n1", "kind": "observation", "text": note}]})
                .to_string(),
        )
        .unwrap();
        directory
    }

    #[test]
    fn an_export_of_a_post_that_quotes_a_private_passage_is_not_refused() {
        // The portable Markdown holds nothing but the post's own text, which
        // the boundary's export check accepts; a refusal of text no post
        // holds is tested where the check lives (`boundary::tests`).
        let note =
            "Plato's prisoners are not a metaphor for anything at all, really, said the reader.";
        let directory = export_site_with_note("quote", note);
        std::fs::write(
            directory.join("content/posts/two.md"),
            "---\ntitle: two\nslug: two\ndate: 2020-02-01\n---\n\n> Plato's prisoners are not a metaphor\n> for anything at *all*, really,\n> said the reader.\n",
        )
        .unwrap();
        let destination = directory.join("exports/two.md");
        run(
            &directory,
            "two",
            Format::Markdown,
            Some(destination.to_str().unwrap()),
            true,
            false,
        )
        .unwrap();
        assert!(std::fs::read_to_string(&destination)
            .unwrap()
            .contains("prisoners are not a metaphor"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn universal_publishing_export_requires_write_and_preserves_source_and_existing_files() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("examples")
            .join("portable-publishing");
        let source_path = root.join("content/posts/portable-lesson.md");
        let before = std::fs::read(&source_path).unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let destination = std::env::temp_dir().join(format!("openblog-portable-{unique}.md"));
        let output = destination.to_str().unwrap();
        run(
            &root,
            "portable-lesson",
            Format::Markdown,
            Some(output),
            false,
            false,
        )
        .unwrap();
        assert!(!destination.exists());
        run(
            &root,
            "portable-lesson",
            Format::Markdown,
            Some(output),
            true,
            false,
        )
        .unwrap();
        let exported = std::fs::read_to_string(&destination).unwrap();
        for essential in [
            "Alex Example",
            "**Answer:** 2. 42",
            "Open in Rust Playground",
            "Supporting study",
            "Join the discussion",
        ] {
            assert!(exported.contains(essential), "{essential}: {exported}");
        }
        for private in ["PRIVATE_", "runner.example.org", "discussion.example.org"] {
            assert!(!exported.contains(private), "{private}: {exported}");
        }
        let error = run(
            &root,
            "portable-lesson",
            Format::Markdown,
            Some(output),
            true,
            false,
        )
        .unwrap_err();
        assert!(error.contains("refusing to overwrite"));
        assert_eq!(std::fs::read_to_string(&destination).unwrap(), exported);
        assert_eq!(std::fs::read(&source_path).unwrap(), before);
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn bibliography_exports_hold_only_cited_public_references_and_never_overwrite() {
        let directory = std::env::temp_dir().join(format!(
            "openblog-export-bibliography-{}",
            crate::auth::random_token().unwrap()
        ));
        let posts = directory.join("content/posts");
        std::fs::create_dir_all(&posts).unwrap();
        std::fs::write(
            directory.join("openblog.json"),
            r#"{"url":"https://portable.example.org"}"#,
        )
        .unwrap();
        let library = directory.join(crate::source_store::LIBRARY_FILE);
        std::fs::create_dir_all(library.parent().unwrap()).unwrap();
        std::fs::write(
            &library,
            r#"{"version":1,"sources":[
              {"id":"plato","kind":"work","title":"Politeia","creators":[{"name":"Plato"}],"secret":"PRIVATE-EXPORT"},
              {"id":"slings","kind":"edition","of":"plato","title":"Rempublicam","issued":"2003",
               "identifiers":[{"scheme":"my-drive","value":"PRIVATE-EXPORT.pdf"}]},
              {"id":"uncited","kind":"work","title":"PRIVATE-EXPORT uncited"}]}"#,
        )
        .unwrap();
        std::fs::write(
            posts.join("cited.md"),
            "---\ntitle: Cited\ndate: 2020-01-01\ncitations: notes\n---\nSee [@slings, page 3] and [@plato, canonical 514a].\n",
        )
        .unwrap();
        std::fs::write(
            posts.join("plain.md"),
            "---\ntitle: Plain\ndate: 2020-01-02\n---\nNo citations.\n",
        )
        .unwrap();

        let (site, _) = site::load_site(&directory, false, None).unwrap();
        let cited = site.posts.iter().find(|post| post.slug == "cited").unwrap();
        let bibtex = bibliography_export(cited, None, Format::Bibtex).unwrap();
        assert!(
            bibtex.content.starts_with("@misc{slings,\n"),
            "{}",
            bibtex.content
        );
        assert!(
            bibtex.content.contains("\n@misc{plato,\n"),
            "{}",
            bibtex.content
        );
        let csl = bibliography_export(cited, None, Format::CslJson).unwrap();
        for content in [&bibtex.content, &csl.content] {
            assert!(!content.contains("PRIVATE-EXPORT"), "{content}");
            assert!(!content.contains("uncited"), "{content}");
        }
        assert!(csl
            .losses
            .iter()
            .any(|loss| loss.source_id == "slings" && loss.field == "kind"));

        // Written only on request, atomically, and never over an existing file.
        let destination = directory.join("exports/refs.bib");
        let output = destination.to_str().unwrap();
        run(
            &directory,
            "cited",
            Format::Bibtex,
            Some(output),
            false,
            false,
        )
        .unwrap();
        assert!(!destination.exists());
        run(
            &directory,
            "cited",
            Format::Bibtex,
            Some(output),
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            bibtex.content
        );
        let error = run(
            &directory,
            "cited",
            Format::CslJson,
            Some(output),
            true,
            false,
        )
        .unwrap_err();
        assert!(error.contains("refusing to overwrite"), "{error}");
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            bibtex.content
        );

        // A post that publishes no citations exports nothing and writes nothing.
        let none = directory.join("exports/none.json");
        let error = run(
            &directory,
            "plain",
            Format::CslJson,
            Some(none.to_str().unwrap()),
            true,
            false,
        )
        .unwrap_err();
        assert!(
            error.contains("publishes no citations") && error.contains("No files were changed"),
            "{error}"
        );
        assert!(!none.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
