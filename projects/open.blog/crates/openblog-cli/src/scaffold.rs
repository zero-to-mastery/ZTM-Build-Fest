//! `openblog init` and `openblog new`.

use std::fs;
use std::path::Path;

use openblog_core::frontmatter::{self, Value};
use openblog_core::slug::slugify;
use openblog_core::{DateTime, SiteConfig};

use crate::fsutil;
use crate::site::{self, CONFIG_FILE, EMBEDDED_BASE_THEME, EMBEDDED_WEB};

pub fn today() -> DateTime {
    crate::clock::now()
}

const WELCOME: &str = "Welcome to your new blog. This post is a plain Markdown file in `content/posts/`.

## Write

Drop any `.md` file into `content/posts/`. The front matter at the top sets the title, date, tags, and optional series.

## Publish

Run `openblog build`, then upload the `dist/` folder to any static host. Your RSS feed is at `/rss.xml`.

```rust runnable
fn main() {
    println!(\"Hello, open.blog!\");
}
```
";

const ABOUT: &str = "This page is `content/pages/about.md`. Pages with `nav: true` in their front matter appear in the header.
";

/// Create a new project in `dir`. Existing content is never overwritten. In a
/// Git project, an existing `.gitignore` keeps its rules and gains the private
/// assistant-storage rule when that boundary is missing.
pub fn init(dir: &Path, title: Option<&str>, github_pages: bool) -> Result<Vec<String>, String> {
    let mut created = Vec::new();
    let mut write = |rel: &str, contents: &str| -> Result<(), String> {
        let path = dir.join(rel);
        if path.exists() {
            return Ok(());
        }
        fsutil::write_file(&path, contents.as_bytes())?;
        created.push(rel.to_string());
        Ok(())
    };

    let mut config = SiteConfig::default();
    if let Some(t) = title {
        config.title = t.to_string();
    }
    write(CONFIG_FILE, &format!("{}\n", config.to_json()))?;

    let date = today().ymd();
    let post = frontmatter::serialize(&[
        ("title", Value::Scalar("Hello, world".into())),
        ("date", Value::Scalar(date)),
        ("tags", Value::List(vec!["meta".into()])),
        (
            "description",
            Value::Scalar("The first post on a new open.blog.".into()),
        ),
    ]);
    write(
        "content/posts/hello-world.md",
        &format!("{post}\n{WELCOME}"),
    )?;
    let page = frontmatter::serialize(&[
        ("title", Value::Scalar("About".into())),
        ("nav", Value::Scalar("true".into())),
    ]);
    write("content/pages/about.md", &format!("{page}\n{ABOUT}"))?;
    write("content/series/.gitkeep", "")?;
    write("static/.gitkeep", "")?;

    write("themes/base/theme.json", EMBEDDED_BASE_THEME)?;
    for (rel, contents) in site::EMBEDDED_THEMES {
        write(&format!("themes/{rel}"), contents)?;
    }
    for (rel, contents) in EMBEDDED_WEB {
        write(&format!("web/{rel}"), contents)?;
    }
    write(".gitignore", "/dist\n/.openblog\n/.openblog/private/\n")?;
    if github_pages {
        let workflow = site::PAGES_WORKFLOW.replace("OPENBLOG_VERSION", env!("CARGO_PKG_VERSION"));
        write(".github/workflows/pages.yml", &workflow)?;
    }
    if dir.join(".git").exists() {
        let ignore_path = dir.join(".gitignore");
        let mut ignored = fs::read_to_string(&ignore_path)
            .map_err(|error| format!("cannot read {}: {error}", ignore_path.display()))?;
        if !ignored
            .lines()
            .any(|line| line.trim() == "/.openblog/private/")
        {
            if !ignored.is_empty() && !ignored.ends_with('\n') {
                ignored.push('\n');
            }
            ignored.push_str("/.openblog/private/\n");
            fsutil::write_file(&ignore_path, ignored.as_bytes())?;
            if !created.iter().any(|path| path == ".gitignore") {
                created.push(".gitignore".into());
            }
        }
    }
    // Binary files (the WebAssembly search engine) go last, after the text closure is done.
    for (rel, bytes) in site::EMBEDDED_WEB_BINARY {
        let path = dir.join("web").join(rel);
        if !path.exists() {
            fsutil::write_file(&path, bytes)?;
            created.push(format!("web/{rel}"));
        }
    }
    Ok(created)
}

