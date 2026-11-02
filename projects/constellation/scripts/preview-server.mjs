import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { fetchPinnedRepositories } from "../src/constellation.mjs";

const allowed = new Map([
  ...["onboarding-model", "onboarding-generator", "profile-story-export", "portfolio-artifact", "portable-export"].map(
    (name) => [`/src/${name}.mjs`, [`../src/${name}.mjs`, "text/javascript"]],
  ),
  ...[
    "temporal-geometry",
    "temporal-ring-layout",
    "temporal-geometry-drawing",
    "temporal-geometry-svg",
    "temporal-geometry-runtime",
    "temporal-ring-editor",
  ].map((name) => [
    `/src/${name}.mjs`,
    [`../src/${name}.mjs`, "text/javascript"],
  ]),
  ...[
    "temporal-stack",
    "temporal-stack-model",
    "temporal-stack-svg",
    "temporal-stack-runtime",
    "temporal-scene-layers",
    "temporal-motion",
    "temporal-svg-motion",
  ].map((name) => [
    `/src/${name}.mjs`,
    [`../src/${name}.mjs`, "text/javascript"],
  ]),
  [
    "/src/hierarchy-model.mjs",
    ["../src/hierarchy-model.mjs", "text/javascript"],
  ],
  ["/src/story-model.mjs", ["../src/story-model.mjs", "text/javascript"]],
  ...[
    "asteroid-field",
    "commit-field",
    "repository-commits",
    "commit-graph",
    "story",
    "renderer-html",
    "interactive-runtime",
    "semantic-zoom",
    "timeline-runtime",
    "hierarchy-runtime",
    "story-runtime",
    "scene-transition",
  ].map((name) => [
    `/src/${name}.mjs`,
    [`../src/${name}.mjs`, "text/javascript"],
  ]),
  ["/src/wasm/inline.mjs", ["../src/wasm/inline.mjs", "text/javascript"]],
  [
    "/examples/web-component.html",
    ["../examples/web-component.html", "text/html"],
  ],
  [
    "/packages/web-component/index.mjs",
    ["../packages/web-component/index.mjs", "text/javascript"],
  ],
  ["/packages/web-component/web-component-atlas.mjs", ["../packages/web-component/web-component-atlas.mjs", "text/javascript"]],
  ...readdirSync(new URL("../packages/core/src/", import.meta.url), {
    recursive: true,
  })
    .filter((name) => /\.(mjs|js|wasm)$/.test(name))
    .map((name) => {
      const path = name.replaceAll("\\", "/");
      return [
        `/packages/core/src/${path}`,
        [
          `../packages/core/src/${path}`,
          path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        ],
      ];
    }),
  ...[
    "account-sun",
    "orbit-shape",
    "scene",
    "timeline",
    "scene-layers",
    "renderer-svg",
    "recruiter",
    "recruiter-svg",
    "data-pipeline",
    "data-transforms",
    "data-mappings",
    "pipeline-cache",
    "layout-api",
    "layout-host",
  ].map((name) => [
    `/src/${name}.mjs`,
    [`../src/${name}.mjs`, "text/javascript"],
  ]),
  ["/src/scaling.mjs", ["../src/scaling.mjs", "text/javascript"]],
  ...["plugin-host", "json-feed-source", "theme-packs", "semantic-groups", "semantic-graph", "semantic-markdown", "developer-atlas", "developer-atlas-scene", "story-candidates", "story-clarity", "evidence-navigation", "evidence-navigator", "interactive-focus", "scene-framing"].map((name) => [
    `/src/${name}.mjs`,
    [`../src/${name}.mjs`, "text/javascript"],
  ]),
  [
    "/src/filter-explanation.mjs",
    ["../src/filter-explanation.mjs", "text/javascript"],
  ],
  ["/src/evidence.mjs", ["../src/evidence.mjs", "text/javascript"]],
  ...["settings", "model", "data", "graph"].map((name) => [
    `/src/organization/${name}.mjs`,
    [`../src/organization/${name}.mjs`, "text/javascript"],
  ]),
  ...[
    "settings",
    "historical-snapshot",
    "project-lifecycle",
    "contribution-history",
    "contribution-comet",
    "language-history",
    "external-contributions",
    "history-svg",
    "time-lapse-svg",
  ].map((name) => [
    `/src/history/${name}.mjs`,
    [`../src/history/${name}.mjs`, "text/javascript"],
  ]),
  ["/", ["../index.html", "text/html"]],
  ["/how-it-works.html", ["../how-it-works.html", "text/html"]],
  ["/profiles/preview.html", ["../profiles/preview.html", "text/html"]],
  ...[
    "github-oauth",
    "github-session",
    "github-request-cache",
    "github-access",
    "export-density",
    "preview-data",
    "constellation",
    "export",
    "visual-style",
    "label-editor",
    "engine",
    "hierarchy",
    "project-constellation",
    "project-constellation-scene",
    "github-project-structure",
    "ring-animation",
    "perspective",
    "selection",
    "artifact-layouts",
    "config-schema",
    "config-store",
    "design-randomizer",
    "design-randomizer-v5",
    "design-randomizer-v6",
    "randomize-parts",
    "layout-refinement",
    "export-image",
    "node-sizing",
    "repository-filters",
    "contributed-repositories",
    "commit-constellation",
    "seeded-random",
    "share-link",
    "semantic-studio",
    "studio-presets",
    "themes",
    "visual-mapping",
    "starfield",
    "coding-rhythm",
    "coding-rhythm-svg",
    "activity",
    "activity-effects",
    "github-activity",
    "github-mark",
    "sample-activity",
  ].map((name) => [
    `/src/${name}.mjs`,
    [`../src/${name}.mjs`, "text/javascript"],
  ]),
  [
    "/src/wasm/constellation_core.js",
    ["../src/wasm/constellation_core.js", "text/javascript"],
  ],
  [
    "/src/wasm/constellation_core_bg.wasm",
    ["../src/wasm/constellation_core_bg.wasm", "application/wasm"],
  ],
  ...["constellation", "mnichols08", "mnichols08-dark", "mnichols08-light"].map(
    (name) => [`/dist/${name}.svg`, [`../dist/${name}.svg`, "image/svg+xml"]],
  ),
]);

