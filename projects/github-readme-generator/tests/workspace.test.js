import { describe, it, expect } from "vitest";
import {
  commands,
  searchWorkspace,
  validateActivity,
  activityEntry,
} from "../src/workspace/commands.js";
import { workspaceSettings } from "../src/state/workspace-backup.js";
describe("workspace navigation", () => {
  it("searches multiple terms and ranks exact prefixes without mutating entries", () => {
    expect(searchWorkspace(commands, "github publish")[0].id).toBe(
      "publish-github",
    );
    expect(searchWorkspace(commands, "no such tool")).toEqual([]);
    expect(
      searchWorkspace(
        Array.from({ length: 200 }, (_, i) => ({
          id: i,
          name: "Snippet " + i,
        })),
        "snippet",
      ),
    ).toHaveLength(50);
  });
  it("stores only known activity codes and bounded timestamps", () => {
    expect(activityEntry("unknown")).toBeNull();
    expect(
      validateActivity([
        { action: "publish-github", time: 123, token: "secret" },
        { action: "unknown", time: 2 },
      ]),
    ).toEqual([{ action: "publish-github", time: 123 }]);
    expect(
      validateActivity(Array.from({ length: 90 }, () => activityEntry("copy"))),
    ).toHaveLength(50);
  });
  it("allowlists preferences and excludes transient publishing state", () => {
    expect(
      workspaceSettings({
        pane: "preview",
        collapsed: true,
        closedGroups: ["GitHub", "evil"],
        editorFont: "18",
        token: "secret",
        publishing: true,
      }),
    ).toMatchObject({
      pane: "preview",
      collapsed: true,
      closedGroups: ["GitHub"],
      editorFont: "18",
    });
    expect(workspaceSettings({ pane: "bad", editorFont: "999" }).pane).toBe(
      "build",
    );
    expect(workspaceSettings({ token: "secret" })).not.toHaveProperty("token");
  });
});