/// The body of `openblog new --recipe`: the sections the engine turns into
/// a recipe card, scaling, checklists and timers, ready to fill in.
const RECIPE_BODY: &str = "
A few words about this dish: where it comes from and why you make it.

> [!TIP]
> A swap, a shortcut, or something to watch out for.

## Ingredients

- 2 cups flour
- 1 tsp salt
- 1 1/2 cups milk

## Steps

1. Heat the oven to 200 °C (400 °F).
2. Mix everything into a smooth batter.
3. Bake for 25 minutes, until golden.
";

/// Create `content/posts/<date>-<slug>.md` and return its path. With `recipe`,
/// the post starts from a recipe template (servings, times, ingredients, steps).
pub fn new_post(
    root: &Path,
    title: &str,
    series: Option<&str>,
    tags: &[String],
    draft: bool,
    recipe: bool,
) -> Result<String, String> {
    let config = site::load_config(root)?;
    let slug = slugify(title);
    if slug.is_empty() {
        return Err("the title needs at least one letter or digit".into());
    }
    let date = today().ymd();
    let rel = format!("{}/posts/{date}-{slug}.md", config.paths.content);
    let path = root.join(&rel);
    if path.exists() {
        return Err(format!("{rel} already exists"));
    }
    let mut fields: Vec<(&str, Value)> = vec![
        ("title", Value::Scalar(title.to_string())),
        ("date", Value::Scalar(date)),
    ];
    if let Some(s) = series {
        fields.push(("series", Value::Scalar(slugify(s))));
    }
    if !tags.is_empty() {
        fields.push(("tags", Value::List(tags.to_vec())));
    }
    fields.push(("description", Value::Scalar(String::new())));
    if recipe {
        for (key, value) in [
            ("profile", "recipe"),
            ("servings", "4"),
            ("prep", "15 min"),
            ("cook", "25 min"),
        ] {
            fields.push((key, Value::Scalar(value.into())));
        }
    }
    if draft {
        fields.push(("draft", Value::Scalar("true".into())));
    }
    let mut text = frontmatter::serialize(&fields);
    text.push_str(if recipe {
        RECIPE_BODY
    } else {
        "\nWrite your post here.\n"
    });
    fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|e| e.to_string())?;
    fsutil::write_file(&path, text.as_bytes())?;
    Ok(rel)
}

/// The answers `openblog new --profile job` can take. Every one is optional: a
/// job starts as a draft and the build says what is still missing.
#[derive(Default)]
pub struct JobStart<'a> {
    pub trade: Option<&'a str>,
    pub service: Option<&'a str>,
    pub town: Option<&'a str>,
    pub region: Option<&'a str>,
}

/// Create a draft job post (ADR 0287): the same `job` front matter and the same
/// four headings Admin's Job mode writes, checked by the job profile in core.
pub fn new_job(
    root: &Path,
    title: &str,
    series: Option<&str>,
    tags: &[String],
    start: &JobStart,
) -> Result<String, String> {
    use openblog_core::job;
    let config = site::load_config(root)?;
    fn clean(value: Option<&str>) -> Option<&str> {
        value.map(str::trim).filter(|value| !value.is_empty())
    }
    let trade = match clean(start.trade) {
        Some(trade) => job::normalize_trade(trade, &config.extra_trades)?,
        None => String::new(),
    };
    let service = match clean(start.service) {
        Some(service) => job::normalize_service(service)?,
        None => String::new(),
    };
    let town = match clean(start.town) {
        Some(town) => job::normalize_place(town, "job.place.town")?,
        None => String::new(),
    };
    let region = match clean(start.region) {
        Some(region) => job::normalize_place(region, "job.place.region")?,
        None => String::new(),
    };
    let slug = slugify(title);
    if slug.is_empty() {
        return Err("the title needs at least one letter or digit".into());
    }
    let date = today().ymd();
    let rel = format!("{}/posts/{date}-{slug}.md", config.paths.content);
    let path = root.join(&rel);
    if path.exists() {
        return Err(format!("{rel} already exists"));
    }
    let mut fields: Vec<(&str, Value)> = vec![
        ("title", Value::Scalar(title.to_string())),
        ("date", Value::Scalar(date.clone())),
    ];
    if let Some(s) = series {
        fields.push(("series", Value::Scalar(slugify(s))));
    }
    if !tags.is_empty() {
        fields.push(("tags", Value::List(tags.to_vec())));
    }
    fields.push(("description", Value::Scalar(String::new())));
    fields.push((
        "profile",
        Value::Scalar(openblog_core::profile::JOB_ID.into()),
    ));
    fields.push(("draft", Value::Scalar("true".into())));
    for (key, value) in [
        ("job.trade", trade),
        ("job.service", service),
        ("job.place.town", town),
        ("job.place.region", region),
        ("job.started", date.clone()),
        ("job.finished", date),
    ] {
        fields.push((key, Value::Scalar(value)));
    }
    let mut text = frontmatter::serialize(&fields);
    text.push('\n');
    text.push_str(&job::scaffold_body());
    fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|e| e.to_string())?;
    fsutil::write_file(&path, text.as_bytes())?;
    Ok(rel)
}

