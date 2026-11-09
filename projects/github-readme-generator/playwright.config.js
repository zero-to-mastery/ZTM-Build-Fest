import { defineConfig } from "@playwright/test";
const port = Number(process.env.README_STUDIO_TEST_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error(
    "README_STUDIO_TEST_PORT must be an integer from 1024 to 65535.",
  );
const baseURL = `http://127.0.0.1:${port}`;
const projects = ["chromium", "firefox", "webkit"].map((name) => ({
  name,
  use: { browserName: name },
}));
if (process.env.INCLUDE_CHROME === "true")
  projects.push({
    name: "chrome",
    use: { browserName: "chromium", channel: "chrome" },
  });
export default defineConfig({
  testDir: "./tests/browser",
  projects,
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
  reporter: "list",
});
