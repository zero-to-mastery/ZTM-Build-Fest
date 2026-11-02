import { html } from "../markdown/serialize.js";
import {
  commandGroups,
  commands,
  searchWorkspace,
  activityEntry,
  validateActivity,
} from "./commands.js";
import { widgetRegistry as widgets } from "../widgets/registry.js";
import { template } from "../data/templates.js";
import {
  GOALS,
  goalIds,
  knownGoal,
  guideGoal,
  chooseGoal,
  goalOptions,
  blankDocument,
  createArrival,
  documentFacts,
  nextSteps,
  offlineHidden,
  arrivalContext,
  nextStepsEnabled,
  setNextSteps,
} from "./guide.js";

const privacyDocs =
  "https://github.com/mnichols08/readme-studio/blob/main/docs/privacy.md";
const goalHeadings = {
  profile: "Start your profile README",
  repository: "Start a repository README",
  audit: "Audit your repository READMEs",
};
// The Locality statement. It describes what this browser does today and must
// stay true: Markdown leaves only through publishing or the opt-in Writing
// Assistant, and nothing is published without its own review. The GitHub
// sentence must name every flow listed under "Network requests" in
// docs/privacy.md, and every other way data leaves the browser (link checks to
// third-party sites, the Writing Assistant) must be stated; extend it when a
// new network flow is added.
// Storage that works but holds an unreadable workspace is told apart from
// blocked storage: the original is still there and only recovery data has it.
function storageSentence(app) {
  if (app.storageBlocked && app.recoveryRaw !== undefined)
    return "Your saved workspace could not be read, so this is a temporary workspace: the original is left untouched in this browser, and nothing is saved over it until you restore a backup. Download original recovery data to keep the original; drafts you make now stay in memory only until this tab closes, so download all drafts backup to keep them.";
  if (app.storageBlocked)
    return "Browser storage is unavailable, so this is a temporary workspace: drafts stay in memory only until this tab closes. Download all drafts backup to keep your work.";
  return "Drafts are saved only in this browser. They are not encrypted and clearing site data removes them, so download a backup to keep a copy.";
}
function localityStatement(app) {
  return `<section class="guide-locality" aria-labelledby="guide-locality-title"><h2 id="guide-locality-title">Where your work is kept</h2><ul><li>${storageSentence(
    app,
  )}</li><li>GitHub is contacted only when you choose a GitHub action: import, autofill, audit, repository lookup, refresh and link checks, evidence and drift checks, or publishing. Link checks also contact the sites your links point to. Analysis runs in this browser: your Markdown is sent only when you publish it, or when you review and send text to the optional Writing assistant's provider. Images and badges in the preview load from their own sites.</li><li>Nothing is published without its own review.</li></ul><a href="${privacyDocs}" target="_blank" rel="noopener noreferrer">Privacy details</a></section>`;
}

