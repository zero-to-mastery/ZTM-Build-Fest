# Architecture

How a key press turns into a change on screen, and which part of orb is allowed to change which piece of state.

## The flow

```
 key or mouse (crossterm)
   │  keymap ................................ crates/orb-tui/src/keymap.rs
   ▼
 Intent .................................... crates/orb-domain/src/intent.rs:14
   │  IntentHandler::handle ................. crates/orb-domain/src/intent_handler.rs:36
   │    └ one call into feat/<x>/intent.rs, e.g. jump_back (feat/jumps/intent.rs:10)
   ▼
 Vec<Command> .............................. crates/orb-domain/src/command.rs:19
   │  the loop's execute .................... crates/orb-tui/src/run.rs:842
   ├─► pane commands: run right there in the loop
   └─► actor commands: one tell to one actor's mailbox
         │  the actor writes the AppState fields it owns
         ▼
       Reporter sends an Outcome ........... crates/orb-domain/src/common/state.rs:87, :46
         ▼
 LoopEvent channel ......................... crates/orb-tui/src/run.rs:260
   │  apply every pending report
   │  reconcile panes with the layouts
   ▼
 draw one frame
```

## Intents and commands

- **An intent is user input and nothing else.** Keys and clicks become an `Intent`; no actor or timer makes one.
- **The handler is synchronous and stays inside orb.** `IntentHandler` checks the intent, changes `AppState`, and hands back a list of `Command`. It never calls git, zmx or any other service.
- **`handle` is a single match, then four steps every intent shares.** Each arm is one call into that feature's `intent.rs`; only quitting keeps a small function beside the match (intent_handler.rs:210). After the match, `handle` records a focus move as a jump (intent_handler.rs:153), marks an agent pane the keys entered as seen through the sessions feature (:155), reveals the cursor (:156), and puts the cursor on the active row when the keys leave a pane (:157-171).
- **Shared ids sit in one module.** Agent, session, pane and project ids are in crates/orb-domain/src/ids.rs.
- **Real work always leaves as a command.** Starting, settling or searching never happens inside the handler.
- **The loop runs a few commands itself.** Attaching and detaching panes, passing Ctrl-g to the attached pane, and quick reads such as a branch or folder list for a picker or the session picker's preview.
- **Every other command belongs to exactly one actor.** It is a variant of `SessionsCommand` (command.rs:44), `WorktreesCommand` (command.rs:153) or `SearchCommand` (command.rs:162), and the loop sends it straight to that actor with one `tell`. Nothing sits in between.

## Actors

- **orb has three actors.** `SessionsActor`, `WorktreesActor` and `SearchActor`, all kameo actors, are spawned in src/main.rs:175-193. Each one gets a `State` handle on the shared `AppState` and its own `Reporter`.
- **Each actor matches its command enum in one place.** One `impl Message` holds one match over the enum (worktrees_actor.rs:80-94, sessions_actor.rs:487).
- **Messages an actor sends to itself stay separate.** The hourly `Sweep` (worktrees_actor.rs:48), the two halves of the poll (`PollPlan`, `PollSeen`), a finished worktree (`WorktreeReady`), a fresh colony's copied folder (`ColonyFolderReady`), the start-up `KillSettled`, and search's `IndexNext` each have their own handler. So do the control socket's asks to the sessions actor, `ApiAdd` and `ApiStart` (sessions_actor.rs:584, :596).
- **Slow outside calls never block the queue.** The poll is two asks with the harness and zmx listing done between them, a new worktree is made in a blocking task beside the actor, and a fresh colony's folder is copied, and a deleted one's removed, beside it the same way. Commands queued behind any of them keep moving.

## Who writes what

