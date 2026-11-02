// Today's events and the next countdown on Today (#663, ADR 0022 §2), and
// reusable on the kitchen display (#669). The calendar controller calls
// update({ date, events, countdown, people }); `events` are the day's
// placed occurrences (all-day first, then by time), `countdown` a line such
// as "12 days until Trip" or "". With neither, the section says so quietly
// and offers the calendar; it never nags.
import { eventChip } from "./event-chip.js";

class KinCalendarToday extends HTMLElement {
  connectedCallback() {
    if (this.section) return;
    this.section = document.createElement("section");
    this.section.className = "today-section calendar-today";
    this.section.dataset.section = "calendar";
    this.section.setAttribute("aria-labelledby", "calendar-today-heading");
    const heading = document.createElement("h2");
    heading.id = "calendar-today-heading";
    heading.textContent = "Today's events";
    this.countdown = document.createElement("p");
    this.countdown.className = "calendar-countdown";
    this.list = document.createElement("ul");
    this.list.className = "cal-agenda-list calendar-today-list";
    this.empty = document.createElement("p");
    this.empty.className = "calendar-today-empty";
    this.link = document.createElement("a");
    this.link.className = "calendar-today-link";
    this.link.href = "#week/day";
    this.link.textContent = "Open the calendar";
    this.link.dataset.featureRoute = "week/day";
    this.section.append(heading, this.countdown, this.list, this.empty, this.link);
    this.append(this.section);
    this.render();
  }

  update({ date = null, events = [], countdown = "", people = null, readonly = false } = {}) {
    Object.assign(this, { date, events, countdownText: countdown, people, readonly });
    this.render();
  }

  render() {
    if (!this.section) return;
    const events = this.events ?? [];
    this.countdown.textContent = this.countdownText ?? "";
    this.countdown.hidden = !this.countdownText;
    this.list.replaceChildren(...events.map((placed) => {
      const item = document.createElement("li");
      item.append(eventChip(placed, this.date, this.people ?? { labelOf: (id) => id, colourOf: () => 0 }, { open: !this.readonly }));
      return item;
    }));
    this.list.hidden = !events.length;
    this.empty.textContent = "Nothing on the calendar today.";
    this.empty.hidden = Boolean(events.length);
  }
}

if (!customElements.get("kin-calendar-today")) customElements.define("kin-calendar-today", KinCalendarToday);
