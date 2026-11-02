# Drift checks

Version 1.6.1 adds **drift checks** on top of [evidence snapshots](evidence-snapshots.md). A drift check compares the commands, paths, links and config keys written in your Markdown with what the document's GitHub repository contains now, and says which statements look outdated. It never runs anything from the repository, never changes your Markdown and never writes to GitHub. Results are not saved.

## Run a check

1. Give the document a repository, branch and README path in **Documents** (see [Workspace documents](workspace-documents.md)).
2. Open **GitHub → Drift check** (focus lands on the button), or **Evidence snapshots** in the GitHub group or the Documents dialog.
3. Choose **Run drift check**. **Cancel** stops it; nothing is saved either way.

The check reads one branch-head commit and one repository tree, then at most:

- the root `package.json`, when your Markdown uses npm, pnpm, yarn or bun, or mentions a Node version;
- one root `.env` example (`.env.example`, `.env.sample`, `.env.template`, `.env.dist` or `example.env`), when your Markdown sets environment variables;
- up to 10 linked Markdown files that your links point into with an `#anchor`.

Files are read by their Git blob revision from that tree, so every read describes the same commit. Each is limited to 256 KB of UTF-8 text; symbolic links, submodules, larger and binary files are not read. Requests use the same public, credential-free GitHub client as capture, with its timeout, one retry and shared rate-limit pause. A rate limit stops further reads. File content is parsed as data, used for the comparison and discarded: only script names, `.env` keys, `engines.node`, `packageManager` and heading anchors are looked at, and script bodies are never kept or shown. See [ADR 0002](adr/0002-drift-checks-read-content-but-persist-nothing.md).

A document whose only claims are anchors within itself is checked without contacting GitHub, so that also works offline.

## What is checked

Claims come from your local Markdown, not from the README currently on GitHub. Code examples in non-shell fences, indented code, HTML comments and command output in `console` sessions are ignored.

| Claim                         | Where it comes from                                                                                                                                       | Evidence                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Package scripts               | `npm run`, `npm test`, `npm start`, `pnpm run`, `yarn <name>`, `bun run` and similar, in shell fences or inline code                                      | script names in the root `package.json`                                        |
| Lockfiles and package manager | `npm ci`, `npm install`, `yarn`, `pnpm install`, `bun install`                                                                                            | lockfiles in the tree, `packageManager`                                        |
| Command files                 | `node`, `python`, `bash`, `sh`, `deno run`, `./script`, `cp`/`chmod` sources, `pip install -r`, `make` (Makefile), `cargo` (Cargo.toml), `docker compose` | the tree                                                                       |
| Paths                         | inline code such as `src/config/app.js`                                                                                                                   | the tree                                                                       |
| Links                         | relative links and images; `github.com` blob/tree/raw and `raw.githubusercontent.com` links to the document's own repository and branch                   | the tree                                                                       |
| Anchors                       | `#section` links into this document or into linked Markdown files                                                                                         | headings (Markdown and raw HTML `<h1>`–`<h6>`) and HTML `id`/`name` attributes |
| Config keys                   | `Node 18+`, `requires Node.js 20`, `node >= 18` in prose; `KEY=value` lines in `env` fences and `export KEY=`                                             | `engines.node`; the `.env` example's keys                                      |

