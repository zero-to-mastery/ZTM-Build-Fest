// "My calendar colour" in Identity & appearance (#663, ADR 0022 §1): twelve
// named colours as native radio buttons, plus "Kin's choice" (the default
// by join order). The household sees it beside the member's name on every
// event. The calendar controller calls update({ colour, chosen, people })
// and saves a choice from `kin:set-member-colour` ({ colour: 0–11 or
// null, done }).
import { MEMBER_PALETTE, colourClass } from "../../calendar/member-colours.js";

class KinMemberColour extends HTMLElement {
  connectedCallback() {
    if (this.form) return;
    this.form = document.createElement("form");
    this.form.className = "today-section member-colour";
    this.form.setAttribute("aria-labelledby", "member-colour-heading");
    this.form.addEventListener("submit", (event) => event.preventDefault());
    const heading = document.createElement("h2");
    heading.id = "member-colour-heading";
    heading.textContent = "My calendar colour";
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.id = "member-colour-hint";
    hint.textContent = "Your events show this colour, always with your name beside it. Everyone in your household sees it.";
    this.set = document.createElement("fieldset");
    this.set.className = "member-colour-choices";
    this.set.setAttribute("aria-describedby", hint.id);
    const legend = document.createElement("legend");
    legend.className = "visually-hidden";
    legend.textContent = "My calendar colour";
    this.set.append(legend);
    this.defaultChoice = this.choice("default", "Kin's choice", null);
    this.set.append(this.defaultChoice.wrap);
    this.choices = MEMBER_PALETTE.map((entry, index) => {
      const choice = this.choice(String(index), entry.name, index);
      this.set.append(choice.wrap);
      return choice;
    });
    this.feedback = document.createElement("p");
    this.feedback.className = "section-hint member-colour-feedback";
    this.feedback.setAttribute("role", "status");
    this.others = document.createElement("ul");
    this.others.className = "member-colour-others";
    this.others.setAttribute("aria-label", "Everyone's colours");
    this.form.append(heading, hint, this.set, this.feedback, this.others);
    this.append(this.form);
    this.render();
  }

  choice(value, label, index) {
    const wrap = document.createElement("label");
    wrap.className = "member-colour-choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "member-colour";
    input.value = value;
    input.addEventListener("change", () => { if (input.checked) this.choose(index); });
    const swatch = document.createElement("span");
    swatch.className = `cal-swatch ${index == null ? "cal-swatch-default" : colourClass(index)}`;
    swatch.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    wrap.append(input, swatch, text);
    return { wrap, input, swatch };
  }

  /** { colour (shown, 0–11), chosen (whether it's the member's own
   * choice), people ([{ memberId, label, colour }]), myId, disabled }. */
  update(value = {}) {
    Object.assign(this, { value });
    this.render();
  }

  render() {
    if (!this.form) return;
    const { colour = 0, chosen = false, people = [], myId = null, disabled = false } = this.value ?? {};
    this.defaultChoice.input.checked = !chosen;
    this.defaultChoice.swatch.className = `cal-swatch ${chosen ? "cal-swatch-default" : colourClass(colour)}`;
    this.defaultChoice.wrap.lastChild.textContent = chosen ? "Kin's choice" : `Kin's choice (${MEMBER_PALETTE[colour]?.name ?? ""})`;
    this.choices.forEach((choice, index) => { choice.input.checked = chosen && index === colour; });
    for (const input of this.set.querySelectorAll("input")) input.disabled = disabled || this.saving === true;
    this.others.replaceChildren(...people.filter((person) => person.memberId !== myId).map((person) => {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = `cal-swatch ${colourClass(person.colour)}`;
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch, document.createTextNode(` ${person.label}: ${MEMBER_PALETTE[person.colour]?.name ?? ""}`));
      return item;
    }));
    this.others.hidden = !this.others.children.length;
  }

  choose(index) {
    this.saving = true;
    this.feedback.textContent = "Saving…";
    this.render();
    this.dispatchEvent(new CustomEvent("kin:set-member-colour", {
      bubbles: true, composed: true,
      detail: {
        colour: index,
        done: (outcome) => {
          this.saving = false;
          this.feedback.textContent = outcome?.ok ? (index == null ? "Kin chooses your colour." : `Your colour is ${MEMBER_PALETTE[index].name}.`) : (outcome?.error ?? "Kin couldn't save your colour.");
          this.render();
        },
      },
    }));
  }
}

if (!customElements.get("kin-member-colour")) customElements.define("kin-member-colour", KinMemberColour);
