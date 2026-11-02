import { COMMANDS, filterCommands, SHORTCUTS } from "../keyboard-commands.js";

// The command palette and the keyboard shortcut help: two native modal
// dialogs in light DOM, styled by the app stylesheet like Quick add. The
// palette is an APG combobox over a listbox; options stay out of the tab
// order and the field keeps focus while Arrow keys move aria-activedescendant.
// Choosing an option only reports its allowlisted id to the host (onCommand),
// which performs it through the app's existing navigation and Quick add
// methods after the palette has closed. The query is never stored or logged.

class KinCommandPalette extends HTMLElement {
  constructor() {
    super();
    this.onCommand = null;
    this.onDismiss = null;
    this.matches = [];
    this.activeIndex = -1;
    this.opener = null;
    this.pendingCommand = null;
  }

  connectedCallback() {
    if (this.palette) return;
    this.palette = this.buildDialog("command-palette", "Commands");
    const label = document.createElement("label");
    label.htmlFor = "command-palette-input";
    label.textContent = "Search commands";
    this.input = document.createElement("input");
    this.input.id = "command-palette-input";
    this.input.type = "text";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-expanded", "true");
    this.input.setAttribute("aria-controls", "command-palette-list");
    this.input.setAttribute("aria-describedby", "command-palette-hint");
    this.list = document.createElement("ul");
    this.list.id = "command-palette-list";
    this.list.className = "command-palette-list";
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Commands");
    this.empty = document.createElement("p");
    this.empty.className = "command-palette-empty";
    this.empty.textContent = "No commands match. Try another word.";
    this.empty.hidden = true;
    this.count = document.createElement("p");
    this.count.className = "visually-hidden";
    this.count.setAttribute("role", "status");
    this.count.setAttribute("aria-live", "polite");
    const hint = document.createElement("p");
    hint.id = "command-palette-hint";
    hint.className = "command-palette-hint";
    hint.textContent = "Use the Up and Down arrow keys to choose, Enter to run, and Escape to close.";
    this.palette.append(label, this.input, this.list, this.empty, this.count, hint);

    this.help = this.buildDialog("shortcut-help", "Keyboard shortcuts");
    const helpHint = document.createElement("p");
    helpHint.className = "shortcut-help-hint";
    helpHint.textContent = "Single-key shortcuts work whenever you are not typing in a field.";
    const shortcuts = document.createElement("dl");
    shortcuts.className = "shortcut-list";
    for (const entry of SHORTCUTS) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const keys = document.createElement("dt");
      for (const combo of entry.combos) {
        const line = document.createElement("span");
        line.className = "shortcut-combo";
        combo.keys.forEach((name, index) => {
          if (index) line.append(combo.either ? " or " : " + ");
          line.append(this.keycap(name));
        });
        if (combo.platform) {
          const platform = document.createElement("span");
          platform.className = "shortcut-platform";
          platform.textContent = combo.platform;
          line.append(" ", platform);
        }
        keys.append(line);
      }
      const action = document.createElement("dd");
      action.textContent = entry.action;
      row.append(keys, action);
      shortcuts.append(row);
    }
    // Something not working? (ADR 0021 §3) The app opens the report once
    // this dialog has closed.
    const report = document.createElement("p");
    report.className = "shortcut-help-report";
    const reportButton = document.createElement("button");
    reportButton.type = "button";
    reportButton.textContent = "Report a problem";
    reportButton.addEventListener("click", () => {
      this.opener = null;
      this.help.close();
      this.dispatchEvent(new CustomEvent("kin:report-problem", { bubbles: true, composed: true }));
    });
    report.append(reportButton);
    this.help.append(helpHint, shortcuts, report);
    this.append(this.palette, this.help);

