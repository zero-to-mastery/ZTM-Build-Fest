import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";
const root = resolve("dist");
let originUnavailable = false;
let workerRevision = 0;
const server = createServer(async (req, res) => {
  if (originUnavailable) {
    req.socket.destroy();
    return;
  }
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const relative = pathname.startsWith("/readme-studio/")
      ? pathname.slice("/readme-studio/".length)
      : pathname.slice(1);
    const file = resolve(root, relative || "index.html");
    if (file !== root && !file.startsWith(root + sep))
      throw new Error("Outside dist");
    const body = await readFile(file);
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
      }[extname(file)] || "application/octet-stream",
    );
    res.end(
      relative === "sw.js"
        ? Buffer.concat([
            body,
            Buffer.from(`\n// update-smoke-${workerRevision}\n`),
          ])
        : body,
    );
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  for (const engine of [chromium, firefox, webkit]) {
    browser = await engine.launch();
    for (const path of ["/", "/readme-studio/"]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("https://**/*", (route) => route.abort());
      await page.goto(`http://127.0.0.1:${server.address().port}${path}`);
      await page
        .getByRole("button", { name: "Explore the sample profile" })
        .click();
      await page
        .getByRole("textbox", { name: "Markdown editor", exact: true })
        .fill("# Static hosting\n\n### Deeper\n\nContent");
      await page
        .locator("github-preview h1")
        .filter({ hasText: "Static hosting" })
        .waitFor();
      await page.getByRole("button", { name: "Health", exact: true }).click();
      await page.locator("readme-health .stats").waitFor();
      if (
        (await page.locator("readme-health").getAttribute("data-engine")) !==
        "WASM"
      )
        throw new Error("Production WASM asset failed to load");
      await page
        .getByRole("navigation", { name: "Workspace tools" })
        .getByRole("button", { name: "Safe refactors", exact: true })
        .click();
      await page.getByLabel(/Normalize heading hierarchy/).check();
      await page
        .getByRole("button", { name: "Review selected refactors", exact: true })
        .click();
      await page.getByLabel("After refactor").waitFor();
      if (
        !(await page.getByLabel("After refactor").inputValue()).includes(
          "\n## Deeper",
        )
      )
        throw new Error("Production refactor worker failed");
      if (errors.length) throw new Error(errors.join("\n"));
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.route("https://api.github.com/**", (route) =>
        route.fulfill({
          json: route.request().url().includes("/users/")
            ? [
                {
                  name: "sample",
                  topics: ["cli"],
                  full_name: "example/sample",
                  default_branch: "main",
                },
              ]
            : {
                path: "README.md",
                sha: "a".repeat(40),
                size: 7,
                encoding: "base64",
                content: Buffer.from("# Hello").toString("base64"),
              },
        }),
      );
      await page
        .getByRole("button", { name: "README audit", exact: true })
        .click();
      await page.getByLabel("GitHub username", { exact: true }).fill("example");
      await page
        .getByRole("button", { name: "Load repositories", exact: true })
        .click();
      await page.getByLabel("Select example/sample", { exact: true }).check();
      const auditWorker = page.waitForEvent("worker", {
        predicate: (worker) => worker.url().includes("analyze.worker"),
      });
      await page
        .getByRole("button", { name: "Audit selected", exact: true })
        .click();
      await auditWorker;
      await page
        .locator("repository-audit [data-status]")
        .filter({ hasText: "Audit complete: 1 of 1" })
        .waitFor();
      await page
        .locator("repository-audit [data-audit-results]")
        .getByText("Stub README for a CLI", { exact: true })
        .waitFor();
      await page
        .getByLabel("Project type for example/sample", { exact: true })
        .selectOption("web-app");
      await page
        .locator("repository-audit [data-audit-results]")
        .getByText("Stub README for a Web App", { exact: true })
        .waitFor();
      await page
        .locator("repository-audit")
        .getByRole("button", { name: "README Attention Queue", exact: true })
        .click();
      await page
        .locator("readme-attention-queue")
        .getByText("Medium attention", { exact: true })
        .waitFor();
      await page
        .locator("readme-attention-queue")
        .getByRole("button", {
          name: "Mark intentionally minimal",
          exact: true,
        })
        .click();
      if (await page.locator("readme-attention-queue [data-item]").count())
        throw Error("Production queue did not suppress the marked README");
      await page
        .getByRole("button", { name: "Audit selected", exact: true })
        .focus();
      await page.keyboard.press("Escape");
      await page.evaluate(() => navigator.serviceWorker.ready);
      if (await page.locator(".update-status").count())
        throw Error("First service-worker installation offered an update");
      await page.reload();
      await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
      );
      await page
        .getByRole("textbox", { name: "Markdown editor", exact: true })
        .fill("# Offline source\n\n### Heading");
      await page.keyboard.press("Control+s");
      originUnavailable = true;
      const offlineResponse = await page.reload();
      if (!offlineResponse?.fromServiceWorker())
        throw Error("Offline reload did not come from the service worker");
      if (
        (await page
          .getByRole("textbox", { name: "Markdown editor", exact: true })
          .inputValue()) !== "# Offline source\n\n### Heading"
      )
        throw Error("Offline reload lost source");
      await page.getByRole("button", { name: "Health", exact: true }).click();
      await page.locator("readme-health .stats").waitFor();
      await page
        .getByRole("navigation", { name: "Workspace tools" })
        .getByRole("button", { name: "Safe refactors", exact: true })
        .click();
      await page.getByLabel(/Normalize heading hierarchy/).check();
      await page
        .getByRole("button", { name: "Review selected refactors", exact: true })
        .click();
      await page.getByLabel("After refactor").waitFor();
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Save Studio project", exact: true })
        .click();
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download Studio project", exact: true })
        .click();
      const project = JSON.parse(
        await readFile(await (await download).path(), "utf8"),
      );
      if (project.document.markdown !== "# Offline source\n\n### Heading")
        throw Error("Offline project export lost source");
      await page.keyboard.press("Escape");
      await page
        .getByRole("navigation", { name: "Workspace tools" })
        .getByRole("button", { name: "Audience review", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Audience review", exact: true })
        .waitFor();
      if (
        (await page
          .getByRole("textbox", { name: "Markdown editor", exact: true })
          .inputValue()) !== "# Offline source\n\n### Heading"
      )
        throw Error("Offline audience review changed source");
      await page.keyboard.press("Escape");
      await page
        .getByRole("navigation", { name: "Workspace tools" })
        .getByRole("button", { name: "Local feedback export", exact: true })
        .click();
      await page.getByLabel("I choose to create a local diagnostic").check();
      await page
        .getByRole("button", { name: "Review local diagnostic", exact: true })
        .click();
      const feedback = JSON.parse(
        await page.locator("[data-feedback-preview]").textContent(),
      );
      if (JSON.stringify(feedback).includes("Offline source"))
        throw Error("Local feedback export included README source");
      await page.keyboard.press("Escape");
      const cached = await page.evaluate(async () => {
        const urls = [];
        for (const name of await caches.keys())
          for (const request of await (await caches.open(name)).keys())
            urls.push(request.url);
        return urls;
      });
      if (
        cached.some(
          (url) =>
            new URL(url).origin !== new URL(page.url()).origin ||
            url.includes("/api/"),
        )
      )
        throw Error("Offline cache contains a non-static request");
      originUnavailable = false;
      if (engine.name() === "chromium" && path === "/") {
        await page.keyboard.press("Escape");
        await page
          .getByRole("textbox", { name: "Markdown editor", exact: true })
          .fill("# Saved before update");
        workerRevision++;
        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          await registration.update();
        });
        await page
          .getByRole("button", { name: "Save and reload update", exact: true })
          .click();
        await page.waitForFunction(
          () => !document.querySelector(".update-status"),
        );
        if (
          (await page
            .getByRole("textbox", { name: "Markdown editor", exact: true })
            .inputValue()) !== "# Saved before update"
        )
          throw Error("Update reload lost unsaved source");
      }
      console.log(
        `Static smoke passed: ${engine.name()} ${path} (preview, Health/WASM, refactor and repository-audit workers)`,
      );
      if (errors.length) throw new Error(errors.join("\n"));
      await page.close();
    }
    await browser.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