// Guided start: step 1 asks for a Goal beside the earlier Start paths (their
// accessible names are kept) and Restore a backup, the first thing an author
// needs after losing browser data; step 2 offers existing flows for that Goal.
// Every option opens its tool's normal flow, so no document is changed here.
function installGuidedStart(app) {
  let firstRun = false;
  const content = () => app.querySelector(".dialog-content");
  const goalStep = (focusGoal) => {
    const current = guideGoal(app.data.guide);
    app.modal(
      `<div class="eyebrow">GUIDED START</div><h1>What do you want to do first?</h1><p>Choose a goal for a few ways to begin. Your goal never changes a document, and you can choose again from Create → Guided start.</p><ul class="guide-goals" aria-label="Goals">${goalIds
        .map(
          (id) =>
            `<li><button data-goal="${id}" aria-describedby="guide-goal-${id}${id === current ? " guide-current" : ""}"${id === current ? ' aria-current="true"' : ""}>${html(GOALS[id].label)} <span aria-hidden="true">→</span></button><p id="guide-goal-${id}">${html(GOALS[id].description)}</p>${id === current ? '<p class="guide-current" id="guide-current">Your current goal</p>' : ""}</li>`,
        )
        .join(
          "",
        )}</ul><section class="guide-paths" aria-labelledby="guide-paths-title"><h2 id="guide-paths-title">Other ways to start</h2><div class="welcome-options"><button data-start="templates">Start from a template <span>→</span></button><button data-action="profile">Autofill from GitHub <span>↗</span></button><button data-start="import">Import GitHub README <span>↥</span></button><button data-action="open-project">Open Studio project <span>↥</span></button><button data-start="blank">Start blank <span>+</span></button><button data-action="restore">Restore a backup <span>↥</span></button></div><button class="text-button" data-start="sample">Explore the sample profile →</button></section>${localityStatement(app)}`,
    );
    content()
      .querySelectorAll("[data-goal]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            app.data.guide = chooseGoal(app.data.guide, b.dataset.goal);
            app.save();
            optionStep(b.dataset.goal);
          }),
      );
    content()
      .querySelectorAll("[data-start]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const start = b.dataset.start;
            if (start === "templates") app.templates();
            else if (start === "import") app.importDialog();
            else {
              app.closeDialog();
              if (start === "blank" && app.addDraft("Untitled", [])) {
                app.arrive("blank");
                app.notify("Blank draft created.");
              }
              // On first run the sample is already open; later it is a copy.
              if (start === "sample" && !firstRun)
                app.addDraft("My developer profile", template(), {
                  workspaceDocument: blankDocument("profile"),
                });
            }
          }),
      );
    const target = focusGoal || current;
    if (target) content().querySelector(`[data-goal="${target}"]`)?.focus();
  };
  const optionStep = (goal) => {
    const online = navigator.onLine !== false;
    app.modal(
      `<div class="eyebrow">GUIDED START</div><h1 tabindex="-1">${goalHeadings[goal]}</h1><p>${html(GOALS[goal].description)}</p><div class="welcome-options guide-options">${goalOptions(
        goal,
        { online },
      )
        .map((o) =>
          o.unavailable
            ? `<button data-option="${o.id}" aria-disabled="true" aria-describedby="guide-unavailable">${html(o.label)}</button><p id="guide-unavailable" class="guide-unavailable">${html(o.unavailable)}</p>`
            : `<button data-option="${o.id}">${html(o.label)}</button>`,
        )
        .join(
          "",
        )}</div><button data-guide-back>Back</button><p class="hint">Each choice opens the tool's normal flow, with its usual review and Undo.</p>`,
    );
    content()
      .querySelectorAll("[data-option]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const id = b.dataset.option;
            // Unavailable means unavailable: what is announced is what happens,
            // even if the connection returns while this step is open.
            if (b.getAttribute("aria-disabled") === "true") return;
            if (id.startsWith("blank-")) {
              const kind = id.slice(6);
              app.closeDialog();
              if (
                app.addDraft(
                  kind === "profile" ? "Profile README" : "Repository README",
                  [],
                  { workspaceDocument: blankDocument(kind) },
                )
              ) {
                app.arrive("blank");
                app.notify("Blank draft created.");
              }
              return;
            }
            app.action(id);
            // The shared templates dialog lists the repository builder first;
            // this option promised profile templates, so start on the first.
            if (id === "templates")
              content().querySelector("[data-template]")?.focus();
          }),
      );
    content().querySelector("[data-guide-back]").onclick = () => goalStep(goal);
    content().querySelector("h1").focus();
  };
  app.openStart = ({ goal, firstRun: first = false } = {}) => {
    firstRun = first;
    if (app.dialog.open && !first) {
      app.closeDialog();
      if (app.dialog.open) return;
    }
    if (knownGoal(goal)) optionStep(goal);
    else goalStep();
  };
}

