# GitHub community files

**Status:** current as of v1.6.0.

## What Kin provides

At `projects/kin/`: the [README](../README.md), the MIT [LICENSE](../LICENSE),
[CONTRIBUTING](../CONTRIBUTING.md), a [Code of Conduct](../CODE_OF_CONDUCT.md)
(Contributor Covenant 2.1 with Kin's privacy expectations added),
[SECURITY](../SECURITY.md), [SUPPORT](../SUPPORT.md) and the
[CHANGELOG](../CHANGELOG.md). Under `projects/kin/.github/`: issue forms for a
bug report, a feature proposal and self-hosting help, a `config.yml` with
contact links, and a pull request template.

Together these are what GitHub's *Community Standards* profile looks for in a
repository, plus a changelog.

## The monorepo limitation

GitHub reads community files and issue templates from a repository's root,
its `.github/` folder or `docs/`, not from a project subfolder. Kin's
[repository boundary](../AGENTS.md#the-repository-boundary-hard-rule) forbids
placing Kin-specific files at the root of the ZTM Build Fest repository, so:

- Kin's issue forms and PR template are **not** offered automatically when
  someone opens an issue or PR on the hosting repository. [SUPPORT](../SUPPORT.md)
  and [CONTRIBUTING](../CONTRIBUTING.md) ask people to pick the form by hand
  or copy its headings.
- The hosting repository's Community Standards profile does not count Kin's
  files.
- GitHub's private vulnerability reporting, if enabled, belongs to the hosting
  repository; Kin's security policy points there.

Do not work around this by editing root files or other participants'
projects.

## If Kin moves to its own repository

Copy or move these to the new repository's root and verify that GitHub
recognises each one:

1. `README.md`, `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
   `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`.
2. `.github/ISSUE_TEMPLATE/*.yml`, `.github/ISSUE_TEMPLATE/config.yml` and
   `.github/pull_request_template.md`, replacing the absolute links in them
   with relative ones.
3. `docs/ci/kin-verification.workflow.yml` as `.github/workflows/`, with its
   `working-directory` and path filters simplified; then remove the
   monorepo-boundary wording from `AGENTS.md` and `CONTRIBUTING.md`.
4. Enable private vulnerability reporting and update `SECURITY.md` to point
   at it.
