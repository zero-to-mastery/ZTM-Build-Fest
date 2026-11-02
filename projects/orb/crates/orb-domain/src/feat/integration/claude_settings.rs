//! orb's entries in Claude Code's `settings.json`: a `SessionStart` hook for
//! every session source and a `SessionEnd` hook, both running orb's hook
//! script. The file is plain JSON; it is rewritten in serde_json's pretty
//! form, which is the form Claude writes, so other keys keep their order and
//! look.

use std::path::Path;

use error_stack::{Report, ResultExt};
use serde_json::{Map, Value, json};

use super::{IntegrationError, SCRIPT_NAME};

/// Claude's SessionStart sources (Claude Code 2.1.292).
const SESSION_START_MATCHER: &str = "^(startup|resume|clear|compact|fork)$";
const TIMEOUT_SECS: u64 = 10;

/// The command Claude runs: `sh '<script>'`, quoted for sh.
pub fn hook_command(script: &Path) -> String {
    format!(
        "sh '{}'",
        script.display().to_string().replace('\'', r"'\''")
    )
}

/// `content` (`None` for no file) with orb's old entries removed and its
/// current ones appended to `hooks.SessionStart` and `hooks.SessionEnd`. An
/// event that already holds just orb's current entry is left as it is.
/// Other keys, hooks and their order are kept; a group left with no hooks
/// once orb's are gone is dropped.
///
/// # Errors
///
/// Returns an error if `content` isn't JSON, its root or `hooks` isn't an
/// object, or an event's value isn't an array.
pub fn merge(content: Option<&str>, command: &str) -> Result<String, Report<IntegrationError>> {
    let mut root: Value = match content {
        Some(text) => serde_json::from_str(text)
            .change_context(IntegrationError)
            .attach("settings.json isn't plain JSON")?,
        None => Value::Object(Map::new()),
    };
    let hooks = root
        .as_object_mut()
        .ok_or_else(|| not_a("settings", "an object"))?
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| not_a("hooks", "an object"))?;
    for (event, matcher) in [
        ("SessionStart", Some(SESSION_START_MATCHER)),
        ("SessionEnd", None),
    ] {
        let groups = hooks
            .entry(event)
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| not_a(event, "an array"))?;
        let wanted = group(matcher, command);
        // Already in place: leave it where it is, even with groups after it.
        let orbs = groups.iter().filter(|group| holds_orbs(group)).count();
        if orbs == 1 && groups.contains(&wanted) {
            continue;
        }
        groups.retain_mut(|group| !drop_orbs(group));
        groups.push(wanted);
    }
    let mut text = serde_json::to_string_pretty(&root).change_context(IntegrationError)?;
    text.push('\n');
    Ok(text)
}

fn not_a(key: &str, kind: &str) -> Report<IntegrationError> {
    Report::new(IntegrationError).attach(format!("settings.json: {key} isn't {kind}"))
}

/// Removes orb's hooks (a command naming `orb-agent-state.sh`) from a matcher
/// group; true when that left it empty.
fn drop_orbs(group: &mut Value) -> bool {
    let Some(hooks) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
        return false;
    };
    let before = hooks.len();
    hooks.retain(|hook| !is_orbs(hook));
    hooks.len() < before && hooks.is_empty()
}

/// Whether a matcher group runs one of orb's hooks.
fn holds_orbs(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| hooks.iter().any(is_orbs))
}

fn is_orbs(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(&format!("/{SCRIPT_NAME}")))
}

/// `{"matcher": …, "hooks": [{"type":"command","command":…,"timeout":10}]}`,
/// no matcher for SessionEnd.
fn group(matcher: Option<&str>, command: &str) -> Value {
    let hooks = json!([{ "type": "command", "command": command, "timeout": TIMEOUT_SECS }]);
    match matcher {
        Some(matcher) => json!({ "matcher": matcher, "hooks": hooks }),
        None => json!({ "hooks": hooks }),
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests parse with `?` and assert on the outcome"
)]
mod tests {
    use std::path::Path;

    use error_stack::{Report, ResultExt};
    use serde_json::{Value, json};

    use super::{hook_command, merge};
    use crate::feat::integration::IntegrationError;

    type TestResult = Result<(), Report<IntegrationError>>;

    const CMD: &str = "sh '/home/u/.orb/hooks/orb-agent-state.sh'";

    /// A trimmed copy of a real settings file's shape, in Claude's form.
    const USER_LIKE: &str = r#"{
  "fileSuggestion": {
    "type": "command",
    "command": "fd"
  },
  "model": "opus",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "^(startup|resume|clear|compact|fork)$",
        "hooks": [
          {
            "type": "command",
            "command": "bash '/home/u/.claude/hooks/herdr-agent-state.sh' session",
            "timeout": 10
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "status.sh"
  },
  "enabledPlugins": {
    "a@b": true
  }
}
"#;

    fn parse(text: &str) -> Result<Value, Report<IntegrationError>> {
        serde_json::from_str(text).change_context(IntegrationError)
    }

    fn orb_group(matcher: bool) -> Value {
        let hooks = json!([{ "type": "command", "command": CMD, "timeout": 10 }]);
        if matcher {
            json!({ "matcher": "^(startup|resume|clear|compact|fork)$", "hooks": hooks })
        } else {
            json!({ "hooks": hooks })
        }
    }

