# Release process

Each version is an independently tested, documented commit. Use a separate `release/<version>-<topic>` branch and pull request where practical. Stacked branches must name their preceding release as base until it is merged. Preserve version boundaries in history.

## Prepare

1. Verify the actual baseline, cleanly identify user-owned/unrelated changes and read the release scope. Never substitute a version number for missing implementation.
2. Complete the version's work and source-preservation/recovery tests. Update README, relevant guides and a separate changelog section.
3. Set package and lockfile versions together with `npm version <version> --no-git-tag-version`. App version and public file schema versions are independent.
4. Run unit, browser, Rust and WASM checks appropriate to the release. A stable release requires all three browser engines, security/migration cases and large-document smoke tests. Record manual keyboard/screen-reader and live GitHub verification separately; mocks do not prove production configuration.
5. Build production assets and run root/subpath static smoke tests. Inspect JavaScript/chunks, CSS, fonts and WASM sizes. Record dependency audit results and any accepted limitations.
6. Review changes, commit the release checkpoint and push its branch. Open a pull request with exact validation evidence. Keep unrelated files out of the commit. Require green CI for the actual commit being released.

## Publish only after acceptance

Confirm that no known critical data-loss, security, migration, export or publishing issue remains. Confirm the production host and deployment configuration. For the first stable release, complete the [1.0 readiness gates](releases/1.0-readiness.md); the audit is not itself acceptance.

Merge only within the maintainer's authorization. Create the version tag on the accepted commit, prepare the GitHub Release from reviewed notes and deploy that same commit using the configured host. Never move an existing release tag silently. Verify the live About/version display, core authoring/export, root/subpath assets and optional publishing configuration. Keep credentials out of build-time frontend variables.

If deployment fails, preserve the accepted source/tag and report the failed step. Use the host's previous known-good deployment for rollback when authorized. Do not claim the live release succeeded based only on a local build.

## Evidence to retain

Record version, commit, schema versions, runtime/toolchain versions, test commands/results, bundle measurements, dependency audit date, deployment URL and manual verification date. Documentation screenshots must use synthetic data. List unsupported behavior and remaining operator setup in release notes.
