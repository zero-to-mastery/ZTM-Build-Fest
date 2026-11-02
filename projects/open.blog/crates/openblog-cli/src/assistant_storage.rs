//! Canonical containment for every Assistant-managed project path.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// Resolve an Assistant-managed target without requiring its final directories
/// to exist. The nearest existing ancestor is canonicalized so a symlinked
/// parent cannot redirect a later create outside the canonical project root.
pub fn contained_target(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Assistant path must stay relative to the project".into());
    }

    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Cannot resolve the project root: {error}"))?;
    let target = root.join(relative);
    let mut nearest = target.as_path();
    loop {
        match fs::symlink_metadata(nearest) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                nearest = nearest
                    .parent()
                    .ok_or_else(|| "Assistant path has no existing project parent".to_string())?;
            }
            Err(error) => return Err(format!("Cannot inspect Assistant path: {error}")),
        }
    }
    let canonical_nearest = fs::canonicalize(nearest)
        .map_err(|error| format!("Cannot resolve Assistant path: {error}"))?;
    if !canonical_nearest.starts_with(&canonical_root) {
        return Err("Assistant path resolves outside the project".into());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn contained_target_uses_the_nearest_existing_parent_and_rejects_escape() {
        let root = std::env::temp_dir().join(format!(
            "openblog-assistant-containment-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("assistant")).unwrap();

        assert_eq!(
            contained_target(&root, std::path::Path::new("assistant/context/author.md")).unwrap(),
            root.join("assistant/context/author.md")
        );
        assert!(contained_target(&root, std::path::Path::new("../outside.md")).is_err());

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn contained_target_rejects_a_symlinked_parent_outside_the_project() {
        use std::os::unix::fs::symlink;

        let base =
            std::env::temp_dir().join(format!("openblog-assistant-symlink-{}", std::process::id()));
        let root = base.join("project");
        let outside = base.join("outside");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("assistant")).unwrap();

        assert!(contained_target(&root, Path::new("assistant/context/author.md")).is_err());

        let _ = fs::remove_dir_all(base);
    }
}
