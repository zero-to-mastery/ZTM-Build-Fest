import { describe, it, expect } from "vitest";
import { classifyReadme } from "../src/repository-audit/classify.js";
import { activityStatus } from "../src/repository-audit/presentation.js";
import {
  AuditClient,
  AuditError,
  auditRepositories,
  filterRepositories,
} from "../src/repository-audit/github.js";

const paragraph =
  "This project provides a practical local workspace for organizing personal notes with clear keyboard controls and predictable text exports. ";
const basic = `# Notes\n\n${paragraph.repeat(3)}\n\n## Installation\n\nInstall the package using your preferred package manager and select a local folder for storage.\n\n## Usage\n\nUse the editor to write a note, then export your text to a file.\n`;
const detailed =
  basic +
  `\n## Examples\n\n${paragraph.repeat(10)}\n\n\`\`\`js\nconsole.log('example');\n\`\`\`\n\n[Documentation](https://example.com/docs)`;
const repo = (name, extra = {}) => ({
  name,
  full_name: `example/${name}`,
  owner: { login: "example" },
  default_branch: "main",
  private: false,
  pushed_at: "2026-09-01T00:00:00Z",
  ...extra,
});
const response = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const file = (source = basic, path = "README.md") => ({
  path,
  sha: "a".repeat(40),
  size: new TextEncoder().encode(source).length,
  encoding: "base64",
  content: Buffer.from(source).toString("base64"),
});

describe("evidence-based README classification", () => {
  it("normalizes a leading BOM only for analysis and counts supporting images", () => {
    const source = `\ufeff# Overview\r\n\r\n${paragraph.repeat(2)}`;
    const result = classifyReadme(source);
    expect(result.metrics.headings).toBe(1);
    expect(result.metrics.characters).toBe(source.length);
    expect(result.metrics.bytes).toBe(new TextEncoder().encode(source).length);
    const illustrated =
      basic +
      `\n## Walkthrough\n\n${paragraph.repeat(10)}\n\n![Screenshot](./screen.png)`;
    expect(classifyReadme(illustrated).state).toBe("detailed");
    expect(classifyReadme(illustrated).metrics.supportingImages).toBe(1);
  });
  it.each([
    [null, "missing"],
    ["", "stub"],
    ["# Notes\nTODO", "stub"],
    ["```js\n" + paragraph.repeat(100) + "\n```", "stub"],
    [
      "![Build](https://img.shields.io/badge/build-passing-green)\n".repeat(50),
      "stub",
    ],
    [paragraph + paragraph, "minimal"],
    [basic, "basic"],
    [detailed, "detailed"],
  ])("classifies source by combined evidence (%s)", (source, state) => {
    const result = classifyReadme(source);
    expect(result.state).toBe(state);
    expect(classifyReadme(source)).toEqual(result);
    expect(result).not.toHaveProperty("score");
  });
  it("requires structure, prose and useful content rather than rewarding length", () => {
    expect(classifyReadme(paragraph.repeat(200)).state).toBe("minimal");
    const heavy =
      detailed +
      Array.from(
        { length: 8 },
        (_, i) =>
          `\n## Guide ${i}\n\n${paragraph.repeat(10)}\n\n\`\`\`sh\necho guide\n\`\`\`\n`,
      ).join("");
    expect(classifyReadme(heavy).state).toBe("documentation-heavy");
    const emptySections =
      paragraph +
      "\n\n## Setup\n\n## Usage\n\n<!-- install run the example -->";
    expect(classifyReadme(emptySections).metrics).toMatchObject({
      setup: false,
      usage: false,
    });
  });
  it("ignores code, images, comments and executable HTML as prose", () => {
    expect(classifyReadme(`<code>${paragraph.repeat(20)}</code>`).state).toBe(
      "stub",
    );
    expect(
      classifyReadme(
        `[![Build](https://img.shields.io/badge/build-green)](https://example.com)\n\n[Unsafe](javascript:alert(1))`,
      ).metrics.projectLinks,
    ).toBe(0);
    const source = `<!-- ${paragraph} -->\n<script>${paragraph}</script>\n\n<img src=x alt="${paragraph}">\n\n\`\`\`md\n## Installation\n${paragraph}\n\`\`\``;
    expect(classifyReadme(source).metrics).toMatchObject({
      meaningfulWords: 0,
      setup: false,
      usage: false,
    });
    expect(
      classifyReadme(`<h1>Notes</h1><p>${paragraph.repeat(2)}</p>`).state,
    ).toBe("minimal");
    expect(
      classifyReadme(
        "# Unicode\n\n" +
          "Des outils accessibles pour écrire et partager des idées avec une équipe internationale. ".repeat(
            3,
          ),
      ).metrics.meaningfulWords,
    ).toBeGreaterThan(20);
  });
  it("separates archive/activity evidence from documentation state and defaults to owned non-forks", () => {
    const repos = [
      repo("normal"),
      repo("fork", { fork: true }),
      repo("old", { archived: true }),
    ];
    expect(filterRepositories(repos).map((r) => r.name)).toEqual(["normal"]);
    expect(filterRepositories(repos, { includeArchived: true })).toHaveLength(
      2,
    );
    expect(
      filterRepositories(repos, { includeArchived: true, includeForks: true }),
    ).toHaveLength(3);
    expect(activityStatus(repos[2])).toBe("Archived");
    expect(activityStatus(repos[0], Date.parse("2026-09-28"))).toContain(
      "30 days",
    );
    expect(activityStatus(repo("unknown", { pushed_at: "" }))).toContain(
      "unknown",
    );
  });
});

