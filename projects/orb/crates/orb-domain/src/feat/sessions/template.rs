//! Folder templates: the folder a new colony in a fresh world is copied from,
//! written from orb's built-in default when the user has none.

use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

use error_stack::{Report, ResultExt};
use wherror::Error;

use super::state::FolderKind;

/// The built-in Research template: each file's path in the folder and its text.
const RESEARCH: &[(&str, &str)] = &[
    (
        "AGENTS.md",
        include_str!("../../../templates/research/AGENTS.md"),
    ),
    (
        "SOURCES.md",
        include_str!("../../../templates/research/SOURCES.md"),
    ),
    (
        ".gitignore",
        include_str!("../../../templates/research/.gitignore"),
    ),
    (
        ".claude/settings.json",
        include_str!("../../../templates/research/.claude/settings.json"),
    ),
    (
        ".claude/agents/investigator.md",
        include_str!("../../../templates/research/.claude/agents/investigator.md"),
    ),
    (
        ".claude/agents/falsifier.md",
        include_str!("../../../templates/research/.claude/agents/falsifier.md"),
    ),
    (
        ".claude/agents/simulator.md",
        include_str!("../../../templates/research/.claude/agents/simulator.md"),
    ),
    (
        ".pi/agents/investigator.md",
        include_str!("../../../templates/research/.pi/agents/investigator.md"),
    ),
    (
        ".pi/agents/falsifier.md",
        include_str!("../../../templates/research/.pi/agents/falsifier.md"),
    ),
    (
        ".pi/agents/simulator.md",
        include_str!("../../../templates/research/.pi/agents/simulator.md"),
    ),
    (
        ".research/CONVENTIONS.md",
        include_str!("../../../templates/research/.research/CONVENTIONS.md"),
    ),
    (
        ".research/REPORT_TEMPLATE.md",
        include_str!("../../../templates/research/.research/REPORT_TEMPLATE.md"),
    ),
];
/// The built-in Learn template: each file's path in the folder and its text.
const LEARN: &[(&str, &str)] = &[
    (
        "AGENTS.md",
        include_str!("../../../templates/learn/AGENTS.md"),
    ),
    (
        ".gitignore",
        include_str!("../../../templates/learn/.gitignore"),
    ),
    (
        ".claude/agents/saboteur.md",
        include_str!("../../../templates/learn/.claude/agents/saboteur.md"),
    ),
    (
        ".pi/agents/saboteur.md",
        include_str!("../../../templates/learn/.pi/agents/saboteur.md"),
    ),
    (
        ".learn/STORYTELLER.md",
        include_str!("../../../templates/learn/.learn/STORYTELLER.md"),
    ),
    (
        ".learn/CHALLENGES.md",
        include_str!("../../../templates/learn/.learn/CHALLENGES.md"),
    ),
    (
        ".learn/TUTOR.md",
        include_str!("../../../templates/learn/.learn/TUTOR.md"),
    ),
    (
        ".learn/CONVENTIONS.md",
        include_str!("../../../templates/learn/.learn/CONVENTIONS.md"),
    ),
    (
        ".learn/ingest_epub.py",
        include_str!("../../../templates/learn/.learn/ingest_epub.py"),
    ),
];

/// A template couldn't be written or copied.
#[derive(Debug, Error)]
#[error(debug)]
pub struct TemplateError;

/// Writes the built-in template for `kind` into `dir` (made if missing): its
/// files, and `CLAUDE.md` as a symlink to `AGENTS.md`.
///
/// # Errors
///
/// Returns an error if a write fails.
pub fn seed(dir: &Path, kind: FolderKind) -> Result<(), Report<TemplateError>> {
    let files = match kind {
        FolderKind::Research => RESEARCH,
        FolderKind::Learn => LEARN,
    };
    for (path, text) in files {
        let file = dir.join(path);
        fs::create_dir_all(file.parent().unwrap_or(dir))
            .change_context(TemplateError)
            .attach(format!("failed to make the folder for {path}"))?;
        fs::write(&file, text)
            .change_context(TemplateError)
            .attach(format!("failed to write {path}"))?;
    }
    symlink("AGENTS.md", dir.join("CLAUDE.md"))
        .change_context(TemplateError)
        .attach("failed to link CLAUDE.md")
}

