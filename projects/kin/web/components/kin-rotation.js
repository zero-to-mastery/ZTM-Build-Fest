// Taking turns on a routine (#433, #437, ADR 0016): shows whose turn it is
// and who is next, Skip to next, Give this turn to…, and an editor for who
// takes turns and in what order. The turn passes on its own when the
// routine is done (Rust). The element keeps its editor open across renders;
// kin-routines reuses one per routine.
import { assigneeLabel } from "./shared/assignee-label.js";

const MAX = 12;

class KinRotation extends HTMLElement {
  constructor() {
    super();
    this.value = null;
    this.editing = false;
    this.draft = [];
    this.isDisabled = false;
  }

  /** `{ routineId, text, rotation: { memberIds, current, next } | null,
   * memberId, memberIds (active, household order), names }`. */
  set record(value) {
    this.value = value;
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input, select")) control.disabled = this.isDisabled || control.dataset.off === "true";
  }

  label(id) {
    const { memberId, memberIds, names } = this.value;
    return assigneeLabel(id, { memberId, memberIds, names });
  }

  turnText(id) {
    return id === this.value.memberId ? "Your turn" : `${this.label(id)}'s turn`;
  }

  button(text, aria, key, onClick, off = false) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = text;
    if (aria) control.setAttribute("aria-label", aria);
    control.dataset.key = key;
    control.dataset.off = String(off);
    control.disabled = off || this.isDisabled;
    control.addEventListener("click", onClick);
    return control;
  }

  send(type, detail) {
    this.message.textContent = "";
    // Saving disables the controls, which drops focus; it comes back here.
    const key = this.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    this.dispatchEvent(new CustomEvent(type, {
      bubbles: true, composed: true,
      detail: { ...detail, done: (outcome) => {
        if (outcome?.ok) { this.editing = false; this.render(); }
        else if (this.message) this.message.textContent = outcome?.message ?? "Kin couldn't change the turns. Try again.";
        if (this.isConnected && !this.contains(document.activeElement) && (document.activeElement === document.body || !document.activeElement)) {
          const controls = [...this.querySelectorAll("[data-key]")].filter((node) => !node.disabled);
          (controls.find((node) => node.dataset.key === key) ?? controls[0])?.focus({ preventScroll: true });
        }
      } },
    }));
  }

  render() {
    if (!this.value) return;
    const focusKey = this.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const { routineId, text, rotation, memberIds } = this.value;
    const people = [...new Set(memberIds)].filter(Boolean);
    const parts = [];
    this.message = document.createElement("p");
    this.message.className = "compose-message";
    this.message.setAttribute("role", "alert");
    if (rotation && !this.editing) {
      const turn = document.createElement("p");
      turn.className = "rotation-turn";
      turn.textContent = rotation.current
        ? `${this.turnText(rotation.current)} · ${rotation.next === this.value.memberId ? "You" : this.label(rotation.next)} next`
        : "Taking turns is paused: fewer than two of the people listed are in the household.";
      const order = document.createElement("p");
      order.className = "rotation-order item-meta";
      order.textContent = `Taking turns: ${rotation.memberIds.map((id) => this.label(id)).join(" → ")}`;
      parts.push(turn, order);
      const actions = document.createElement("div");
      actions.className = "rotation-actions";
      if (rotation.current) {
        actions.append(this.button("Skip to next", `Skip to next: give ${text} to ${this.label(rotation.next)}`, "skip",
          () => this.send("kin:set-routine-turn", { routineId, memberId: rotation.next })));
        const others = rotation.memberIds.filter((id) => id !== rotation.current && people.includes(id));
        if (others.length > 1) {
          const select = document.createElement("select");
          select.dataset.key = "give";
          select.setAttribute("aria-label", `Give this turn of ${text} to…`);
          select.append(new Option("Give this turn to…", ""));
          for (const id of others) select.append(new Option(this.label(id), id));
          select.disabled = this.isDisabled;
          select.addEventListener("change", () => { if (select.value) this.send("kin:set-routine-turn", { routineId, memberId: select.value }); });
          actions.append(select);
        }
      }
      actions.append(
        this.button("Change who takes turns", `Change who takes turns on ${text}`, "change", () => this.openEditor(), people.length < 2),
        this.button("Stop taking turns", `Stop taking turns on ${text}`, "stop", () => this.send("kin:set-routine-rotation", { routineId, memberIds: [] })),
      );
      parts.push(actions, this.message);
    } else if (!this.editing) {
      if (people.length >= 2) parts.push(this.button("Take turns…", `Take turns on ${text}`, "start", () => this.openEditor()));
    } else {
      parts.push(...this.editor(people));
    }
    this.replaceChildren(...parts);
    if (focusKey) {
      const target = [...this.querySelectorAll("[data-key]")].find((node) => node.dataset.key === focusKey && !node.disabled);
      (target ?? this.querySelector("button:not([disabled]), input:not([disabled])"))?.focus({ preventScroll: true });
    }
  }

  openEditor() {
    const { rotation, memberIds } = this.value;
    const people = new Set(memberIds);
    if (rotation) {
      // Start from whose turn it is, so saving without changes keeps it.
      const at = Math.max(0, rotation.memberIds.indexOf(rotation.current));
      this.draft = [...rotation.memberIds.slice(at), ...rotation.memberIds.slice(0, at)].filter((id) => people.has(id));
    } else {
      this.draft = [];
    }
    this.editing = true;
    this.render();
    this.querySelector("input")?.focus();
  }

  editor(people) {
    const { routineId, text } = this.value;
    const group = document.createElement("fieldset");
    group.className = "rotation-editor";
    const legend = document.createElement("legend");
    legend.textContent = `Who takes turns on ${text}`;
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = "Tick people in the order they take turns. The first takes the next turn; it passes on when the routine is done.";
    group.append(legend, hint);
    for (const id of people) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.key = `pick:${id}`;
      box.checked = this.draft.includes(id);
      box.disabled = this.isDisabled || (!box.checked && this.draft.length >= MAX);
      box.addEventListener("change", () => {
        this.draft = box.checked ? [...this.draft, id] : this.draft.filter((member) => member !== id);
        this.render();
      });
      label.append(box, ` ${this.label(id)}`);
      group.append(label);
    }
    const order = document.createElement("ol");
    order.className = "rotation-draft";
    order.setAttribute("aria-label", "Turn order");
    this.draft.forEach((id, index) => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = this.label(id);
      row.append(name, this.button("↑", `Move ${this.label(id)} earlier`, `up:${id}`, () => {
        this.draft.splice(index, 1);
        this.draft.splice(index - 1, 0, id);
        this.render();
      }, index === 0));
      order.append(row);
    });
    const actions = document.createElement("div");
    actions.className = "rotation-actions";
    actions.append(
      this.button(this.value.rotation ? "Save turns" : "Start taking turns", null, "save",
        () => this.send("kin:set-routine-rotation", { routineId, memberIds: [...this.draft] }), this.draft.length < 2),
      this.button("Cancel", `Cancel changing turns on ${text}`, "cancel", () => { this.editing = false; this.render(); this.querySelector("button")?.focus(); }),
    );
    return [group, order, actions, this.message];
  }
}

if (!customElements.get("kin-rotation")) customElements.define("kin-rotation", KinRotation);