Shell blocks are read line by line: prompts (`$`, `>`, `PS>`) and comments are removed, continuations are joined (`\`, or a backtick in PowerShell and `^` in cmd fences), and `&&`, `||`, `;` and `|` split commands. Untagged fences are read as shell, but a line such as `python = "^3.9"` (a setting) is not a command, and in them an interpreter's file must look like one (`python app.py`, not `source code lives in src/`); `source` and `.` always need a file name with `.` or `/`. Heredoc and PowerShell here-string bodies are skipped, `pushd`/`popd` change and restore the directory, and `cd` inside `( … )` ends with the subshell. In `console` sessions a bare `>` line is output (npm echoes its scripts that way), not a prompt. `git clone … && cd <repo>` for this repository (or a fork with the same name) stays at the repository root; `cd <repo>` without a clone in the block may be the clone or a folder of that name, so when the tree has that folder both are checked and a file missing from both is uncertain; `cd` into a clone of another repository makes the directory unknown; `cd` into a folder in the tree continues there. Files created earlier (`cp`, `mv`, `touch`, `mkdir`, `>` redirects), in the same block or an earlier one, are not reported. Interpreter options and their values (`node -r dotenv/config`, `node --import tsx`, `python -X dev`, `php -S localhost:8000`, `tsx watch`) are not read as files, and `node server` matches `server.js`, `server.ts` or a `server/` folder as Node.js would. Version and help commands (`cargo --version`, `make -v`, `docker compose version`, `yarn --version`) need no project file. Placeholders such as `path/to/file`, `<file>`, `$VAR`, globs, specifiers such as `npm:vite`, absolute and home paths, `npx`, global installs and package arguments (`npm install left-pad`) are ignored. An absolute `github.com` link to this document itself is checked against your local headings, like a `#section` link.

## Read the result

Results are grouped by status, each with the claim, its line in your Markdown and the evidence:

- **Observed mismatch** — the repository directly contradicts the claim: `npm run lint` with no `lint` script, `npm ci` with no `package-lock.json` or `npm-shrinkwrap.json`, a linked or commanded file that is not in a complete tree, or an anchor that no heading produces. A case-only difference (`docs/guide.md` vs `docs/Guide.md`) is a mismatch because GitHub paths are case-sensitive; the result names the existing path.
- **Uncertain finding** — a heuristic suggests drift, but the claim may be fine. Examples: a command only mentioned inline; `yarn <name>`, `pnpm <name>` and `bun run <name>`, which can also run a binary or file; `npm start` (npm has a default); `--if-present`; a missing `dist`, `build`, `node_modules` or similar folder, or a file under one, or a `.env` file (not a committed template such as `.env.example`), which builds and local setup usually create; a missing file when the working directory is ambiguous (a README in a subfolder, or an earlier block that changed directory); a missing file that an earlier command, in the same or an earlier block, mentions and may create (`python -m venv env`, `gcc -o hello`, a downloaded `install.sh`); a missing `./program` after a build, unpack, download or package-manager step or another `./script` (`./autogen.sh` then `./configure`, `make` then `./widget`, `unzip` then `./widget`); a missing `Makefile` for `make` after a step that generates one (`./configure`, `cmake .`); a missing file after an interpreter option whose value is not known; a `github.com` link whose path could instead be part of a longer branch name (`blob/release/1.0/…` when the document's branch is `release`); `npm install` with no `package.json` or lockfile; another manager's lockfile or a different `packageManager`; an anchor that only differs from a heading in punctuation; a Node version in prose older than `engines.node` (compared as far as it is written: `Node 20` matches `>=20.11`, `Node 20.5` does not); a variable missing from the `.env` example.
- **Unknown — not checked** — the evidence could not be read or does not cover the claim: the tree failed or GitHub truncated it, a file could not be read or parsed, or a command runs in a workspace package (`-w`, `--filter`, `--prefix`, `yarn workspace`) or after `cd` into a folder that is not in the tree or into another repository's clone, or a path inside a Git submodule (the tree does not list a submodule's files). Unknown is never drift.
- **Matches** — collapsed by default.

If the document has a pinned [Baseline](evidence-snapshots.md#baseline-and-change-check) for the same target, results whose evidence file the Baseline recorded also say whether that file changed, was added or was removed since then. A missing `lint` script whose `package.json` "Changed since Baseline" usually means the script was renamed or removed after your README was written.

Notes list what was bounded or skipped: claims beyond the first 200, links above the repository root or undecodable, links to this repository on another branch or commit, linked Markdown files beyond the first 10, and environment variables with no `.env` example to compare against.

A drift check itself never edits your Markdown. To fix findings, edit the Markdown as usual or choose **Review fixes** under the result: see [Reviewed drift fixes](drift-remediation.md), which turns observed mismatches and uncertain findings into line-by-line proposals that apply only after you approve each one.

## Offline, failure and accessibility

Offline, rate-limited, not-found and cancelled checks report a status message and change nothing. If the head is read but the tree is not, the result is still shown with every repository claim unknown. If the document, its Markdown or its target changes while GitHub is being read, the result is discarded. Starting a check hides the previous result, so a failed, cancelled or discarded check never leaves an earlier result on screen.

All controls are native buttons. Progress and outcomes use the dialog's polite live region; when a result is shown, focus moves to its **Drift check** heading, and after a failure focus returns to **Run drift check**. Tables scroll horizontally inside the dialog at 320px. Automated checks cover keyboard operation; they do not replace manual screen-reader review.

## Limits

- Public repositories only, as for snapshots.
- Only the root `package.json` is read. Workspace members, `.nvmrc`/`.node-version`, Makefile targets, Cargo features and other configuration files are not inspected.
- Commands are interpreted with simple shell rules, not a full shell parser. Heredoc bodies are skipped, subshells only scope `cd`, and aliases, functions and variables are not followed. `node --run <name>` is checked as a `package.json` script. Shell setup variables such as `PATH`, `JAVA_HOME` or `NODE_OPTIONS` are not compared with the `.env` example.
- GitHub footnotes (`[^1]: …`) are not links. Links to the repository root (`./`, `./#install`) open the repository page, so only their anchor is checked, and only when the document is the root README.
- Heading anchors follow GitHub's slug rules approximately; near matches are reported as uncertain rather than as mismatches.
- External link reachability is not part of a drift check; use **README Health → Check links**.
- Results describe the repository at the commit read. They are not saved and are not included in backups, projects or exports.
