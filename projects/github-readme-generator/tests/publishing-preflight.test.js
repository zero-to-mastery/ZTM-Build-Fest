import { describe, it, expect, vi } from "vitest";
import {
  evaluatePreflight,
  blockingFailure,
  passes,
  PREFLIGHT_CHECKS,
  ACCESS_CHECKS,
  READ_CHECKS,
  BRANCH_CHECKS,
  branchChecks,
} from "../src/publishing/preflight.js";
import { PublishingClient } from "../src/github/publishing-client.js";

const commitSha = "c".repeat(40);
// Facts for a fully writable README target on a non-default branch.
function facts(overrides = {}) {
  return {
    configured: true,
    connected: true,
    allowWorkflows: false,
    target: {
      repository: "octocat/octocat",
      branch: "docs",
      path: "README.md",
    },
    installation: { permissions: { contents: "write", workflows: "read" } },
    repository: { push: true, archived: false, defaultBranch: "main" },
    branch: { protected: false, commitSha },
    rules: [],
    ...overrides,
  };
}
const check = (report, id) => report.checks.find((c) => c.id === id);
const now = () => Date.UTC(2026, 0, 2);

describe("evaluatePreflight", () => {
  it("returns a versioned writable report with every check in display order", () => {
    const report = evaluatePreflight(facts(), { now });
    expect(report).toMatchObject({
      version: 1,
      target: {
        repository: "octocat/octocat",
        branch: "docs",
        path: "README.md",
      },
      checkedAt: "2026-01-02T00:00:00.000Z",
      verdict: "writable",
      branchCommitSha: commitSha,
      defaultBranch: "main",
    });
    expect(report.checks.map((c) => c.id)).toEqual(
      PREFLIGHT_CHECKS.filter((id) => id !== "workflow-permission"),
    );
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    expect(report.checks.filter((c) => !c.blocking).map((c) => c.id)).toEqual([
      "branch-rules",
      "default-branch",
    ]);
    expect(blockingFailure(report)).toBeNull();
  });

  it.each([
    [
      "service",
      { configured: false },
      "fail",
      "not configured on this deployment",
    ],
    ["service", { configured: undefined }, "unknown", "could not be checked"],
    ["session", { connected: false }, "fail", "Connect GitHub"],
    ["installation", { installation: null }, "fail", "not installed"],
    [
      "installation",
      { installation: undefined, reasons: { installation: "GitHub down." } },
      "unknown",
      "GitHub down.",
    ],
    [
      "contents-permission",
      { installation: { permissions: { contents: "read" } } },
      "fail",
      "App grants Contents: read only",
    ],
    [
      "contents-permission",
      { installation: { permissions: {} } },
      "fail",
      "no Contents permission",
    ],
    [
      "user-push",
      { repository: { push: false, archived: false, defaultBranch: "main" } },
      "fail",
      "cannot push",
    ],
    ["user-push", { repository: undefined }, "unknown", "could not be checked"],
    [
      "not-archived",
      { repository: { push: true, archived: true, defaultBranch: "main" } },
      "fail",
      "archived",
    ],
    ["branch-exists", { branch: null }, "fail", "Publish on a new branch"],
    [
      "branch-exists",
      { branch: undefined, reasons: { branch: "Timed out." } },
      "unknown",
      "Timed out.",
    ],
    [
      "path-supported",
      {
        target: {
          repository: "octocat/octocat",
          branch: "docs",
          path: "../secret",
        },
      },
      "fail",
      "README file path",
    ],
  ])("%s → %s blocks the verdict", (id, override, status, message) => {
    const report = evaluatePreflight(facts(override));
    expect(check(report, id)).toMatchObject({ status, blocking: true });
    expect(check(report, id).message).toContain(message);
    expect(report.verdict).toBe("read-only");
    expect(blockingFailure(report).id).toBe(id);
  });

  it.each([
    [{ configured: true, connected: false }, "session"],
    [{ configured: false }, "service"],
  ])(
    "without a chosen target, path support is unknown, not a failure",
    (local, blocker) => {
      const report = evaluatePreflight(local);
      expect(check(report, "path-supported")).toMatchObject({
        status: "unknown",
        message: "Requires a repository, branch and path.",
      });
      expect(report.checks.filter((c) => c.status === "fail")).toHaveLength(1);
      expect(blockingFailure(report).id).toBe(blocker);
    },
  );

  it("branch checks include archive state, and workflow permission for workflows", () => {
    expect(BRANCH_CHECKS).toContain("not-archived");
    expect(branchChecks()).toEqual(BRANCH_CHECKS);
    expect(branchChecks("workflow")).toEqual([
      ...BRANCH_CHECKS,
      "workflow-permission",
    ]);
    const archived = evaluatePreflight(
      facts({
        repository: { push: true, archived: true, defaultBranch: "main" },
      }),
    );
    expect(passes(archived, branchChecks())).toBe(false);
    const workflow = evaluatePreflight(
      facts({
        target: {
          repository: "octocat/octocat",
          branch: "docs",
          path: ".github/workflows/readme-studio.yml",
          kind: "workflow",
        },
      }),
    );
    expect(passes(workflow, branchChecks())).toBe(true);
    expect(passes(workflow, branchChecks("workflow"))).toBe(false);
  });

  it("marks dependent checks unknown instead of guessing", () => {
    const report = evaluatePreflight(facts({ connected: false }));
    for (const id of ["installation", "contents-permission", "branch-exists"])
      expect(check(report, id).status).toBe("unknown");
    expect(check(report, "path-supported").status).toBe("pass");
    expect(blockingFailure(report).id).toBe("session");
  });

  it("an unavailable service makes every check unknown and read-only", () => {
    const report = evaluatePreflight(
      { target: facts().target, unavailable: "You are offline." },
      { kind: "workflow" },
    );
    expect(report.checks.map((c) => c.id)).toContain("workflow-permission");
    expect(report.checks.every((c) => c.status === "unknown")).toBe(true);
    expect(report.checks.every((c) => c.message === "You are offline.")).toBe(
      true,
    );
    expect(report.verdict).toBe("read-only");
    expect(report.branchCommitSha).toBeNull();
  });

  describe("workflow-permission", () => {
    const workflow = {
      repository: "octocat/octocat",
      branch: "docs",
      path: ".github/workflows/readme.yml",
      kind: "workflow",
    };
    it("is evaluated only for workflow targets", () => {
      expect(check(evaluatePreflight(facts()), "workflow-permission")).toBe(
        undefined,
      );
      expect(evaluatePreflight(facts({ target: workflow })).target.kind).toBe(
        "workflow",
      );
    });
    it("fails without server opt-in even when the app grants workflows", () => {
      const report = evaluatePreflight(
        facts({
          target: workflow,
          installation: {
            permissions: { contents: "write", workflows: "write" },
          },
        }),
      );
      expect(check(report, "workflow-permission").status).toBe("fail");
      expect(check(report, "workflow-permission").message).toContain(
        "ALLOW_WORKFLOW_WRITES",
      );
      expect(report.verdict).toBe("read-only");
    });
    it("fails with opt-in but no Workflows: write", () => {
      const report = evaluatePreflight(
        facts({ target: workflow, allowWorkflows: true }),
      );
      expect(check(report, "workflow-permission")).toMatchObject({
        status: "fail",
        blocking: true,
      });
      expect(check(report, "workflow-permission").message).toContain(
        "Workflows: write",
      );
    });
    it("passes with opt-in and Workflows: write", () => {
      const report = evaluatePreflight(
        facts({
          target: workflow,
          allowWorkflows: true,
          installation: {
            permissions: { contents: "write", workflows: "write" },
          },
        }),
      );
      expect(check(report, "workflow-permission").status).toBe("pass");
      expect(check(report, "path-supported").message).toContain("workflow");
      expect(report.verdict).toBe("writable");
    });
    it("rejects a non-workflow path for a workflow target", () => {
      const report = evaluatePreflight(
        facts({ target: { ...workflow, path: "README.md" } }),
      );
      expect(check(report, "path-supported").status).toBe("fail");
    });
  });

  describe("advisory checks never flip the verdict", () => {
    it.each([
      ["classic protection", { branch: { protected: true, commitSha } }],
      ["pull request ruleset", { rules: [{ type: "pull_request" }] }],
      ["status check ruleset", { rules: [{ type: "required_status_checks" }] }],
      ["signed commits", { rules: [{ type: "required_signatures" }] }],
      ["update rule", { rules: [{ type: "update" }] }],
      ["no force push", { rules: [{ type: "non_fast_forward" }] }],
    ])("%s warns", (_, override) => {
      const report = evaluatePreflight(facts(override));
      expect(check(report, "branch-rules")).toMatchObject({
        status: "warn",
        blocking: false,
      });
      expect(report.verdict).toBe("writable");
    });
    it("ignores rules that do not affect direct commits", () => {
      const report = evaluatePreflight(
        facts({ rules: [{ type: "creation" }, { type: "deletion" }] }),
      );
      expect(check(report, "branch-rules").status).toBe("pass");
    });
    it("unreadable rules are unknown but still writable", () => {
      const report = evaluatePreflight(facts({ rules: undefined }));
      expect(check(report, "branch-rules")).toMatchObject({
        status: "unknown",
        blocking: false,
      });
      expect(report.verdict).toBe("writable");
      expect(blockingFailure(report)).toBeNull();
    });
    it("warns about committing directly to the default branch", () => {
      const report = evaluatePreflight(
        facts({ target: { ...facts().target, branch: "main" } }),
      );
      expect(check(report, "default-branch").status).toBe("warn");
      expect(check(report, "default-branch").message).toContain(
        "committing directly to the default branch",
      );
      expect(report.verdict).toBe("writable");
    });
    it("advisory warnings stay advisory when a blocking check fails", () => {
      const report = evaluatePreflight(
        facts({
          branch: { protected: true, commitSha },
          repository: { push: false, archived: false, defaultBranch: "docs" },
        }),
      );
      expect(blockingFailure(report).id).toBe("user-push");
    });
  });

  it("helpers compare named checks only", () => {
    const report = evaluatePreflight(
      facts({ installation: { permissions: { contents: "read" } } }),
    );
    expect(passes(report, READ_CHECKS)).toBe(true);
    expect(passes(report, ACCESS_CHECKS)).toBe(false);
    expect(blockingFailure(report, ["branch-exists"])).toBeNull();
    expect(passes(null, ["service"])).toBe(false);
  });
});

