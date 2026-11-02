import { assigneeLabel } from "./shared/assignee-label.js";

class KinResponsibility extends HTMLElement {
  set record(value) { this.value = value; this.render(); }
  render() {
    if (!this.value) return;
    const { targetKind, targetId, text, ownerId, memberId, memberIds = [], names = null } = this.value;
    const status = document.createElement("span");
    status.className = "responsibility-status";
    const people = { memberId, memberIds, names };
    status.textContent = assigneeLabel(ownerId, people);
    this.replaceChildren(status);
    const action = (label, assignedMemberId) => {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = label; button.setAttribute("aria-label", label);
      button.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:change-responsibility", { detail: { targetKind, targetId, memberId: assignedMemberId }, bubbles: true, composed: true })));
      this.append(button);
    };
    if (ownerId !== memberId) action(`Take responsibility for ${text}`, memberId);
    for (const id of [...new Set(memberIds)].filter((id) => id && id !== memberId)) {
      if (ownerId !== id) action(`Assign ${text} to ${assigneeLabel(id, people)}`, id);
    }
    if (ownerId) action(`Clear responsibility for ${text}`, null);
  }
}
customElements.define("kin-responsibility", KinResponsibility);
