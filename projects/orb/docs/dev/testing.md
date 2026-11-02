# Testing

How orb's tests are written. `just test` runs them all; `just lint` checks the rules marked "lint" below.

## What to test

- **Test what someone outside the code could see.** The state after an intent, the commands it returns, what an actor wrote, what the screen draws. Never a private field or a helper's call count, unless that count is the behaviour (a fake recording what was run).
- **If the behaviour can't be seen from outside, stop and ask the user** before adding an abstraction just to make it visible.

## One test, one behaviour

- **Each test answers one question.** It has one `// When` and one `// Then`. `// And` lines may follow the `// Then`, but only to say more about the same behaviour.
- **The name alone tells you what broke.** Read it as a sentence about orb: `jump_back_into_a_pane_adds_no_entry`.
- **These count as one behaviour:** several fields of one result, a save and load that round-trips, a reset that clears everything, every row of a filtered list matching the filter.
- **These are separate tests:**
  - a state change and the command the same intent returns;
  - a second input after a first one;
  - each kind of row a renderer draws;
  - each step of a lifecycle, such as a session starting, becoming ready and being settled.
- **Copy the setup rather than merge tests.** Repeated Given blocks are fine.

Jumping back from a pane both moves the keys and asks the loop to show a pane. Those are two behaviours.

```rust
// ✗ one test, two answers
fn jump_back_from_a_pane_works() {
    // When handling JumpBack.
    // Then the keys are in agent 1's pane.
    // And the commands contain Attach for session 1.   <- a second behaviour
}

// ✓ two tests (crates/orb-domain/src/feat/jumps/intent.rs:149, :169)
fn jump_back_from_a_pane_onto_an_attached_agent_focuses_its_pane() { /* ... */ }
fn jump_back_from_a_pane_onto_an_attached_agent_returns_attach() { /* ... */ }
```

## Given / When / Then

Write the three comments as plain sentences. Three real tests show the shape.

A validator (crates/orb-domain/src/feat/jumps/validator.rs:108-118):

```rust
#[rstest::rstest]
fn jump_back_without_an_older_row_is_rejected() {
    // Given a jump list holding only the cursor's agent.
    let state = jumping(&[2]);

    // When validating a jump back.
    let result = validate_jump_back(&state);

    // Then there's nowhere to go.
    assert_eq!(result, Err(JumpError::NoTarget), "<C-[> needs an older row");
}
```

The intent handler (crates/orb-domain/src/intent_handler.rs:278-293):

```rust
#[rstest::rstest]
fn next_intent_clears_the_error() {
    // Given a failure on the mode line.
    let mut state = state_with(vec![in_root(1)], 1);
    state.sessions.error = Some("A session is working in this directory".to_owned());

    // When handling the next intent.
    IntentHandler::handle(&Intent::SelectNext, &mut state);

    // Then the failure is gone.
    assert_eq!(
        state.sessions.error, None,
        "the user has seen the error once they press a key"
    );
}
```

An actor (crates/orb-domain/src/feat/worktrees/worktrees_actor.rs:868-888):

```rust
#[rstest::rstest]
fn refresh_writes_the_size() -> io::Result<()> {
    // Given a worktree.
    let root = tempfile::tempdir()?;
    worktree(&root, "orb-a1")?;
    let git = Arc::new(FakeGit::default());
    let (actor, state) = start(&git, &root, one_project());

    // When refreshing.
    actor.refresh();

    // Then its size is in the state.
    // ...reads the sizes out of state.read().worktrees...
    assert_eq!(sizes, vec![Some(42)], "the measured size should be written");
    Ok(())
}
```

## rstest

- **Every test carries `#[rstest::rstest]`** (lint). `just lint-testattr` rejects a bare `#[test]` or `#[tokio::test]`, because only rstest applies the per-test time limit in `RSTEST_TIMEOUT` (.cargo/config.toml:8).
- **Reach for `#[case]` when one assertion runs over many inputs**, and only when every case checks the same property. `layout_intents_display_their_labels` (crates/orb-domain/src/intent.rs:338-371) checks one which-key label per case.
- **An odd edge case gets its own Given/When/Then test** instead of a case that needs a different assertion.
- **Async tests stack `#[rstest::rstest]` over `#[tokio::test]`** (`second_sweep_inside_the_hour_does_not_run`, worktrees_actor.rs:803-805).

## Asserts

- **Every `assert!` and `assert_eq!` carries a message** (lint). `just lint` runs clippy with warnings as errors, and that includes `clippy::missing_assert_message`.
- **Say what should be true**, as the examples above do, so a failure reads as the broken promise.

## Helpers

- **Fakes live beside their trait**, such as `FakeZmx` next to the zmx trait and `FakeGit` in the git and worktrees tests. They answer with fixed output and record what was asked.
- **Anything on disk goes in a `tempfile` folder.**
- **Drawing tests use ratatui's `TestBackend`** (crates/orb-tui/src/render/tests.rs:117).
- **Shared builders go in a test_support.rs** (crates/orb-tui/src/test_support.rs, crates/orb-domain/src/intent_handler/test_support.rs) or in the feature's own test module.
