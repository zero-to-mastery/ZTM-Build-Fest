# Releasing GitHub Constellation

The root `action.yml` is the Marketplace entry point. No npm publication is required; the action runs the checked-in JavaScript and Rust WebAssembly assets. After changing Rust, run `npm run test:rust` and `npm run build:rust`, and include both generated `src/wasm` files in the release. Consumers do not need a Rust installation.

1. Run `npm test`, push the reviewed changes, and wait for the Test workflow to pass, including its live GitHub API smoke test.
2. Update `package.json` and release notes for the version being released. Create a version tag such as `v1.0.1` at the tested commit and push that tag.
3. Create a GitHub release for that version. In GitHub's release editor, select **Publish this Action to the GitHub Marketplace**, choose the most suitable available category, and publish. The owner must accept the Marketplace Developer Agreement and have two-factor authentication enabled. GitHub validates the action name's availability in this form.
4. Point the `v1` tag to the tested release commit for compatible version 1 updates. Inspect the existing remote tag first; use an explicit force-with-lease when updating it. Do not move version tags such as `v1.0.0`. Do not attach a release to the moving `v1` tag.
5. Check that `mnichols08/constellation@v1` resolves to the intended commit and run a profile workflow. Verify its published SVG and job summary.

For breaking changes, create a new major tag and update the studio and README examples deliberately. Users on `v1` must continue receiving compatible behavior.

For 2.0.0, keep `v1` on the tested v1.9.3 commit and create `v2` at the tested v2.0.0 commit. Rebuild `packages/core` with `npm run build:core` after Rust/JS changes, and verify isolated package tests. Include the v6 migration guide and stable extension API policy in the release notes. The root Action description is the Marketplace listing metadata; Marketplace publication still requires the release-editor opt-in described above.

Creating a release through the CLI does not by itself opt it into Marketplace. Complete the Marketplace checkbox in GitHub's web release editor and verify the listing before advertising a Marketplace badge.

Reference: [GitHub's publishing instructions](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).
