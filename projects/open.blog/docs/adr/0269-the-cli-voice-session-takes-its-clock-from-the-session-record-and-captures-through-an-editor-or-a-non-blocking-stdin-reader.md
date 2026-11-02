# ADR 0269: The CLI voice session takes its clock from the session record and captures through an editor or a non-blocking stdin reader

- Status: Accepted
- Date: 2026-10-28
- Parent epic: [#407](https://github.com/journey-to-code-org/open.blog/issues/407)
- Tasks: #438, #439, #440, #441, #442
- Builds on: ADR 0266, ADR 0267, ADR 0268

## Context

Many authors only ever use the terminal, and `openblog init` is the one moment they are sure to be there.
The session has to be quick, low pressure and honest about the clock, and it has to leave the rough draft
exactly as typed. The rules already live in the store and the session record (ADR 0266, ADR 0267); the CLI
must add no way around them.

## Decision

- **The CLI is a thin layer.** `openblog voice` calls `voice_session` (start, save draft, lock, resume,
  scrap), `voice_store` and the core types. It writes no sample file itself, so every rule in ADR 0266 and
  ADR 0267 applies unchanged.
- **The clock is the record's deadline.** The deadline is fixed when the session starts and is read back from
  the record on every resume; the CLI never restarts it. Text that arrives after the deadline is discarded
  and the author is told the deadline. Resuming after the deadline locks the last saved text at once; a
  session that expired with nothing saved is discarded.
- **Two capture modes, chosen by the environment.** With `$VISUAL` (then `$EDITOR`) set, the CLI writes a
  temporary file under `.openblog/private/voice/` (so it stays out of Git) holding a commented header and a
  marker line, opens the editor, and takes the text below the marker; the header and marker are never
  saved. Otherwise, or with `--stdin`, it prints the prompt and reads lines until a line holding only `.`,
  the end of input, or the deadline. Standard input is read on a helper thread, so a silent terminal cannot
  hold the session past the deadline. The editor is polled, never waited for: at the deadline the file is
  read as it stands and the editor is stopped, and anything it writes later is not read.
- **Every change is saved as it happens.** Each new line, and each change to the editor file, is written to
  the session record while time remains, so a crash or a closed terminal costs nothing and
  `openblog voice --resume` carries on with the original deadline.
- **Nothing is cleaned.** Line endings become LF (as the session already does) and the one final newline an
  editor adds is dropped (the format adds it back). No trimming, spell-check or reflowing.
- **Private by default.** A sample is private unless `--portable`. The window is 180 seconds unless
  `--seconds` (30 to 3600, as the session enforces).
- **Polish is a copy.** `voice polish` copies the body (of the rough draft, or of the existing polished draft
  on a second run) into a private working file, opens the editor on it, and saves through
  `write_polished` with the revision it read, so a changed file is a stale error and not an overwrite. It
  compares the rough file's revision before and after and refuses to save if it moved. The CLI offers no
  command that takes a rough draft as the thing to edit. An empty result, or text equal to what the editor
  opened, saves nothing. `voice diff` prints a unified diff of the two bodies.
- **The invitation after `init` is for a person at a terminal.** It is offered once, only when both standard
  input and output are terminals, something was created, and `--no-voice` was not given. Anything but `y`
  continues silently and nothing about the answer is recorded, so scripts and pipes see exactly the output
  they saw before and cannot hang.
- **Plain text.** No colour is used, so `NO_COLOR` needs no special case.
- **Durable workspace mode** refuses `voice` like the other CLI commands that write.

## Considered options

- **A raw-terminal editor in the CLI.** Rejected: a new dependency and a second editor to get right, when
  every author already has an editor and plain stdin works anywhere.
- **Waiting for the editor and checking the time afterwards.** Rejected: an editor left open would hold the
  session open indefinitely and make the deadline advisory.
- **A sentinel that ends stdin capture other than a dot.** Rejected: `.` is what mail and `ed` taught people,
  and end of input also works.

## What would trigger revisiting this

- Authors wanting to resume in a different capture mode mid-session (supported today by text, not by
  position).
- A need to run sessions where `sh` or `cmd` cannot start an editor.

## Consequences

- The CLI and Admin write the same files through the same code and cannot disagree about the clock.
- Tests use a fake editor script and a piped stdin, and set the deadline by writing the session record.

## Notes

- 2026-10-28 (pre-release audit): an empty capture never throws a session away while the record holds saved
  text; the editor file is read through the transient-hold retry, and a file that cannot be read keeps the last
  text seen. An editor that returns within three seconds with the file untouched (`code` without `--wait`) is
  an error that leaves the session open. The editor file name carries the process id, so a second window
  refuses to drive a session another running window is writing, and leftover files are removed only when
  their process is gone (the same for `polish`). Piped input with no prompt id that ends without a pick is an
  error, not "Nothing started".
