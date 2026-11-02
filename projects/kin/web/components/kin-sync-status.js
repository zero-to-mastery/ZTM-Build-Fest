// Compact, truthful device/sync state for the header. It only names states
// the app actually knows: local save, coordinator ready/syncing/paused, and
// the browser's own offline signal. Relay acceptance is never shown as
// delivery or reading. Always text, never only a dot.

const LABELS = {
  local: ["On this device", "Local", "Changes are saved on this device. Device sync is not set up."],
  ready: ["Up to date", "Current", "This device has sent its changes and received the household's latest."],
  syncing: ["Syncing…", "Syncing", "Exchanging changes with the household relay."],
  paused: ["Sync paused", "Paused", "Changes are saved on this device until sync can continue."],
  offline: ["Offline — saved here", "Offline", "You're offline. Changes are saved on this device."],
  "offline-sync": ["Offline — saved here", "Offline", "You're offline. Changes are saved on this device and will sync when you're connected."],
};

class KinSyncStatus extends HTMLElement {
  constructor() {
    super();
    this.current = null;
  }

  connectedCallback() { this.render(); }

  set state(value) {
    this.current = LABELS[value] ? value : null;
    this.render();
  }
  get state() { return this.current; }

  render() {
    if (!this.current) { this.replaceChildren(); this.hidden = true; return; }
    const [label, compactLabel, description] = LABELS[this.current];
    const chip = document.createElement("span");
    chip.className = "sync-chip";
    chip.dataset.state = this.current;
    chip.dataset.compactLabel = compactLabel;
    const text = document.createElement("span");
    text.className = "sync-label";
    text.textContent = label;
    const desc = document.createElement("span");
    desc.className = "visually-hidden";
    desc.textContent = `. ${description}`;
    chip.append(text, desc);
    chip.title = description;
    this.replaceChildren(chip);
    this.hidden = false;
  }
}

customElements.define("kin-sync-status", KinSyncStatus);
