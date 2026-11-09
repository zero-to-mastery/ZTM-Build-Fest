import { it, expect, vi } from "vitest";
import {
  healthTargets,
  checkTarget,
  scanTargets,
  repositoryNotes,
} from "../src/github/health.js";
import {
  cachedHealth,
  cacheHealth,
  invalidateHealth,
  HEALTH_TTL,
} from "../src/github/health-cache.js";
import { newDraft } from "../src/state/drafts.js";
import { createBlock } from "../src/markdown/serialize.js";
const target = {
  url: "https://example.com/a",
  requestUrl: "https://example.com/a",
  image: false,
  category: "External Links",
};
it("extracts links, picture variants and imported relative paths without code examples", () => {
  const d = newDraft("D", [
    createBlock("custom", {
      markdown:
        '[repo](https://github.com/ada/demo)\n![local](img/a.png)\n<picture><source srcset="dark.svg"><img src="light.svg" alt="a"></picture>\n<a href="https://example.com/?a=1&amp;b=2">site</a>\n```md\n[x](https://ignored.test)\n```',
    }),
  ]);
  d.metadata.importSource = {
    type: "github",
    owner: "ada",
    repository: "demo",
    ref: "main",
    readmePath: "README.md",
  };
  const targets = healthTargets(d);
  expect(targets).toHaveLength(5);
  expect(targets.find((t) => t.repo).requestUrl).toBe(
    "https://api.github.com/repos/ada/demo",
  );
  expect(targets.find((t) => t.url.includes("img/a.png")).requestUrl).toContain(
    "/contents/img/a.png?ref=main",
  );
  expect(targets.some((t) => t.url.includes("&amp;"))).toBe(false);
});
it.each([
  [200, "reachable"],
  [301, "redirected"],
  [404, "not found"],
  [429, "rate limited"],
  [500, "unknown"],
])("classifies HTTP %i as %s", async (code, state) => {
  const result = await checkTarget(target, {
    fetcher: async () => new Response(null, { status: code }),
  });
  expect(result.state).toBe(state);
});
it("HEAD policy fallback cancels response bodies and detects image mismatch/size", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 405 }))
    .mockResolvedValueOnce(
      new Response("ignored", {
        headers: { "content-type": "text/html", "content-length": "9000000" },
      }),
    );
  const result = await checkTarget({ ...target, image: true }, { fetcher });
  expect(fetcher.mock.calls.map((c) => c[1].method)).toEqual(["HEAD", "GET"]);
  expect(result.notes.join(" ")).toContain("Expected an image");
  expect(result.notes.join(" ")).toContain("5 MB");
  expect(fetcher.mock.calls[0][1].credentials).toBe("omit");
});
it("ambiguous CORS and timeouts never claim a broken link", async () => {
  expect(
    (
      await checkTarget(target, {
        fetcher: async () => {
          throw new TypeError("Failed to fetch");
        },
      })
    ).state,
  ).toBe("blocked by CORS/HEAD policy");
  const result = await checkTarget(target, {
    timeout: 5,
    fetcher: (_u, { signal }) =>
      new Promise((_r, reject) =>
        signal.addEventListener("abort", () => reject(Error("abort"))),
      ),
  });
  expect(result.state).toBe("timeout");
});
it("GitHub checks report archived and changed metadata, with factual age only", async () => {
  const t = {
    ...target,
    repo: "ada/demo",
    api: true,
    snapshot: { defaultBranch: "master", homepage: "https://old.example" },
  };
  const result = await checkTarget(t, {
    fetcher: async () =>
      new Response(
        JSON.stringify({
          name: "demo",
          full_name: "ada/demo",
          archived: true,
          default_branch: "main",
          homepage: "https://new.example",
          updated_at: "2020-01-01",
        }),
      ),
  });
  expect(result.notes.join(" ")).toContain("archived");
  expect(result.notes.join(" ")).toContain("Default branch changed");
  expect(result.notes.join(" ")).toContain("does not imply abandonment");
  expect(repositoryNotes({ archived: false, updatedAt: "" }, null)).toEqual([]);
});
it("bounded scans preserve partial results and cache expires", async () => {
  invalidateHealth();
  let concurrent = 0,
    max = 0;
  const fetcher = async () => {
    concurrent++;
    max = Math.max(max, concurrent);
    await new Promise((r) => setTimeout(r, 1));
    concurrent--;
    return new Response(null);
  };
  const targets = Array.from({ length: 12 }, (_, i) => ({
    ...target,
    url: target.url + i,
    requestUrl: target.url + i,
  }));
  const results = await scanTargets(targets, { fetcher, force: true });
  expect(results).toHaveLength(12);
  expect(max).toBeLessThanOrEqual(4);
  expect(cachedHealth(targets[0])).toBeTruthy();
  expect(cachedHealth(targets[0], Date.now() + HEALTH_TTL + 1)).toBeNull();
  const controller = new AbortController();
  const partial = await scanTargets(targets, {
    fetcher,
    force: true,
    signal: controller.signal,
    onResult: () => controller.abort(),
  });
  expect(partial.length).toBeLessThan(12);
  invalidateHealth();
  expect(cachedHealth(targets[0])).toBeNull();
});
it("small error SVG inspection is advisory and unsafe URLs are never fetched", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 405 }))
    .mockResolvedValueOnce(
      new Response("<svg><text>not found</text></svg>", {
        headers: { "content-type": "image/svg+xml" },
      }),
    );
  expect(
    (await checkTarget({ ...target, image: true }, { fetcher })).notes.join(
      " ",
    ),
  ).toContain("provider error");
  const no = vi.fn();
  expect(
    (
      await checkTarget(
        { ...target, requestUrl: "javascript:bad" },
        { fetcher: no },
      )
    ).state,
  ).toBe("unknown");
  expect(no).not.toHaveBeenCalled();
});
