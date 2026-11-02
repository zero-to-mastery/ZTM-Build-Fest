use openblog_core::{
    frontmatter, generate, job, model, profile, LoadOptions, Site, SiteConfig, SourceFile, Sources,
    ThemeSet,
};

fn fields(source: &str) -> frontmatter::FrontMatter {
    frontmatter::parse(source).unwrap().front_matter
}

const VALID: &str = "---
title: New oak floor in Maple Falls
date: 2026-10-21
tags: [flooring]
profile: job
custom: kept
job:
  trade: flooring
  service: hardwood-install
  place:
    town: Maple Falls
    region: WA
  started: 2026-10-14
  finished: 2026-10-16
  durationHours: 22.5
  costBand: 2k-10k
  materials:
    - Red oak 3/4 in
    - Matte finish
  media:
    before:
      - /images/floor-before.jpg
    after: [/images/floor-after.jpg, https://example.com/a.webp?w=800]
  review: rev_01-a
  futureKey: from a newer build
---
Body.";

fn job_post(contents: &str) -> Result<model::Post, String> {
    model::load_post(
        &SourceFile {
            path: "posts/floor.md".into(),
            contents: contents.into(),
        },
        &SiteConfig::default(),
        Default::default(),
    )
}

fn replace(from: &str, to: &str) -> String {
    assert!(VALID.contains(from), "{from}");
    VALID.replacen(from, to, 1)
}

fn problems(contents: &str) -> String {
    job_post(contents).expect_err("job should be refused")
}

#[test]
fn the_job_profile_is_selectable_and_listed_after_the_others() {
    let resolved = profile::resolve(&fields("---\nprofile: job\n---\nBody"));
    assert_eq!(resolved.id, "job");
    assert_eq!(resolved.behavior, profile::ProfileBehavior::Job);
    assert!(resolved.warnings.is_empty());
    let ids = profile::catalog().iter().map(|p| p.id).collect::<Vec<_>>();
    assert_eq!(ids.last(), Some(&"job"));
    assert_eq!(ids[0], "article");
}

#[test]
fn a_complete_job_loads_every_field() {
    let post = job_post(VALID).unwrap();
    let job = post.job.expect("job metadata");
    assert_eq!(job.trade, "flooring");
    assert_eq!(job.service, "hardwood-install");
    assert_eq!(
        (job.town.as_str(), job.region.as_str()),
        ("Maple Falls", "WA")
    );
    assert_eq!(
        (job.started.as_str(), job.finished.as_str()),
        ("2026-10-14", "2026-10-16")
    );
    assert_eq!(job.duration_hours.as_deref(), Some("22.5"));
    assert_eq!(job.cost_band, Some(job::CostBand::From2kTo10k));
    assert_eq!(job.materials, vec!["Red oak 3/4 in", "Matte finish"]);
    assert_eq!(job.before, vec!["/images/floor-before.jpg"]);
    assert_eq!(job.after.len(), 2);
    assert_eq!(job.review.as_deref(), Some("rev_01-a"));
}

#[test]
fn only_the_required_fields_are_needed() {
    let minimal = "---\ntitle: Quick fix\ndate: 2026-10-21\nprofile: job\njob:\n  trade: plumbing\n  service: leak-repair\n  place:\n    town: Bend\n    region: OR\n  started: 2026-10-21\n  finished: 2026-10-21\n---\nBody.";
    let job = job_post(minimal).unwrap().job.unwrap();
    assert!(job.materials.is_empty() && job.before.is_empty() && job.after.is_empty());
    assert!(job.cost_band.is_none() && job.duration_hours.is_none() && job.review.is_none());
}

#[test]
fn unknown_keys_survive_a_parse_and_compose_round_trip() {
    let document = frontmatter::parse(VALID).unwrap();
    assert_eq!(
        document.front_matter.get("job.futureKey"),
        Some("from a newer build")
    );
    assert_eq!(document.front_matter.get("custom"), Some("kept"));
    let written = frontmatter::compose(&document.front_matter.fields, &document.body);
    let again = frontmatter::parse(&written).unwrap();
    assert_eq!(again.front_matter, document.front_matter);
    assert!(
        written.contains("\njob:\n  costBand: 2k-10k\n"),
        "{written}"
    );
    assert!(
        written.contains("\n  place:\n    region: WA\n    town: Maple Falls\n"),
        "{written}"
    );
}

#[test]
fn a_nested_mapping_is_only_understood_under_job() {
    let error = frontmatter::parse("---\ntitle: x\nother:\n  key: value\n---\n").unwrap_err();
    assert!(
        error.contains("unsupported nested value under `other`"),
        "{error}"
    );
}

#[test]
fn trade_must_be_known_or_added_by_the_site() {
    let error = problems(&replace("trade: flooring", "trade: fencing"));
    assert!(
        error.contains("job.trade: `fencing` is not a known trade"),
        "{error}"
    );
    assert!(error.contains("extraTrades"), "{error}");

    let config = SiteConfig {
        extra_trades: vec!["Fencing".into()],
        ..Default::default()
    };
    let post = model::load_post(
        &SourceFile {
            path: "posts/fence.md".into(),
            contents: replace("trade: flooring", "trade: fencing"),
        },
        &config,
        Default::default(),
    )
    .unwrap();
    assert_eq!(post.job.unwrap().trade, "fencing");
    assert!(job::TRADES.contains(&"mobile-mechanic") && job::TRADES.len() == 12);
    assert!(job::check_extra_trade("Bad Trade!").is_err());
}

#[test]
fn required_fields_are_named_in_plain_words() {
    let bare = "---\ntitle: Bare\ndate: 2026-10-21\nprofile: job\n---\nBody.";
    let error = problems(bare);
    for field in [
        "job.trade",
        "job.service",
        "job.place.town",
        "job.place.region",
        "job.started",
        "job.finished",
    ] {
        assert!(error.contains(field), "{field} in {error}");
    }
}

#[test]
fn dates_must_be_real_and_finished_not_before_started() {
    let error = problems(&replace("finished: 2026-10-16", "finished: 2026-10-13"));
    assert!(
        error.contains("job.finished: must be the same day as `started` or later"),
        "{error}"
    );
    assert!(job_post(&replace("finished: 2026-10-16", "finished: 2026-10-14")).is_ok());
    let error = problems(&replace("started: 2026-10-14", "started: 2026-13-40"));
    assert!(
        error.contains("job.started: `2026-13-40` is not a date"),
        "{error}"
    );
    let error = problems(&replace("started: 2026-10-14", "started: last Tuesday"));
    assert!(error.contains("job.started"), "{error}");
}

#[test]
fn cost_band_is_an_enum_never_free_text() {
    for band in [
        "under-500",
        "500-2k",
        "2k-10k",
        "10k-50k",
        "over-50k",
        "ask",
    ] {
        assert!(job_post(&replace("costBand: 2k-10k", &format!("costBand: {band}"))).is_ok());
    }
    let error = problems(&replace("costBand: 2k-10k", "costBand: about $3000"));
    assert!(
        error.contains("job.costBand: `about $3000` is not a cost band"),
        "{error}"
    );
    assert!(
        error.contains("under-500, 500-2k, 2k-10k, 10k-50k, over-50k, ask"),
        "{error}"
    );
}

#[test]
fn place_is_a_town_never_an_address() {
    let error = problems(&replace("town: Maple Falls", "town: 123 Main St"));
    assert!(error.contains("job.place.town"), "{error}");
    assert!(error.contains("not an address"), "{error}");
    let error = problems(&replace("region: WA", "region: WA 98264"));
    assert!(error.contains("job.place.region"), "{error}");
}

#[test]
fn duration_materials_and_review_are_checked() {
    for bad in ["0", "-3", "lots", "NaN"] {
        let error = problems(&replace(
            "durationHours: 22.5",
            &format!("durationHours: {bad}"),
        ));
        assert!(error.contains("job.durationHours"), "{bad}: {error}");
    }
    let error = problems(&replace("review: rev_01-a", "review: not an id!"));
    assert!(error.contains("job.review"), "{error}");
    let many = (0..51).map(|n| format!("    - m{n}\n")).collect::<String>();
    let error = problems(&replace(
        "  materials:\n    - Red oak 3/4 in\n    - Matte finish\n",
        &format!("  materials:\n{many}"),
    ));
    assert!(error.contains("job.materials: list at most 50"), "{error}");
}

#[test]
fn media_must_be_image_references() {
    for bad in [
        "notes.pdf",
        "javascript:alert(1).png",
        "../secret.png",
        "ftp://host/a.png",
        "//cdn.example/a.png",
        "no extension",
    ] {
        let error = problems(&replace(
            "- /images/floor-before.jpg",
            &format!("- \"{bad}\""),
        ));
        assert!(error.contains("job.media.before"), "{bad}: {error}");
    }
    let error = problems(&replace(
        "after: [/images/floor-after.jpg,",
        "after: [/x.exe,",
    ));
    assert!(error.contains("job.media.after"), "{error}");
}

#[test]
fn every_problem_is_reported_together() {
    let error = problems(
        &replace("trade: flooring", "trade: nope").replace("costBand: 2k-10k", "costBand: cheap"),
    );
    assert!(
        error.contains("job.trade") && error.contains("job.costBand"),
        "{error}"
    );
}

#[test]
fn a_job_must_be_a_mapping() {
    let error =
        problems("---\ntitle: X\ndate: 2026-10-21\nprofile: job\njob: flooring\n---\nBody.");
    assert!(error.contains("job: must be a mapping"), "{error}");
}

#[test]
fn an_unfinished_draft_job_is_a_warning_not_an_error() {
    let draft = "---\ntitle: Wip\ndate: 2026-10-21\ndraft: true\nprofile: job\njob:\n  trade: flooring\n---\nBody.";
    let site = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/wip.md".into(),
                contents: draft.into(),
            }],
            ..Default::default()
        },
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(site.posts[0].job.is_none());
    assert!(site
        .warnings
        .iter()
        .any(|warning| warning.contains("job not ready to publish: job.service")));
}

