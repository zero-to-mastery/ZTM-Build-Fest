import { providers, generateWorkflow } from "../workflows/model.js";
import { html } from "../markdown/serialize.js";
import hljs from "highlight.js/lib/common";
export class WorkflowBuilder extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<h1>Workflow Builder</h1><p>Generate and review YAML locally. Studio never executes these workflows. Publishing a workflow can enable future scheduled writes on GitHub.</p><label>Workflow helper<select data-field="provider">${providers.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}</select></label><section data-upstream></section><div class="visual-fields">${[
      ["name", "Workflow name", "Constellation refresh"],
      ["filename", "Workflow filename", "constellation.yml"],
      ["username", "GitHub username (blank uses repository owner)", ""],
      ["repository", "Repository for README embed", "OWNER/REPOSITORY"],
      ["output", "SVG output path", "constellation.svg"],
      ["outputBranch", "Output branch", "output"],
      ["secretName", "Metrics secret NAME", "METRICS_TOKEN"],
      ["configPath", "Constellation config path (optional)", ""],
      ["action", "Custom action with version (optional)", ""],
    ]
      .map(
        ([k, n, v]) =>
          `<label>${n}<input data-field="${k}" value="${v}"></label>`,
      )
      .join(
        "",
      )}</div><label>Schedule<select data-field="schedule"><option value="manual">Manual only</option><option value="daily">Daily at 03:17 UTC</option><option value="weekly">Weekly Monday at 03:17 UTC</option><option value="custom">Custom cron (UTC)</option></select></label><label>Custom cron<input data-field="cron" value="17 3 * * *"></label><label class="check"><input type="checkbox" data-field="publish"> Workflow may publish generated images (requires Contents write)</label><label>Constellation inline config JSON (optional)<textarea data-field="configJson" rows="3"></textarea></label><label>Repository command (generic/asset refresh only)<textarea data-field="command" rows="3"></textarea></label><p>Enter secret names only. Add their values on GitHub → repository Settings → Secrets and variables → Actions. Do not paste tokens into Studio.</p><button data-generate>Generate YAML for review</button><p data-status role="status"></p><section data-output></section>`;
    this.querySelector("[data-field=provider]").onchange = () => {
      const p = providers.find(
        (p) => p.id === this.querySelector("[data-field=provider]").value,
      );
      for (const [key, value] of [
        ["name", `${p.name} refresh`],
        ["filename", `${p.id}.yml`],
        ["output", `${p.id}.svg`],
      ])
        this.querySelector(`[data-field=${key}]`).value = value;
      this.providerView();
      this.invalidate();
    };
    this.querySelectorAll("[data-field]").forEach((el) =>
      el.addEventListener("input", () => this.invalidate()),
    );
    this.querySelector("[data-generate]").onclick = () => this.generate();
    this.providerView();
  }
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }
  invalidate() {
    this.result = null;
    this.querySelector("[data-output]").replaceChildren();
    this.querySelector("[data-status]").textContent =
      "Settings changed. Generate a fresh YAML review.";
  }
  providerView() {
    const provider = providers.find(
      (p) => p.id === this.querySelector("[data-field=provider]").value,
    );
    this.querySelector("[data-upstream]").innerHTML =
      `<p>Upstream: <a href="${provider.project}" target="_blank" rel="noopener noreferrer">${provider.name}</a> · ${html(provider.ref || "your chosen command/action")}. ${html(provider.notes)}</p>`;
    for (const key of [
      "secretName",
      "configPath",
      "configJson",
      "action",
      "command",
      "outputBranch",
      "output",
    ])
      this.querySelector(`[data-field=${key}]`).closest("label").hidden =
        key === "secretName"
          ? provider.id !== "metrics"
          : key.startsWith("config")
            ? provider.id !== "constellation"
            : ["action", "command"].includes(key)
              ? !["generic", "asset-refresh"].includes(provider.id)
              : key === "outputBranch"
                ? !["constellation", "snake"].includes(provider.id)
                : ["generic", "asset-refresh"].includes(provider.id);
    this.querySelector("[data-field=publish]").closest("label").hidden = [
      "generic",
      "asset-refresh",
    ].includes(provider.id);
  }
  generate() {
    try {
      const raw = Object.fromEntries(
        [...this.querySelectorAll("[data-field]")]
          .filter((el) => !el.closest("label").hidden)
          .map((el) => [
            el.dataset.field,
            el.type === "checkbox" ? el.checked : el.value,
          ]),
      );
      this.result = generateWorkflow(raw);
      const r = this.result;
      this.querySelector("[data-output]").innerHTML =
        `<h2>Review ${html(r.path)}</h2><p>${html(r.permissionReason)}</p><ul>${r.attribution.map((a) => `<li><a href="${html(a.project)}" target="_blank" rel="noopener noreferrer">${html(a.ref)}</a></li>`).join("")}${r.warnings.map((w) => `<li>Warning: ${html(w)}</li>`).join("")}</ul><p>Static checks are advisory, not full GitHub Actions validation. Review upstream requirements before committing.</p><pre class="workflow-yaml" tabindex="0" aria-label="Highlighted workflow YAML"><code></code></pre><label>Generated YAML<textarea data-yaml readonly rows="12"></textarea></label><div class="row-actions"><button data-copy>Copy YAML</button><button data-download>Download YAML</button><button data-publish>Review workflow publishing</button></div><label>README embed<textarea data-embed readonly rows="4"></textarea></label><button data-insert ${r.embed ? "" : "disabled"}>Insert workflow README embed</button>`;
      this.querySelector("code").innerHTML = hljs.highlight(r.yaml, {
        language: "yaml",
      }).value;
      this.querySelector("[data-yaml]").value = r.yaml;
      this.querySelector("[data-embed]").value = r.embed;
      this.querySelector("[data-copy]").onclick = async () => {
        try {
          await navigator.clipboard.writeText(r.yaml);
          this.querySelector("[data-status]").textContent =
            "Workflow YAML copied.";
        } catch {
          const el = this.querySelector("[data-yaml]");
          el.focus();
          el.select();
          this.querySelector("[data-status]").textContent =
            "Clipboard unavailable. Copy the selected YAML.";
        }
      };
      this.querySelector("[data-download]").onclick = () =>
        this.emit("publish-download", {
          content: r.yaml,
          name: r.path.split("/").at(-1),
          type: "text/yaml",
        });
      this.querySelector("[data-publish]").onclick = () =>
        this.emit("workflow-publish", r);
      this.querySelector("[data-insert]").onclick = () =>
        this.emit("workflow-insert", { source: r.embed });
      this.querySelector("[data-status]").textContent =
        "Workflow generated locally. Review YAML before copying, downloading or publishing.";
    } catch (e) {
      this.result = null;
      this.querySelector("[data-output]").replaceChildren();
      this.querySelector("[data-status]").textContent = e.message;
    }
  }
}
customElements.define("workflow-builder", WorkflowBuilder);