// The Next steps panel (ADR 0005). It sits directly after the batch bar so it
// stays above every pane, also on mobile. It is not a live region and never
// takes focus by itself; while a dialog is open, native modality makes it
// inert. Steps use the shared data-action dispatch, so each opens its tool's
// normal flow and the dialog close returns focus to the step button.
function installNextSteps(app) {
  const panel = document.createElement("section");
  panel.className = "next-steps";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "next-steps-title");
  panel.innerHTML =
    '<h2 id="next-steps-title">Next steps</h2><p data-next-context></p><ul class="next-step-list"></ul><p class="hint" data-next-offline hidden>GitHub steps are hidden while offline.</p><div class="next-steps-tools"><button data-action="command-palette">All tools</button><button data-next-hide>Hide</button></div>';
  app.querySelector(".batch-bar").after(panel);
  const list = panel.querySelector(".next-step-list");
  app.arrival = null;
  app.renderNextSteps = () => {
    const arrival = app.arrival,
      show =
        !!arrival &&
        arrival.draftId === app.store?.draft.id &&
        nextStepsEnabled(app.data.guide);
    panel.hidden = !show;
    if (!show) {
      list.replaceChildren();
      return;
    }
    const facts = {
      goal: guideGoal(app.data.guide),
      online: navigator.onLine !== false,
      storageBlocked: !!(app.storageBlocked || app.saveFailed),
      ...documentFacts(app.store.draft),
    };
    panel.querySelector("[data-next-context]").textContent =
      arrivalContext(arrival);
    panel.querySelector("[data-next-offline]").hidden = !offlineHidden(
      arrival,
      facts,
    );
    // Keyed by command: a step that stays keeps its button element, so focus
    // and the dialog's return target survive a re-render.
    const kept = new Map(
      [...list.children].map((item) => [item.dataset.step, item]),
    );
    const items = nextSteps(arrival, facts).map((step) => {
      let item = kept.get(step.command);
      if (!item) {
        item = document.createElement("li");
        item.dataset.step = step.command;
        item.innerHTML = `<button data-action="${step.command}" aria-describedby="next-step-${step.command}"></button><span id="next-step-${step.command}"></span>`;
      }
      item.querySelector("button").textContent = step.label;
      item.querySelector("span").textContent = step.reason;
      return item;
    });
    if (
      items.length !== list.children.length ||
      items.some((item, i) => list.children[i] !== item)
    ) {
      const before = [...list.querySelectorAll("button")],
        focused = document.activeElement;
      list.replaceChildren(...items);
      // A step that went away hands focus, and the closing dialog's return
      // targets, to the step now in its place.
      const after = [...list.querySelectorAll("button")],
        replace = (element) => {
          const at = before.indexOf(element);
          if (at < 0 || element.isConnected) return element;
          return after[Math.min(at, after.length - 1)] || element;
        };
      if (before.includes(focused)) replace(focused).focus();
      app.dialogTrigger = replace(app.dialogTrigger);
      app.afterDialogFocus = replace(app.afterDialogFocus);
    }
  };
  // Records an Arrival for a document (the active one by default) and shows
  // its Next steps. A new Arrival replaces the previous one.
  app.arrive = (kind, detail = {}, draftId = app.store?.draft.id) => {
    app.arrival = createArrival(draftId, kind, detail);
    // Changes recorded in the active document's history since the Arrival.
    app.arrivalChanges = 0;
    app.renderNextSteps();
  };
  // Undo and Redo are not dialogs, so they re-run the steps here. Undoing
  // past the import that changed this document means the Arrival no longer
  // describes it, so the panel goes away with the import.
  app.documentChanged = (source) => {
    const arrival = app.arrival;
    if (!arrival || arrival.draftId !== app.store?.draft.id) return;
    app.arrivalChanges += source === "undo" ? -1 : 1;
    if (source !== "undo" && source !== "redo") return;
    if (
      app.arrivalChanges < 0 &&
      arrival.kind === "import" &&
      arrival.detail.mode !== "new"
    )
      app.clearArrival();
    else app.renderNextSteps();
  };
  app.clearArrival = () => {
    app.arrival = null;
    app.renderNextSteps();
  };
  panel.querySelector("[data-next-hide]").onclick = () => {
    app.clearArrival();
    const input = app.editor?.input;
    (input?.getClientRects().length
      ? input
      : app.querySelector("#draft-select")
    ).focus();
  };
  // A tool may change the facts (a target set, sections split); connectivity
  // changes which GitHub steps can be offered.
  app.dialog.addEventListener("close", () => {
    if (!app.dialog.open) app.renderNextSteps();
  });
  addEventListener("online", () => app.renderNextSteps());
  addEventListener("offline", () => app.renderNextSteps());
}

