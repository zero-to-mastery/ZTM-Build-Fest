# Documentation

New here? Read the [Studio guide](studio.md). Then open the guide for the task you have. Most pages are reference guides; you do not need to read them in order.

## Use Constellation

| I want to… | Read |
| --- | --- |
| Make a map and change how it looks | [Studio guide](studio.md) |
| Publish a graphic in my profile README | [Daily profile graphic](#publish-a-profile-graphic) · [Publishing](publishing.md) |
| Save a design or return to a saved one | [Save and saved designs](studio.md#save-and-saved-designs) |
| Know what stays in my browser and what goes to GitHub | [Privacy](studio.md#privacy-what-stays-where) |
| Understand what a README map communicates | [README Showcase](readme-showcase.md) |
| Understand what rings, size and colour mean | [Reading a constellation](semantic-studio.md) |
| Explore an organization | [Organization maps](organizations.md) |
| Explore projects over time or by language/topic | [Universe dimensions](temporal-stack.md) |
| Explain a project's evidence, position, or appearance | [Evidence and provenance](evidence-provenance.md) |
| Compress a project map into explainable groups | [Semantic Groups](semantic-groups.md) |
| See commit history or recent activity | [History and activity](history.md) |
| Find every setting, settings files, or share links | [Designs and configuration](designs.md) |
| Make the map accessible | [Accessibility](accessibility.md) |

### Publish a profile graphic

1. Open the [Studio](https://mnichols08.github.io/constellation/), type your GitHub username and press **Show my sky**.
2. Make it yours with the **Look**, **Layout**, **Projects** and **Details** tabs.
3. Press **Get it** → **Add it to your GitHub profile**. Check the **Repository** (usually `YOUR_USERNAME/YOUR_USERNAME`), press **Create the file on GitHub**, and commit the workflow at `.github/workflows/constellation.yml` on the default branch. It needs `contents: write` permission to publish the image to the `output` branch.
4. Press **Open the Actions page**, run **Daily constellation** once, then paste the README snippet shown in the same dialog into your README.

GitHub provides the workflow token automatically. To refresh the image manually, run the workflow again. For a one-time image, use **Get it** → **Download an image** and commit the SVG yourself. See [GitHub OAuth](github-oauth.md) only if you operate a hosted Studio and need to configure sign-in.

## Build or embed

| I want to… | Read |
| --- | --- |
| Embed a custom element in a web page | [Web component](web-component.md) |
| Export an interactive, offline HTML file | [Interactive HTML](interactive-html.md) |
| Render or validate data from JavaScript/Node | [Core API](core-api.md) |
| Load JSON sources or transform data | [Data pipeline](data-pipeline.md) |
| Add a theme, layout, or extension | [Extension authoring](extension-authoring.md) |
| Understand scene structure and rendering | [Scene API](scene-api.md) · [Renderer API](renderer-api.md) · [Layout API](layout-api.md) |

## Understand the project

| Topic | Read |
| --- | --- |
| System overview and ownership boundaries | [Architecture](architecture.md) · [Rust/WASM boundary](architecture/RUST-WASM-BOUNDARY.md) |
| Why the Studio is built the way it is | [ADR-0008: Studio rebuild](architecture/decisions/ADR-0008-STUDIO-REBUILD.md) |
| Evidence, security, and privacy | [Evidence and provenance](evidence-provenance.md) · [Security model](security-model.md) · [Security and trust](engineering/SECURITY-AND-TRUST.md) |
| Recruiter evidence derivation and ordering | [Recruiter Evidence v1](recruiter-evidence.md) |
| Tests and quality checks | [Testing and quality](engineering/TESTING-AND-QUALITY.md) · [Studio budgets and usability procedure](guided-experience-evaluation.md) |
| Performance limits | [Performance budgets](engineering/PERFORMANCE-BUDGETS.md) |
| AI-assisted interpretation | [AI specification](ai/AI-CONSTELLATION-SPEC.md) · [Implementation playbook](ai/AI-IMPLEMENTATION-PLAYBOOK.md) |
| Planned work | [Roadmap](ROADMAP.md) |

## More guides

[Timeline](timeline.md) · [Hierarchical scenes](hierarchical-scenes.md) · [Story mode](story-mode.md) · [Reading a constellation](semantic-studio.md) · [Layers](layers.md) · [Plugins](plugins.md) · [Scaling](scaling.md) · [GitHub data cache](github-data-cache.md) · [Migration from v2](migration-v2.md) · [Design examples](readme-showcase.md)

## GitHub data and privacy

Public exploration makes two requests from your browser to GitHub per account and works without sign-in. Signing in enables additional authenticated data. A local `GH_TOKEN` is used only by the local development server or CLI; do not put tokens in configs, share links, or exported graphics. Changing a loaded design makes no GitHub requests. The [Studio guide](studio.md#privacy-what-stays-where) lists what stays in your browser and what goes to GitHub. Details and limits are described in the [security model](security-model.md), [GitHub cache guide](github-data-cache.md), and [GitHub OAuth guide](github-oauth.md).