/// Copies `from` into `to`, which must not exist yet, keeping symlinks as
/// symlinks and leaving out every entry named `.git`, at any depth.
///
/// # Errors
///
/// Returns an error if `to` exists, or if a read or write fails.
pub fn copy(from: &Path, to: &Path) -> Result<(), Report<TemplateError>> {
    #[expect(
        clippy::create_dir,
        reason = "`to` must not exist yet, so a user's folder is never written into"
    )]
    let made = fs::create_dir(to);
    made.change_context(TemplateError)
        .attach(format!("failed to make {}", to.display()))?;
    let entries = fs::read_dir(from)
        .change_context(TemplateError)
        .attach(format!("failed to read {}", from.display()))?;
    for entry in entries {
        let entry = entry.change_context(TemplateError)?;
        if entry.file_name() == ".git" {
            continue;
        }
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let kind = fs::symlink_metadata(&src)
            .change_context(TemplateError)?
            .file_type();
        match (kind.is_dir(), kind.is_symlink()) {
            (true, _) => copy(&src, &dst)?,
            (_, true) => fs::read_link(&src)
                .and_then(|target| symlink(target, &dst))
                .change_context(TemplateError)
                .attach(format!("failed to link {}", dst.display()))?,
            _ => {
                fs::copy(&src, &dst)
                    .change_context(TemplateError)
                    .attach(format!("failed to copy {}", src.display()))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate setup failures with `?` and assert on the outcome"
)]
mod tests {
    use std::fs;
    use std::path::Path;

    use error_stack::{Report, ResultExt};

    use super::{LEARN, RESEARCH, TemplateError, copy, seed};
    use crate::feat::sessions::state::FolderKind;

    #[rstest::rstest]
    fn seed_writes_every_research_kit_file() -> Result<(), Report<TemplateError>> {
        // Given an empty temp folder.
        let root = tempfile::tempdir().change_context(TemplateError)?;
        let dir = root.path().join("research");

        // When seeding the Research template.
        seed(&dir, FolderKind::Research)?;

        // Then every kit file holds its built-in text.
        let wrong: Vec<&str> = RESEARCH
            .iter()
            .filter(|(path, text)| {
                fs::read_to_string(dir.join(path)).ok().as_deref() != Some(*text)
            })
            .map(|(path, _)| *path)
            .collect();
        assert_eq!(
            wrong,
            Vec::<&str>::new(),
            "every kit file should be the built-in text"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn seed_links_claude_md_to_agents_md() -> Result<(), Report<TemplateError>> {
        // Given an empty temp folder.
        let root = tempfile::tempdir().change_context(TemplateError)?;

        // When seeding the Learn template.
        seed(root.path(), FolderKind::Learn)?;

        // Then CLAUDE.md links to its sibling AGENTS.md.
        let target = fs::read_link(root.path().join("CLAUDE.md")).change_context(TemplateError)?;
        assert_eq!(
            target,
            Path::new("AGENTS.md"),
            "CLAUDE.md should link to AGENTS.md"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn seed_links_research_claude_md_to_agents_md() -> Result<(), Report<TemplateError>> {
        // Given an empty temp folder.
        let root = tempfile::tempdir().change_context(TemplateError)?;

        // When seeding the Research template.
        seed(root.path(), FolderKind::Research)?;

        // Then CLAUDE.md links to its sibling AGENTS.md.
        let target = fs::read_link(root.path().join("CLAUDE.md")).change_context(TemplateError)?;
        assert_eq!(
            target,
            Path::new("AGENTS.md"),
            "CLAUDE.md should link to AGENTS.md"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn seed_writes_every_learn_kit_file() -> Result<(), Report<TemplateError>> {
        // Given an empty temp folder.
        let root = tempfile::tempdir().change_context(TemplateError)?;
        let dir = root.path().join("learn");

        // When seeding the Learn template.
        seed(&dir, FolderKind::Learn)?;

        // Then every kit file holds its built-in text.
        let wrong: Vec<&str> = LEARN
            .iter()
            .filter(|(path, text)| {
                fs::read_to_string(dir.join(path)).ok().as_deref() != Some(*text)
            })
            .map(|(path, _)| *path)
            .collect();
        assert_eq!(
            wrong,
            Vec::<&str>::new(),
            "every kit file should be the built-in text"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn copy_keeps_symlinks_as_symlinks() -> Result<(), Report<TemplateError>> {
        // Given a seeded template.
        let root = tempfile::tempdir().change_context(TemplateError)?;
        let (from, to) = (root.path().join("from"), root.path().join("to"));
        seed(&from, FolderKind::Research)?;

        // When copying it.
        copy(&from, &to)?;

        // Then the copy's CLAUDE.md is still a symlink.
        let meta = fs::symlink_metadata(to.join("CLAUDE.md")).change_context(TemplateError)?;
        assert!(meta.is_symlink(), "CLAUDE.md should stay a symlink");
        Ok(())
    }

    #[rstest::rstest]
    fn copy_copies_nested_files() -> Result<(), Report<TemplateError>> {
        // Given a template with `notes/a.md`.
        let root = tempfile::tempdir().change_context(TemplateError)?;
        let (from, to) = (root.path().join("from"), root.path().join("to"));
        fs::create_dir_all(from.join("notes")).change_context(TemplateError)?;
        fs::write(from.join("notes/a.md"), "hello").change_context(TemplateError)?;

        // When copying it.
        copy(&from, &to)?;

        // Then the copy has the nested file with the same text.
        let text = fs::read_to_string(to.join("notes/a.md")).change_context(TemplateError)?;
        assert_eq!(text, "hello", "nested files should be copied");
        Ok(())
    }

    #[rstest::rstest]
    fn copy_copies_dotfiles() -> Result<(), Report<TemplateError>> {
        // Given a template with `.claude/agents/x.md`.
        let root = tempfile::tempdir().change_context(TemplateError)?;
        let (from, to) = (root.path().join("from"), root.path().join("to"));
        fs::create_dir_all(from.join(".claude/agents")).change_context(TemplateError)?;
        fs::write(from.join(".claude/agents/x.md"), "hello").change_context(TemplateError)?;

        // When copying it.
        copy(&from, &to)?;

        // Then the copy has the dotfile folder's file.
        assert!(
            to.join(".claude/agents/x.md").is_file(),
            "dotfile folders should be copied"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn copy_skips_git_at_any_depth() -> Result<(), Report<TemplateError>> {
        // Given a folder with `.git` at its top and in a subfolder.
        let root = tempfile::tempdir().change_context(TemplateError)?;
        let (from, to) = (root.path().join("from"), root.path().join("to"));
        for dir in [from.join(".git"), from.join("sub/.git")] {
            fs::create_dir_all(&dir).change_context(TemplateError)?;
            fs::write(dir.join("HEAD"), "ref").change_context(TemplateError)?;
        }
        fs::write(from.join("sub/a.md"), "a").change_context(TemplateError)?;

        // When copying it.
        copy(&from, &to)?;

        // Then neither `.git` is copied, and the other file is.
        assert_eq!(
            (
                to.join(".git").exists(),
                to.join("sub/.git").exists(),
                to.join("sub/a.md").is_file()
            ),
            (false, false, true),
            "every `.git` should be left out and the rest copied"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn copy_refuses_an_existing_destination() -> Result<(), Report<TemplateError>> {
        // Given a seeded template and a destination holding `mine.md`.
        let root = tempfile::tempdir().change_context(TemplateError)?;
        let (from, to) = (root.path().join("from"), root.path().join("to"));
        seed(&from, FolderKind::Research)?;
        fs::create_dir_all(&to).change_context(TemplateError)?;
        fs::write(to.join("mine.md"), "mine").change_context(TemplateError)?;

        // When copying into it.
        let copied = copy(&from, &to);

        // Then it's refused and the existing file is untouched.
        let text = fs::read_to_string(to.join("mine.md")).change_context(TemplateError)?;
        assert_eq!(
            (copied.is_err(), text.as_str()),
            (true, "mine"),
            "an existing destination should be refused and left alone"
        );
        Ok(())
    }

    /// A temp folder seeded with the Research template.
    fn seeded_research() -> Result<tempfile::TempDir, Report<TemplateError>> {
        let root = tempfile::tempdir().change_context(TemplateError)?;
        seed(root.path(), FolderKind::Research)?;
        Ok(root)
    }

    /// The frontmatter and body of the seeded agent file at `path`: the text
    /// between the opening `---` line and the next one, and everything after it.
    fn agent_parts(dir: &Path, path: &str) -> Result<(String, String), Report<TemplateError>> {
        let text = fs::read_to_string(dir.join(path)).change_context(TemplateError)?;
        let (front, body) = text
            .strip_prefix("---\n")
            .and_then(|rest| rest.split_once("\n---\n"))
            .ok_or_else(|| {
                Report::new(TemplateError).attach(format!("{path} has no frontmatter"))
            })?;
        Ok((front.to_owned(), body.to_owned()))
    }

    #[rstest::rstest]
    #[case("investigator")]
    #[case("falsifier")]
    #[case("simulator")]
    fn pi_agent_bodies_match_claude_agents(
        #[case] agent: &str,
    ) -> Result<(), Report<TemplateError>> {
        // Given a seeded Research folder.
        let root = seeded_research()?;

        // When reading the agent's pi and Claude files.
        let (_, pi) = agent_parts(root.path(), &format!(".pi/agents/{agent}.md"))?;
        let (_, claude) = agent_parts(root.path(), &format!(".claude/agents/{agent}.md"))?;

        // Then the bodies are identical.
        assert_eq!(
            pi, claude,
            "the pi {agent} body should match its Claude twin"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn pi_falsifier_tools_leave_out_edit() -> Result<(), Report<TemplateError>> {
        // Given a seeded Research folder.
        let root = seeded_research()?;

        // When reading the pi falsifier's `tools` line.
        let (front, _) = agent_parts(root.path(), ".pi/agents/falsifier.md")?;
        let tools: Option<Vec<&str>> = front
            .lines()
            .find_map(|line| line.strip_prefix("tools:"))
            .map(|list| list.split(',').map(str::trim).collect());

        // Then it lists tools, and `edit` isn't one of them.
        assert!(
            tools.is_some_and(|tools| !tools.contains(&"edit")),
            "the pi falsifier should have a tools line without edit"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[case("investigator")]
    #[case("falsifier")]
    #[case("simulator")]
    fn pi_agents_set_no_model(#[case] agent: &str) -> Result<(), Report<TemplateError>> {
        // Given a seeded Research folder.
        let root = seeded_research()?;

        // When reading the pi agent's frontmatter.
        let (front, _) = agent_parts(root.path(), &format!(".pi/agents/{agent}.md"))?;

        // Then no line sets a model.
        assert!(
            !front.lines().any(|line| line.starts_with("model:")),
            "the pi {agent} should set no model"
        );
        Ok(())
    }

    /// A temp folder seeded with the Learn template.
    fn seeded_learn() -> Result<tempfile::TempDir, Report<TemplateError>> {
        let root = tempfile::tempdir().change_context(TemplateError)?;
        seed(root.path(), FolderKind::Learn)?;
        Ok(root)
    }

    #[rstest::rstest]
    fn pi_saboteur_body_matches_claude_saboteur() -> Result<(), Report<TemplateError>> {
        // Given a seeded Learn folder.
        let root = seeded_learn()?;

        // When reading the saboteur's pi and Claude files.
        let (_, pi) = agent_parts(root.path(), ".pi/agents/saboteur.md")?;
        let (_, claude) = agent_parts(root.path(), ".claude/agents/saboteur.md")?;

        // Then the bodies are identical.
        assert_eq!(
            pi, claude,
            "the pi saboteur body should match its Claude twin"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn pi_saboteur_sets_no_model() -> Result<(), Report<TemplateError>> {
        // Given a seeded Learn folder.
        let root = seeded_learn()?;

        // When reading the pi saboteur's frontmatter.
        let (front, _) = agent_parts(root.path(), ".pi/agents/saboteur.md")?;

        // Then no line sets a model.
        assert!(
            !front.lines().any(|line| line.starts_with("model:")),
            "the pi saboteur should set no model"
        );
        Ok(())
    }
}