export function installWorkspace(app) {
  installGuidedStart(app);
  installNextSteps(app);
  const actions = app.querySelector(".header-actions");
  actions.innerHTML =
    '<button data-action="command-palette">Search workspace <kbd>Ctrl K</kbd></button>';
  const tools = document.createElement("nav");
  tools.className = "workspace-tools";
  tools.setAttribute("aria-label", "Workspace tools");
  tools.innerHTML = Object.entries(commandGroups)
    .map(
      ([group, items]) =>
        `<details data-tool-group="${group}" ${app.data.settings.closedGroups?.includes(group) ? "" : "open"}><summary>${group}</summary><div>${items
          .filter(([id]) => !["drafts", "profile", "backup-all"].includes(id))
          .map(([id, name]) => `<button data-action="${id}">${name}</button>`)
          .join("")}</div></details>`,
    )
    .join("");
  app.querySelector(".app-header").after(tools);
  tools.querySelectorAll("details").forEach((d) =>
    d.addEventListener("toggle", () => {
      app.data.settings.closedGroups = [
        ...tools.querySelectorAll("details:not([open])"),
      ].map((e) => e.dataset.toolGroup);
      app.save();
    }),
  );
  app.openCommandPalette = () => {
    if (app.dialog.open) {
      app.closeDialog();
      if (app.dialog.open) return;
    }
    const draft = app.store.draft;
    const items = [
      ...commands,
      ...draft.blocks.map((b) => ({
        id: b.id,
        name: b.section?.title || b.settings.name || b.settings.title || b.type,
        category: "Sections",
        kind: "section",
      })),
      ...(app.data.badgeCollections?.items || []).map((c) => ({
        ...c,
        category: "Badge collections",
        kind: "collection",
      })),
      ...(app.data.componentLibrary?.snippets || []).map((c) => ({
        ...c,
        component: c,
        category: "Snippets",
        kind: "snippet",
      })),
      ...widgets.map((w) => ({ ...w, category: "Widgets", kind: "widget" })),
      ...draft.blocks
        .filter((b) => b.type === "projects")
        .flatMap((b) =>
          (b.settings.items || b.settings.projects || []).map((p) => ({
            id: b.id,
            name: p.name || p.title || "Project",
            category: "Projects",
            kind: "section",
          })),
        ),
    ];
    app.modal(
      '<h1>Search workspace</h1><label>Search commands and content<input type="search" data-search autocomplete="off"></label><p class="hint">Commands open their normal review flow. Enter chooses the first result; Tab explores results.</p><p data-search-count role="status"></p><div data-search-results></div>',
    );
    const input = app.querySelector("[data-search]"),
      results = app.querySelector("[data-search-results]");
    let found = [];
    const choose = (i) => {
      const item = found[i];
      if (!item) return;
      app.closeDialog();
      if (item.kind === "command") app.action(item.id);
      else if (item.kind === "section") {
        app.mobile("build");
        app.blockAction("edit", item.id);
        app.afterDialogFocus =
          app.content.querySelector("input,textarea,select") ||
          app.content.querySelector("button");
        app.afterDialogFocus?.focus();
      } else if (item.kind === "collection") {
        app.openCollections();
        const editor = app.querySelector("badge-collection-editor");
        editor.selected = item.id;
        editor.draw();
      } else if (item.kind === "widget") {
        app.openWidgets();
        app.querySelector("widget-hub").open(item.id);
      } else {
        app.openComponents();
        app.querySelector("component-library").open(item.component);
      }
    };
    const render = () => {
      found = searchWorkspace(items, input.value);
      results.innerHTML = found
        .map(
          (c, i) =>
            `<button class="wide" data-result="${i}">${html(c.name)} <small>${html(c.category)}</small></button>`,
        )
        .join("");
      app.querySelector("[data-search-count]").textContent = found.length
        ? `${found.length} results shown (maximum 50).`
        : "No matches. Try a section name or a tool such as badges.";
    };
    input.oninput = render;
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        choose(0);
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        results.querySelector("button")?.focus();
      }
    };
    results.onclick = (e) => {
      const b = e.target.closest("[data-result]");
      if (b) choose(Number(b.dataset.result));
    };
    render();
  };
  app.workspaceAction = (action) => {
    if (action === "guided-start") {
      app.openStart();
      return true;
    }
    if (action === "command-palette") {
      app.openCommandPalette();
      return true;
    }
    if (action === "show-preview" || action === "show-health") {
      app.mobile(action === "show-preview" ? "preview" : "health");
      return true;
    }
    // Next steps can open the Sections and Library builder tabs.
    if (action === "sections" || action === "library") {
      if (app.querySelector(".workspace").classList.contains("collapsed"))
        app.action("expand");
      app.mobile("build", false);
      app.showTab(action);
      const heading = app.content.querySelector("h2");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
      return true;
    }
    if (action === "activity") {
      const events = validateActivity(app.data.activity).reverse();
      app.modal(
        `<h1>Local activity</h1><p>Recent tool openings on this browser only. No document content, account data or network analytics.</p>${events.length ? `<ol>${events.map((e) => `<li>${html(commands.find((c) => c.id === e.action).name)} — ${html(new Date(e.time).toLocaleString())}</li>`).join("")}</ol>` : "<p>No activity yet. Open a tool to get started.</p>"}<button data-clear-activity>Clear activity</button>`,
      );
      app.querySelector("[data-clear-activity]").onclick = () => {
        app.data.activity = [];
        app.save();
        app.workspaceAction("activity");
      };
      return true;
    }
    if (action === "settings") {
      app.modal(
        `<h1>Workspace settings</h1><fieldset><legend>Editor</legend><label>Editor font size<select data-setting="editorFont"><option value="13">Small</option><option value="15">Medium</option><option value="18">Large</option></select></label></fieldset><fieldset><legend>Preview</legend><label>Default preview width<select data-setting="preview"><option value="1012">Desktop</option><option value="760">Narrow</option><option value="640">Tablet</option><option value="375">Mobile</option></select></label></fieldset><fieldset><legend>Accessibility</legend><label class="check"><input type="checkbox" data-setting="reduceMotion">Reduce motion</label><p>System reduced-motion preferences are also respected. Escape closes dialogs; Shift+Tab leaves the editor.</p></fieldset><fieldset><legend>Guidance</legend><label class="check"><input type="checkbox" data-guide-setting="nextSteps">Show next steps after imports, audits and templates</label><p>Next steps only open existing tools. Search workspace always lists every tool.</p></fieldset><fieldset><legend>GitHub</legend><p>Connection is optional. Publishing always requires a separate review.</p><button data-action="publish-github">Open publishing</button></fieldset><fieldset><legend>Storage</legend><button data-action="backup-all">Download all drafts backup</button><button data-action="restore">Restore backup</button></fieldset><fieldset><legend>Voluntary feedback</legend><p>Create a redacted diagnostic file locally. Studio never sends it.</p><button data-action="feedback-diagnostics">Open local feedback export</button></fieldset><details><summary>Advanced</summary><p>Analysis runs locally. Download a backup before clearing browser data.</p><a href="https://github.com/mnichols08/readme-studio/blob/main/docs/contributing.md" target="_blank" rel="noopener noreferrer">Contributor documentation</a></details>`,
      );
      app.querySelectorAll("[data-setting]").forEach((e) => {
        const key = e.dataset.setting;
        if (e.type === "checkbox") e.checked = !!app.data.settings[key];
        else e.value = String(app.data.settings[key] || 15);
        e.onchange = () => {
          app.data.settings[key] = e.type === "checkbox" ? e.checked : e.value;
          app.applySettings();
          app.save();
        };
      });
      // A workspace preference (ADR 0004), not a setting: projects never
      // carry it.
      const guidance = app.querySelector("[data-guide-setting]");
      guidance.checked = nextStepsEnabled(app.data.guide);
      guidance.onchange = () => {
        app.data.guide = setNextSteps(app.data.guide, guidance.checked);
        app.save();
        app.renderNextSteps();
      };
      return true;
    }
    if (action === "feedback-diagnostics") {
      app.modal(
        '<h1>Local feedback export</h1><p data-feedback-loading role="status">Loading local feedback tools…</p>',
      );
      const loading = app.querySelector("[data-feedback-loading]");
      import("../feedback/dialog.js")
        .then(({ openFeedbackDiagnostics }) => {
          if (loading.isConnected && app.dialog.open)
            openFeedbackDiagnostics(app);
        })
        .catch(() => {
          if (loading.isConnected)
            loading.textContent =
              "Local feedback tools could not load. Nothing was recorded; reload and try again.";
        });
      return true;
    }
    if (action === "audience-review") {
      app.modal(
        '<h1>Audience review</h1><p data-audience-loading role="status">Loading local audience review…</p>',
      );
      const loading = app.querySelector("[data-audience-loading]");
      import("../audience/dialog.js")
        .then(({ openAudienceReview }) => {
          if (loading.isConnected && app.dialog.open) openAudienceReview(app);
        })
        .catch(() => {
          if (loading.isConnected)
            loading.textContent =
              "Audience review could not load. Your source is unchanged; reload and try again.";
        });
      return true;
    }
    if (action === "learning-studio") {
      app.modal(
        '<h1>Learning studio</h1><p data-learning-loading role="status">Loading local learning tools…</p>',
      );
      const loading = app.querySelector("[data-learning-loading]");
      import("../learning/dialog.js")
        .then(({ openLearningStudio }) => {
          if (loading.isConnected && app.dialog.open) openLearningStudio(app);
        })
        .catch(() => {
          if (loading.isConnected)
            loading.textContent =
              "Learning tools could not load. Your source and checklist progress are unchanged; reload and try again.";
        });
      return true;
    }
    if (action === "translation-review") {
      app.modal(
        '<h1>Translation review</h1><p data-translation-loading role="status">Loading local translation review…</p>',
      );
      const loading = app.querySelector("[data-translation-loading]");
      import("../localization/dialog.js")
        .then(({ openTranslationReview }) => {
          if (loading.isConnected && app.dialog.open)
            openTranslationReview(app);
        })
        .catch(() => {
          if (loading.isConnected)
            loading.textContent =
              "Translation review could not load. Source and localization metadata are unchanged; reload and try again.";
        });
      return true;
    }
    const event = activityEntry(action);
    if (event) {
      app.data.activity = validateActivity([
        ...(app.data.activity || []),
        event,
      ]);
      app.save();
    }
    return false;
  };
}
