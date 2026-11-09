import { describe, expect, it } from "vitest";
import { buildFeedbackDiagnostics } from "../src/feedback/diagnostics.js";

describe("local feedback diagnostics", () => {
  it("requires an explicit opt-in and exposes only bounded aggregate fields", () => {
    expect(() => buildFeedbackDiagnostics({ consent: false })).toThrow(
      /opt in/i,
    );

    const report = buildFeedbackDiagnostics({
      consent: true,
      now: "2026-10-23T15:00:00.000Z",
      appVersion: "1.9.24",
      online: false,
      storageStatus: "temporary",
      reducedMotion: true,
      draftCount: 501,
      totalMarkdownLength: 987_654,
      blockCount: 10_000,
      scenario: "offline-recovery",
      outcome: "completed-with-friction",
      friction: ["navigation", "recovery-copy", "unknown", "navigation"],
      comment:
        "Contact me@example.com at https://private.example/path?token=secret",
    });

    expect(report).toEqual({
      schemaVersion: 1,
      createdAt: "2026-10-23T15:00:00.000Z",
      app: {
        version: "1.9.24",
        online: false,
        storageStatus: "temporary",
        reducedMotion: true,
      },
      workspace: {
        draftCount: "101+",
        markdownSize: "500 KB+",
        blockCount: "501+",
      },
      feedback: {
        scenario: "offline-recovery",
        outcome: "completed-with-friction",
        friction: ["navigation", "recovery-copy"],
      },
    });
    expect(JSON.stringify(report)).not.toContain("987654");
    expect(JSON.stringify(report)).not.toContain("private.example");
  });

  it("never accepts arbitrary prose or identifier-shaped extra fields", () => {
    const report = buildFeedbackDiagnostics({
      consent: true,
      appVersion: "1.9.24",
      now: "2026-10-23T15:00:00.000Z",
      comment: "AKIAIOSFODNN7EXAMPLE Draft Alpha octocat/private-repo",
      repository: "octocat/private-repo",
      draftName: "Draft Alpha",
    });
    expect(JSON.stringify(report)).not.toMatch(
      /AKIA|Draft Alpha|octocat|private-repo/,
    );
  });

  it("omits optional feedback instead of inventing or retaining it", () => {
    const report = buildFeedbackDiagnostics({
      consent: true,
      appVersion: "1.9.24",
      now: "2026-10-23T15:00:00.000Z",
    });
    expect(report.feedback).toEqual({});
    expect(report.workspace).toEqual({
      draftCount: "0",
      markdownSize: "0 KB",
      blockCount: "0",
    });
  });
});