#[test]
fn job_front_matter_only_matters_to_job_posts() {
    let article = "---\ntitle: Notes\ndate: 2026-10-21\njob:\n  trade: nonsense\n---\nBody.";
    assert!(job_post(article).unwrap().job.is_none());
}

fn fnv(files: &[openblog_core::OutputFile]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
    };
    for file in files {
        feed(file.path.as_bytes());
        feed(&[0]);
        feed(file.contents.as_bytes());
        feed(&[1]);
    }
    hash
}

/// A site that never writes `profile: job` builds exactly as it did before the
/// job profile existed. The value below was produced by the build before it.
#[test]
fn a_site_without_a_job_profile_builds_byte_for_byte_unchanged() {
    let config = SiteConfig::from_json(
        r#"{"title":"Notes","url":"https://notes.example","postPath":"/{slug}/"}"#,
    )
    .unwrap();
    let post = |name: &str, extra: &str| {
        SourceFile {
        path: format!("posts/{name}.md"),
        contents: format!(
            "---\ntitle: {name}\ndate: 2026-10-2{}\ntags: [one, two]\n{extra}---\n# {name}\n\nSome *text* and a [link](/a/).\n",
            name.len() % 9
        ),
    }
    };
    let site = Site::load(
        config,
        Sources {
            posts: vec![
                post("alpha", ""),
                post("beta", "profile: article\n"),
                post("gamma", "profile: field-journal\nlocationPrivacy: hidden\n"),
            ],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    let files = generate(&site, &ThemeSet::new()).unwrap();
    assert!(files.iter().all(|file| !file.path.starts_with("jobs")));
    assert_eq!(
        (files.len(), format!("{:016x}", fnv(&files))),
        (23, String::from("c50e9f5e18e3cdbf"))
    );
}
