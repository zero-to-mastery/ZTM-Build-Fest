// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installOfflineStatus } from "../src/workspace/offline.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.innerHTML = "";
});

function installWithRegistration(registration) {
  document.body.innerHTML = "<app-shell></app-shell>";
  vi.stubEnv("PROD", true);
  vi.stubGlobal("navigator", {
    onLine: true,
    serviceWorker: {
      register: vi.fn().mockResolvedValue(registration),
    },
  });
  installOfflineStatus();
}

it("does not offer an update on a first service-worker installation", async () => {
  installWithRegistration({
    active: null,
    waiting: { postMessage: vi.fn() },
    addEventListener: vi.fn(),
  });
  await vi.waitFor(() =>
    expect(navigator.serviceWorker.register).toHaveBeenCalled(),
  );

  expect(document.querySelector(".update-status")).toBeNull();
});

it("offers an update when a waiting worker can replace an active worker", async () => {
  installWithRegistration({
    active: {},
    waiting: { postMessage: vi.fn() },
    addEventListener: vi.fn(),
  });
  await vi.waitFor(() =>
    expect(navigator.serviceWorker.register).toHaveBeenCalled(),
  );

  expect(document.querySelector(".update-status")?.textContent).toContain(
    "A new README Studio version is ready.",
  );
});

it("refuses update activation when the current workspace cannot be saved", async () => {
  const postMessage = vi.fn();
  installWithRegistration({
    active: {},
    waiting: { postMessage },
    addEventListener: vi.fn(),
  });
  document.querySelector("app-shell").save = vi.fn(() => false);
  await vi.waitFor(() =>
    expect(document.querySelector(".update-status button")).not.toBeNull(),
  );

  document.querySelector(".update-status button").click();

  expect(postMessage).not.toHaveBeenCalled();
  expect(document.querySelector(".update-status")?.textContent).toContain(
    "Save failed. Download your work before reloading.",
  );
});