describe("PublishingClient injection", () => {
  it("refuses to send anything while offline", async () => {
    const fetchImpl = vi.fn();
    const client = new PublishingClient({ fetchImpl, online: () => false });
    await expect(client.request("preflight", {})).rejects.toThrow("offline");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reports network failure without leaking details and keeps CSRF", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrf: "token" }))
      .mockRejectedValueOnce(new Error("PRIVATE network detail"));
    const client = new PublishingClient({ fetchImpl, online: () => true });
    await client.request("session");
    await expect(client.request("preflight", {})).rejects.toThrow(
      "local draft and download are safe",
    );
    expect(fetchImpl.mock.calls[1][0]).toBe("/api/publishing/preflight");
    expect(fetchImpl.mock.calls[1][1].headers["X-Studio-CSRF"]).toBe("token");
  });
  it("passes the server's Preflight refusal marker through", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: "Cannot push.", preflight: "user-push" },
          { status: 403 },
        ),
      );
    const client = new PublishingClient({ fetchImpl, online: () => true });
    await expect(client.request("commit", {})).rejects.toMatchObject({
      status: 403,
      preflight: "user-push",
    });
  });
  it("surfaces server errors with status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "Busy." }, { status: 429 }));
    const client = new PublishingClient({ fetchImpl, online: () => true });
    await expect(client.request("preflight", {})).rejects.toMatchObject({
      message: "Busy.",
      status: 429,
    });
  });
});
