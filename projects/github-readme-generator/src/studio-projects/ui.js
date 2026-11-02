import { html } from "../markdown/serialize.js";
import {
  createProject,
  inspectProject,
  PROJECT_LIMIT,
  projectFilename,
} from "./model.js";
import { restoreWorkspace, uniqueName } from "../state/workspace-backup.js";
import { validateLocalizationGraph } from "../localization/graph.js";

export function saveProjectDialog(app) {
  app.modal(
    `<h1>Save Studio project</h1><p>Download a portable file with exact README source and supported builder settings. It lists sections detached by raw edits by kind, and by name while that name is still in the README. Text you removed with a raw edit, including detached generated text, its titles and detached banner settings, stays in this browser and is not included. Public data fetched from GitHub (profile and repository details) is included as fetched. Browser autosave remains separate.</p><label>Project file name<input data-project-name maxlength="200" value="${html(app.store.draft.name)}"></label><label class="check"><input type="checkbox" data-project-libraries>Include reusable libraries (snippets, badge collections, themes and presets)</label><button data-save-project>Download Studio project</button><p data-project-status role="status"></p>`,
  );
  app.querySelector("[data-save-project]").onclick = () => {
    try {
      const name = app.querySelector("[data-project-name]").value.trim();
      if (!name) throw Error("Enter a project name.");
      const project = createProject(
        { ...app.store.draft, name },
        app.data.settings,
        app.querySelector("[data-project-libraries]").checked
          ? app.data
          : undefined,
      );
      app.download(
        JSON.stringify(project, null, 2),
        projectFilename(name),
        "application/json",
      );
      app.querySelector("[data-project-status]").textContent =
        "Project download started. Keep the file to reopen on another device.";
    } catch (error) {
      app.querySelector("[data-project-status]").textContent = error.message;
    }
  };
}
export function openProjectDialog(app) {
  app.modal(
    '<h1>Open Studio project</h1><p>Files are inspected locally. Opening creates a new draft; your current draft and original file stay unchanged.</p><label>Studio project file<input type="file" accept=".json,application/json" data-project-file></label><p data-project-status role="status"></p><div data-project-review></div>',
  );
  const input = app.querySelector("[data-project-file]");
  let request = 0;
  input.onchange = async () => {
    const id = ++request;
    const review = app.querySelector("[data-project-review]"),
      status = app.querySelector("[data-project-status]");
    review.replaceChildren();
    try {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > PROJECT_LIMIT)
        throw Error(
          "Project exceeds 10 MB. The file and drafts are unchanged.",
        );
      const raw = await file.text();
      if (id !== request || !input.isConnected || !app.dialog.open) return;
      const result = inspectProject(raw);
      status.textContent =
        result.warning || "Project validated. Review before opening.";
      review.innerHTML = `<h2>${html(result.name)}</h2><p>Schema ${html(result.schemaVersion)} · ${(file.size / 1024).toFixed(1)} KB · ${result.draft.blocks.length} blocks · ${result.assets.length} assets</p><p>${result.createdAt ? "Created " + html(result.createdAt) : "Recovery mode: structured settings will not be used."}</p><p>${result.draft.metadata?.repository || result.draft.metadata?.importSource ? "GitHub references included; no authentication session is restored." : "No linked GitHub target."}</p><details><summary>README source</summary><textarea readonly aria-label="Project README source" rows="8"></textarea></details>${result.mode === "project" ? '<label class="check"><input type="checkbox" data-project-settings>Use saved workspace preferences</label>' : ""}${result.libraries ? '<label class="check"><input type="checkbox" data-project-merge>Merge embedded libraries (keep both on collisions)</label>' : ""}<button data-open-project>${result.mode === "project" ? "Open as new draft" : "Open Markdown only"}</button><button data-recover-project>Download recovered README</button><button data-cancel-project>Cancel</button>`;
      review.querySelector("textarea").value = result.source;
      review.querySelector("[data-recover-project]").onclick = () =>
        app.download(result.source, "Recovered-README.md");
      review.querySelector("[data-cancel-project]").onclick = () =>
        app.closeDialog();
      review.querySelector("[data-open-project]").onclick = () => {
        app.save();
        const draft = structuredClone(result.draft);
        draft.id = crypto.randomUUID();
        draft.name = uniqueName(draft.name, app.data.drafts);
        if (app.data.drafts.length >= 500) {
          status.textContent =
            "Workspace already contains 500 drafts. Export and remove a draft first.";
          return;
        }
        let next;
        try {
          next =
            result.libraries &&
            review.querySelector("[data-project-merge]").checked
              ? restoreWorkspace(
                  app.data,
                  {
                    version: 1,
                    drafts: [draft],
                    active: draft.id,
                    settings: app.data.settings,
                    ...result.libraries,
                  },
                  "merge",
                )
              : { ...app.data, drafts: [...app.data.drafts, draft] };
          validateLocalizationGraph(next.drafts);
          if (review.querySelector("[data-project-settings]")?.checked)
            next.settings = result.settings;
        } catch (error) {
          status.textContent = error.message;
          return;
        }
        const opened = next.drafts.at(-1);
        app.data = next;
        app.load(opened.id);
        app.arrive("import", { origin: "project" });
        app.applySettings();
        app.mobile(app.data.settings.pane || "build", false);
        app.closeDialog(app.querySelector("#draft-select"));
        app.notify(
          result.mode === "project"
            ? "Studio project opened as a new draft."
            : "README recovered as custom Markdown. Original file unchanged.",
        );
      };
    } catch (error) {
      if (input.isConnected && id === request)
        status.textContent = error.message;
    }
  };
}
