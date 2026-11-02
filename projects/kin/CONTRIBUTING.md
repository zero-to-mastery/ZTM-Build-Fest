# Contributing to Kin

Thank you for considering a contribution. Kin is a small, opinionated project:
a private household app built from Rust, WebAssembly, Web Components and the
browser, with no frameworks. This page explains how to get set up, what a
good change looks like, and how a pull request is checked. Everyone taking
part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** with the [bug report form](.github/ISSUE_TEMPLATE/bug_report.yml),
  or from inside Kin (the Help button on any screen, then Report a problem).
- **Propose a change** with the [feature proposal form](.github/ISSUE_TEMPLATE/feature_request.yml).
  Describe the household problem first, not the feature.
- **Ask about self-hosting** with the [self-hosting form](.github/ISSUE_TEMPLATE/self_hosting.yml),
  after reading [SELF-HOSTING](docs/SELF-HOSTING.md).
- **Improve the docs.** Clearer words and fixed links are always welcome.
- **Fix or build something.** Small, focused pull requests are easiest to
  review. For anything larger than a fix, open an issue first so we can agree
  on scope before you spend time on it.

Security problems go through the [security policy](SECURITY.md), never a
public issue.

## Where things live

Kin is nested in the ZTM Build Fest monorepo at `projects/kin/`. Everything
about Kin lives there, and a pull request must change nothing outside it (the
root `kin-verification.yml` workflow is the one authorized exception, kept in
step with `docs/ci/`). Because of that nesting, GitHub does not apply Kin's
issue templates automatically; please pick the right form by hand, or copy
its headings into a plain issue.

Branches:

- `kin-development` is the integration branch. Pull requests target it.
- `kin-testing` is what the test server deploys; maintainers promote
  `kin-development` into it when CI is green.
- Releases are annotated tags `kin-vX.Y.Z` cut by the maintainer
  ([RELEASES](docs/RELEASES.md)).

## Set up

1. Install Node.js 24.16.0 or later and `rustup`. The Rust toolchain
   (1.93.0) and the `wasm32-unknown-unknown` target are installed on first
   use from `rust-toolchain.toml`.
2. Fork and clone the repository, then:

   ```sh
   cd projects/kin
   npm ci
   rustup target add wasm32-unknown-unknown
   sh run.sh          # ./run.ps1 on Windows
   ```

3. Open <http://localhost:8000> once the log says `service_ready`.

[DEVELOPMENT](docs/DEVELOPMENT.md) has the rest: `npm run dev` for a
restarting service, the service sandbox, lock files, icons, and how the
offline shell updates while you edit.

Use synthetic household text only, in fixtures, screenshots, bug reports and
logs. Never copy real family messages, health details, credentials or keys
anywhere in the repository.

## Making a change

**Keep the scope tight.** One problem per pull request. If you notice
something else, open an issue or a second PR.

**Follow the architecture.** Rust owns household events, validation and
derived state; JavaScript owns the DOM, components, storage, crypto and
networking. Rust never touches the DOM, and JavaScript never re-implements the
Rust reducer. Read [ARCHITECTURE](docs/ARCHITECTURE.md) and the
[decision records](docs/decisions/) before changing how something works, and
add a new ADR for a decision that would be hard to reverse. [CODE-STYLE](docs/CODE-STYLE.md)
has the conventions for Rust, JavaScript and CSS.

**Don't add dependencies.** The web runtime has no npm dependencies and the
engine has no crates. A new dependency needs a specific requirement, a
meaningful benefit, an update and security plan, and an explanation of why a
platform-native option is not enough, written in the PR.

**Keep the frozen formats.** Every v1.x release must keep reading the
storage, sync, export and server formats in
[V1.0-COMPATIBILITY](docs/V1.0-COMPATIBILITY.md). Add a format; never replace
one. A CI test fails if a frozen version changes without that document.

**Privacy and security are not optional.** No household-content analytics,
telemetry, tracking or plaintext sync. Treat household text and imported data
as untrusted: render it as text, never as HTML. Changes to WebAuthn, Web
Crypto, sync, device authorization, key handling, migration or HTML
rendering get extra review; say so in the PR. Never claim encryption,
anonymity or deletion beyond what the code does.

**Accessibility is a baseline.** Semantic HTML, native controls, labels,
keyboard operation, visible focus, 48 px targets, 320 px reflow, reduced
motion, contrast, and nothing that relies on colour alone
([ACCESSIBILITY](docs/ACCESSIBILITY.md)). The browser gate checks most of
this; keep it passing.

**Would a tired parent holding a child use it?** That is the product test.
Kin does not blame, score, rank, compare or watch anyone, and it is not a
project-management tool ([PRINCIPLES](docs/PRINCIPLES.md)).

**Update the docs and the changelog.** Change the contract a feature
touches, keep the README's description of what exists accurate, and add a
line under *Unreleased* in [CHANGELOG](CHANGELOG.md).

## Tests and checks

```sh
npm run verify            # static checks, every Node and Rust test, the WASM build (a few minutes)
npm run verify:browser    # plus the browser suites in an installed Edge, Chrome or Chromium
npm run test:server       # just the Node service tests
cargo test                # just the Rust engine tests
```

Every meaningful Rust behaviour has a test. Browser behaviour has a browser
suite under `scripts/`, written against the real engine and store without a
JavaScript test framework. [TESTING](docs/TESTING.md) explains how to run a
single suite, the flaky-suite policy, and how to read a failure. CI runs the
same gate as the "Kin verification" workflow; a PR needs it green.

Please do not claim checks you did not run. If you could not run the browser
suites (no Chromium-family browser, for example), say so in the PR.

## Commits and pull requests

- Write commit messages that say what changed and why, in the imperative
  ("Kitchen display: let go of the adult check as its dialog closes"). Mention
  the issue number where there is one.
- Fill in the [pull request template](.github/pull_request_template.md): what
  changed, how you validated it, and the checklist.
- Keep the PR to `projects/kin/`. Reviewers will ask you to revert anything
  else.
- Expect review comments about scope, privacy, accessibility and docs; they
  are the things this project cares about most.

By contributing you agree that your contribution is licensed under the
project's [MIT License](LICENSE).

## Questions

[SUPPORT](SUPPORT.md) lists where to ask. Kin is a volunteer project with no
response-time promise, but questions and good proposals are read.
