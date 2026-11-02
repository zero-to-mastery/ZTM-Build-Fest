use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use openblog_core::contributor::Contributor;
use openblog_core::{LoadOptions, SiteConfig, SourceFile};
use serde_json::{json, Value as Json};

use crate::site;
use crate::transaction::ContentTransactionLock;

#[derive(Debug)]
pub struct MigrationPlan {
    pub contributor_id: String,
    pub config_changed: bool,
    pub sidecars: Vec<(PathBuf, String)>,
    pub skipped: usize,
    config_path: PathBuf,
    original_config: Vec<u8>,
    updated_config: String,
    source_snapshots: Vec<(PathBuf, Vec<u8>)>,
}

pub fn plan(root: &Path, contributor_id: &str) -> Result<MigrationPlan, String> {
    let config_path = root.join(site::CONFIG_FILE);
    let original_config = fs::read(&config_path)
        .map_err(|error| format!("cannot read {}: {error}", config_path.display()))?;
    let text = std::str::from_utf8(&original_config)
        .map_err(|error| format!("{} is not UTF-8: {error}", config_path.display()))?;
    let current = SiteConfig::from_json(text)?;
    if current.author.name.trim().is_empty() {
        return Err(
            "author.name is empty; configure the legacy site author before migrating".into(),
        );
    }
    let legacy = Contributor {
        name: current.author.name.clone(),
        url: current.author.url.clone(),
        same_as: current.author.same_as.clone(),
        orcid: String::new(),
    };
    let mut raw: Json =
        serde_json::from_str(text).map_err(|error| format!("invalid openblog.json: {error}"))?;
    let mut validation_json = raw.clone();
    {
        let object = validation_json
            .as_object_mut()
            .ok_or("openblog.json must contain a JSON object")?;
        let contributors = object
            .entry("contributors")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or("openblog.json contributors must be an object")?;
        contributors.insert(contributor_id.to_string(), json!(legacy));
    }
    let candidate = serde_json::to_string(&validation_json)
        .map_err(|error| format!("cannot serialize openblog.json: {error}"))?;
    let normalized = SiteConfig::from_json(&candidate)?;
    let normalized_contributor = normalized
        .contributors
        .get(contributor_id)
        .ok_or_else(|| format!("contributors.{contributor_id} is not a valid stable ID"))?;
    let config_changed = match current.contributors.get(contributor_id) {
        Some(existing) if existing == normalized_contributor => false,
        Some(_) => {
            return Err(format!(
                "contributors.{contributor_id} already exists with a different identity"
            ))
        }
        None => true,
    };
    if config_changed {
        raw["contributors"][contributor_id] = json!(normalized_contributor);
    }
    let updated_config = format!(
        "{}\n",
        serde_json::to_string_pretty(&raw)
            .map_err(|error| format!("cannot serialize openblog.json: {error}"))?
    );

    let sources = site::read_sources(root, &current)?;
    let existing = sources
        .credits
        .iter()
        .map(|source| source.path.replace('\\', "/"))
        .collect::<HashSet<_>>();
    let contents = format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "credits": [{
                "contributor": contributor_id,
                "roles": [{ "vocabulary": "crossref", "role": "author" }]
            }]
        }))
        .map_err(|error| format!("cannot serialize credit sidecar: {error}"))?
    );
    let mut sidecars = Vec::new();
    let mut planned = HashSet::new();
    let mut skipped = 0;
    for post in &sources.posts {
        let Some(relative) = openblog_core::contributor::sidecar_path(&post.path) else {
            continue;
        };
        if existing.contains(&relative) {
            skipped += 1;
        } else if !planned.insert(relative.clone()) {
            return Err(format!(
                "multiple Markdown posts would own the same credit sidecar `{relative}`"
            ));
        } else {
            sidecars.push((
                root.join(&current.paths.content).join(&relative),
                contents.clone(),
            ));
        }
    }
    sidecars.sort_by(|left, right| left.0.cmp(&right.0));
    let mut candidate_sources = sources;
    candidate_sources
        .credits
        .extend(sidecars.iter().map(|(path, contents)| {
            SourceFile {
                path: path
                    .strip_prefix(root.join(&current.paths.content))
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/"),
                contents: contents.clone(),
            }
        }));
    let source_snapshots = candidate_sources
        .posts
        .iter()
        .map(|post| {
            let path = root.join(&current.paths.content).join(&post.path);
            fs::read(&path)
                .map(|bytes| (path.clone(), bytes))
                .map_err(|error| format!("cannot snapshot {}: {error}", path.display()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    site::load_site_from_sources(
        root,
        normalized,
        candidate_sources,
        LoadOptions {
            include_drafts: true,
            now: None,
            preview_source: None,
        },
    )?;
    Ok(MigrationPlan {
        contributor_id: contributor_id.to_string(),
        config_changed,
        sidecars,
        skipped,
        config_path,
        original_config,
        updated_config,
        source_snapshots,
    })
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(format!("refusing to replace symlink {}", path.display()));
    }
    let mut temporary = None;
    for attempt in 0..100_u32 {
        let candidate = path.with_extension(format!(
            "openblog-migrate-{}-{attempt}.tmp",
            std::process::id()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(contents) {
                    drop(file);
                    let _ = fs::remove_file(&candidate);
                    return Err(format!("cannot write {}: {error}", candidate.display()));
                }
                temporary = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("cannot create {}: {error}", candidate.display())),
        }
    }
    let temporary = temporary
        .ok_or_else(|| format!("cannot reserve a temporary file beside {}", path.display()))?;
    crate::fsutil::replace_file(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("cannot replace {}: {error}", path.display())
    })
}

pub fn apply(plan: &MigrationPlan) -> Result<MigrationPlan, String> {
    apply_using(plan, write_atomic, write_new)
}

fn write_new(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            format!(
                "cannot create {} without overwriting: {error}",
                path.display()
            )
        })?;
    if let Err(error) = file.write_all(contents) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!("cannot write {}: {error}", path.display()));
    }
    Ok(())
}

