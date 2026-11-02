# Publishing a Constellation

In the Studio, press **Get it**. It offers five destinations:

- **Add it to your GitHub profile** installs a daily workflow that publishes a static SVG for your profile README (or any README).
- **Download an image** saves an SVG or PNG once. Commit or upload it yourself.
- **Put it on a website** downloads a standalone interactive HTML page, an SVG with ready-made image code, or a portfolio package. Upload it to your host yourself.
- **Share a link** copies a link to this design.
- **Save the settings file** downloads the design as JSON for backup, the CLI, or the Action.

None of these talks to GitHub from the Studio. See the [Studio guide](studio.md#get-it) for each screen.

## GitHub README setup

**Add it to your GitHub profile** shows three steps:

1. **Add this file to your profile repository.** The **Repository** field suggests `you/you` for a person or `org/.github` for an organization; any `owner/name` works. **Create the file on GitHub** opens GitHub's new-file page with `.github/workflows/constellation.yml` filled in. If the repository doesn't exist yet, use the **Create it on GitHub** link under the field first. Very large designs can't be filled in through a link; the dialog says so, and you copy the file with **Copy the file** and add it on GitHub yourself. **Show the file** lets you review it.
2. **Run it once.** **Open the Actions page**, choose **Daily constellation**, then **Run workflow**.
3. **Paste this into your README.** Copy the Markdown image snippet into the README.

Nothing is published until the workflow runs. The workflow has `contents: write` so it can update its output branch; it uses the repository's automatic `GITHUB_TOKEN`, with no personal access token. The Studio does not check whether the workflow was installed or ran: look at the repository's Actions run for the verified result.

The workflow checks out the repository, loads the embedded normalized configuration, fetches the evidence needed by that configuration, generates a temporary SVG, validates it, then updates the output branch. Concurrent runs are serialized per repository. Existing files on the output branch are preserved. The publisher never force-pushes.

When the validated SVG bytes match the existing artifact, the run skips the publication commit and reports **unchanged**. It does not strip dates or metadata to manufacture no-op results: any resulting byte change is published. A failed fetch, generation, validation, filesystem operation, or push stops before replacing the current output. The workflow summary reports failure; the previous output branch artifact remains available.

### Profile Story inputs

Workflows you write yourself can pass the Action's optional `story` and `target-width` inputs to publish a bounded compact (480px) or wide (900px) Profile Story instead of the current view. The CLI uses the same candidate and SVG pipeline. Auto refreshes reconsider current evidence; explicit stories remain explicit and fail safely if evidence no longer supports them. The Studio's generated workflow publishes the current view. See [Profile Story output](profile-story.md).

## Website and portfolio

**Put it on a website** → **Download interactive page** saves one HTML file with the map built in. It includes the accessible interactive runtime, a content security policy, keyboard support and reduced-motion behaviour, and works offline. HTML is not executable inside GitHub README rendering.

**Download SVG** under **Just want the picture?** saves a script-free image, with an `<img>` snippet to paste next to it. **Download portfolio package** saves a single JSON container holding the page, the image and the data behind the map (see [Portfolio artifact](portfolio-artifact.md)); unpack the files before static hosting.

Upload the file yourself. The Studio cannot see your host, so open the page once it is uploaded to check it works, and upload it again after you change your design.

## Publication records

On the output branch, `.constellation/publication-manifest.json` is an internal sidecar (it is not part of Scene v1). Version 1 records source repository and commit when available, selected account, configuration and evidence digests when available, UTC reference date, artifact format/name/SHA-256/size, destination, revision, generation result, and bounded diagnostics. It contains no credentials or source contents. Missing evidence identity remains unknown; it is never interpreted as proof that the source is unchanged.

Publication comparison uses the actual artifact digest. An unchanged artifact creates no commit even if the workflow source commit or run date changed. Volatile fields are not removed from output; if they change the artifact bytes, the artifact is published. If the artifact is unchanged but its sidecar is missing, corrupt, or does not describe those bytes, the publisher repairs the sidecar without rewriting the artifact; the next identical run is a no-op. A malformed new artifact is rejected before the output branch is touched.

## Limits

The automatic GitHub publisher currently publishes SVG only. Standalone HTML and Web Component examples are available for manual static hosting; the Studio does not create a hosting account, upload files to a third-party host, or claim deployment status. Publication artifact size is capped at 12 MiB and manifest size at 16 KiB.

## Measurements

Run `node scripts/benchmark-publication.mjs` for manifest validation/comparison latency and local-Git publication timing, and `node scripts/benchmark-html.mjs` for HTML bundle measurements. On the Windows development host (Node 22.12), 20,000 manifest validations averaged 0.0037 ms each and 20,000 comparisons averaged 0.0064 ms. The publication benchmark's Git child process was blocked by this host's process policy; the local Git fixture suite completed the multi-refresh case in about 4.2 seconds and its concurrent first-publish case in about 1.8 seconds, including fixture Git setup and assertions.

The current raw WASM is 670,680 bytes, unchanged from v4.4. The Core package directory is 1,973,168 bytes versus the recorded v4.4 baseline of 1,966,297 bytes (+6,871 bytes, 0.35%), within its 2 MiB budget. The Web Component entry remains 24,572 bytes. The HTML benchmark measured a 1,040,342-byte embedded runtime (8,234 bytes below its 1 MiB budget) and 1,196,237 bytes for the 45-node document. Render time was 21.5 ms on this run. Gzip measurements are not compared because the recorded v4.4 value used a different host/toolchain. These measurements predate the v5.0.0 Studio rebuild, which changed no engine, package or export code. The Playwright suite checks that **Get it** makes no GitHub requests.
