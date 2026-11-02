import { it, expect, beforeEach } from "vitest";
import { classifyReadme } from "../src/repository-audit/classify.js";
import { historyFindings } from "../src/repository-audit/signals.js";
import { reviewReadme } from "../src/repository-audit/review.js";
import {
  AuditClient,
  auditRepositories,
} from "../src/repository-audit/github.js";
import { invalidateHealth } from "../src/github/health-cache.js";
import { sourceHash } from "../src/state/source-hash.js";
const now = Date.parse("2026-09-28T00:00:00Z");
const repo = { full_name: "example/demo", default_branch: "main" };
const response = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const commits = Array.from({ length: 10 }, (_, i) => ({
  sha: String(i),
  commit: { committer: { date: new Date(now - i * 86400000).toISOString() } },
}));
beforeEach(() => invalidateHealth());

it("finds prose placeholders but excludes inline, fenced, HTML code and comments", () => {
  expect(
    classifyReadme("# your-project-name\n\nTODO: write usage").findings.map(
      (finding) => finding.id,
    ),
  ).toEqual(["placeholder:todo", "placeholder:project-name"]);
  const examples =
    "# `TODO` examples\n\n`your-project-name`\n\n```md\nTODO your-project-name\n```\n\n<pre>TODO your-project-name</pre>\n\n<!-- TODO -->\n\n<code>TODO</code>";
  expect(classifyReadme(examples).findings).toEqual([]);
  expect(
    classifyReadme("A TODO list manager with useful controls.").findings[0]
      .message,
  ).toContain("whether it is intentional");
});
it("requires combined framework markers and never asserts an untouched template", () => {
  expect(
    classifyReadme("This project was bootstrapped with Create React App.")
      .findings,
  ).toEqual([]);
  expect(
    classifyReadme(
      "# Available Scripts\n\nThis project was bootstrapped with Create React App.",
    ).findings[0],
  ).toMatchObject({
    id: "starter:create-react-app",
    message: expect.stringContaining("starter text remains"),
  });
  expect(
    classifyReadme(
      "```md\n# Available Scripts\nThis project was bootstrapped with Create React App.\n```",
    ).findings,
  ).toEqual([]);
});
it("requires an old observed README and sustained distinct recent activity", () => {
  expect(historyFindings("2026-01-01", commits, now)[0]).toMatchObject({
    id: "history:activity-after-readme",
    message: expect.stringContaining("may need review"),
    updated: "2026-01-01",
    commits: 10,
  });
  for (const date of ["", "invalid", "2027-01-01", "2026-09-01"])
    expect(historyFindings(date, commits, now)).toEqual([]);
  expect(historyFindings("2026-01-01", commits.slice(0, 9), now)).toEqual([]);
  expect(
    historyFindings("2026-01-01", Array(20).fill(commits[0]), now),
  ).toEqual([]);
  expect(
    historyFindings(
      "2026-01-01",
      commits.map((c) => ({ ...c, commit: commits[0].commit })),
      now,
    ),
  ).toEqual([]);
});
it("queries path-specific history on the selected branch and caches bounded observations", async () => {
  const urls = [];
  const client = new AuditClient({
    now: () => now,
    fetcher: async (url) => {
      urls.push(url);
      return response(
        url.includes("path=")
          ? [{ commit: { committer: { date: "2026-01-01" } } }]
          : commits,
      );
    },
  });
  const result = await client.history(repo, "README.md");
  expect(historyFindings(result.updated, result.commits, now)).toHaveLength(1);
  await client.history(repo, "README.md");
  expect(urls).toHaveLength(2);
  expect(urls[0]).toContain("sha=main&path=README.md&per_page=1");
  expect(urls[1]).toContain("per_page=30");
});
it("retries transient responses once, but honors a shared rate-limit cooldown", async () => {
  let calls = 0,
    time = now;
  const client = new AuditClient({
    now: () => time,
    fetcher: async () => (++calls === 1 ? response({}, 503) : response([])),
  });
  await client.request("/test");
  expect(calls).toBe(2);
  client.fetcher = async () => {
    calls++;
    return response({}, 429, { "retry-after": "120" });
  };
  await expect(client.request("/test")).rejects.toMatchObject({
    kind: "rate-limit",
  });
  await expect(client.request("/another")).rejects.toMatchObject({
    kind: "rate-limit",
  });
  expect(calls).toBe(3);
  time += 120001;
  await expect(client.request("/test")).rejects.toMatchObject({
    kind: "rate-limit",
  });
  expect(calls).toBe(4);
});
it("cancels during retry delay without another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new AuditClient({
    fetcher: async () => {
      calls++;
      setTimeout(() => controller.abort(), 20);
      return response({}, 502);
    },
  });
  await expect(
    client.request("/test", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});
