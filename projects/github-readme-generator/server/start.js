import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createPublishingService } from "./publishing.js";
const origin = process.env.PUBLISH_ORIGIN;
const handle = createPublishingService({
  origin,
  clientId: process.env.GITHUB_APP_CLIENT_ID,
  allowWorkflows: process.env.ALLOW_WORKFLOW_WRITES === "true",
});
const root = resolve("dist");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".json": "application/json",
};
createServer(async (req, res) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
  try {
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith("/api/publishing/")) {
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 1_600_000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const response = await handle(
        new Request(url, {
          method: req.method,
          headers: req.headers,
          ...(req.method === "GET" || req.method === "HEAD"
            ? {}
            : { body: Buffer.concat(chunks) }),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const path = resolve(
      root,
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": types[extname(path)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404).end("Unavailable");
  }
}).listen(Number(process.env.PORT || 8787), "127.0.0.1");