describe("public GitHub audit fetching", () => {
  it("paginates 1,000 owned public repositories without following arbitrary Link URLs", async () => {
    const calls = [];
    const client = new AuditClient({
      fetcher: async (url, options) => {
        calls.push(url);
        expect(options.credentials).toBe("omit");
        const page = Number(new URL(url).searchParams.get("page"));
        return response(
          Array.from({ length: 100 }, (_, i) => repo(`repo-${page}-${i}`)),
          200,
          { link: '<https://untrusted.invalid>; rel="next"' },
        );
      },
    });
    let total = 0;
    for (let page = 1; page <= 10; page++) {
      const result = await client.repositories("example", page);
      total += result.repositories.length;
      expect(result.next).toBe(page < 10);
      expect(result.capped).toBe(page === 10);
    }
    expect(total).toBe(1000);
    expect(calls).toHaveLength(10);
    await client.repositories("example", 1);
    expect(calls).toHaveLength(10);
    await expect(client.repositories("example", 11)).rejects.toThrow(
      /10 pages/,
    );
  });
  it("excludes private and non-owned metadata, keeps forks for explicit filtering", async () => {
    const client = new AuditClient({
      fetcher: async () =>
        response([
          repo("a"),
          repo("fork", { fork: true }),
          repo("private", { private: true }),
          repo("other", { full_name: "someone/other" }),
        ]),
    });
    expect(
      (await client.repositories("example")).repositories.map((r) => r.name),
    ).toEqual(["a", "fork"]);
  });
  it("preserves exact source, caches reads and permits explicit refresh/expiry", async () => {
    let count = 0,
      now = 1;
    const source = "\ufeff# Café 🌍\r\n\n<script>example</script>\n";
    const client = new AuditClient({
      now: () => now,
      fetcher: async () => {
        count++;
        return response(file(source));
      },
    });
    expect((await client.readme(repo("a"))).source).toBe(source);
    await client.readme(repo("a"));
    expect(count).toBe(1);
    await client.readme(repo("a"), { force: true });
    expect(count).toBe(2);
    now += 300001;
    await client.readme(repo("a"));
    expect(count).toBe(3);
  });
  it("distinguishes missing from partial failures and bounds concurrency for 100 repositories", async () => {
    let active = 0,
      peak = 0;
    const client = new AuditClient({
      fetcher: async (url) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return url.includes("/repo-1/")
          ? response({}, 404)
          : url.includes("/repo-2/")
            ? response({}, 500)
            : response(file());
      },
    });
    const results = [];
    const summary = await auditRepositories(
      Array.from({ length: 100 }, (_, i) => repo(`repo-${i}`)),
      { client, analyze: classifyReadme, onResult: (r) => results.push(r) },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(summary.completed).toBe(100);
    expect(results.find((r) => r.repo.name === "repo-1").result.state).toBe(
      "missing",
    );
    expect(results.find((r) => r.repo.name === "repo-2")).toMatchObject({
      kind: "http",
    });
    expect(results.find((r) => r.repo.name === "repo-2")).not.toHaveProperty(
      "result",
    );
  });
  it("stops scheduling after rate limits and retains successful in-flight results", async () => {
    let calls = 0;
    const client = new AuditClient({
      fetcher: async () => {
        calls++;
        return calls === 1
          ? response({}, 403, {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1900000000",
            })
          : response(file());
      },
    });
    const results = [];
    const summary = await auditRepositories(
      Array.from({ length: 100 }, (_, i) => repo(`r${i}`)),
      { client, analyze: classifyReadme, onResult: (r) => results.push(r) },
    );
    expect(calls).toBeLessThanOrEqual(3);
    expect(summary.stopped).toMatch(/rate limit.*after/i);
    expect(results.some((r) => r.result)).toBe(true);
  });
  it("checks root when GitHub returns a preferred non-root README", async () => {
    let calls = 0;
    const client = new AuditClient({
      fetcher: async (url) => {
        calls++;
        if (url.includes("/readme?"))
          return response(file("# Nested", ".github/README.md"));
        if (url.includes("/contents/?"))
          return response([
            { name: "README.md", path: "README.md", type: "file" },
          ]);
        return response(file("# Root"));
      },
    });
    expect((await client.readme(repo("a"))).source).toBe("# Root");
    expect(calls).toBe(3);
    const absent = new AuditClient({
      fetcher: async (url) =>
        response(
          url.includes("/readme?") ? file("# Docs", "docs/README.md") : [],
        ),
    });
    expect(await absent.readme(repo("a"))).toMatchObject({
      source: null,
      alternatePath: "docs/README.md",
    });
  });
  it("rejects corrupt/oversized responses and does not cache failures", async () => {
    let calls = 0;
    const client = new AuditClient({
      fetcher: async () => {
        calls++;
        return response({ ...file(), size: 9 });
      },
    });
    await expect(client.readme(repo("a"))).rejects.toThrow(/UTF-8/);
    await expect(client.readme(repo("a"))).rejects.toThrow();
    expect(calls).toBe(2);
    const oversized = new AuditClient({
      fetcher: async () => response({ ...file(), size: 1000001 }),
    });
    await expect(oversized.readme(repo("a"))).rejects.toMatchObject({
      kind: "size",
    });
  });
  it("cancels without scheduling new work and reports timeout independently of missing", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = new AuditClient({
      fetcher: async () => {
        calls++;
        controller.abort();
        throw new DOMException("Cancelled", "AbortError");
      },
    });
    const summary = await auditRepositories([repo("a"), repo("b")], {
      client,
      signal: controller.signal,
      analyze: classifyReadme,
    });
    expect(summary.cancelled).toBe(true);
    expect(calls).toBe(1);
    const slow = new AuditClient({
      timeout: 1,
      fetcher: (_, { signal }) =>
        new Promise((resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    });
    await expect(slow.readme(repo("a"))).rejects.toBeInstanceOf(AuditError);
  });
  it("bounds session source memory", () => {
    const client = new AuditClient();
    for (let i = 0; i < 25; i++)
      client.put(`r${i}`, { source: "x".repeat(1000000) });
    expect(client.bytes).toBeLessThanOrEqual(20000000);
    expect(client.readmes.has("r24")).toBe(true);
    expect(client.readmes.has("r0")).toBe(false);
  });
});
