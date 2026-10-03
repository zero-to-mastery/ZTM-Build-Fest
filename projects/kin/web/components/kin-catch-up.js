class KinCatchUp extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;

    this.section = document.createElement("section");
    this.section.className = "catch-up-section today-section";
    this.heading = document.createElement("h2");
    this.heading.textContent = "Since you last checked";
    this.heading.tabIndex = -1;
    this.since = document.createElement("p");
    this.since.className = "catch-up-since";
    this.empty = document.createElement("p");
    this.empty.className = "empty-state";
    this.empty.textContent = "You're caught up.";
    this.list = document.createElement("ul");
    this.list.className = "catch-up-list";
    this.omitted = document.createElement("p");
    this.omitted.className = "catch-up-omitted";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "complete-button catch-up-button";
    this.button.textContent = "Caught up";
    this.section.append(
      this.heading,
      this.since,
      this.empty,
      this.list,
      this.omitted,
      this.button,
    );
    this.append(this.section);
    this.button.addEventListener("click", () => {
      if (!this.isDisabled) {
        this.dispatchEvent(
          new CustomEvent("kin:caught-up", {
            bubbles: true,
            composed: true,
          }),
        );
      }
    });
    this.render();
  }

  set summary(value) {
    this.value = value;
    this.render();
  }

  set lastLookedAt(value) {
    this.lookedAt = value;
    this.render();
  }

  set disabled(value) {
    this.isDisabled = value;
    if (this.button) this.button.disabled = value;
  }

  render() {
    if (!this.initialized) return;
    const restoreHeadingFocus = document.activeElement === this.button;
    const summary = this.value ?? { entries: [], totalCount: 0 };
    const entries = summary.entries ?? [];
    const hasChanges = summary.totalCount > 0;
    this.since.textContent = this.lookedAt
      ? `Since ${new Date(this.lookedAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}`
      : "Since your last check";
    this.empty.hidden = hasChanges;
    this.list.hidden = !hasChanges;
    this.button.hidden = !hasChanges;
    this.list.replaceChildren(
      ...entries.map((entry) => {
        const item = document.createElement("li");
        item.textContent = entryCopy(entry);
        return item;
      }),
    );
    const omittedCount = Math.max(0, summary.totalCount - entries.length);
    this.omitted.hidden = omittedCount === 0;
    this.omitted.textContent = `${omittedCount} earlier ${omittedCount === 1 ? "change" : "changes"}`;
    this.button.disabled = Boolean(this.isDisabled);
    if (restoreHeadingFocus && this.button.hidden) this.heading.focus();
  }
}

function entryCopy(entry) {
  switch (entry.kind) {
    case "routine-created": return `${entry.text} added to Routines`;
    case "routine-occurrence-completed": return `${entry.text} occurrence completed`;
    case "routine-occurrence-reopened": return `${entry.text} occurrence reopened`;
    case "routine-archived": return `${entry.text} archived`;
    case "item-added":
      return `${entry.text} added to ${entry.classification === "today" ? "Today" : "Needs"}`;
    case "item-completed":
      return `${entry.text} handled`;
    case "item-reopened":
      return `${entry.text} reopened`;
    case "item-archived":
      return `${entry.text} archived`;
    case "handoff-added":
      return `${entry.text} added to Handoff`;
    case "handoff-acknowledged":
      return `${entry.text} acknowledged`;
    case "handoff-archived":
      return `${entry.text} archived`;
    case "talk-added":
      return `${entry.text} added to Talk`;
    case "talk-resolved":
      return `${entry.text} resolved`;
    case "talk-reopened":
      return `${entry.text} reopened`;
    case "talk-archived":
      return `${entry.text} archived`;
    default:
      return "A household change was recorded";
  }
}

customElements.define("kin-catch-up", KinCatchUp);