export function createPreviewServer({ token, fetchImpl = fetch } = {}) {
  return createServer(async (req, res) => {
    const port = req.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) {
      res.writeHead(403);
      res.end("Forbidden host");
      return;
    }
    const origin = `http://${req.headers.host}`;
    if (
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res.writeHead(403);
      res.end("Cross-site requests are not allowed");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      res.end("Method not allowed");
      return;
    }
    const url = new URL(req.url, origin);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (url.pathname.startsWith("/api/github/")) {
      const path = url.pathname.slice("/api/github".length);
      const pinned = /^\/users\/([a-z\d][a-z\d-]{0,38})\/pinned$/i.exec(path);
      if (pinned && !url.search) {
        res.setHeader("Content-Type", "application/json");
        if (!token) {
          res.writeHead(401);
          res.end(
            JSON.stringify({
              message:
                "Pinned repositories need GH_TOKEN in the local server .env file.",
            }),
          );
          return;
        }
        try {
          res.end(
            JSON.stringify(
              await fetchPinnedRepositories(pinned[1], { token, fetchImpl }),
            ),
          );
        } catch (error) {
          res.writeHead(502);
          res.end(
            JSON.stringify({
              message:
                error.message.startsWith("GitHub") ||
                error.message.startsWith("Could not load pinned")
                  ? error.message
                  : "Could not load pinned repositories from GitHub.",
            }),
          );
        }
        return;
      }
      const accountInfo = /^\/(users|orgs)\/[a-z\d][a-z\d-]{0,38}$/i.test(path);
      const repoList = /^\/(users|orgs)\/[a-z\d][a-z\d-]{0,38}\/repos$/i.test(
        path,
      );
      const publicEvents =
        /^\/(users\/[a-z\d][a-z\d-]{0,38}\/events\/public|orgs\/[a-z\d][a-z\d-]{0,38}\/events)$/i.test(
          path,
        );
      const languages =
        /^\/repos\/[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]+\/languages$/i.test(path);
      const contributors =
        /^\/repos\/[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]+\/contributors$/i.test(
          path,
        );
      const commits =
        /^\/repos\/[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]+\/commits$/i.test(path);
      const repoMetadata =
        /^\/repos\/[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]+$/i.test(path);
      const contributionSearch =
        (path === "/search/issues" &&
          /^author:[a-z\d][a-z\d-]{0,38}(?: org:[a-z\d][a-z\d-]{0,38})? is:pr is:public$/i.test(
            url.searchParams.get("q") || "",
          )) ||
        (path === "/search/commits" &&
          /^author:[a-z\d][a-z\d-]{0,38}(?: org:[a-z\d][a-z\d-]{0,38})? is:public$/i.test(
            url.searchParams.get("q") || "",
          ));
      if (
        (!repoList &&
          !languages &&
          !publicEvents &&
          !accountInfo &&
          !contributors &&
          !commits &&
          !repoMetadata &&
          !contributionSearch) ||
        [...url.searchParams.keys()].some(
          (key) =>
            !(
              contributionSearch
                ? ["q", "per_page", "page", "sort", "order"]
                : commits
                  ? ["per_page", "page", "sha"]
                  : publicEvents || contributors
                    ? ["per_page", "page"]
                    : accountInfo || repoMetadata
                      ? []
                      : ["type", "sort", "per_page", "page"]
            ).includes(key),
        )
      ) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.removeHeader("Cache-Control");
      try {
        const upstream = await fetchImpl(
          `https://api.github.com${path}${url.search}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              ...(req.headers["if-none-match"]
                ? { "If-None-Match": req.headers["if-none-match"] }
                : {}),
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(20000),
            redirect: "error",
          },
        );
        res.setHeader("Content-Type", "application/json");
        for (const header of [
          "x-ratelimit-limit",
          "x-ratelimit-remaining",
          "x-ratelimit-reset",
          "retry-after",
          "link",
          "etag",
          "cache-control",
          "last-modified",
          "vary",
        ]) {
          const value = upstream.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        if (upstream.status === 304) {
          res.writeHead(304);
          res.end();
          return;
        }
        if (!upstream.ok) {
          res.writeHead(upstream.status);
          res.end(
            JSON.stringify({
              message:
                upstream.status === 401
                  ? "The local GitHub token was rejected."
                  : "GitHub request failed.",
            }),
          );
          return;
        }
        res.end(await upstream.text());
      } catch {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            message: "Could not reach GitHub from the local server.",
          }),
        );
      }
      return;
    }
    // Studio UI files are resolved per request so new modules need no restart.
    const app = /^\/src\/app\/((?:[a-z\d-]+\/)*[a-z\d-]+\.(mjs|css))$/.exec(url.pathname);
    const entry = app
      ? [`../src/app/${app[1]}`, app[2] === "css" ? "text/css" : "text/javascript"]
      : allowed.get(url.pathname);
    if (!entry) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    try {
      let content = await readFile(new URL(entry[0], import.meta.url));
      if (url.pathname === "/") {
        content = content
          .toString()
          .replace(
            "<head>",
            `<head>\n<meta name="constellation-api" content="/api/github">\n<meta name="constellation-auth" content="${token ? "authenticated" : "public"}">`,
          );
      }
      // Binary types take no charset; a suffixed WASM type makes browsers warn.
      res.setHeader("Content-Type", entry[1] === "application/wasm" ? entry[1] : `${entry[1]}; charset=utf-8`);
      res.end(content);
    } catch (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500);
      res.end(error.code === "ENOENT" ? "Not found" : "Could not load preview");
    }
  });
}
