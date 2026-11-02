//! The `openblog` command line.

mod admin;
mod admin_preferences;
mod alignment_store;
mod analytics;
mod assistant;
mod assistant_storage;
mod atlas_store;
mod auth;
mod boundary;
mod claims_store;
mod clock;
mod comparison_store;
mod config_text;
mod contributor_migration;
mod fsutil;
mod git;
mod hashnode;
mod http;
mod landing_history;
mod landing_store;
mod notebook_store;
mod paths_exchange;
mod portable_export;
mod private_guard;
mod publish;
mod readiness;
mod reading_path_store;
mod research_review;
mod safe_http;
mod scaffold;
mod selection_store;
mod serve;
mod shared_publications;
mod site;
mod source_metadata;
mod source_store;
mod syndication;
mod transaction;
mod url_context;
mod voice_assistant;
mod voice_capture;
mod voice_cli;
mod voice_diff;
mod voice_exchange;
mod voice_prompts;
mod voice_session;
mod voice_store;
mod workspace;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::{Command, ExitCode};

const HELP: &str = "openblog: a Markdown blog engine in Rust and WebAssembly

USAGE
    openblog <command> [options]

COMMANDS
    init [dir]                 Create a new blog in dir (default: current directory)
    init [dir] --github-pages  Also write a GitHub Pages deployment workflow
    init [dir] --no-voice      Never offer a writing session afterwards (a terminal is
                               asked once; scripts and pipes are never asked)
    new \"Title\"                Create content/posts/<date>-<slug>.md
    build                      Build the site into dist/
    serve                      Build, serve at http://localhost:8080, rebuild on change,
                               and publish scheduled posts on time
    serve --admin              Also serve the login-protected editor at /admin
    user add|passwd|remove|list <name>
                               Manage who can sign in to the admin editor
    check                      Validate content and themes without writing anything
    export <slug>              Preview or write a portable Markdown article, or the
                               post's cited references as CSL JSON or BibTeX
    paths export|import        Export reading paths to one file, or check and import one
                               (dry run unless --write)
    publish [summary]          Commit changed content with git and push (deploys via CI)
    publish setup              Create the repository and Pages workflow, report what is left
    syndicate <slug>           Plan cross-posting (add --write to create/update remote drafts)
    analytics backup           Save view counts to the analytics branch (and push)
    analytics pull <url>       Merge counts from a hosted counter (--secret <s>)
    analytics worker [dir]     Write a Cloudflare Worker counter to deploy (default: counter/)
    analytics service [dir]    Write a Node + MongoDB counter for Render (default: counter-service/)
    voice [prompt-id]          A timed writing session: draw three prompts (or name one),
                               write in your editor or the terminal, and keep the rough draft
                               exactly as written (see voice OPTIONS)
    voice --list               Prompts by pack, with what you have answered
    voice --resume             Carry on with an interrupted session (an expired one is locked)
    voice erase --yes          Erase every sample, the session record, the guide and editor files
    voice guide --move portable|private
                               Move the voice guide between the folders (preview; --yes moves it)
    voice polish|diff|promote <sample>
                               Refine a copy, compare it, or make a post draft from it
    voice export|import        Move your voice samples and guide in one file, previewed and
                               all or nothing (see voice OPTIONS)
    themes                     List themes and the inheritance chain of each
    import hashnode <host>     Import a Hashnode blog (e.g. yourname.hashnode.dev)
    contributors migrate --id <stable-id> [--write]
                               Plan or write explicit legacy-author credit sidecars
    build-wasm                 Rebuild the WebAssembly module (engine repository only)
    help                       Show this help

COMMON OPTIONS
    --root <dir>               Project directory (default: .)
    --drafts                   Include drafts and scheduled posts (for previews)
    --out <dir>                Output directory for build (default: paths.output)
    --port <n>                 Port for serve (default: 8080)
    --host <addr>              Address for serve (default: 127.0.0.1; use 0.0.0.0 behind HTTPS)
    --password-stdin           For `user`: read the password from standard input

syndicate OPTIONS
    --target a,b               Limit the run to named configured targets
    --write                    Send remote create/update requests and save private state
    --publish                  Request publication (also requires target allowPublish: true)
    --json                     Print a deterministic dry-run plan with before/after artifacts

export OPTIONS
    --format markdown|csl-json|bibtex
                               Portable format (default: markdown); csl-json and bibtex
                               export the public description of the references the post
                               cites, and list what the format leaves out
    --out <path>               Output file for an explicit --write
    --write                    Write the export (otherwise print a dry-run preview)
    --json                     Print a versioned dry-run manifest with exact content

paths OPTIONS
    paths export [--out <file>] [--drafts] [--write]
                               Print the published reading paths as one portable JSON file,
                               or with --out and --write create that file (never replaces one)
    paths import <file> [--overwrite] [--write]
                               Check an export and say what would change; with --write apply
                               it all or not at all. A stored path that differs is a conflict
                               unless --overwrite

voice OPTIONS
    voice [prompt-id]          Draw three prompts and pick 1-3, r (draw again) or q; or name a
                               prompt id to skip the draw
    --portable                 Keep the sample beside shared Assistant context instead of in
                               the private folder (default: private)
    --seconds <n>              Writing time, 30 to 3600 (default: 180)
    --stdin                    Type in the terminal even if $VISUAL/$EDITOR is set; finish with
                               a line holding only a dot (.) or end of input
    --resume                   Resume the open session with its original deadline (one window at
                               a time; $VISUAL/$EDITOR must wait for its window, e.g. code --wait)
    --scrap --yes              Give up the open session and save nothing
    erase [--yes]              List, then (with --yes) erase ALL voice data: samples in both
                               folders, the session record, the guide and leftover editor
                               files. All or nothing, then checks that nothing is left
    guide --move portable|private [--yes]
                               Say what moving the voice guide would do; with --yes move it in one
                               step, copied, checked and only then removed. Moving to portable is
                               refused for a guide that quotes private samples or cannot be read
    --list                     Show the prompt packs, answered counts and stages
    polish <sample>            Edit a COPY of a rough draft in $VISUAL/$EDITOR and save it as the
                               polished draft (the rough draft is locked and never changes);
                               --title, --slug, --description, --tags a,b set its details
    diff <sample>              Show what the polished draft changed (unified diff)
    promote <sample>           Create a post draft (draft: true) in content/posts from the polished
                               draft; refuses a taken slug; --dir posts/2026 picks a folder under
                               posts. The sample is left in place.
    export [--out <file>] [--include-private] [--write]
                               Put the voice samples and guide in one portable JSON file. Private
                               samples and guide are left out unless --include-private, and such a
                               file is only written outside the project or in .openblog/private/.
                               One guide travels (the portable one when both exist); one export
                               holds at most 100 samples and 8 MiB
    import <file> [--overwrite] [--as private] [--write]
                               Check an export and say what would change; with --write apply it all
                               or not at all. Items keep their folder (--as private makes all
                               private); a rough draft is never replaced; --overwrite replaces a
                               differing polished draft or guide
    <sample> is a file name from `voice --list` output or a prompt id. The clock is fixed when the
    session starts: text after the deadline is not saved, and an interrupted session locks what
    was saved when you resume after the deadline. Nothing edits a rough draft.

new OPTIONS
    --series <slug>            Put the post in a series
    --tags a,b,c               Comma-separated tags
    --draft                    Mark the post as a draft
    --recipe                   Start from a recipe template (servings, times, ingredients, steps)
    --profile job              Start a job: the job front matter and the headings Problem, What we
                               found, What we did, Result. Always a draft until it is filled in
    --trade <id>               With --profile job: the trade (bundled, or from extraTrades)
    --service <id>             With --profile job: the service, such as hardwood-install
    --town <name>              With --profile job: the town (never an address)
    --region <name>            With --profile job: the region or state
    --profile service          Start a service in content/services/: a draft with version 1 front
                               matter (id, name, summary, price band) until you fill it in
    --id <id>                  With --profile service: the id (default: the name, as a slug)
    --price-band <band>        With --profile service: under-500, 500-2k, 2k-10k, 10k-50k, over-50k
                               or ask

import hashnode OPTIONS
    --source public|graphql    public (default) reads your live site and needs no account;
                               graphql uses Hashnode's API (needs Pro plus --token or HASHNODE_TOKEN)
    --no-images                Keep remote image URLs instead of downloading them
    --token <pat>              Personal access token for --source graphql (or HASHNODE_TOKEN)
    --overwrite                Replace imported posts you have edited since the last run
    --limit <n>                Import only the first n posts (useful for a trial run)
    --delay <ms>               Pause between requests (default: 250)
";

struct Args {
    positional: Vec<String>,
    options: HashMap<String, String>,
    switches: HashSet<String>,
}