it.each([100, 500, 1000])(
  "processes %i synthetic READMEs with three requests, bounded cache and no retained source",
  async (count) => {
    let active = 0,
      maximum = 0,
      calls = 0;
    const source =
      "# Example\n\nA practical local tool for writing notes and exporting files with accessible keyboard controls and predictable plain text output for everyday work.";
    const client = new AuditClient({
      fetcher: async () => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((r) => setTimeout(r, 0));
        active--;
        return response({
          path: "README.md",
          sha: "a".repeat(40),
          size: Buffer.byteLength(source),
          encoding: "base64",
          content: Buffer.from(source).toString("base64"),
        });
      },
    });
    const results = [];
    const summary = await auditRepositories(
      Array.from({ length: count }, (_, i) => ({
        ...repo,
        full_name: `example/repo-${i}`,
      })),
      { client, analyze: classifyReadme, onResult: (r) => results.push(r) },
    );
    expect(summary).toMatchObject({ assessed: count, failed: 0, remaining: 0 });
    expect(calls).toBe(count);
    expect(maximum).toBeLessThanOrEqual(3);
    expect(client.bytes).toBeLessThanOrEqual(20_000_000);
    expect(
      results.every(
        (r) =>
          !Object.hasOwn(r.readme, "source") && r.result.state === "minimal",
      ),
    ).toBe(true);
  },
  20000,
);
it("reports partial failures separately from unstarted work", async () => {
  const client = new AuditClient({ fetcher: async () => response({}, 429) });
  const records = [];
  const result = await auditRepositories(
    Array.from({ length: 100 }, (_, i) => ({
      ...repo,
      full_name: `example/r${i}`,
    })),
    { client, analyze: classifyReadme, onResult: (r) => records.push(r) },
  );
  expect(result.assessed).toBe(0);
  expect(result.failed).toBeLessThanOrEqual(3);
  expect(result.remaining + result.failed).toBe(100);
  expect(records.every((r) => !r.result)).toBe(true);
});
it("reuses link health, resolves relative images, and treats CORS failures as unknown", async () => {
  const urls = [];
  const client = {
    now: () => now,
    history: async () => ({ updated: "", commits: [] }),
    fetcher: async (url) => {
      urls.push(url);
      if (url.includes("blocked")) throw new TypeError("CORS");
      return response({}, 404);
    },
  };
  const readme = {
    source: "![Diagram](./missing.png)\n[Site](https://example.org/blocked)",
    path: "README.md",
  };
  const result = await reviewReadme(repo, readme, { client });
  expect(urls[0]).toContain(
    "/repos/example/demo/contents/missing.png?ref=main",
  );
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]).toMatchObject({
    id: `image:unavailable:${sourceHash(result.findings[0].url)}`,
    message: expect.stringContaining("Image unavailable"),
  });
  expect(result.findings[0].url).toContain("missing.png");
  expect(result.notes.join(" ")).toContain("1 unverifiable");
  expect(result).toMatchObject({ historyChecked: true, linksChecked: false });
  await reviewReadme(repo, readme, { client });
  expect(urls).toHaveLength(2);
});
it("limits optional checks to 20 URLs and stops on provider throttling", async () => {
  let calls = 0;
  const client = {
    now: () => now,
    history: async () => ({ updated: "", commits: [] }),
    fetcher: async () => {
      calls++;
      return response({}, 200);
    },
  };
  const readme = {
    source: Array.from(
      { length: 30 },
      (_, i) => `[Link](https://example.org/${i})`,
    ).join("\n"),
    path: "README.md",
  };
  const complete = await reviewReadme(repo, readme, { client });
  expect(complete.notes.join(" ")).toContain("20 per review");
  expect(complete.linksChecked).toBe(false);
  expect(calls).toBe(20);
  invalidateHealth();
  calls = 0;
  client.fetcher = async () => {
    calls++;
    return response({}, 429);
  };
  expect((await reviewReadme(repo, readme, { client })).linksChecked).toBe(
    false,
  );
  expect(calls).toBe(1);
});
