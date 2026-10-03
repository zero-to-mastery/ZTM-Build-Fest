# GitHub Community Files

**Status:** Current through v0.7.4 Routine Stale-Action Correctness; community documentation for Kin as a project nested in the ZTM Build Fest monorepo.

## Project files

Kin provides a project README, MIT `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and `SUPPORT.md`. Reusable issue forms and a pull-request template are stored under `projects/kin/.github/` for Kin-specific use if the project is later extracted.

## Monorepo limitation

GitHub's repository-level Community Standards profile and issue/PR template discovery are based on files at the repository root, not an individual `projects/kin/` subdirectory. Kin's repository-boundary rule forbids placing project-specific files at that root. Therefore the nested templates are not automatically applied by the current ZTM Build Fest hosting repository, and the Kin files may not make the parent repository's Community Standards profile appear complete.

Do not work around this by modifying root files or another participant's project. If Kin is extracted into its own repository, move/copy the project community documents and `.github` templates to that repository's root and verify GitHub recognizes them. Until then, contributors should follow the guidance in the Kin files manually and use host-repository support channels where available.