- **Every `AppState` field has at most one writing actor: its owner.** For example the worktrees actor owns the worktree list (worktrees_actor.rs:1).
- **Writing is ordinary work for the owner.** The owner may also save to disk or report while it writes. Never add an actor just so something can write a field.
- **The intent handler is not an actor, so it doesn't count.** It may write any field. A quick write from the handler followed by the owner's authoritative write is fine.
- **Ownership is per field.** The sessions actor owns the layouts even though they sit next to fields other code writes. The warning sign is a second actor writing the same field.
- **Don't split one domain across a worker and a copier.** If one actor does the work and a second exists only to copy its results into `AppState`, give the first actor a `State` and delete the second.

## Reports and the loop

- **State holds the facts; reports hold the news.** Sessions, statuses, layouts and worktrees live in `AppState`. An `Outcome` says what changed or what the screen should do about it.
- **One channel wakes the loop.** Terminal input, a failed terminal read, a quit signal, pane output, clipboard and exit events, actor reports and control-socket pane requests all arrive as a `LoopEvent`. The loop drains whatever is waiting, then reconciles and draws once.
- **Reports are applied in one place** (`apply`, `show`, `open_ready` in crates/orb-tui/src/run/report.rs:113, :74, :138). Applying a report:
  - opens a ready session, as long as the session that was active when it was asked for is still active, even if the cursor has moved since; from the sidebar it opens at once, from a pane it takes the keys into the new pane, behind a picker or text box it waits until that closes;
  - shows an error or notice in the message box, without repeating an error until the next key or success, and without letting a notice hide an error from the same turn;
  - sends a desktop notice for a status change while orb's terminal isn't focused;
  - re-lists an open worktree picker and re-sorts an open projects screen;
  - fills the search picker unless the rows are stale.
- **There is no fixed tick.** Apart from the channel, the loop only wakes for a held pane screen update, a spinner frame, the message box timing out, or the session picker's preview being due.
- **Workers never touch the picker or the message box.** Those belong to the loop.

## Panes

- **The loop owns every pane's attach client.** `reconcile`, `classify_exits` and `reattach_live` (crates/orb-tui/src/run/panes.rs:378, :303, :549) close or reconnect clients and kill pane sessions no layout shows any more.
- **Actors change layouts; the loop makes the panes match.** The one exception: the sessions actor kills a session's panes itself when it settles, deletes or moves that session to another workspace, and when it kills settled sessions at start-up.

## The control socket

- **orb listens on two sockets.** `orb session`, `orb tab`, `orb pane` and `orb agent` are served on orb.sock (crates/orb-domain/src/feat/control/server.rs:1-3); terminal-browser's split socket (control/browser_socket.rs:1-10) passes its splits and focus moves through the same requests.
- **Each request gets its own thread, and it writes no state.** It answers reads from the state, asks the sessions actor for anything it adds or starts (the actor checks and claims the one starting slot), and hands pane changes to the loop as a control event.

## Adding a feature

1. **Add the `Intent` variant** and its which-key label in the `Display` impl (intent.rs:239).
2. **Add a validator if the intent can fail.** A plain function in feat/<feature>/validator.rs that takes `&AppState` and returns its own error enum (crates/orb-domain/src/feat/jumps/validator.rs:7-28).
3. **Add the intent function** in feat/<feature>/intent.rs. It validates, changes state, returns commands, and does nothing when the check fails (jumps/intent.rs:10-20). Then add its one-line arm to `handle` (intent_handler.rs:93).
4. **Bind the key** in the right `Scope` (crates/orb-tui/src/keymap.rs:81). See keybindings.md.
5. **Add a command variant** to the owning actor's enum and an arm to its match. A new struct without its enum variant does nothing.
6. **Draw it, if it shows on screen.** Give the new element its own module in crates/orb-tui/src/ (toast.rs is one), list it in lib.rs and call it from render.rs (render.rs:183).
7. **Write the tests** as testing.md describes: the validator on its own, the intent function for the state it changes and for the commands it returns, the actor for what it writes. Then the module, type and error docs as rust-style.md describes.