    this.input.addEventListener("input", () => this.render());
    this.input.addEventListener("keydown", (event) => this.handleKeydown(event));
    // Pointer selection must not pull focus out of the field first.
    this.list.addEventListener("mousedown", (event) => event.preventDefault());
    this.list.addEventListener("click", (event) => {
      const option = event.target.closest?.("[role='option']");
      if (option) this.activate(Number(option.dataset.index));
    });
    for (const dialog of [this.palette, this.help]) {
      dialog.addEventListener("close", () => this.handleClose(dialog));
      dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    }
  }

  disconnectedCallback() { this.dismiss(); }

  buildDialog(id, title) {
    const dialog = document.createElement("dialog");
    dialog.className = `command-dialog ${id}`;
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    const bar = document.createElement("div");
    bar.className = "command-dialog-bar";
    const heading = document.createElement("h2");
    heading.id = `${id}-title`;
    heading.tabIndex = -1;
    heading.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "command-dialog-close";
    close.textContent = "Close";
    close.addEventListener("click", () => dialog.close());
    bar.append(heading, close);
    dialog.append(bar);
    return dialog;
  }

  keycap(name) {
    const key = document.createElement("kbd");
    if (name === "Cmd") {
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "⌘ ";
      key.append(glyph, "Cmd");
    } else if (name === "↑" || name === "↓") {
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = name;
      const spoken = document.createElement("span");
      spoken.className = "visually-hidden";
      spoken.textContent = name === "↑" ? "Up arrow" : "Down arrow";
      key.append(glyph, spoken);
    } else {
      key.textContent = name;
    }
    return key;
  }

  get isOpen() { return Boolean(this.palette?.open || this.help?.open); }

  // Opening one dialog while the other is showing swaps them and keeps the
  // element the user started from, so Escape still returns there.
  openPalette({ opener = null } = {}) {
    if (!this.palette || !this.isConnected) return false;
    if (this.palette.open) { this.input.focus(); return true; }
    if (this.help.open) this.help.close();
    else this.opener = opener;
    this.pendingCommand = null;
    this.input.value = "";
    this.render();
    this.palette.showModal();
    this.input.focus();
    return true;
  }

  openHelp({ opener = null } = {}) {
    if (!this.help || !this.isConnected) return false;
    if (this.help.open) return true;
    if (this.palette.open) { this.pendingCommand = null; this.palette.close(); }
    else this.opener = opener;
    this.help.showModal();
    this.help.querySelector("h2").focus();
    return true;
  }

  // Lock, logout, and disconnection close both dialogs without running a
  // command or restoring focus into an interface that is going away.
  dismiss() {
    this.pendingCommand = null;
    this.opener = null;
    for (const dialog of [this.palette, this.help]) if (dialog?.open) dialog.close();
    if (this.input) this.input.value = "";
    this.matches = [];
    this.list?.replaceChildren();
  }

  handleClose(dialog) {
    const command = dialog === this.palette ? this.pendingCommand : null;
    if (dialog === this.palette) this.pendingCommand = null;
    // The other dialog took over (palette ↔ help); it now owns the opener.
    if (this.isOpen) return;
    const opener = this.opener;
    this.opener = null;
    if (!this.isConnected) return;
    if (command) this.onCommand?.(command, { opener });
    else this.onDismiss?.({ opener });
  }

  handleKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!this.matches.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.setActive((this.activeIndex + step + this.matches.length) % this.matches.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) this.activate(this.activeIndex);
    }
  }

  activate(index) {
    const command = this.matches[index];
    if (!command || !this.palette.open || this.pendingCommand) return;
    this.pendingCommand = command.id;
    this.palette.close(command.id);
  }

  render() {
    // `commands` leaves out switched-off features' commands (#625).
    this.matches = filterCommands(this.input.value, this.commands ?? COMMANDS);
    const options = this.matches.map((command, index) => {
      const option = document.createElement("li");
      option.id = `command-option-${command.id}`;
      option.className = "command-option";
      option.dataset.index = String(index);
      option.dataset.command = command.id;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      const label = document.createElement("span");
      label.className = "command-label";
      label.textContent = command.label;
      const description = document.createElement("span");
      description.className = "command-description";
      description.textContent = command.description;
      option.append(label, description);
      if (command.shortcut) {
        option.setAttribute("aria-keyshortcuts", command.shortcut === "?" ? "Shift+?" : command.shortcut);
        const shortcut = document.createElement("kbd");
        shortcut.className = "command-shortcut";
        shortcut.setAttribute("aria-hidden", "true");
        shortcut.textContent = command.shortcut;
        option.append(shortcut);
      }
      return option;
    });
    this.list.replaceChildren(...options);
    this.list.hidden = !options.length;
    this.empty.hidden = Boolean(options.length);
    this.input.setAttribute("aria-expanded", String(Boolean(options.length)));
    this.count.textContent = options.length
      ? `${options.length} ${options.length === 1 ? "command" : "commands"} available.`
      : "No commands match.";
    this.setActive(options.length ? 0 : -1);
  }

  setActive(index) {
    this.activeIndex = index;
    const options = [...this.list.children];
    options.forEach((option, position) => option.setAttribute("aria-selected", String(position === index)));
    const active = options[index] ?? null;
    if (active) {
      this.input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView?.({ block: "nearest" });
    } else {
      this.input.removeAttribute("aria-activedescendant");
    }
  }
}

customElements.define("kin-command-palette", KinCommandPalette);