fn apply_using(
    preview: &MigrationPlan,
    mut write_config: impl FnMut(&Path, &[u8]) -> Result<(), String>,
    mut create_sidecar: impl FnMut(&Path, &[u8]) -> Result<(), String>,
) -> Result<MigrationPlan, String> {
    let root = preview
        .config_path
        .parent()
        .ok_or("openblog.json has no project directory")?;
    let _lock = ContentTransactionLock::acquire(root)?;
    let plan = plan(root, &preview.contributor_id)?;
    let current_config = fs::read(&plan.config_path)
        .map_err(|error| format!("cannot reread {}: {error}", plan.config_path.display()))?;
    if current_config != plan.original_config {
        return Err(
            "openblog.json changed after the migration was planned; run the command again".into(),
        );
    }
    for (path, expected) in &plan.source_snapshots {
        if fs::read(path).ok().as_deref() != Some(expected.as_slice()) {
            return Err(format!(
                "{} changed after the migration was planned; run the command again",
                path.display()
            ));
        }
    }
    let mut created: Vec<PathBuf> = Vec::new();
    if plan.config_changed {
        write_config(&plan.config_path, plan.updated_config.as_bytes())?;
    }
    for (path, contents) in &plan.sidecars {
        let result = create_sidecar(path, contents.as_bytes());
        if let Err(error) = result {
            let mut rollback_errors = Vec::new();
            for created_path in created.iter().rev() {
                let expected = plan
                    .sidecars
                    .iter()
                    .find(|(path, _)| path == created_path)
                    .map(|(_, contents)| contents.as_bytes());
                if fs::read(created_path).ok().as_deref() != expected {
                    rollback_errors.push(format!(
                        "{} changed during migration; refusing to remove it",
                        created_path.display()
                    ));
                } else if let Err(rollback) = fs::remove_file(created_path) {
                    rollback_errors.push(format!(
                        "cannot remove {}: {rollback}",
                        created_path.display()
                    ));
                }
            }
            if plan.config_changed {
                if fs::read(&plan.config_path).ok().as_deref()
                    != Some(plan.updated_config.as_bytes())
                {
                    rollback_errors.push(
                        "openblog.json changed during migration; refusing to overwrite it".into(),
                    );
                } else if let Err(rollback) = write_config(&plan.config_path, &plan.original_config)
                {
                    rollback_errors.push(format!("config rollback failed: {rollback}"));
                }
            }
            return Err(if rollback_errors.is_empty() {
                format!("{error}; migration rolled back")
            } else {
                format!(
                    "{error}; rollback incomplete: {}",
                    rollback_errors.join("; ")
                )
            });
        }
        created.push(path.clone());
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scaffold;

    fn fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ob-contributor-migrate-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        scaffold::init(&root, Some("Migration"), false).unwrap();
        let path = root.join(site::CONFIG_FILE);
        let mut config: Json = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        config["author"] =
            json!({ "name": "Ada", "url": "/about/", "sameAs": ["https://example.test/ada"] });
        config["futureSetting"] = json!({ "keep": true });
        fs::write(path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
        root
    }

    #[test]
    fn dry_run_plan_is_idempotent_and_preserves_existing_sidecars() {
        let root = fixture("plan");
        let config_before = fs::read(root.join(site::CONFIG_FILE)).unwrap();
        let migration = plan(&root, "ada").unwrap();
        assert!(migration.config_changed);
        assert_eq!(migration.sidecars.len(), 1);
        assert_eq!(
            fs::read(root.join(site::CONFIG_FILE)).unwrap(),
            config_before
        );
        let post = fs::read(root.join("content/posts/hello-world.md")).unwrap();
        fs::write(root.join("content/posts/added-after-preview.md"), post).unwrap();
        let applied = apply(&migration).unwrap();
        assert_eq!(applied.sidecars.len(), 2);
        let written: Json =
            serde_json::from_str(&fs::read_to_string(root.join(site::CONFIG_FILE)).unwrap())
                .unwrap();
        assert_eq!(written["futureSetting"]["keep"], true);
        assert!(root
            .join("content/posts/hello-world.credits.json")
            .is_file());
        assert!(root
            .join("content/posts/added-after-preview.credits.json")
            .is_file());
        let second = plan(&root, "ada").unwrap();
        assert!(!second.config_changed);
        assert!(second.sidecars.is_empty());
        assert_eq!(second.skipped, 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn conflicting_identity_and_partial_write_are_rejected_or_rolled_back() {
        let root = fixture("rollback");
        let first_post = fs::read_to_string(root.join("content/posts/hello-world.md")).unwrap();
        fs::write(root.join("content/posts/second.markdown"), first_post).unwrap();
        let original = fs::read(root.join(site::CONFIG_FILE)).unwrap();
        let migration = plan(&root, "ada").unwrap();
        assert_eq!(migration.sidecars.len(), 2);
        let error = apply_using(&migration, write_atomic, |path, bytes| {
            if path.ends_with("second.credits.json") {
                return Err("injected sidecar failure".into());
            }
            write_new(path, bytes)
        })
        .unwrap_err();
        assert!(error.contains("rolled back"));
        assert_eq!(fs::read(root.join(site::CONFIG_FILE)).unwrap(), original);
        assert!(!root.join("content/posts/hello-world.credits.json").exists());
        assert!(!root.join("content/posts/second.credits.json").exists());

        let path = root.join(site::CONFIG_FILE);
        let mut config: Json = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        config["contributors"] = json!({ "ada": { "name": "Someone Else" } });
        fs::write(&path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
        assert!(plan(&root, "ada")
            .unwrap_err()
            .contains("different identity"));
        assert!(plan(&root, "Ada Lovelace")
            .unwrap_err()
            .contains("lowercase ASCII slug"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn custom_content_dry_run_and_write_preserve_markdown_and_existing_empty_sidecars() {
        let root = fixture("custom-content");
        let config_path = root.join(site::CONFIG_FILE);
        let mut config: Json =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        config["paths"]["content"] = json!("writings");
        fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
        fs::rename(root.join("content"), root.join("writings")).unwrap();
        let first = root.join("writings/posts/hello-world.md");
        let second = root.join("writings/posts/second.markdown");
        fs::write(&second, fs::read(&first).unwrap()).unwrap();
        let existing = root.join("writings/posts/hello-world.credits.json");
        let empty = b"{\"version\":1,\"credits\":[]}\n";
        fs::write(&existing, empty).unwrap();
        let markdown_before = fs::read(&second).unwrap();
        let config_before = fs::read(&config_path).unwrap();

        let migration = plan(&root, "ada").unwrap();
        assert_eq!(migration.skipped, 1);
        assert_eq!(migration.sidecars.len(), 1);
        assert_eq!(fs::read(&config_path).unwrap(), config_before);
        assert_eq!(fs::read(&second).unwrap(), markdown_before);
        apply(&migration).unwrap();
        assert_eq!(fs::read(&existing).unwrap(), empty);
        assert_eq!(fs::read(&second).unwrap(), markdown_before);
        assert!(root.join("writings/posts/second.credits.json").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn production_validation_and_apply_conflicts_leave_authored_files_untouched() {
        let root = fixture("production-validation");
        let posts = root.join("content/posts");
        let source = fs::read(posts.join("hello-world.md")).unwrap();
        fs::write(posts.join("collision.md"), &source).unwrap();
        fs::write(posts.join("collision.markdown"), &source).unwrap();
        let collision_sidecar = posts.join("collision.credits.json");
        fs::write(&collision_sidecar, b"{\"version\":1,\"credits\":[]}").unwrap();
        let collision_error = plan(&root, "ada").unwrap_err();
        assert!(collision_error.contains("collision"), "{collision_error}");
        assert_eq!(
            fs::read(&collision_sidecar).unwrap(),
            b"{\"version\":1,\"credits\":[]}"
        );
        fs::remove_file(posts.join("collision.markdown")).unwrap();
        fs::write(&collision_sidecar, b"not json").unwrap();
        assert!(plan(&root, "ada").is_err());
        assert_eq!(fs::read(&collision_sidecar).unwrap(), b"not json");
        fs::remove_file(&collision_sidecar).unwrap();

        let migration = plan(&root, "ada").unwrap();
        let config_path = root.join(site::CONFIG_FILE);
        fs::write(&config_path, b"{}\n").unwrap();
        assert!(apply(&migration).is_err());
        assert!(!posts.join("hello-world.credits.json").exists());
        let _ = fs::remove_dir_all(root);

        let root = fixture("sidecar-race");
        let migration = plan(&root, "ada").unwrap();
        let raced = root.join("content/posts/hello-world.credits.json");
        fs::write(&raced, b"owner edit").unwrap();
        let config_before = fs::read(root.join(site::CONFIG_FILE)).unwrap();
        assert!(apply(&migration).is_err());
        assert_eq!(fs::read(&raced).unwrap(), b"owner edit");
        assert_eq!(
            fs::read(root.join(site::CONFIG_FILE)).unwrap(),
            config_before
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_honors_the_shared_content_transaction_lock() {
        let root = fixture("shared-lock");
        let migration = plan(&root, "ada").unwrap();
        let lock = ContentTransactionLock::acquire(&root).unwrap();

        let error = apply(&migration).unwrap_err();
        let lock_path = root.join(".openblog").join("content-transaction.lock");
        assert!(error.contains(&lock_path.display().to_string()), "{error}");
        assert!(error.contains("no writer is running"), "{error}");
        assert!(!root.join("content/posts/hello-world.credits.json").exists());

        drop(lock);
        let _ = fs::remove_dir_all(root);
    }
}
