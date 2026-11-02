import "../src/components/publish-dialog.js";
import { describe, it, expect } from "vitest";
import {
  documentTarget,
  documentGroup,
  findDocument,
  documentSettings,
  DocumentHistories,
} from "../src/workspace/documents.js";
import { newDraft, readDrafts, saveDrafts } from "../src/state/drafts.js";
import { Store } from "../src/state/store.js";
import {
  createBackup,
  validateWorkspace,
} from "../src/state/workspace-backup.js";
import { createProject, inspectProject } from "../src/studio-projects/model.js";
import "../src/components/workspace-documents.js";
const destination = {
  repository: "example/game",
  branch: "main",
  path: "README.md",
};
describe("multi-README workspace", () => {
  it("resolves legacy targets without migrating or mutating source", () => {
    const draft = newDraft("old");
    draft.metadata.importSource = {
      owner: "example",
      repository: "example",
      ref: "main",
      readmePath: "README.md",
    };
    expect(documentGroup(draft)).toBe("profile");
    expect(documentTarget(draft).repository).toBe("example/example");
    draft.metadata.workspaceDocument = documentSettings("local");
    expect(documentTarget(draft)).toBeNull();
    expect(documentGroup(draft)).toBe("local");
    expect(draft.markdown).toBe("");
  });
  it("validates targets and matches repository case without conflating branches or paths", () => {
    const draft = newDraft("game");
    draft.metadata.workspaceDocument = documentSettings(
      "repository",
      destination,
    );
    expect(
      findDocument([draft], { ...destination, repository: "EXAMPLE/GAME" }),
    ).toBe(draft);
    expect(
      findDocument([draft], { ...destination, branch: "next" }),
    ).toBeUndefined();
    expect(
      findDocument([draft], { ...destination, path: "docs/README.md" }),
    ).toBeUndefined();
    for (const path of [
      "../README.md",
      "<script>",
      "https://evil.example/README.md",
    ])
      expect(() =>
        documentSettings("repository", { ...destination, path }),
      ).toThrow();
    expect(() => documentSettings("unknown", destination)).toThrow();
  });
  it("preserves independent undo and redo across repeated switches", () => {
    const a = new Store(newDraft("A")),
      b = new Store(newDraft("B"));
    a.raw("A1");
    a.raw("A2");
    b.raw("B1");
    const histories = new DocumentHistories();
    histories.remember(a);
    histories.remember(b);
    const resumed = new Store(a.draft);
    histories.restore(resumed, [a.draft, b.draft]);
    resumed.undo();
    expect(resumed.draft.markdown).toBe("A1");
    histories.remember(resumed);
    const other = new Store(b.draft);
    histories.restore(other, [resumed.draft, b.draft]);
    other.undo();
    expect(other.draft.markdown).toBe("");
    const again = new Store(resumed.draft);
    histories.restore(again, [resumed.draft, other.draft]);
    again.redo();
    expect(again.draft.markdown).toBe("A2");
  });
  it("bounds inactive history and rejects stale or removed documents", () => {
    const store = new Store(newDraft("A"));
    store.raw("a".repeat(100));
    const histories = new DocumentHistories(10);
    histories.remember(store);
    expect(histories.items.size).toBe(0);
    const retained = new DocumentHistories();
    retained.remember(store);
    const changed = new Store({ ...store.draft, markdown: "replaced" });
    retained.restore(changed, [changed.draft]);
    expect(changed.past).toEqual([]);
    retained.remember(store);
    retained.restore(new Store(newDraft("B")), []);
    expect(retained.items.size).toBe(0);
  });
  it("round trips each source and target through reload, backup and portable project", () => {
    const a = new Store(newDraft("A")),
      b = new Store(newDraft("B"));
    a.raw("\ufeff# A\r\nExact source");
    b.raw("# B\nDifferent");
    a.draft.metadata.workspaceDocument = documentSettings("profile", {
      ...destination,
      repository: "example/example",
    });
    b.draft.metadata.workspaceDocument = documentSettings(
      "repository",
      destination,
    );
    const data = {
      drafts: [a.draft, b.draft],
      active: a.draft.id,
      settings: {},
    };
    const storage = {
      setItem(_, value) {
        this.value = value;
      },
      getItem() {
        return this.value;
      },
    };
    saveDrafts(data, storage);
    for (const workspace of [
      readDrafts(storage),
      validateWorkspace(createBackup(data)),
    ]) {
      expect(workspace.drafts.map((d) => d.markdown)).toEqual([
        a.draft.markdown,
        b.draft.markdown,
      ]);
      expect(workspace.drafts.map(documentGroup)).toEqual([
        "profile",
        "repository",
      ]);
      expect(documentTarget(workspace.drafts[1])).toEqual(destination);
    }
    const reopened = inspectProject(JSON.stringify(createProject(b.draft)));
    expect(documentTarget(reopened.draft)).toEqual(destination);
  });
  it("publishing suggests only this document's authorized target without reading or writing", async () => {
    const panel = document.createElement("publish-dialog");
    panel.innerHTML = "<section data-target></section><p data-status></p>";
    panel.auth = { identity: { login: "example" } };
    panel.draftSnapshot = newDraft("game");
    panel.draftSnapshot.metadata.workspaceDocument = documentSettings(
      "repository",
      { ...destination, branch: "develop", path: "docs/README.md" },
    );
    const requests = [];
    panel.client = {
      request: async (operation) => {
        requests.push(operation);
        return {
          repositories: [
            { repository: "example/game", branch: "main", writable: true },
          ],
        };
      },
    };
    await panel.loadRepositories();
    expect(panel.querySelector("[data-repo]").value).toBe("example/game");
    expect(panel.querySelector("[data-branch]").value).toBe("develop");
    expect(panel.querySelector("[data-path]").value).toBe("docs/README.md");
    expect(requests).toEqual(["repositories"]);
    panel.draftSnapshot.metadata.workspaceDocument.target.repository =
      "other/private";
    await panel.loadRepositories();
    expect(panel.querySelector("[data-repo]").value).toBe("");
    expect(panel.querySelector("[data-branch]").value).toBe("");
  });
  it("search renders names safely and announces the current document", () => {
    const draft = newDraft("<script>evil()</script>");
    const el = document.createElement("workspace-documents");
    el.configure([draft], draft.id);
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector('[aria-current="true"]').textContent).toContain(
      draft.name,
    );
    el.querySelector("[data-search]").value = "missing";
    el.list();
    expect(el.querySelector("[data-documents]").textContent).toContain(
      "No matching",
    );
  });
  it("opens the guided documentation suite without changing a document", () => {
    const draft = newDraft("Existing");
    draft.markdown = "# Existing exact source";
    const el = document.createElement("workspace-documents");
    el.configure([draft], draft.id);
    let opened = 0;
    el.addEventListener("document-suite", () => opened++);

    el.querySelector("[data-suite]").click();

    expect(opened).toBe(1);
    expect(draft.markdown).toBe("# Existing exact source");
  });
  it("opens the read-only cross-document link check", () => {
    const draft = newDraft("Existing");
    draft.markdown = "[Guide](docs/GUIDE.md)";
    const el = document.createElement("workspace-documents");
    el.configure([draft], draft.id);
    let opened = 0;
    el.addEventListener("document-links", () => opened++);

    el.querySelector("[data-links]").click();

    expect(opened).toBe(1);
    expect(draft.markdown).toBe("[Guide](docs/GUIDE.md)");
  });
});
