# Constellation

Turn a GitHub account's public projects into a star map you can customize and put on your profile README, your website, or anywhere you share a picture.

[Open the Studio](https://mnichols08.github.io/constellation/) · [Source repository](https://github.com/mnichols08/constellation) · [Browse examples](examples/README.md) · [Documentation](docs/README.md)

![Example GitHub constellation](./dist/constellation.svg)

## Links

- **Live project:** <https://mnichols08.github.io/constellation/>
- **Source repository:** <https://github.com/mnichols08/constellation>

## The problem it solves

A GitHub profile is a flat list of repositories. Pinned repos show six at most, and a language bar says little about what someone actually builds. Anyone who wants to show their work (developers, students, career changers) has to describe it by hand, and the description goes stale.

Constellation reads an account's public repository metadata (languages, topics, stars and dates) and draws it as a star map. You choose which projects appear and how they look. A daily GitHub Action keeps the image current, so your profile README stays up to date without any manual work. The map shows evidence from GitHub. It does not judge skill or ability.

## Quick install and run

The fastest path needs no install: open the [Studio](https://mnichols08.github.io/constellation/), type a GitHub username and press **Show my sky**.

To run it on your own machine, you need Node.js 22 or newer:

```sh
git clone https://github.com/zero-to-mastery/ZTM-Build-Fest.git
cd ZTM-Build-Fest/projects/constellation
npm install
npm run preview
```

Open <http://127.0.0.1:4173>. To generate an SVG from the command line instead, run `node src/cli.mjs --username YOUR_USERNAME --output constellation.svg`. More options are covered below under [Use the command line](#use-the-command-line) and [Run locally](#run-locally).

## How AI was used

- **Building it:** AI coding agents helped write and review much of the code, tests and documentation. [AGENTS.md](AGENTS.md) and [AI_README.md](AI_README.md) set the rules those agents follow, such as which layer owns what, how to keep public contracts stable, and what to test. A person decides the design and checks the results.
- **In the product:** AI is an optional way to describe a map, not something you need. The design in [AI Constellation Spec](docs/ai/AI-CONSTELLATION-SPEC.md) lets a model propose meaning (for example, "focus on my Rust projects"). The Rust/WASM engine then validates that proposal and computes the layout deterministically. The model never produces raw coordinates or code. The Studio, the CLI and the GitHub Action all work without any AI.

## Get started

1. **Type your username.** Open the [Studio](https://mnichols08.github.io/constellation/), type a GitHub username, and press **Show my sky**. No sign-in needed. Not ready? **Try an example**.
2. **Make it yours.** Click a star to see why it is there, then change the map with the **Look**, **Layout**, **Projects** and **Details** tabs. **Shuffle** tries a random look; **Undo** brings yours back. **Save** keeps a design in your browser.
3. **Get it.** Press **Get it**, choose **Add it to your GitHub profile**, and follow the three steps: create the workflow file on GitHub, run it once, and paste the README snippet. The map then refreshes every day.

The workflow publishes `constellation.svg` to an `output` branch using GitHub's own token; you don't create one. **Get it** also offers **Download an image** (SVG or PNG), **Put it on a website** (an interactive page), **Share a link**, and **Save the settings file**.

The [Studio guide](docs/studio.md) covers every screen, shortcut and privacy detail. [Publishing](docs/publishing.md) explains what the daily workflow does.

## Use the command line

Requires Node.js 22 or newer. Run these from `projects/constellation`.

```sh
npm install
node src/cli.mjs --username YOUR_USERNAME --output constellation.svg
```

Pass `--config settings.json` to use a settings file saved from the Studio (**Get it** → **Save the settings file**). See the [CLI and configuration guide](docs/designs.md) for options, fixtures, validation, and migration.

## Use the GitHub Action

The workflow that **Add it to your GitHub profile** creates runs this repository's Action. You can also write your own:

```yaml
- uses: mnichols08/constellation@v1
  with:
    config: constellation.json
    output: constellation.svg
```

See [Publishing](docs/publishing.md) and [Designs and configuration](docs/designs.md#multiple-images).

## What the map means

Constellation draws public repository metadata: languages, topics, stars, and dates. You choose which projects to include and what size, colour and position show. Click any star in the Studio and its card explains, in plain sentences, why it is on the map and why it looks the way it does, and whether each reason comes from GitHub, from Constellation's calculation, or from your choice. A layout or score is not an assessment of skill or professional ability. Read about [evidence and provenance](docs/evidence-provenance.md), [reading a constellation](docs/semantic-studio.md), and the [README Showcase](docs/readme-showcase.md).

Public exploration works without signing in and makes two GitHub requests per account. Sign-in adds pinned projects, full language breakdowns, and recent activity. See [Privacy](docs/studio.md#privacy-what-stays-where).

## Explore and share

- **Studio:** pick projects, change the look, save named designs, and get an SVG, PNG, interactive page, settings file, or share link. [Guide](docs/studio.md)
- **README Showcase:** feature projects and choose a compact presentation for your profile. [Guide](docs/readme-showcase.md)
- **Universe:** compare projects by year, language, repository, or topic. [Guide](docs/temporal-stack.md)
- **Organization maps:** explore public organization repositories. [Guide](docs/organizations.md)
- **History and activity:** repository commits or limited recent public activity. These are partial signals, not a complete contribution calendar. [History](docs/history.md)
- **Interactive exports:** an offline HTML file or framework-free web component. [HTML](docs/interactive-html.md) · [Web component](docs/web-component.md)

## Run locally

```sh
npm install
npm run preview
```

Open <http://127.0.0.1:4173>. Public data works without a token. For authenticated local requests, create a `.env` file with `GH_TOKEN=...`; keep it private and out of Git. Home then shows **Signed in locally**. The hosted Studio never needs your token for public exploration.

## Develop

Constellation is framework-independent. JavaScript handles GitHub and browser APIs, Rust/WASM handles graph and layout computation, and HTML/CSS/SVG present the result. The Studio lives in `src/app/`. Rust/WASM is bundled; using the Studio or Action does not require a Rust toolchain.

```sh
npm test               # unit, engine, package, CLI and component tests
npx playwright test    # Studio journeys and perception budgets
```

`npx playwright test` drives the real Studio on a desktop and a phone viewport with stubbed GitHub responses. Besides the journeys, it fails when a screen has overlapping controls, a control without a visible label, engine jargon on screen, a map smaller than its share of the screen, more than one primary action, or an axe accessibility violation. Run `npx playwright install chromium` once first, or set `E2E_CHANNEL=chrome` to use an installed Chrome.

When changing the Rust engine, build the WASM assets and core package as described in [Core development](docs/core-api.md). Before changing architecture or public contracts, read [the engineering contract](AGENTS.md) and [architecture guide](docs/architecture.md).

## Documentation

Use the [documentation map](docs/README.md) to find guides by task. The [changelog](CHANGELOG.md) records releases; [v3 migration](docs/migration-v3.md) covers older configurations and workflows.

## License

[MIT](LICENSE)