const SWITCHES: &[&str] = &[
    "drafts",
    "draft",
    "no-images",
    "help",
    "admin",
    "password-stdin",
    "github-pages",
    "overwrite",
    "include-private",
    "recipe",
    "write",
    "publish",
    "json",
    "no-voice",
    "portable",
    "resume",
    "list",
    "scrap",
    "stdin",
    "yes",
];

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut args = Args {
        positional: Vec::new(),
        options: HashMap::new(),
        switches: HashSet::new(),
    };
    let mut i = 0;
    while i < raw.len() {
        let token = &raw[i];
        if let Some(name) = token.strip_prefix("--") {
            if let Some((key, value)) = name.split_once('=') {
                args.options.insert(key.to_string(), value.to_string());
            } else if SWITCHES.contains(&name) {
                args.switches.insert(name.to_string());
            } else {
                i += 1;
                let value = raw
                    .get(i)
                    .ok_or_else(|| format!("--{name} needs a value"))?;
                args.options.insert(name.to_string(), value.clone());
            }
        } else {
            args.positional.push(token.clone());
        }
        i += 1;
    }
    Ok(args)
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    match run(&raw) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(raw: &[String]) -> Result<(), String> {
    let Some(command) = raw.first() else {
        print!("{HELP}");
        return Ok(());
    };
    let args = parse_args(&raw[1..])?;
    if args.switches.contains("help") {
        print!("{HELP}");
        return Ok(());
    }
    let root = PathBuf::from(args.options.get("root").map(String::as_str).unwrap_or("."));
    let drafts = args.switches.contains("drafts");
    if workspace::configured()
        && matches!(
            command.as_str(),
            "init" | "new" | "import" | "publish" | "contributors" | "voice"
        )
    {
        return Err("durable workspace mode requires content mutations and publishing through the admin API; CLI mutations are disabled to avoid unacknowledged writes".into());
    }

    match command.as_str() {
        "help" | "-h" | "--help" => {
            print!("{HELP}");
            Ok(())
        }
        "init" => {
            let dir = args.positional.first().map(PathBuf::from).unwrap_or(root);
            let title = args.options.get("title").map(String::as_str);
            let created = scaffold::init(&dir, title, args.switches.contains("github-pages"))?;
            if created.is_empty() {
                println!(
                    "Nothing to do: {} already looks like an open.blog project.",
                    dir.display()
                );
            } else {
                for file in &created {
                    println!("created {file}");
                }
                println!(
                    "\nNext: cd into the folder, run `openblog serve`, and edit openblog.json."
                );
            }
            // A person at a terminal is asked once; pipes and scripts never are (ADR 0269).
            voice_cli::invite_after_init(
                &dir,
                args.switches.contains("no-voice"),
                !created.is_empty(),
            );
            Ok(())
        }
        "voice" => voice_cli::run(&root, &args.positional, &args.options, &args.switches),
        "new" => {
            let title = args
                .positional
                .first()
                .ok_or("usage: openblog new \"Post title\"")?;
            let tags: Vec<String> = args
                .options
                .get("tags")
                .map(|t| {
                    t.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let _transaction = transaction::ContentTransactionLock::acquire(&root)?;
            let series = args.options.get("series").map(String::as_str);
            let recipe = args.switches.contains("recipe");
            let profile = args.options.get("profile").map(|p| p.trim().to_lowercase());
            let job_option = |name: &str| args.options.get(name).map(String::as_str);
            let created = match profile.as_deref() {
                Some("service") if !recipe => {
                    if ["trade", "service", "town", "region", "series", "tags"]
                        .iter()
                        .any(|name| args.options.contains_key(*name))
                    {
                        return Err("a service takes only a name, --id and --price-band".into());
                    }
                    let start = scaffold::ServiceStart {
                        id: job_option("id"),
                        price_band: job_option("price-band"),
                    };
                    scaffold::new_service(&root, title, &start)?
                }
                Some("service") => {
                    return Err("--recipe and --profile service cannot be combined".into())
                }
                Some("job") if !recipe => {
                    let start = scaffold::JobStart {
                        trade: job_option("trade"),
                        service: job_option("service"),
                        town: job_option("town"),
                        region: job_option("region"),
                    };
                    scaffold::new_job(&root, title, series, &tags, &start)?
                }
                Some("job") => return Err("--recipe and --profile job cannot be combined".into()),
                None | Some("article") | Some("recipe") => {
                    if ["trade", "service", "town", "region"]
                        .iter()
                        .any(|name| args.options.contains_key(*name))
                    {
                        return Err(
                            "--trade, --service, --town and --region need --profile job".into()
                        );
                    }
                    scaffold::new_post(
                        &root,
                        title,
                        series,
                        &tags,
                        args.switches.contains("draft"),
                        recipe || profile.as_deref() == Some("recipe"),
                    )?
                }
                Some(other) => {
                    return Err(format!(
                        "`--profile {other}` is not supported by `new`; use article, recipe, job or service"
                    ))
                }
            };
            println!("created {created}");
            if profile.as_deref() == Some("job") {
                println!("It is a draft until you fill in the job's details; `openblog check` lists what is missing.");
            }
            if profile.as_deref() == Some("service") {
                println!("It is a draft until you write its summary and remove `draft`; `openblog check` lists what is missing.");
            }
            Ok(())
        }
        "contributors" => {
            if args.positional.first().map(String::as_str) != Some("migrate") {
                return Err(
                    "usage: openblog contributors migrate --id <stable-id> [--write]".into(),
                );
            }
            let id = args
                .options
                .get("id")
                .ok_or("usage: openblog contributors migrate --id <stable-id> [--write]")?;
            let write = args.switches.contains("write");
            let preview = contributor_migration::plan(&root, id)?;
            let plan = if write {
                contributor_migration::apply(&preview)?
            } else {
                preview
            };
            let identity_action = if plan.config_changed {
                format!("register `{}`", plan.contributor_id)
            } else {
                format!("reuse `{}`", plan.contributor_id)
            };
            println!(
                "Contributor migration {}: {}, {} credit sidecar(s), {} existing sidecar(s) skipped.",
                if write { "write" } else { "dry run" },
                identity_action,
                plan.sidecars.len(),
                plan.skipped
            );
            if write {
                println!("Migration written. Markdown was not changed; manually entered identity data remains unauthenticated.");
            } else {
                println!("No files changed. Re-run with --write to apply this plan.");
            }
            Ok(())
        }
        "syndicate" => {
            let slug = args.positional.first().ok_or(
                "usage: openblog syndicate <slug> [--target a,b] [--json] [--write] [--publish]",
            )?;
            let target_names = args
                .options
                .get("target")
                .map(|targets| {
                    targets
                        .split(',')
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            syndication::run(
                &root,
                slug,
                syndication::Options {
                    target_names,
                    write: args.switches.contains("write"),
                    publish: args.switches.contains("publish"),
                    json: args.switches.contains("json"),
                },
            )
        }
        "paths" => {
            let options = paths_exchange::Options {
                file: args
                    .options
                    .get("out")
                    .map(String::as_str)
                    .or_else(|| args.positional.get(1).map(String::as_str)),
                write: args.switches.contains("write"),
                drafts,
                overwrite: args.switches.contains("overwrite"),
            };
            match args.positional.first().map(String::as_str) {
                Some("export") => paths_exchange::export(&root, &options),
                Some("import") => paths_exchange::import(&root, &options),
                _ => Err("usage: openblog paths export|import (see `openblog help`)".into()),
            }
        }
        "export" => {
            let slug = args.positional.first().ok_or(
                "usage: openblog export <slug> [--format markdown|csl-json|bibtex] [--out <path>] [--json] [--write]",
            )?;
            let format = args
                .options
                .get("format")
                .map(String::as_str)
                .unwrap_or("markdown");
            let format = portable_export::Format::parse(format).ok_or_else(|| {
                format!(
                    "unsupported portable export format `{format}`; expected `markdown`, `csl-json` or `bibtex`"
                )
            })?;
            portable_export::run(
                &root,
                slug,
                format,
                args.options.get("out").map(String::as_str),
                args.switches.contains("write"),
                args.switches.contains("json"),
            )
        }
        "build" => {
            let out = args.options.get("out").map(PathBuf::from);
            let report = site::build(
                &root,
                &site::BuildOptions {
                    include_drafts: drafts,
                    out_override: out,
                    now: Some(clock::now()),
                },
            )?;
            serve::print_report(&report);
            Ok(())
        }
        "serve" => {
            let port: u16 = args
                .options
                .get("port")
                .map(|p| p.parse().map_err(|_| format!("`{p}` is not a valid port")))
                .transpose()?
                .unwrap_or(8080);
            let host = args
                .options
                .get("host")
                .cloned()
                .unwrap_or_else(|| "127.0.0.1".to_string());
            serve::run(
                &root,
                &serve::ServeOptions {
                    include_drafts: drafts,
                    host,
                    port,
                    admin: args.switches.contains("admin"),
                },
            )
        }
        "user" => user_command(&root, &args),
        "publish" => {
            let _transaction = transaction::ContentTransactionLock::acquire(&root)?;
            let config = site::load_config(&root)?;
            if args.positional.first().map(String::as_str) == Some("setup") {
                for note in publish::setup(&root, &config)? {
                    println!("- {note}");
                }
                return Ok(());
            }
            let outcome =
                publish::publish(&root, &config, args.positional.first().map(String::as_str))?;
            for p in &outcome.committed {
                println!("  + {p}");
            }
            for p in &outcome.skipped_drafts {
                println!("  (draft, not committed) {p}");
            }
            println!("{}", outcome.message);
            Ok(())
        }
        "analytics" => analytics_command(&root, &args),
        "check" => check_command(&root, args.switches.contains("json")),
        "themes" => {
            let config = site::load_config(&root)?;
            let themes = site::load_themes(&root, &config)?;
            for name in themes.names() {
                match themes.resolve(&name) {
                    Ok(t) => {
                        let default = if name == config.theme {
                            "  (site default)"
                        } else {
                            ""
                        };
                        println!("{name:<16} {}  [{}]{default}", t.label, t.chain.join(" > "));
                    }
                    Err(e) => println!("{name:<16} ERROR: {e}"),
                }
            }
            Ok(())
        }
        "import" => {
            let platform = args.positional.first().map(String::as_str).unwrap_or("");
            if platform != "hashnode" {
                return Err("usage: openblog import hashnode <host>   (only `hashnode` is supported so far)".into());
            }
            let host = args
                .positional
                .get(1)
                .ok_or("usage: openblog import hashnode <host>, e.g. yourname.hashnode.dev")?;
            let source = match args
                .options
                .get("source")
                .map(String::as_str)
                .unwrap_or("public")
            {
                "public" => hashnode::Source::Public,
                "graphql" => hashnode::Source::GraphQl,
                other => return Err(format!("unknown --source `{other}`; use public or graphql")),
            };
            let config = site::load_config(&root)?;
            let options = hashnode::ImportOptions {
                host: host.clone(),
                source,
                token: args.options.get("token").cloned(),
                content_dir: root.join(&config.paths.content),
                static_dir: root.join(&config.paths.static_dir),
                download_images: !args.switches.contains("no-images"),
                overwrite: args.switches.contains("overwrite"),
                limit: args
                    .options
                    .get("limit")
                    .map(|l| l.parse().map_err(|_| format!("`{l}` is not a number")))
                    .transpose()?,
                post_path: config.post_path.clone(),
                delay_ms: args
                    .options
                    .get("delay")
                    .map(|d| d.parse().map_err(|_| format!("`{d}` is not a number")))
                    .transpose()?
                    .unwrap_or(250),
            };
            let _transaction = transaction::ContentTransactionLock::acquire(&root)?;
            let report = hashnode::run(&options)?;
            println!(
                "\nImported: {} posts written, {} unchanged, {} series, {} images downloaded.",
                report.posts_written,
                report.posts_unchanged,
                report.series_written,
                report.images_downloaded
            );
            for note in &report.skipped {
                println!("note: {note}");
            }
            if !report.image_failures.is_empty() {
                eprintln!(
                    "\n{} image(s) could not be downloaded and still point at Hashnode:",
                    report.image_failures.len()
                );
                for failure in &report.image_failures {
                    eprintln!("  - {failure}");
                }
            }
            println!("Review with `openblog check`, then `openblog serve`.");
            Ok(())
        }
        "build-wasm" => {
            let status = Command::new("wasm-pack")
                .current_dir(&root)
                .args([
                    "build",
                    "crates/openblog-wasm",
                    "--target",
                    "web",
                    "--release",
                    "--out-dir",
                    "../../web/wasm",
                    "--out-name",
                    "openblog_wasm",
                ])
                .status()
                .map_err(|e| {
                    format!(
                        "could not run wasm-pack ({e}). Install it with `cargo install wasm-pack`."
                    )
                })?;
            if status.success() {
                // wasm-pack writes a `.gitignore` containing `*`; the artifacts are meant to be committed.
                let _ = std::fs::remove_file(root.join("web/wasm/.gitignore"));
                Ok(())
            } else {
                Err("wasm-pack failed".into())
            }
        }
        other => Err(format!("unknown command `{other}`. Run `openblog help`.")),
    }
}

fn analytics_command(root: &std::path::Path, args: &Args) -> Result<(), String> {
    let config = site::load_config(root)?;
    let store_path = root.join(".openblog").join("analytics.json");
    match args.positional.first().map(String::as_str).unwrap_or("") {
        "backup" => {
            let branch = config.analytics.branch.trim().to_string();
            if branch.is_empty() {
                return Err("analytics.branch is empty in openblog.json".into());
            }
            let store = analytics::Store::load(&store_path, config.analytics.retention_days);
            let git = git::Git::new(root);
            if !git.is_repo() {
                return Err(
                    "this blog is not a git repository; run `openblog publish setup` first".into(),
                );
            }
            let message = format!("Analytics backup {}", clock::now().rfc3339());
            match git.commit_file_to_branch(
                &branch,
                "analytics.json",
                &store.export_json(),
                &message,
            )? {
                Some(id) => println!("saved analytics.json to branch `{branch}` ({id})"),
                None => println!("branch `{branch}` already has the latest analytics"),
            }
            if git.has_remote(&config.publish.remote) {
                git.push_branch(&config.publish.remote, &branch)
                    .map_err(|e| format!("push failed: {e}"))?;
                println!("pushed `{branch}` to {}", config.publish.remote);
            }
            Ok(())
        }
        "pull" => {
            let url = args
                .positional
                .get(1)
                .ok_or("usage: openblog analytics pull <counter url> --secret <secret>")?;
            let secret = args
                .options
                .get("secret")
                .cloned()
                .or_else(|| std::env::var("OPENBLOG_COUNTER_SECRET").ok())
                .ok_or("pass --secret <secret> (the worker's EXPORT_SECRET) or set OPENBLOG_COUNTER_SECRET")?;
            let name = args
                .options
                .get("name")
                .cloned()
                .unwrap_or_else(|| "worker".to_string());
            let export_url = format!("{}/export", url.trim_end_matches('/'));
            let agent: ureq::Agent = ureq::Agent::config_builder()
                .timeout_global(Some(std::time::Duration::from_secs(60)))
                .build()
                .into();
            let body = agent
                .get(&export_url)
                .header("Authorization", &format!("Bearer {secret}"))
                .call()
                .map_err(|e| format!("GET {export_url}: {e}"))?
                .body_mut()
                .read_to_string()
                .map_err(|e| e.to_string())?;
            let data: analytics::SourceData = serde_json::from_str(&body)
                .map_err(|e| format!("the counter returned something unexpected: {e}"))?;
            let pages = data.totals.len();
            let mut store = analytics::Store::load(&store_path, config.analytics.retention_days);
            store.import_source(&name, data);
            store.save(&store_path)?;
            println!(
                "merged counts for {pages} page(s) from `{name}` into .openblog/analytics.json"
            );
            println!("run `openblog analytics backup` to save them to the branch, then rebuild to bake them in");
            Ok(())
        }
        "worker" => {
            let dir = root.join(
                args.positional
                    .get(1)
                    .map(String::as_str)
                    .unwrap_or("counter"),
            );
            let worker = dir.join("worker.js");
            let toml = dir.join("wrangler.toml");
            if worker.exists() || toml.exists() {
                return Err(format!(
                    "{} already has worker files; delete them to regenerate",
                    dir.display()
                ));
            }
            fsutil::write_file(&worker, site::COUNTER_WORKER.as_bytes())?;
            fsutil::write_file(
                &toml,
                site::COUNTER_WRANGLER
                    .replace("SITE_URL", &config.url)
                    .as_bytes(),
            )?;
            println!("wrote {} and {}", worker.display(), toml.display());
            println!("Next: follow the steps at the top of worker.js (wrangler kv namespace create, secret put, deploy),");
            println!("then set \"analytics\": {{ \"endpoint\": \"https://<name>.<you>.workers.dev\" }} in openblog.json.");
            Ok(())
        }
        "service" => {
            let dir = root.join(
                args.positional
                    .get(1)
                    .map(String::as_str)
                    .unwrap_or("counter-service"),
            );
            if dir.join("server.js").exists() {
                return Err(format!(
                    "{} already has a server.js; delete it to regenerate",
                    dir.display()
                ));
            }
            for (name, contents) in site::COUNTER_SERVICE {
                fsutil::write_file(
                    &dir.join(name),
                    contents.replace("SITE_URL", &config.url).as_bytes(),
                )?;
                println!("wrote {}", dir.join(name).display());
            }
            let workflow = root.join(".github/workflows/keep-counter-awake.yml");
            if !workflow.exists() {
                fsutil::write_file(&workflow, site::KEEP_AWAKE_WORKFLOW.as_bytes())?;
                println!("wrote {} (pings the service every 14 minutes so it never sleeps)", workflow.display());
            }
            println!(
                "Next: read {} for the Render and MongoDB steps,",
                dir.join("README.md").display()
            );
            println!("then set \"analytics\": {{ \"endpoint\": \"https://<service>.onrender.com\" }} in openblog.json.");
            Ok(())
        }
        _ => Err(
            "usage: openblog analytics backup | pull <url> --secret <s> | worker [dir] | service [dir]"
                .into(),
        ),
    }
}

fn read_password(args: &Args, confirm: bool) -> Result<String, String> {
    use std::io::{BufRead, Write};
    if let Ok(p) = std::env::var("OPENBLOG_PASSWORD") {
        if !p.is_empty() {
            return Ok(p);
        }
    }
    let stdin = std::io::stdin();
    let mut line = String::new();
    if !args.switches.contains("password-stdin") {
        eprintln!("Note: the password is shown as you type. Use --password-stdin or OPENBLOG_PASSWORD to avoid that.");
        eprint!(
            "Password (at least {} characters): ",
            auth::MIN_PASSWORD_LEN
        );
        std::io::stderr().flush().ok();
    }
    stdin
        .lock()
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let password = line.trim_end_matches(['\r', '\n']).to_string();
    if confirm && !args.switches.contains("password-stdin") {
        eprint!("Repeat password: ");
        std::io::stderr().flush().ok();
        let mut again = String::new();
        stdin
            .lock()
            .read_line(&mut again)
            .map_err(|e| e.to_string())?;
        if again.trim_end_matches(['\r', '\n']) != password {
            return Err("the passwords do not match".into());
        }
    }
    Ok(password)
}

fn user_command(root: &std::path::Path, args: &Args) -> Result<(), String> {
    user_command_with(root, args, || read_password(args, true))
}

/// `user_command` with the password source supplied, so tests need no terminal or environment.
fn user_command_with(
    root: &std::path::Path,
    args: &Args,
    password: impl FnOnce() -> Result<String, String>,
) -> Result<(), String> {
    let config = site::load_config(root)?;
    let path = root.join(&config.admin.users_file);
    let action = args.positional.first().map(String::as_str).unwrap_or("");
    let name = args.positional.get(1).map(String::as_str).unwrap_or("");
    let mut users = auth::Users::load(&path)?;
    match action {
        "list" => {
            if users.users.is_empty() {
                println!("No users. Add one with `openblog user add <name>`.");
            }
            for u in &users.users {
                println!("{}", u.name);
            }
            Ok(())
        }
        "add" | "passwd" => {
            if !auth::valid_username(name) {
                return Err(
                    "usernames are 1 to 32 characters: lowercase letters, digits, and . _ -".into(),
                );
            }
            let exists = users.find(name).is_some();
            if action == "add" && exists {
                return Err(format!("`{name}` already exists; use `openblog user passwd {name}` to change the password"));
            }
            if action == "passwd" && !exists {
                return Err(format!("no user named `{name}`"));
            }
            let password = password()?;
            if action == "add" {
                // A new account under a reused name must not inherit an old binding.
                revoke_shared_publication_bindings(root, name)?;
            }
            users.set(name, &password)?;
            users.save(&path)?;
            println!(
                "{} `{name}`. The admin users file is {}; keep it out of version control.",
                if exists { "Updated" } else { "Added" },
                path.display()
            );
            if action == "passwd" {
                println!("Any sessions that user had open are ended.");
            }
            Ok(())
        }
        "remove" => {
            if !users.remove(name) {
                return Err(format!("no user named `{name}`"));
            }
            users.save(&path)?;
            println!("Removed `{name}`. Their open sessions end immediately.");
            revoke_shared_publication_bindings(root, name)
        }
        _ => Err("usage: openblog user add|passwd|remove|list <name>".into()),
    }
}

/// The checks `openblog check` has always printed, for a site that loaded.
/// While `readingPaths.publish` is off, warn when path files exist beside a
/// page or post that would collide with `/paths/` once it is switched on, so
/// the author learns before the build refuses (ADR 0212). With it on the build
/// refuses the collision itself, so there is nothing more to say here.
fn reading_paths_warning(root: &std::path::Path, site: &openblog_core::Site) -> Option<String> {
    if site.config.reading_paths.publish {
        return None;
    }
    let stored = reading_path_store::list(root, &site.config.paths.content).ok()?;
    if stored.is_empty() {
        return None;
    }
    openblog_core::render::reading_paths_address_conflict(site)
}

/// Like [`reading_paths_warning`] for `/interpretations/` (ADR 0232): while
/// `interpretations.publish` is off, warn when comparison files exist beside a
/// page or post that would collide once it is switched on.
fn interpretations_warning(root: &std::path::Path, site: &openblog_core::Site) -> Option<String> {
    if site.config.interpretations.publish {
        return None;
    }
    let stored = comparison_store::list(root, &site.config.paths.content).ok()?;
    if stored.is_empty() {
        return None;
    }
    openblog_core::render::interpretations_address_conflict(site)
}

fn check_site(
    root: &std::path::Path,
    site: &mut openblog_core::Site,
    themes: &openblog_core::ThemeSet,
    reported: bool,
    quiet: bool,
) -> Result<(), String> {
    // Standard output is the JSON document alone under `--json`.
    macro_rules! say {
        ($($arg:tt)*) => {
            if !quiet {
                println!($($arg)*);
            }
        };
    }
    // When the research report applies it lists every evidence and
    // source-review finding itself, with the same codes, so they are not
    // printed a second time; a site without research has none to print.
    let own_lines = !reported;
    let files = site::generate_site(root, site, themes)?;
    say!(
        "OK: {} posts, {} series, {} tags, {} pages; would write {} generated files.",
        site.posts.len(),
        site.series.len(),
        site.tags.len(),
        site.pages.len(),
        files.len()
    );
    for w in &site.warnings {
        eprintln!("warning: {w}");
    }
    for warning in portable_export::diagnostics(site)? {
        eprintln!("warning: portability: {warning}");
    }
    if let Some(warning) = reading_paths_warning(root, site) {
        eprintln!("warning: {warning}");
    }
    if let Some(warning) = interpretations_warning(root, site) {
        eprintln!("warning: {warning}");
    }
    serve::print_accessibility_findings(&site.accessibility);
    if own_lines {
        serve::print_evidence_findings(&site.evidence);
    }
    if let Some(summary) = citation_summary(site) {
        say!("{summary}");
    }
    if let Some(summary) = check_source_library(root, &site.config.contributors)? {
        say!("{summary}");
    }
    if let Some(summary) = check_research_notebook(root, &site.config.contributors)? {
        say!("{summary}");
    }
    if let Some((summary, findings)) =
        check_source_review(root, &site.config.contributors, &site.source_review)?
    {
        if own_lines {
            serve::print_source_review_findings(&findings);
        }
        say!("{summary}");
    }
    if let Some((summary, notices)) = check_knowledge_atlas(
        root,
        &site.config.contributors,
        site.config.knowledge_atlas.publish,
    )? {
        for notice in notices {
            eprintln!("notice: {notice}");
        }
        say!("{summary}");
    }
    if let Some((summary, notices, findings)) =
        check_claims(root, &site.config.contributors, &site.config.paths.content)?
    {
        for notice in notices {
            eprintln!("notice: {notice}");
        }
        if own_lines {
            serve::print_evidence_findings(&findings);
        }
        say!("{summary}");
    }
    if let Some((summary, notices)) = check_alignments(
        root,
        &site.config.contributors,
        site.config.comparisons.publish,
    )? {
        for notice in notices {
            eprintln!("notice: {notice}");
        }
        say!("{summary}");
    }
    Ok(())
}

/// `openblog check` and `openblog check --json`.
///
/// Without `--json`, the checks print as they always did, then the one
/// research report on standard error (ADR 0150). With `--json`, standard
/// output is one JSON document and nothing else, always: the report Admin
/// receives plus an `error` field that is `null` when the checks passed and
/// the message when they did not, or when the site could not be loaded (the
/// report is then empty). The exit status is `check`'s either way: nonzero
/// when the site fails its checks or a failure of a private file the build
/// reads refuses the next build, zero otherwise. Reads only.
fn check_command(root: &std::path::Path, json: bool) -> Result<(), String> {
    let (mut site, themes) = match site::load_site(root, true, None) {
        Ok(loaded) => loaded,
        Err(error) => {
            if json {
                print!("{}", check_envelope(None, Some(&error)));
            }
            return Err(error);
        }
    };
    // The report is read before the checks run, so a site that has research
    // lists each evidence finding once, in the report, with the same codes
    // and order Admin shows, and a site that has none prints what it always
    // did.
    let readiness = readiness::report_of_all(root, &site);
    let checked = check_site(root, &mut site, &themes, readiness.applies, json);
    let refused = (readiness.blocking() > 0).then(|| {
        format!(
            "research readiness: {} finding(s) refuse the next build{}",
            readiness.blocking(),
            if json { "." } else { "; see above." }
        )
    });
    if json {
        let error = checked.as_ref().err().or(refused.as_ref());
        print!("{}", check_envelope(Some(&readiness), error));
    } else {
        // After the checks above, whether or not they stopped early, so the
        // findings behind a refusal are listed too.
        eprint!("{}", readiness.text_after(checked.is_err()));
    }
    checked?;
    refused.map_or(Ok(()), Err)
}

/// The JSON `check --json` prints: the report's own view, or an empty one
/// when the site could not be loaded, and the error, if any. Deterministic,
/// pretty-printed, with a trailing newline.
fn check_envelope(readiness: Option<&readiness::Readiness>, error: Option<&String>) -> String {
    let empty;
    let readiness = match readiness {
        Some(readiness) => readiness,
        None => {
            empty = readiness::Readiness::empty();
            &empty
        }
    };
    let mut view = readiness.view();
    view["error"] = error.map_or(serde_json::Value::Null, |error| serde_json::json!(error));
    let mut json = serde_json::to_string_pretty(&view).unwrap_or_default();
    json.push('\n');
    json
}

/// How many posts publish citations, and a plain statement that their checks
/// ran offline (ADR 0050); `None` when no post publishes any.
fn citation_summary(site: &openblog_core::Site) -> Option<String> {
    let published: Vec<_> = site
        .posts
        .iter()
        .filter_map(|post| post.citations())
        .collect();
    if published.is_empty() {
        return None;
    }
    let citations: usize = published.iter().map(|summary| summary.citations).sum();
    let references: std::collections::BTreeSet<&str> = published
        .iter()
        .flat_map(|summary| {
            summary
                .references
                .iter()
                .map(|reference| reference.key.as_str())
        })
        .collect();
    Some(format!(
        "OK: {} post(s) publish {citations} citation(s) of {} reference(s). Citation checks ran offline from the source library; no identifier or link was looked up online.",
        published.len(),
        references.len()
    ))
}

/// Validate the private source library when one is stored. It is never
/// built, so a missing library is not mentioned.
fn check_source_library(
    root: &std::path::Path,
    contributors: &std::collections::BTreeMap<String, openblog_core::contributor::Contributor>,
) -> Result<Option<String>, String> {
    let snapshot = source_store::load(root, contributors).map_err(|error| error.to_string())?;
    Ok(snapshot.stored.then(|| {
        let count = snapshot.library.sources.len();
        let interpretations = match snapshot.library.interpretations.len() {
            0 => String::new(),
            1 => " and 1 private interpretation".into(),
            n => format!(" and {n} private interpretations"),
        };
        format!(
            "OK: private source library {} has {count} source{}{interpretations}; builds publish only the public description of references that opted-in posts cite.",
            source_store::LIBRARY_FILE,
            if count == 1 { "" } else { "s" }
        )
    }))
}

/// Validate the private research notebook when one is stored. Like the
/// source library it is never built, so a missing notebook is not mentioned.
fn check_research_notebook(
    root: &std::path::Path,
    contributors: &std::collections::BTreeMap<String, openblog_core::contributor::Contributor>,
) -> Result<Option<String>, String> {
    let snapshot = notebook_store::load(root, contributors).map_err(|error| error.to_string())?;
    Ok(snapshot.stored.then(|| {
        format!(
            "OK: private research notebook {} has {} passage(s) and {} note(s); builds never read or publish it.",
            notebook_store::NOTEBOOK_FILE,
            snapshot.notebook.passages.len(),
            snapshot.notebook.notes.len()
        )
    }))
}

/// Review the stored source library and notebook (ADR 0148), with the
/// findings the site load made about the sources its posts cite, when a
/// library is stored. Every finding is advisory; the summary counts each
/// outcome apart and never combines them.
fn check_source_review(
    root: &std::path::Path,
    contributors: &std::collections::BTreeMap<String, openblog_core::contributor::Contributor>,
    posts: &[openblog_core::source_review::SourceReviewFinding],
) -> Result<
    Option<(
        String,
        Vec<openblog_core::source_review::SourceReviewFinding>,
    )>,
    String,
> {
    let sources = source_store::load(root, contributors).map_err(|error| error.to_string())?;
    if !sources.stored {
        return Ok(None);
    }
    let notebook = notebook_store::load(root, contributors)
        .map_err(|error| error.to_string())?
        .notebook;
    let mut findings = posts.to_vec();
    findings.extend(openblog_core::source_review::review_library(
        &sources.library,
        &notebook,
    ));
    let outcome = |wanted: openblog_core::research::EvidenceOutcome| {
        findings.iter().filter(|f| f.outcome == wanted).count()
    };
    let summary = if findings.is_empty() {
        "OK: source review found no identifier, version, quotation-location or citation-consistency prompts. It ran offline; nothing was looked up or changed.".to_string()
    } else {
        format!(
            "OK: source review has {} identifier, version, quotation-location and citation-consistency prompt(s): {} detected, {} potential, {} needing review. It ran offline and changed nothing; prompts point at what the record leaves open or what only you can check against the source, never at whether a source or quotation is right.",
            findings.len(),
            outcome(openblog_core::research::EvidenceOutcome::Detected),
            outcome(openblog_core::research::EvidenceOutcome::Potential),
            outcome(openblog_core::research::EvidenceOutcome::NeedsReview)
        )
    };
    Ok(Some((summary, findings)))
}

/// Validate the private Knowledge Atlas when one is stored, against the stored
/// library and notebook. A missing atlas is not mentioned. The summary says
/// whether builds publish its approved part (ADR 0058). Approved relationships
/// the publication projection would leave out are non-blocking notices that
/// name ids, never authored text. So are the chronology index's structural
/// prompts (ADR 0097): datings that cannot all hold as recorded, named by id
/// with their stated values, never a ruling on which one is right.
fn check_knowledge_atlas(
    root: &std::path::Path,
    contributors: &std::collections::BTreeMap<String, openblog_core::contributor::Contributor>,
    publish: bool,
) -> Result<Option<(String, Vec<String>)>, String> {
    let snapshot = atlas_store::load(root, contributors).map_err(|error| error.to_string())?;
    if !snapshot.stored {
        return Ok(None);
    }
    let chronology = openblog_core::chronology_index::ChronologyIndex::of(&snapshot.atlas);
    let notices = snapshot
        .atlas
        .notices()
        .iter()
        .map(|notice| format!("{}: {notice}", atlas_store::ATLAS_FILE))
        .chain(
            chronology
                .prompts
                .iter()
                .map(|prompt| format!("{}: {prompt}", atlas_store::ATLAS_FILE)),
        )
        .collect();
    let publication = if publish {
        let (entries, relationships) = snapshot.atlas.projected();
        format!(
            "builds publish its approved part: {} entr{} and {} relationship(s)",
            entries.len(),
            if entries.len() == 1 { "y" } else { "ies" },
            relationships.len()
        )
    } else {
        "builds never read or publish it".to_string()
    };
    Ok(Some((
        format!(
            "OK: private Knowledge Atlas {} has {} entr{} and {} relationship(s); {publication}.{}",
            atlas_store::ATLAS_FILE,
            snapshot.atlas.entries.len(),
            if snapshot.atlas.entries.len() == 1 {
                "y"
            } else {
                "ies"
            },
            snapshot.atlas.relationships.len(),
            chronology_summary(&chronology)
        ),
        notices,
    )))
}

/// What `check` adds about chronology, only when the atlas holds datings, so
/// an atlas without them reads exactly as before.
fn chronology_summary(index: &openblog_core::chronology_index::ChronologyIndex) -> String {
    if index.datings.is_empty() {
        return String::new();
    }
    let prompts = index.prompts.len() + index.unlisted;
    let found = match prompts {
        0 => "no chronology prompts".to_string(),
        n => format!("{n} chronology prompt(s) to check"),
    };
    let unlisted = if index.unlisted > 0 {
        format!(" (the first {} are listed)", index.prompts.len())
    } else {
        String::new()
    };
    format!(
        " Chronology: {} dating(s) indexed, {found}{unlisted}. Prompts point at datings that cannot all hold as recorded, never at which one is right, and dates that are close never link anything."
        ,
        index.datings.len()
    )
}

/// What `check` prints for the claims file: a summary, projection notices
/// and the evidence findings (ADR 0074).
type ClaimsCheck = (
    String,
    Vec<String>,
    Vec<openblog_core::research::EvidenceFinding>,
);

/// Validate the private claims file when one is stored, against the stored
/// library and notebook. A missing file is not mentioned. Approved links the
/// projection leaves out are non-blocking notices that name ids and states,
/// never authored text; anchors that moved or no longer match the saved draft
/// are evidence findings (ADR 0074), with the other gaps and prompts. Counts
/// are given per relation and never combined.
fn check_claims(
    root: &std::path::Path,
    contributors: &std::collections::BTreeMap<String, openblog_core::contributor::Contributor>,
    content_dir: &str,
) -> Result<Option<ClaimsCheck>, String> {
    let snapshot = claims_store::load(root, contributors).map_err(|error| error.to_string())?;
    if !snapshot.stored {
        return Ok(None);
    }
    let set = &snapshot.claims;
    let notices: Vec<String> = set
        .notices()
        .iter()
        .map(|notice| format!("{}: {notice}", claims_store::CLAIMS_FILE))
        .collect();
    // Anchors that moved or went stale are findings now, in the same list and
    // order as the build and Evidence Studio show (ADR 0074).
    let findings = claims_store::review(&snapshot, root, content_dir);
    let mut totals = openblog_core::claims::RelationCounts::default();
    for claim in &set.claims {
        let counts = set.counts(&claim.id);
        totals.supports += counts.supports;
        totals.contradicts += counts.contradicts;
        totals.contextualizes += counts.contextualizes;
    }
    let outcome = |wanted: openblog_core::research::EvidenceOutcome| {
        findings.iter().filter(|f| f.outcome == wanted).count()
    };
    let prompts = if findings.is_empty() {
        "No evidence gaps or review prompts.".to_string()
    } else {
        format!(
            "{} evidence gap(s) and review prompt(s): {} detected, {} potential, {} needing review. They point at what the record lacks or what only you can check, never at whether a claim is true.",
            findings.len(),
            outcome(openblog_core::research::EvidenceOutcome::Detected),
            outcome(openblog_core::research::EvidenceOutcome::Potential),
            outcome(openblog_core::research::EvidenceOutcome::NeedsReview)
        )
    };
    Ok(Some((
        format!(
            "OK: private claims file {} has {} claim(s) and {} evidence link(s): {} supporting, {} contradicting, {} contextualizing; builds never publish it. {prompts}",
            claims_store::CLAIMS_FILE,
            set.claims.len(),
            set.links.len(),
            totals.supports,
            totals.contradicts,
            totals.contextualizes
        ),
        notices,
        findings,
    )))
}

/// Validate the private alignments file when one is stored, against the
/// stored library and notebook. A missing file is not mentioned. Members whose
/// locators no longer match their passage, or that rest on archived records,
/// are non-blocking notices naming ids only.
fn check_alignments(
    root: &std::path::Path,
    contributors: &std::collections::BTreeMap<String, openblog_core::contributor::Contributor>,
    publish: bool,
) -> Result<Option<(String, Vec<String>)>, String> {
    let snapshot = alignment_store::load(root, contributors).map_err(|error| error.to_string())?;
    if !snapshot.stored {
        return Ok(None);
    }
    let set = &snapshot.alignments;
    let notices: Vec<String> = set
        .notices(openblog_core::knowledge_atlas::Links {
            library: &snapshot.library,
            notebook: &snapshot.notebook,
        })
        .iter()
        .map(|notice| format!("{}: {notice}", alignment_store::ALIGNMENTS_FILE))
        .collect();
    let members: usize = set.alignments.iter().map(|a| a.members.len()).sum();
    let absent = set
        .alignments
        .iter()
        .flat_map(|a| &a.members)
        .filter(|m| m.absent)
        .count();
    let publication = if publish {
        let approved = set.alignments.iter().filter(|a| a.is_approved()).count();
        format!("builds publish its {approved} approved comparison(s), quoting wording only where you state a version's rights allow it")
    } else {
        "builds never read or publish it".to_string()
    };
    Ok(Some((
        format!(
            "OK: private alignments file {} has {} alignment(s) of {} place(s), {} of them recorded as absent; {publication}. {}",
            alignment_store::ALIGNMENTS_FILE,
            set.alignments.len(),
            members,
            absent,
            openblog_core::alignment::ALIGNMENT_NOTICE
        ),
        notices,
    )))
}

/// Remove an Admin username from every shared publication binding, under the content
/// transaction lock so a running Admin server cannot interleave a write.
fn revoke_shared_publication_bindings(root: &std::path::Path, name: &str) -> Result<(), String> {
    let _transaction = transaction::ContentTransactionLock::acquire_with_wait(
        root,
        std::time::Duration::from_secs(30),
    )?;
    let changed = shared_publications::revoke_admin_user(root, name)
        .map_err(|error| format!("cannot revoke `{name}` from shared reflections: {error}"))?;
    if changed > 0 {
        println!("Removed `{name}` from {changed} shared reflection(s).");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_warns_before_reading_paths_are_switched_on_over_a_colliding_page() {
        let root = std::env::temp_dir().join(format!(
            "openblog-check-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        scaffold::init(&root, Some("T"), false).unwrap();
        std::fs::write(
            root.join("content/pages/paths.md"),
            "---
title: Paths
---
Mine.
",
        )
        .unwrap();
        let load = || site::load_site(&root, false, None).unwrap().0;
        // No path files: nothing to warn about, and the page works.
        assert_eq!(reading_paths_warning(&root, &load()), None);
        std::fs::create_dir_all(root.join("content/paths")).unwrap();
        std::fs::write(root.join("content/paths/tour.json"), "{}").unwrap();
        let warning = reading_paths_warning(&root, &load()).expect("a warning");
        assert!(warning.contains("pages/paths.md") && warning.contains("readingPaths.publish"));
        // Switched on, the build itself refuses, and the warning steps aside.
        let mut config = site::load_config(&root).unwrap();
        config.reading_paths.publish = true;
        let mut site = load();
        site.config = config;
        assert_eq!(reading_paths_warning(&root, &site), None);
        let mut themes_site = site::load_site(&root, false, None).unwrap();
        themes_site.0.config.reading_paths.publish = true;
        let refused = site::generate_site(&root, &mut themes_site.0, &themes_site.1);
        assert!(refused.unwrap_err().contains("reserved"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn check_warns_before_interpretations_collide_with_a_page() {
        let root = std::env::temp_dir().join(format!(
            "openblog-check-interpretations-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        scaffold::init(&root, Some("T"), false).unwrap();
        std::fs::write(
            root.join("content/pages/interpretations.md"),
            "---
title: Mine
---
Mine.
",
        )
        .unwrap();
        let load = || site::load_site(&root, false, None).unwrap().0;
        // No comparison files: nothing to warn about.
        assert_eq!(interpretations_warning(&root, &load()), None);
        std::fs::create_dir_all(root.join("content/comparisons")).unwrap();
        std::fs::write(root.join("content/comparisons/cave.json"), "{}").unwrap();
        let warning = interpretations_warning(&root, &load()).expect("a warning");
        assert!(
            warning.contains("pages/interpretations.md")
                && warning.contains("interpretations.publish"),
            "{warning}"
        );
        // Switched on, the build itself refuses, and the warning steps aside.
        let mut site = load();
        site.config.interpretations.publish = true;
        assert_eq!(interpretations_warning(&root, &site), None);
        let mut loaded = site::load_site(&root, false, None).unwrap();
        loaded.0.config.interpretations.publish = true;
        let refused = site::generate_site(&root, &mut loaded.0, &loaded.1);
        assert!(refused.unwrap_err().contains("reserved"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn check_reports_the_private_notebook_only_when_it_is_stored() {
        let root = std::env::temp_dir().join(format!(
            "openblog-check-notebook-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let contributors = std::collections::BTreeMap::new();
        assert_eq!(check_research_notebook(&root, &contributors), Ok(None));
        assert!(!root.join(".openblog").exists());

        let library = root.join(source_store::LIBRARY_FILE);
        std::fs::create_dir_all(library.parent().unwrap()).unwrap();
        std::fs::write(
            &library,
            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"}]}"#,
        )
        .unwrap();
        let path = root.join(notebook_store::NOTEBOOK_FILE);
        std::fs::write(
            &path,
            r#"{"version":1,"notes":[{"id":"n","kind":"question","text":"Why?","sources":["w"]}]}"#,
        )
        .unwrap();
        let summary = check_research_notebook(&root, &contributors)
            .unwrap()
            .unwrap();
        assert!(summary.contains("0 passage(s) and 1 note(s)"), "{summary}");

        std::fs::write(
            &path,
            r#"{"version":1,"notes":[{"id":"n","kind":"question","text":"Why?","sources":["gone"]}]}"#,
        )
        .unwrap();
        let error = check_research_notebook(&root, &contributors).unwrap_err();
        assert!(
            error.contains(".openblog/private/research/notebook.json: notes[0] `n`")
                && error.contains("(unknown-source)"),
            "{error}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn check_reports_the_private_alignments_file_only_when_it_is_stored() {
        let root = std::env::temp_dir().join(format!(
            "openblog-check-alignments-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let contributors = std::collections::BTreeMap::new();
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(check_alignments(&root, &contributors, false), Ok(None));
        let library = root.join(source_store::LIBRARY_FILE);
        std::fs::create_dir_all(library.parent().unwrap()).unwrap();
        std::fs::write(
            &library,
            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"},{"id":"e","kind":"edition","of":"w","title":"E","archived":true},{"id":"t","kind":"translation","of":"w","language":"en","title":"T"}]}"#,
        )
        .unwrap();
        let path = root.join(alignment_store::ALIGNMENTS_FILE);
        std::fs::write(
            &path,
            r#"{"version":1,"alignments":[{"id":"a1","label":"ob-secret-label","members":[{"source":"e","locators":[{"kind":"page","value":"1"}]},{"source":"t","absent":true}]}]}"#,
        )
        .unwrap();
        let (summary, notices) = check_alignments(&root, &contributors, false)
            .unwrap()
            .unwrap();
        assert!(
            summary.contains("1 alignment(s) of 2 place(s), 1 of them recorded as absent"),
            "{summary}"
        );
        assert!(summary.contains("does not say they mean the same"));
        assert!(
            summary.contains("builds never read or publish it"),
            "{summary}"
        );
        let (published, _) = check_alignments(&root, &contributors, true)
            .unwrap()
            .unwrap();
        assert!(
            published.contains("builds publish its 0 approved comparison(s)"),
            "{published}"
        );
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("archived-member") && notices[0].contains("a1"));
        assert!(!summary.contains("ob-secret-label") && !notices[0].contains("ob-secret-label"));
        std::fs::write(
            &path,
            r#"{"version":1,"alignments":[{"id":"a1","members":[{"source":"w"}]}]}"#,
        )
        .unwrap();
        let error = check_alignments(&root, &contributors, false).unwrap_err();
        assert!(
            error.starts_with(alignment_store::ALIGNMENTS_FILE),
            "{error}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn check_reports_the_private_claims_file_only_when_it_is_stored() {
        let root = std::env::temp_dir().join(format!(
            "openblog-check-claims-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("content/posts")).unwrap();
        let contributors = std::collections::BTreeMap::new();
        assert_eq!(check_claims(&root, &contributors, "content"), Ok(None));
        assert!(!root.join(".openblog").exists());
        std::fs::write(
            root.join("content/posts/2026-01-07-cave.md"),
            "---\ntitle: Cave\n---\nThe cave educates.\n",
        )
        .unwrap();
        let library = root.join(source_store::LIBRARY_FILE);
        std::fs::create_dir_all(library.parent().unwrap()).unwrap();
        std::fs::write(
            &library,
            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"}]}"#,
        )
        .unwrap();
        let path = root.join(claims_store::CLAIMS_FILE);
        std::fs::write(
            &path,
            r#"{"version":1,"claims":[{"id":"c1","post":"cave","statement":"ob-secret-statement","anchor":{"start":4,"end":8,"text":"cave"}},{"id":"c2","post":"cave","statement":"S","anchor":{"start":0,"end":4,"text":"gone"}}],"links":[{"id":"l1","claim":"c1","relation":"supports","evidence":{"source":"w"},"visibility":"approved"},{"id":"l2","claim":"c1","relation":"contradicts","evidence":{"source":"w"}}]}"#,
        )
        .unwrap();
        let (summary, notices, findings) = check_claims(&root, &contributors, "content")
            .unwrap()
            .unwrap();
        assert!(
            summary.contains("2 claim(s) and 2 evidence link(s): 1 supporting, 1 contradicting, 0 contextualizing; builds never publish it."),
            "{summary}"
        );
        assert!(
            summary.contains("7 evidence gap(s) and review prompt(s): 1 detected, 5 potential, 1 needing review.")
                && summary.contains("never at whether a claim is true"),
            "{summary}"
        );
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert!(
            notices[0].contains("links[0] `l1` claim") && notices[0].contains("(private-endpoint)"),
            "{notices:?}"
        );
        // The anchor that went stale is a finding now, in review order and
        // named by the post it is about.
        let codes: Vec<String> = findings.iter().map(|f| f.code.to_string()).collect();
        assert_eq!(
            codes,
            [
                "claim-contradiction-undiscussed",
                "claim-locator-missing",
                "claim-rationale-missing",
                "claim-locator-missing",
                "claim-rationale-missing",
                "claim-anchor-stale",
                "claim-evidence-missing",
            ]
        );
        assert!(findings
            .iter()
            .all(|f| f.source.path == "posts/2026-01-07-cave.md"));
        assert!(notices
            .iter()
            .chain(findings.iter().map(|f| &f.message))
            .all(|n| !n.contains("ob-secret-statement") && !n.contains("gone")));

        std::fs::write(
            &path,
            r#"{"version":1,"links":[{"id":"l1","claim":"c9","relation":"supports","evidence":{"source":"w"}}]}"#,
        )
        .unwrap();
        let error = check_claims(&root, &contributors, "content").unwrap_err();
        assert!(
            error.contains(".openblog/private/research/claims.json: links[0] `l1` claim")
                && error.contains("(unknown-claim)"),
            "{error}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn check_reports_the_private_atlas_only_when_it_is_stored() {
        let root = std::env::temp_dir().join(format!(
            "openblog-check-atlas-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let contributors = std::collections::BTreeMap::new();
        assert_eq!(check_knowledge_atlas(&root, &contributors, false), Ok(None));
        assert!(!root.join(".openblog").exists());

        let library = root.join(source_store::LIBRARY_FILE);
        std::fs::create_dir_all(library.parent().unwrap()).unwrap();
        std::fs::write(
            &library,
            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"}]}"#,
        )
        .unwrap();
        let path = root.join(atlas_store::ATLAS_FILE);
        std::fs::write(
            &path,
            r#"{"version":1,"entries":[{"id":"a","kind":"person","label":"ob-secret-label"},{"id":"b","kind":"work","label":"B","source":"w","visibility":"approved"}],"relationships":[{"id":"r","kind":"authored","from":"a","to":"b","assertedBy":{"kind":"author"},"evidence":[{"source":"w"}],"visibility":"approved"}]}"#,
        )
        .unwrap();
        let (summary, notices) = check_knowledge_atlas(&root, &contributors, false)
            .unwrap()
            .unwrap();
        assert!(
            summary.contains("2 entries and 1 relationship(s); builds never read or publish it."),
            "{summary}"
        );
        let (published, _) = check_knowledge_atlas(&root, &contributors, true)
            .unwrap()
            .unwrap();
        assert!(
            published.contains("builds publish its approved part: 1 entry and 0 relationship(s)."),
            "{published}"
        );
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert!(
            notices[0].contains("relationships[0] `r` from")
                && notices[0].contains("(private-endpoint)")
                && !notices[0].contains("ob-secret-label"),
            "{notices:?}"
        );

        std::fs::write(
            &path,
            r#"{"version":1,"entries":[{"id":"b","kind":"work","label":"B","source":"gone"}]}"#,
        )
        .unwrap();
        let error = check_knowledge_atlas(&root, &contributors, false).unwrap_err();
        assert!(
            error.contains(".openblog/private/research/atlas.json: entries[0] `b` source")
                && error.contains("(unknown-source)"),
            "{error}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn check_reports_chronology_prompts_by_id_and_leaves_the_atlas_unchanged() {
        let root = std::env::temp_dir().join(format!(
            "openblog-check-chronology-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let library = root.join(source_store::LIBRARY_FILE);
        std::fs::create_dir_all(library.parent().unwrap()).unwrap();
        std::fs::write(
            &library,
            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"}]}"#,
        )
        .unwrap();
        let contributors = std::collections::BTreeMap::new();
        let path = root.join(atlas_store::ATLAS_FILE);
        // Undated: the summary reads exactly as before.
        std::fs::write(
            &path,
            r#"{"version":2,"entries":[{"id":"p","kind":"person","label":"P"}]}"#,
        )
        .unwrap();
        let (summary, notices) = check_knowledge_atlas(&root, &contributors, false)
            .unwrap()
            .unwrap();
        assert!(
            summary.ends_with("1 entry and 0 relationship(s); builds never read or publish it."),
            "{summary}"
        );
        assert!(notices.is_empty());

        let atlas = r#"{"version":2,"entries":[{"id":"p","kind":"person","label":"ob-secret-label","dates":[
          {"id":"p-born","aspect":"birth","date":{"at":{"year":-400}},"assertedBy":{"kind":"named","name":"ob-secret-party"},"unsourced":true,"note":"ob-secret-note"},
          {"id":"p-died","aspect":"death","date":{"at":{"year":-410}},"assertedBy":{"kind":"source","source":"w"},"evidence":[{"source":"w"}]}]}]}"#;
        std::fs::write(&path, atlas).unwrap();
        let (summary, notices) = check_knowledge_atlas(&root, &contributors, false)
            .unwrap()
            .unwrap();
        assert!(
            summary.contains("Chronology: 2 dating(s) indexed, 1 chronology prompt(s) to check.")
                && summary.contains("never at which one is right"),
            "{summary}"
        );
        assert_eq!(notices.len(), 1, "{notices:?}");
        assert!(
            notices[0].starts_with(
                ".openblog/private/research/atlas.json: entries[0] `p` dates[1]: death dating `p-died` (410 BCE) ends before birth dating `p-born` (400 BCE) can begin"
            ) && notices[0].ends_with("(death-before-birth)")
                && !notices[0].contains("ob-secret"),
            "{notices:?}"
        );
        // Checking reads only: the file is byte for byte what was written.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), atlas);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn check_states_that_citation_checks_ran_offline_only_when_posts_cite() {
        use openblog_core::model::LibrarySource;
        let load = |body: &str| {
            openblog_core::Site::load(
                openblog_core::SiteConfig::default(),
                openblog_core::Sources {
                    posts: vec![openblog_core::SourceFile {
                        path: "posts/p.md".into(),
                        contents: format!("---\ntitle: P\ndate: 2026-01-01\n{body}"),
                    }],
                    source_library: Some(LibrarySource::Text(openblog_core::SourceFile {
                        path: "sources.json".into(),
                        contents:
                            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"}]}"#
                                .into(),
                    })),
                    ..Default::default()
                },
                openblog_core::LoadOptions::default(),
            )
            .unwrap()
        };
        assert_eq!(citation_summary(&load("---\nPlain [@w].\n")), None);
        let summary = citation_summary(&load(
            "citations: notes\n---\nSee [@w] and [@w, canonical 2].\n",
        ))
        .unwrap();
        assert!(
            summary.starts_with("OK: 1 post(s) publish 2 citation(s) of 1 reference(s).")
                && summary.contains("offline")
                && summary.contains("no identifier or link was looked up online"),
            "{summary}"
        );
    }

    #[test]
    fn check_reports_the_private_source_library_only_when_it_is_stored() {
        let root = std::env::temp_dir().join(format!(
            "openblog-check-sources-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let contributors = std::collections::BTreeMap::new();
        assert_eq!(check_source_library(&root, &contributors), Ok(None));
        assert!(!root.join(".openblog").exists());

        let path = root.join(source_store::LIBRARY_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"}]}"#,
        )
        .unwrap();
        let summary = check_source_library(&root, &contributors).unwrap().unwrap();
        assert!(summary.contains("has 1 source;"), "{summary}");

        std::fs::write(
            &path,
            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"},{"id":"e","kind":"edition","of":"missing","title":"E"}]}"#,
        )
        .unwrap();
        let error = check_source_library(&root, &contributors).unwrap_err();
        assert!(
            error.contains(".openblog/private/research/sources.json: sources[1] `e` of")
                && error.contains("(unresolved-relationship)"),
            "{error}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn check_reviews_sources_only_when_a_library_is_stored_and_changes_nothing() {
        let root = std::env::temp_dir().join(format!(
            "openblog-check-source-review-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let contributors = std::collections::BTreeMap::new();
        assert_eq!(check_source_review(&root, &contributors, &[]), Ok(None));
        assert!(!root.join(".openblog").exists());

        let library = root.join(source_store::LIBRARY_FILE);
        std::fs::create_dir_all(library.parent().unwrap()).unwrap();
        let text = r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"}]}"#;
        std::fs::write(&library, text).unwrap();
        let (summary, findings) = check_source_review(&root, &contributors, &[])
            .unwrap()
            .unwrap();
        assert!(findings.is_empty());
        assert!(summary.contains("found no identifier"), "{summary}");

        let text = r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"W"},{"id":"t","kind":"translation","of":"w","title":"T","language":"en","identifiers":[{"scheme":"doi","value":"10.1000/a"}]},{"id":"u","kind":"work","title":"U","identifiers":[{"scheme":"doi","value":"10.1000/A"}]}]}"#;
        std::fs::write(&library, text).unwrap();
        std::fs::write(
            root.join(notebook_store::NOTEBOOK_FILE),
            r#"{"version":1,"passages":[{"id":"p","source":"t","excerpt":{"text":"Words"}}]}"#,
        )
        .unwrap();
        let (summary, findings) = check_source_review(&root, &contributors, &[])
            .unwrap()
            .unwrap();
        let codes: Vec<String> = findings.iter().map(|f| f.code.to_string()).collect();
        assert_eq!(
            codes,
            [
                "translator-missing",
                "identifier-shared",
                "passage-locator-missing"
            ]
        );
        assert!(
            summary.contains("3 identifier, version, quotation-location and citation-consistency prompt(s): 0 detected, 2 potential, 1 needing review"),
            "{summary}"
        );
        let line = serve::source_review_line(&findings[1]);
        assert!(
            line.starts_with("source review needs-review: source `u` (identifiers): ")
                && line.ends_with("[identifier-shared]"),
            "{line}"
        );
        assert!(!line.contains("10.1000"), "{line}");
        assert_eq!(std::fs::read_to_string(&library).unwrap(), text);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_flags_values_and_positionals() {
        let a = parse_args(&strings(&[
            "Title",
            "--series",
            "guide",
            "--drafts",
            "--tags=a,b",
            "--port",
            "9000",
        ]))
        .unwrap();
        assert_eq!(a.positional, vec!["Title"]);
        assert_eq!(a.options["series"], "guide");
        assert_eq!(a.options["tags"], "a,b");
        assert!(a.switches.contains("drafts"));
        assert!(parse_args(&strings(&["--series"])).is_err());
    }

    #[test]
    fn removing_an_admin_user_revokes_their_shared_publication_bindings() {
        use openblog_core::collaboration::{
            NewParticipant, NewSharedPublication, NewSourceReference,
        };

        let root = std::env::temp_dir().join(format!("ob-user-revoke-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        scaffold::init(&root, Some("Revoke"), false).unwrap();
        let users_path = root.join(".openblog/users.json");
        let mut users = auth::Users::default();
        users.set("ada", "correct horse battery").unwrap();
        users.save(&users_path).unwrap();
        let record = shared_publications::create(
            &root,
            NewSharedPublication {
                title: "Shared".into(),
                sources: vec![NewSourceReference {
                    title: "Talk".into(),
                    ..NewSourceReference::default()
                }],
                creator: NewParticipant {
                    admin_user: "ada".into(),
                    contributor_id: "ada".into(),
                    display_name: "Ada".into(),
                },
                ..NewSharedPublication::default()
            },
        )
        .unwrap();

        user_command(&root, &parse_args(&strings(&["remove", "ada"])).unwrap()).unwrap();

        let loaded = shared_publications::load_all(&root).unwrap();
        assert_eq!(loaded[0].1.publication_id, record.publication_id);
        assert!(loaded[0].1.authorization.bindings.is_empty());
        assert!(auth::Users::load(&users_path)
            .unwrap()
            .find("ada")
            .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn adding_a_reused_admin_username_revokes_bindings_left_by_the_old_account() {
        use openblog_core::collaboration::{
            NewParticipant, NewSharedPublication, NewSourceReference,
        };

        let root = std::env::temp_dir().join(format!("ob-user-reuse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        scaffold::init(&root, Some("Reuse"), false).unwrap();
        let users_path = root.join(".openblog/users.json");
        // `ada` was dropped from users.json by hand, so her binding outlived the account.
        auth::Users::default().save(&users_path).unwrap();
        let record = shared_publications::create(
            &root,
            NewSharedPublication {
                title: "Shared".into(),
                sources: vec![NewSourceReference {
                    title: "Talk".into(),
                    ..NewSourceReference::default()
                }],
                creator: NewParticipant {
                    admin_user: "ada".into(),
                    contributor_id: "ada".into(),
                    display_name: "Ada".into(),
                },
                ..NewSharedPublication::default()
            },
        )
        .unwrap();
        assert_eq!(record.authorization.bindings.len(), 1);

        user_command_with(
            &root,
            &parse_args(&strings(&["add", "ada"])).unwrap(),
            || Ok("correct horse battery".into()),
        )
        .unwrap();

        let loaded = shared_publications::load_all(&root).unwrap();
        assert_eq!(loaded[0].1.publication_id, record.publication_id);
        assert!(loaded[0].1.authorization.bindings.is_empty());
        assert!(loaded[0].1.authorization.revision > record.authorization.revision);
        assert!(auth::Users::load(&users_path)
            .unwrap()
            .find("ada")
            .is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn json_dry_runs_work_through_command_dispatch_for_export_and_syndication() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("examples")
            .join("portable-publishing");
        for command in ["export", "syndicate"] {
            let mut args = strings(&[
                command,
                "portable-lesson",
                "--root",
                root.to_str().unwrap(),
                "--json",
            ]);
            run(&args).unwrap();
            args.push("--write".into());
            assert!(run(&args).unwrap_err().contains("dry run"));
        }
    }
}
