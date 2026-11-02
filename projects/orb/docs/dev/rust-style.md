# Rust style

The conventions orb's Rust code follows. Each section gives the rule first, then a real piece of orb that shows it.

## Errors

- **Fallible code returns an error-stack `Report` over a `wherror` type.** The type derives `Error` with `#[error(debug)]` and lives in the same file as the code that fails. There are no error.rs or errors.rs files.

  ```rust
  /// A zmx call failed. Every report carries a one-line reason as its latest
  /// `String` attachment, fit for the mode line.
  #[derive(Debug, Error)]
  #[error(debug)]
  pub struct ZmxError;
  ```

  (crates/orb-domain/src/feat/zmx/zmx_service.rs:18-22)

- **Lift the cause into your type and say what went wrong.** Use `change_context` to wrap the lower error, then `attach` or `attach_with` for a short reason. orb's habit is a one-line `String` the message box can show.

  ```rust
      .spawn()
      .change_context(NotifyError)
      .attach_with(|| format!("couldn't run {}", program.display()))?;
  ```

  (crates/orb-domain/src/feat/notify/notifier.rs:160-180)

- **Every public fallible function has a `# Errors` section** that says when it fails (`ZmxService::list`, zmx_service.rs:173-178).

## Validators

- **A validator is a plain function over `&AppState`.** No registry, no trait object. A fallible intent gets its own error enum naming why it can't go ahead, and the intent function does nothing when the validator says no.

  ```rust
  pub enum JumpError {
      /// No row in that direction is reachable.
      NoTarget,
  }

  pub fn validate_jump_back(state: &AppState) -> Result<(), JumpError> {
  ```

  (crates/orb-domain/src/feat/jumps/validator.rs:7-28)

## Traits and services

- **Every outside dependency is a trait.** git, zmx, the harnesses, the notifiers and the sounds each have one, with `fn name(&self) -> &'static str` so debug output can say which backend is in use. A trait sits beside the types that use it, never in a traits.rs.
- **A service struct wraps the trait object.** It holds an `Arc<dyn Trait>` plus whatever it needs, is cheap to `Clone`, and writes its own `Debug` that prints the backend's name.

  ```rust
  #[derive(Clone)]
  pub struct ZmxService {
      zmx: Arc<dyn Zmx>,
      dir: PathBuf,
      log: Log,
  }

  impl fmt::Debug for ZmxService {
      fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
          write!(f, "Zmx<{}>", self.zmx.name())
      }
  }
  ```

  (zmx_service.rs:147-152 and :219-223; `GitService` has the same shape, crates/orb-domain/src/feat/git/git_service.rs:49, :194, :380)
- **Async trait methods use `#[async_trait]`** (`Harness`, crates/orb-domain/src/feat/harness/mod.rs:125-126).
- **Each trait's fake sits next to it** in a `#[cfg(test)]` module (`FakeZmx`, zmx_service.rs:226-236).
- **`Services` is built once at start-up and cloned into the actors** (crates/orb-domain/src/common/services.rs:9-18). Every field is cheap to clone or is a service wrapper. The loop and the intent handler work on `AppState` and never take it.

## Modules

- **src/feat.rs lists the features** (crates/orb-domain/src/feat.rs). There is no feat/mod.rs.
- **A feature folder has a `mod.rs`.** That is the only place `mod.rs` is allowed.
- **Everywhere else a module is `foo.rs` beside a `foo/` folder.** For example sessions_actor.rs sits next to sessions_actor/, which holds poll.rs, settle.rs, start.rs and the rest.

## Actors

- **One actor per file, named `<name>_actor.rs`.** Its spawn function lives in the same file (`spawn_worktrees_actor`, crates/orb-domain/src/feat/worktrees/worktrees_actor.rs:52), never in the feature's `mod.rs`.
- **A feature that is nothing but an actor is named `<name>_actor`.**
- **A big actor splits its helpers into the sibling folder**, as the sessions actor does with poll.rs and settle.rs.

## Block scoping

- **Build a value inside a block.** The temporaries end with the block and the binding that comes out is immutable.

  ```rust
  let dir = {
      let mut word = OsString::from("ZMX_DIR=");
      word.push(dir);
      word
  };
  ```

  (`zmx_argv`, zmx_service.rs:69-78, which also shows a `where` clause)

## Small rules

- **Cut text by grapheme** with unicode-segmentation, never with `.chars()` or byte indexes (crates/orb-domain/src/common/text_input.rs:1-4).
- **Read environment variables only at start-up.** src/main.rs reads them (src/main.rs:61-152) and passes the values on in structs; `child_env` builds the panes' environment from them (crates/orb-domain/src/feat/sessions/child_env.rs:96).
- **Put generic bounds in a `where` clause.**
- **Prefer `match` to a chain of `if`s** (jumps/intent.rs:11).
- **Name the action instead of writing a setter.** `state.sessions.enter(id)` (jumps/intent.rs:47) says what happens; a bare field setter doesn't.
- **Run outside programs through `run_within`** (crates/orb-domain/src/common/child.rs:34), so each one has a time limit; wait on one you started yourself with `wait_within` (child.rs:59). The lint rejects `.output()`, `.status()` outside tests, and `.wait()` outside the reviewed files in scripts/lint-rules.py.
- **Never throw away a kill or a removal.** No `let _ =` on one, and no `|_report|` closure that drops an error. The lint checks both.
- **Keep a file's production part at 2,000 lines or fewer.** `just lint-filelen` counts the lines before the first `#[cfg(test)]`; test-only tests.rs and test_support.rs files don't count.
- **Comments describe orb on its own terms.** No notes about plans, specs or divergences, and no explaining a behaviour by comparing it with another tool.

## Doc comments

- **A module doc says what the module is for and how it behaves**, not how it is built.

  ```rust
  //! The worktrees actor — owns `AppState.worktrees`.
  //!
  //! It lists orb's worktrees, reads their git facts and sizes, sweeps at start
  //! and every hour after, and deletes a worktree when the user asks. A sweep
  //! never forces a removal, and nothing here deletes a branch.
  ```

  (worktrees_actor.rs:1-5)
- **A type doc says what the value means.**

  ```rust
  /// A line of text being typed, with a grapheme cursor.
  pub struct TextInput {
      /// The typed text.
      text: String,
      /// A grapheme index into `text`.
      cursor: usize,
  }
  ```

  (text_input.rs:6-13)
- **Errors go under `# Errors`**, as above.
