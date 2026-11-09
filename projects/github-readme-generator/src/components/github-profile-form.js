import { fetchGithubProfile } from "../state/github-profile.js";
import { autofillProfile, profileOptions } from "../state/profile-autofill.js";
import { html } from "../markdown/serialize.js";
const choices = [
  [
    "identity",
    "Fill name and username placeholders",
    "Replaces “Your Name”, GitHub your-name URLs, {{name}}, {{display_name}}, and {{username}}.",
  ],
  [
    "bio",
    "Use public bio and profile details",
    "Fills untouched sample introductions; adds company and location when available.",
  ],
  [
    "links",
    "Fill public contact links",
    "Uses GitHub, website, public email, and X / Twitter if provided. Keeps custom links.",
  ],
  [
    "stats",
    "Add GitHub stats snapshot",
    "Public repositories, followers, following, gists, received stars/forks, and join date.",
  ],
  [
    "projects",
    "Suggest up to three public projects",
    "Most-starred non-fork, non-archived repositories in the fetched set.",
  ],
  [
    "languages",
    "Add repository language summary",
    "Primary languages in non-fork repositories, with repository counts.",
  ],
  [
    "avatar",
    "Add GitHub avatar",
    "An ordinary linked image, hosted by GitHub.",
  ],
];
export const profileDraftSnapshot = (draft) =>
  JSON.stringify({
    id: draft.id,
    markdown: draft.markdown,
    blocks: draft.blocks,
    metadata: draft.metadata,
  });
export class GithubProfileForm extends HTMLElement {
  connectedCallback() {
    this.generation = 0;
    this.dialog = this.closest("dialog");
    this.closeHandler = () => {
      if (!this.dialog?.open) this.cancelLookup();
    };
    this.dialog?.addEventListener("close", this.closeHandler);
    this.innerHTML = `<div class="eyebrow">MAKE IT YOURS, FROM GITHUB</div><h1>Start with your public profile.</h1><p>Look up a username, review what’s available, and fill your README in one step.</p><form class="profile-lookup"><label>GitHub username or profile URL<input name="username" placeholder="octocat or https://github.com/octocat" required autocomplete="off"></label><button class="primary">Look up profile</button></form><p class="profile-status" role="status"></p><div class="profile-result"></div><p class="hint">Public data only. No token or sign-in. Applying changes is undoable. Private activity and contribution streaks are not available here.</p>`;
    this.querySelector("input").oninput = () => {
      this.cancelLookup();
      this.querySelector(".profile-result").replaceChildren();
      this.querySelector(".profile-status").textContent = "";
      this.querySelector("button").disabled = false;
    };
    this.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      this.cancelLookup();
      this.lookupController = new AbortController();
      const request = ++this.generation;
      const button = this.querySelector("button");
      const status = this.querySelector(".profile-status");
      button.disabled = true;
      this.querySelector(".profile-lookup").setAttribute("aria-busy", "true");
      status.textContent = "Loading public profile and repositories…";
      this.querySelector(".profile-result").replaceChildren();
      try {
        const profile = await fetchGithubProfile(
          new FormData(e.target).get("username"),
          fetch,
          this.lookupController.signal,
        );
        if (!this.isConnected || request !== this.generation) return;
        this.profile = profile;
        status.textContent =
          profile.warning || "Public profile loaded. Choose what to fill.";
        this.showResult();
        this.querySelector(".profile-choices input")?.focus();
      } catch (error) {
        if (this.isConnected && request === this.generation)
          status.textContent = error.message;
      } finally {
        if (request === this.generation) {
          button.disabled = false;
          this.querySelector(".profile-lookup").setAttribute(
            "aria-busy",
            "false",
          );
        }
      }
    };
  }
  cancelLookup() {
    this.generation++;
    this.lookupController?.abort();
    this.querySelector(".profile-lookup")?.setAttribute("aria-busy", "false");
  }
  disconnectedCallback() {
    this.cancelLookup();
    this.dialog?.removeEventListener("close", this.closeHandler);
  }
  set draft(value) {
    this.currentDraft = structuredClone(value);
    this.querySelector("input").value =
      value.metadata.githubProfile?.login || "";
  }
  showResult() {
    const p = this.profile;
    this.querySelector(".profile-result").innerHTML =
      `<div class="callout"><strong>${html(p.name)}</strong> <a href="${html(p.url)}" target="_blank" rel="noopener noreferrer">@${html(p.login)} ↗</a><p>${html(p.bio || "No public bio provided.")}</p><p>${[p.company, p.location, p.website, p.email, p.twitter ? `@${p.twitter}` : ""].filter(Boolean).map(html).join(" · ")}</p><p>${p.publicRepos ?? "Unknown"} public repositories · ${p.followers ?? "Unknown"} followers · ${p.following ?? "Unknown"} following</p><p>${p.fetchedRepos} repositories fetched${p.complete ? "" : " (incomplete)"}. ${p.stars} stars received on ${p.complete ? "" : "fetched "}non-fork repositories.</p></div><form class="profile-choices">${choices.map(([key, label, description]) => `<label class="profile-choice"><span><input type="checkbox" name="${key}" ${profileOptions[key] ? "checked" : ""}> ${label}</span><small>${description}</small></label>`).join("")}<p class="hint">${p.projects.length ? `Project suggestions: ${p.projects.map((r) => html(r.name)).join(", ")}.` : "No eligible public projects found."} ${p.languages.length ? `Languages: ${p.languages.map((l) => html(l.name)).join(", ")}.` : ""}</p><details><summary>Review resulting Markdown</summary><pre class="profile-markdown"></pre></details><p class="profile-preserved hint" role="status"></p><button class="primary" type="submit">Apply to current draft</button></form>`;
    const form = this.querySelector(".profile-choices");
    const prepare = () => {
      const options = Object.fromEntries(
        choices.map(([key]) => [key, form.elements[key].checked]),
      );
      this.result = autofillProfile(this.currentDraft, p, options);
      form.querySelector(".profile-markdown").textContent =
        this.result.markdown;
      form.querySelector(".profile-preserved").textContent = this.result
        .preserved.length
        ? `Kept your edited or detached sections: ${this.result.preserved.join(", ")}.`
        : "Existing custom text is preserved. Stats are dated snapshots, not live counters.";
      form.querySelector("button").disabled =
        !Object.values(options).some(Boolean);
    };
    form.onchange = prepare;
    prepare();
    form.onsubmit = (e) => {
      e.preventDefault();
      this.dispatchEvent(
        new CustomEvent("profile-apply", {
          detail: {
            ...this.result,
            draftId: this.currentDraft.id,
            snapshot: profileDraftSnapshot(this.currentDraft),
          },
          bubbles: true,
        }),
      );
    };
  }
}
customElements.define("github-profile-form", GithubProfileForm);
