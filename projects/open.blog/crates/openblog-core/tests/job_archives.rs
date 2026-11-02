use openblog_core::{
    generate, job_archive, LoadOptions, OutputFile, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};

fn job(name: &str, date: &str, trade: &str, service: &str) -> SourceFile {
    SourceFile {
        path: format!("posts/{name}.md"),
        contents: format!(
            "---\ntitle: {name}\ndate: {date}\nprofile: job\njob:\n  trade: {trade}\n  service: {service}\n  place:\n    town: Bend\n    region: OR\n  started: {date}\n  finished: {date}\n---\nDone.\n"
        ),
    }
}

fn article(name: &str, date: &str) -> SourceFile {
    SourceFile {
        path: format!("posts/{name}.md"),
        contents: format!("---\ntitle: {name}\ndate: {date}\n---\nWords.\n"),
    }
}

fn build(posts: Vec<SourceFile>, per_page: usize) -> Vec<OutputFile> {
    let config = SiteConfig::from_json(&format!(
        r#"{{"title":"Crew","url":"https://crew.example","postPath":"/{{slug}}/","postsPerPage":{per_page}}}"#
    ))
    .unwrap();
    let site = Site::load(
        config,
        Sources {
            posts,
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    generate(&site, &ThemeSet::new()).unwrap()
}

fn find<'a>(files: &'a [OutputFile], path: &str) -> &'a str {
    &files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("{path} missing"))
        .contents
}

fn mixed() -> Vec<SourceFile> {
    vec![
        article("notes", "2026-10-01"),
        job("oak-floor", "2026-10-16", "flooring", "hardwood-install"),
        job("tile-floor", "2026-10-12", "flooring", "tile"),
        job("second-oak", "2026-10-02", "flooring", "hardwood-install"),
        job("driveway", "2026-10-10", "excavation", "grading"),
        article("more-notes", "2026-10-20"),
    ]
}

#[test]
fn jobs_get_an_archive_per_trade_and_per_service() {
    let files = build(mixed(), 10);
    let all = find(&files, "jobs/index.html");
    assert!(all.contains("oak-floor") && all.contains("driveway"));
    assert!(
        !all.contains("more-notes") && !all.contains(">notes<"),
        "{all}"
    );
    assert!(all.contains("href=\"/jobs/flooring/\"") && all.contains("href=\"/jobs/excavation/\""));

    let flooring = find(&files, "jobs/flooring/index.html");
    assert!(flooring.contains("oak-floor") && flooring.contains("tile-floor"));
    assert!(!flooring.contains("driveway"));
    assert!(flooring.contains("href=\"/jobs/flooring/hardwood-install/\""));

    let service = find(&files, "jobs/flooring/hardwood-install/index.html");
    assert!(service.contains("oak-floor") && service.contains("second-oak"));
    assert!(!service.contains("tile-floor"));
    assert!(service.contains("Hardwood Install (Flooring)"));
    assert!(service.contains("href=\"/jobs/flooring/\""));
    find(&files, "jobs/excavation/grading/index.html");
}

#[test]
fn jobs_are_listed_newest_first() {
    let files = build(mixed(), 10);
    let flooring = find(&files, "jobs/flooring/index.html");
    let at = |name: &str| flooring.find(&format!("href=\"/{name}/\"")).unwrap();
    assert!(at("oak-floor") < at("tile-floor") && at("tile-floor") < at("second-oak"));
}

#[test]
fn archives_page_like_the_home_page() {
    let files = build(mixed(), 2);
    let first = find(&files, "jobs/index.html");
    assert!(first.contains("Page 1 of 2") && first.contains("href=\"/jobs/page/2/\""));
    assert!(first.contains("oak-floor") && first.contains("tile-floor"));
    assert!(!first.contains("driveway"));
    let second = find(&files, "jobs/page/2/index.html");
    assert!(second.contains("Page 2 of 2") && second.contains("href=\"/jobs/\""));
    assert!(second.contains("driveway") && second.contains("second-oak"));
    assert!(!files
        .iter()
        .any(|file| file.path == "jobs/page/3/index.html"));
    // A two-job service fits on one page, so it gets no pager.
    assert!(!files
        .iter()
        .any(|file| file.path == "jobs/flooring/hardwood-install/page/2/index.html"));
}

#[test]
fn a_site_without_jobs_emits_no_job_archive() {
    let files = build(vec![article("notes", "2026-10-01")], 10);
    assert!(files.iter().all(|file| !file.path.starts_with("jobs/")));
    assert!(!find(&files, "sitemap.xml").contains("/jobs/"));
}

#[test]
fn only_archives_with_jobs_are_emitted() {
    let files = build(
        vec![
            job("quick", "2026-10-02", "plumbing", "leak-repair"),
            article("a", "2026-10-03"),
        ],
        10,
    );
    let mut paths: Vec<&str> = files
        .iter()
        .filter(|file| file.path.starts_with("jobs/"))
        .map(|file| file.path.as_str())
        .collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        vec![
            "jobs/index.html",
            "jobs/plumbing/index.html",
            "jobs/plumbing/leak-repair/index.html"
        ]
    );
}

#[test]
fn archives_are_in_the_sitemap_and_leave_the_feeds_alone() {
    let files = build(mixed(), 10);
    let sitemap = find(&files, "sitemap.xml");
    for url in [
        "https://crew.example/jobs/",
        "https://crew.example/jobs/flooring/",
        "https://crew.example/jobs/flooring/hardwood-install/",
        "https://crew.example/jobs/excavation/grading/",
    ] {
        assert!(sitemap.contains(&format!("<loc>{url}</loc>")), "{url}");
    }
    // Jobs are posts, so they appear in the feeds as posts and the archives add nothing.
    let rss = find(&files, "rss.xml");
    assert!(rss.contains("oak-floor") && rss.contains("more-notes"));
    assert!(!rss.contains("/jobs/"));
    assert!(!find(&files, "feed.json").contains("/jobs/"));
}

#[test]
fn archives_are_deterministic() {
    let first = build(mixed(), 2);
    let again = build(mixed().into_iter().rev().collect(), 2);
    let mut left: Vec<_> = first.iter().map(|f| (&f.path, &f.contents)).collect();
    let mut right: Vec<_> = again.iter().map(|f| (&f.path, &f.contents)).collect();
    left.sort();
    right.sort();
    assert_eq!(left, right);
}

#[test]
fn the_plan_lists_all_then_trades_then_services_by_name() {
    let config = SiteConfig::default();
    let site = Site::load(
        config,
        Sources {
            posts: mixed(),
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    let urls: Vec<String> = job_archive::plan(&site)
        .into_iter()
        .map(|archive| archive.url)
        .collect();
    assert_eq!(
        urls,
        vec![
            "/jobs/",
            "/jobs/excavation/",
            "/jobs/flooring/",
            "/jobs/excavation/grading/",
            "/jobs/flooring/hardwood-install/",
            "/jobs/flooring/tile/",
        ]
    );
}