/// The answers `openblog new --profile service` can take.
#[derive(Default)]
pub struct ServiceStart<'a> {
    pub id: Option<&'a str>,
    pub price_band: Option<&'a str>,
}

/// Create a draft service, `content/services/<id>.md` (ADR 0313): version 1
/// front matter with the required keys left for the owner to fill in, checked
/// by the same rules the build uses. A draft never stops a build; `openblog
/// check` lists what is still missing.
pub fn new_service(root: &Path, name: &str, start: &ServiceStart) -> Result<String, String> {
    use openblog_core::{job::CostBand, service};
    let config = site::load_config(root)?;
    let name = name.trim();
    if name.is_empty()
        || name.chars().any(char::is_control)
        || name.chars().count() > service::MAX_NAME
    {
        return Err(format!(
            "the name needs 1 to {} characters of plain text",
            service::MAX_NAME
        ));
    }
    let id = match start.id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => id.to_string(),
        None => slugify(name),
    };
    service::check_id(&id)?;
    let band = match start
        .price_band
        .map(str::trim)
        .filter(|band| !band.is_empty())
    {
        Some(band) => Some(CostBand::parse(band).ok_or_else(|| {
            format!(
                "priceBand: `{band}` is not a price band; use one of {}",
                CostBand::ALL.map(CostBand::as_str).join(", ")
            )
        })?),
        None => None,
    };
    let rel = format!("{}/{}/{id}.md", config.paths.content, service::SERVICES_DIR);
    let path = root.join(&rel);
    if path.exists() {
        return Err(format!("{rel} already exists"));
    }
    let mut fields: Vec<(&str, Value)> = vec![
        (
            "version",
            Value::Scalar(service::SERVICE_VERSION.to_string()),
        ),
        ("id", Value::Scalar(id)),
        ("name", Value::Scalar(name.to_string())),
        ("summary", Value::Scalar(String::new())),
    ];
    if let Some(band) = band {
        fields.push(("priceBand", Value::Scalar(band.as_str().into())));
    }
    fields.push(("draft", Value::Scalar("true".into())));
    let mut text = frontmatter::serialize(&fields);
    text.push_str("\nDescribe the service here. This text appears on its page.\n");
    fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|e| e.to_string())?;
    fsutil::write_file(&path, text.as_bytes())?;
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_adds_private_assistant_storage_to_an_existing_gitignore() {
        let dir =
            std::env::temp_dir().join(format!("ob-init-private-ignore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".gitignore"), "/dist\n/custom-cache\n").unwrap();

        init(&dir, Some("Private Context"), false).unwrap();

        let ignored = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(ignored.contains("/custom-cache"));
        assert!(ignored.lines().any(|line| line == "/.openblog/private/"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_ignores_the_private_voice_paths_in_a_git_project() {
        let dir = std::env::temp_dir().join(format!("ob-init-voice-ignore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = crate::git::Git::new(&dir);
        git.init().unwrap();

        init(&dir, Some("Voice"), false).unwrap();

        // The private context folder (which holds voice samples) and the session record are both
        // under the ignored `/.openblog/private/`, while portable samples are not ignored.
        for private in [
            ".openblog/private/context/voice/2026-10-28-a-mistake-i-made-rough.md",
            ".openblog/private/voice/session.json",
        ] {
            assert!(
                git.run(&["check-ignore", "-q", "--no-index", private])
                    .is_ok(),
                "{private} should be ignored"
            );
        }
        assert!(git
            .run(&[
                "check-ignore",
                "-q",
                "--no-index",
                "assistant/context/voice/2026-10-28-a-mistake-i-made-rough.md"
            ])
            .is_err());
        // Creating a voice folder is not init's job.
        assert!(!dir.join("assistant").exists());
        assert!(!dir.join(".openblog/private").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_leaves_an_existing_gitignore_alone_in_a_project_without_git() {
        let dir =
            std::env::temp_dir().join(format!("ob-init-no-git-ignore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(".gitignore"),
            "/dist
/custom-cache",
        )
        .unwrap();

        let created = init(&dir, Some("No Git"), false).unwrap();

        assert_eq!(
            fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "/dist
/custom-cache"
        );
        assert!(!created.iter().any(|path| path == ".gitignore"));
        let _ = fs::remove_dir_all(&dir);

        // A fresh project without Git gets the standard file, which already lists the private folder.
        let fresh =
            std::env::temp_dir().join(format!("ob-init-fresh-ignore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&fresh);
        init(&fresh, Some("Fresh"), false).unwrap();
        assert_eq!(
            fs::read_to_string(fresh.join(".gitignore")).unwrap(),
            "/dist
/.openblog
/.openblog/private/
"
        );
        let _ = fs::remove_dir_all(&fresh);
    }

    #[test]
    fn init_creates_a_buildable_project_and_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("ob-init-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let created = init(&dir, Some("My Blog"), true).unwrap();
        assert!(created.iter().any(|c| c == "openblog.json"));
        fs::write(
            dir.join("content/posts/hello-world.md"),
            "---\ntitle: Mine\ndate: 2026-01-01\n---\nkeep",
        )
        .unwrap();
        assert!(init(&dir, Some("Other"), false).unwrap().is_empty());
        assert!(
            dir.join("web/wasm/openblog_wasm_bg.wasm").exists(),
            "search works without a workspace"
        );
        assert!(
            dir.join("themes/demo/reveal.js").exists()
                && dir.join("themes/paper/theme.json").exists()
        );
        let workflow = fs::read_to_string(dir.join(".github/workflows/pages.yml")).unwrap();
        assert!(workflow.contains("openblog build") && !workflow.contains("OPENBLOG_VERSION"));
        assert!(fs::read_to_string(dir.join("content/posts/hello-world.md"))
            .unwrap()
            .contains("keep"));

        let report = site::build(
            &dir,
            &site::BuildOptions {
                include_drafts: false,
                out_override: None,
                now: None,
            },
        )
        .unwrap();
        assert_eq!(report.posts, 1);
        assert!(dir.join("dist/index.html").exists());
        assert!(dir.join("dist/rss.xml").exists());
        assert!(dir.join("dist/assets/base.css").exists());
        assert!(dir
            .join("dist/assets/orcid-unauthenticated-id-icons.png")
            .exists());
        assert!(dir.join("dist/assets/components/ob-quiz.js").exists());
        assert!(
            dir.join("dist/assets/components/ob-rust-playground.js")
                .exists()
                && dir
                    .join("dist/assets/components/ob-rust-runner.js")
                    .exists()
        );
        assert!(dir.join("dist/themes/base/tokens.css").exists());
        assert!(dir.join("dist/assets/wasm/openblog_wasm_bg.wasm").exists());
        fs::write(dir.join("content/posts/_notes.md"), "not a post").unwrap();
        fs::create_dir_all(dir.join("content/posts/_ideas")).unwrap();
        fs::write(dir.join("content/posts/_ideas/x.md"), "not a post either").unwrap();

        let rel = new_post(
            &dir,
            "A New Post!",
            Some("My Series"),
            &["rust".into()],
            true,
            false,
        )
        .unwrap();
        assert!(rel.ends_with("-a-new-post.md"));
        assert!(new_post(&dir, "A New Post!", None, &[], false, false).is_err());
        let recipe = new_post(&dir, "Lemon Pasta", None, &[], true, true).unwrap();
        let text = fs::read_to_string(dir.join(&recipe)).unwrap();
        let doc = openblog_core::frontmatter::parse(&text).unwrap();
        assert_eq!(doc.front_matter.get("profile"), Some("recipe"));
        assert_eq!(doc.front_matter.get("recipe"), None);
        assert!(openblog_core::recipe::is_recipe(&doc.front_matter));
        assert!(text.contains("## Ingredients") && text.contains("## Steps"));
        let drafts = site::build(
            &dir,
            &site::BuildOptions {
                include_drafts: true,
                out_override: None,
                now: None,
            },
        )
        .unwrap();
        assert_eq!(drafts.posts, 3, "hello world, the new post and the recipe");
        let _ = fs::remove_dir_all(&dir);
    }
}