    #[rstest::rstest]
    fn merge_into_no_file_adds_a_session_start_and_a_session_end_hook() -> TestResult {
        // Given no settings file.

        // When merging orb's hooks.
        let merged = parse(&merge(None, CMD)?)?;

        // Then the file holds just orb's two hooks.
        let expected = json!({ "hooks": {
            "SessionStart": [orb_group(true)],
            "SessionEnd": [orb_group(false)],
        }});
        assert_eq!(merged, expected, "a new file should hold only orb's hooks");
        Ok(())
    }

    #[rstest::rstest]
    fn merge_keeps_every_other_key_and_its_formatting() -> TestResult {
        // Given settings in Claude's form with another tool's SessionStart hook.

        // When merging orb's hooks.
        let merged = merge(Some(USER_LIKE), CMD)?;

        // Then orb's group follows herdr's, SessionEnd comes last in hooks,
        // and the rest of the text is as it was.
        let expected = r#"{
  "fileSuggestion": {
    "type": "command",
    "command": "fd"
  },
  "model": "opus",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "^(startup|resume|clear|compact|fork)$",
        "hooks": [
          {
            "type": "command",
            "command": "bash '/home/u/.claude/hooks/herdr-agent-state.sh' session",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "^(startup|resume|clear|compact|fork)$",
        "hooks": [
          {
            "type": "command",
            "command": "sh '/home/u/.orb/hooks/orb-agent-state.sh'",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh '/home/u/.orb/hooks/orb-agent-state.sh'",
            "timeout": 10
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "status.sh"
  },
  "enabledPlugins": {
    "a@b": true
  }
}
"#;
        assert_eq!(merged, expected, "only orb's hooks should be added");
        Ok(())
    }

    #[rstest::rstest]
    fn merge_twice_adds_no_duplicate_hooks() -> TestResult {
        // Given settings that already hold orb's hooks.
        let once = merge(None, CMD)?;

        // When merging them again.
        let twice = merge(Some(&once), CMD)?;

        // Then nothing changed.
        assert_eq!(twice, once, "a second merge should change nothing");
        Ok(())
    }

    #[rstest::rstest]
    fn merge_leaves_orbs_hooks_in_place_when_another_hook_follows() -> TestResult {
        // Given orb's hooks installed, then another tool's SessionStart group
        // added after orb's.
        let installed = {
            let mut settings = parse(&merge(None, CMD)?)?;
            if let Some(starts) = settings
                .pointer_mut("/hooks/SessionStart")
                .and_then(Value::as_array_mut)
            {
                starts.push(json!({ "hooks": [{ "type": "command", "command": "later.sh" }] }));
            }
            let mut text =
                serde_json::to_string_pretty(&settings).change_context(IntegrationError)?;
            text.push('\n');
            text
        };

        // When merging orb's hooks again.
        let merged = merge(Some(&installed), CMD)?;

        // Then the file is unchanged.
        assert_eq!(
            merged, installed,
            "orb's group should stay before the later one"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn merge_replaces_an_entry_pointing_at_an_old_script_path() -> TestResult {
        // Given a SessionStart group running orb's script from an old home.
        let old = json!({ "hooks": { "SessionStart": [{ "hooks": [{
            "type": "command",
            "command": "sh '/old/home/.orb/hooks/orb-agent-state.sh'",
        }]}]}})
        .to_string();

        // When merging with the current command.
        let merged = parse(&merge(Some(&old), CMD)?)?;

        // Then only the current command is left.
        let starts = merged.pointer("/hooks/SessionStart").cloned();
        assert_eq!(
            starts,
            Some(json!([orb_group(true)])),
            "the old path's entry should be replaced"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn merge_keeps_another_tools_hook_in_the_same_group() -> TestResult {
        // Given a group holding herdr's hook and an old orb hook.
        let herdr = json!({ "type": "command", "command": "bash herdr-agent-state.sh" });
        let old = json!({ "hooks": { "SessionStart": [{ "hooks": [
            herdr,
            { "type": "command", "command": "sh '/old/.orb/hooks/orb-agent-state.sh'" },
        ]}]}})
        .to_string();

        // When merging orb's hooks.
        let merged = parse(&merge(Some(&old), CMD)?)?;

        // Then that group still holds herdr's hook, alone.
        let first = merged.pointer("/hooks/SessionStart/0/hooks").cloned();
        assert_eq!(first, Some(json!([herdr])), "herdr's hook should stay");
        Ok(())
    }

    #[rstest::rstest]
    fn merge_refuses_settings_with_comments() {
        // Given settings with a comment.
        let text = "{\n  // note\n  \"model\": \"x\"\n}\n";

        // When merging orb's hooks.
        let merged = merge(Some(text), CMD);

        // Then the merge is refused.
        assert!(merged.is_err(), "JSON with comments should be refused");
    }

    #[rstest::rstest]
    fn hook_command_quotes_a_path_with_a_quote() {
        // Given a script path with a single quote.
        let script = Path::new("/tmp/it's/x.sh");

        // When building the hook command.
        let command = hook_command(script);

        // Then the quote is escaped for sh.
        assert_eq!(
            command, r"sh '/tmp/it'\''s/x.sh'",
            "the quote should be escaped"
        );
    }
}
