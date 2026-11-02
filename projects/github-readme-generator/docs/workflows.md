# Workflow Builder

Open **Workflows**, choose a helper, configure it, and generate YAML for review. Everything is local; Studio never executes workflows or sends configuration to the providers. Copy YAML has a selectable-text fallback. Download uses a safe `.yml` filename. Place it under the shown `.github/workflows/` path and commit it, or use optional reviewed publishing.

Manual dispatch is always available. Daily and weekly presets use 03:17 UTC; custom schedules accept bounded five-field numeric cron syntax. GitHub schedules run from the default branch and can be delayed; this is not a real-time scheduler. Generated workflows declare Contents read unless their configured output needs Contents write. Publishing the YAML may enable scheduled writes on GitHub, even though Studio itself never publishes in the background.

## Helpers and attribution

- [GitHub Constellation](https://github.com/mnichols08/constellation), `mnichols08/constellation@v3.0.0`: username, SVG output, output branch, optional publishing, and either a repository config JSON path or inline JSON. Publishing writes the output basename on the output branch; keep that branch separate from the checked-out source branch. The generated embed retains upstream attribution.
- [Contribution Snake](https://github.com/Platane/snk), `Platane/snk/svg-only@v3`: light/dark SVG files in `dist/`; optional output publishing uses [peaceiris/actions-gh-pages](https://github.com/peaceiris/actions-gh-pages) `@v4` with `keep_files: true`. Other output files are preserved. Its picture embed points to the selected output branch. The publishing action name does not require enabling a Pages site for raw SVG embeds.
- [Metrics](https://github.com/lowlighter/metrics), `lowlighter/metrics@v3.34`: basic configuration only. Set a secret **name** such as `METRICS_TOKEN`, output filename and publishing choice. Publishing targets the repository default branch, as documented upstream. Configure advanced plugins through [Metrics' configurator](https://metrics.lecoq.io/) and documentation. With publishing off, output stays in the action runner's `/metrics_renders` directory.
- Generic scheduled command/action: supply your own reviewed command or versioned `owner/action@ref`. Studio generates it but never runs it. This is a scaffold, not a guarantee the target repository has its prerequisites.
- Repository asset refresh: explicitly requires your own `scripts/refresh-readme-assets.mjs`. Studio does not install a runtime or regenerate local banner settings in CI. The scaffold does not upload outputs; extend and review it yourself if needed.

Provider inputs and refs were checked against their public action definitions on 2026-09-27. Tags are easier to review but can move; pin reviewed commit SHAs in your repository for stronger supply-chain control. Each generated source review shows upstream project/ref links. No third-party implementation code is copied into Studio.

## Secret handling

Enter names, never credentials. Add actual values on GitHub under repository **Settings → Secrets and variables → Actions**. YAML contains references such as `${{ secrets.METRICS_TOKEN }}`; the automatically provided `${{ secrets.GITHUB_TOKEN }}` needs no pasted token. Plain-field expressions, recognizable GitHub tokens and credential keys in inline configuration are rejected. Generic commands are still user-authored code: inspect them and never paste credentials. Static checks cannot identify every possible secret or validate every upstream setting.

## Publish safely

Workflow publishing additionally requires **Workflows: write** on the GitHub App installation and server `ALLOW_WORKFLOW_WRITES=true`. It is disabled by default so README/asset publishing does not require that extra permission. Choose repository and branch, load the existing workflow, inspect the complete old/new YAML and diff, then confirm. The server regenerates YAML from the validated helper settings and rejects edited/forged source or a mismatched path.

Existing-file SHA changes stop the write. Reload and explicitly review a generated replacement; automatic three-way workflow merging is intentionally unavailable because arbitrary merged YAML would exceed this generator's validation boundary. To preserve complex existing workflow logic, download the scaffold and edit/merge it in your repository. Protected branches and permission failures retain YAML download. See [publishing and authentication](github-publishing.md).

## Validation limits

Central serialization quotes YAML strings/keys to prevent indentation/tag injection. Safe paths disallow traversal and hidden output files. Basic health checks cover cron, explicit permissions, empty action refs, literal secret inputs, known duplicate names and unsafe outputs. They are not full GitHub Actions validation. No real provider workflow execution is performed by Studio tests; test your reviewed workflow in your own repository before relying on scheduled output.
