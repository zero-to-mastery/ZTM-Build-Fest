// The status page (ADR 0025 §11, #720): is the home server reachable, is
// its certificate good, and how big is it. Everything here is a count, a
// date, a state or an error code put in plain words (explain.js); the
// server sends no household content (server/home/control-panel.mjs).
//
// Each section is a <section data-section="…">. "backups" (#721) and
// "updates" (#722) come from the server's sections; `SECTIONS` below says
// how each renders.
import { el, details } from "./dom.js";
import { explain, explainBackupCopyState, explainBackupState, explainCertificateState, explainTransparency, explainTunnelState } from "./explain.js";
import { countOf, formatBytes, formatDate, formatDateTime, formatHour } from "./format.js";

const tone = (good) => (good ? "good" : "attention");

function headline(status) {
  const relay = status.relay;
  const certificate = status.certificate;
  if (!relay || !certificate) return { tone: "attention", text: "This home server isn't set up yet." };
  if (certificate.transparency?.state === "alert") return { tone: "alert", text: "Check the certificate log: a certificate this server didn't make was found." };
  if (!relay.connected || !relay.routed) return { tone: "attention", text: "Phones can't reach this home server right now." };
  if (!certificate.notAfter || certificate.state === "expired") return { tone: "attention", text: "This home server has no valid certificate." };
  if (certificate.expiringSoon) return { tone: "attention", text: "The certificate runs out soon." };
  return { tone: "good", text: "Everything is working." };
}

function relaySection(status) {
  const relay = status.relay;
  const section = el("section", { className: "control-card", "data-section": "relay", "aria-labelledby": "status-relay" }, el("h2", { id: "status-relay", text: "Connection" }));
  if (!relay) {
    section.append(el("p", { text: "Not connected: setup hasn't chosen a name yet." }));
    return section;
  }
  const good = relay.connected && relay.routed;
  section.dataset.tone = tone(good);
  section.append(el("p", { className: "control-state", text: explainTunnelState(relay.state) }));
  const pairs = [
    ["Relay", relay.relay],
    [relay.connected ? "Connected since" : "Last change", formatDateTime(relay.since)],
  ];
  if (!relay.connected && relay.nextAttemptAt) pairs.push(["Next try", formatDateTime(relay.nextAttemptAt)]);
  section.append(details(pairs));
  for (const problem of [relay.nameError, relay.lastError].filter(Boolean))
    section.append(el("p", { className: "control-problem", "data-code": problem.code, text: explain(problem.code) }));
  return section;
}

function nameSection(status) {
  const section = el("section", { className: "control-card", "data-section": "name", "aria-labelledby": "status-name" }, el("h2", { id: "status-name", text: "Name" }));
  if (!status.name) {
    section.append(el("p", { text: "No name chosen yet." }));
    return section;
  }
  section.append(details([
    ["Address", el("a", { href: status.origin, text: status.origin })],
    ["Kind", status.freeName ? "A free name from the relay" : "Your own domain"],
    ["Routed by the relay", status.relay?.routed ? "Yes" : "Not right now"],
  ]));
  return section;
}

function certificateSection(status) {
  const certificate = status.certificate;
  const section = el("section", { className: "control-card", "data-section": "certificate", "aria-labelledby": "status-certificate" }, el("h2", { id: "status-certificate", text: "Certificate" }));
  if (!certificate) {
    section.append(el("p", { text: "No certificate yet." }));
    return section;
  }
  section.dataset.tone = tone(Boolean(certificate.notAfter) && !certificate.expiringSoon && certificate.state !== "expired" && certificate.transparency?.state !== "alert");
  section.append(el("p", { className: "control-state", text: explainCertificateState(certificate.state) }));
  section.append(details([
    ["Valid until", certificate.notAfter ? `${formatDate(certificate.notAfter)}${Number.isInteger(certificate.daysLeft) ? ` (${countOf(certificate.daysLeft, "day", "days")} left)` : ""}` : "No certificate yet"],
    ["Next renewal", certificate.renewAt ? formatDate(certificate.renewAt) : certificate.nextAttemptAt ? formatDateTime(certificate.nextAttemptAt) : null],
    ["Issued by", certificate.issuer],
    ["Certificate log check", explainTransparency(certificate.transparency?.state)],
  ]));
  if (certificate.lastError) section.append(el("p", { className: "control-problem", "data-code": certificate.lastError.code, text: explain(certificate.lastError.code) }));
  if (certificate.transparency?.state === "alert") section.dataset.tone = "alert";
  return section;
}

/** A section a later task provides (#721, #722): until then it says so. */
function seamSection(id, title, value, describe, lead = []) {
  const section = el("section", { className: "control-card", "data-section": id, "aria-labelledby": `status-${id}` }, el("h2", { id: `status-${id}`, text: title }), ...lead);
  if (!value || value.state === "not-built") section.append(el("p", { className: "control-muted", text: describe.notBuilt }));
  else if (value.state === "error") section.append(el("p", { className: "control-problem", text: describe.error }));
  else {
    section.append(...describe.render(value));
    const sectionTone = describe.tone?.(value);
    if (sectionTone) section.dataset.tone = sectionTone;
  }
  return section;
}

function backupNext(value) {
  if (value.state === "off" || value.state === "restoring") return null;
  if (value.state === "running") return "Now";
  if (value.due) return "Within a few minutes";
  return value.nextBackupAt ? formatDateTime(value.nextBackupAt) : null;
}

const UPDATE_STAGES = {
  downloading: "downloading it",
  preparing: "unpacking it",
  "backing-up": "backing up first",
  trying: "trying it for five minutes",
};

function updateState(value) {
  const available = value.available;
  if (value.state === "off") return "This build of Kin doesn't check for updates. New versions are on the releases page.";
  if (value.state === "not-checked") return "Kin checks for updates once a day. It hasn't checked yet.";
  if (value.state === "installing") return `Installing Kin ${available?.version ?? "the update"}: ${UPDATE_STAGES[value.stage] ?? "working on it"}…`;
  if (value.state === "failed") return "Kin couldn't check for updates. It tries again later.";
  if (!available) return "This is the newest version.";
  if (available.blocked === "too-old") return `Kin ${available.version} is available, but this version is too old to update to it by itself. Download it from the releases page.`;
  if (available.install === "manual") return `Kin ${available.version} is available. This copy of Kin can't update itself (only Kin installed as a service does): download it from the releases page.`;
  if (available.install === "automatic") return `Kin ${available.version} is available. Kin installs it by itself tonight, between 02:00 and 05:00, after a backup.`;
  return `Kin ${available.version} is available. ${available.kind === "major" ? "It's a bigger update, so it waits for you" : "It waits for you"}: install it in the settings below.`;
}

function lastUpdate(update) {
  if (!update) return null;
  if (update.outcome === "updated") return el("p", { className: "control-state", "data-update": "updated", text: `Updated from Kin ${update.from} to ${update.to} on ${formatDateTime(update.at)}.` });
  if (update.outcome === "rolled-back")
    return el("p", { className: "control-problem", "data-update": "rolled-back", "data-code": update.code, text: `Kin ${update.to} didn't work here, so Kin went back to ${update.from} and to its data from just before the update. ${explain(update.code)}` });
  return el("p", { className: "control-problem", "data-update": "failed", "data-code": update.code, text: `Kin ${update.to} wasn't installed. ${explain(update.code)}` });
}

/** The copy to a second folder (#763), in a few words for its row. */
function copyRow(copy) {
  if (!copy) return null;
  if (copy.state === "off") return "Not set up";
  if (copy.state === "waiting") return "Kin is checking the folder";
  if (copy.state === "ok") return copy.copies > 0 && copy.lastCopiedCreatedAt ? `${countOf(copy.copies, "copy", "copies")}, the newest from ${formatDateTime(copy.lastCopiedCreatedAt)}` : "No backups to copy yet";
  return explainBackupCopyState(copy.state);
}

function lastRestore(restore) {
  if (!restore) return null;
  if (restore.outcome === "restored")
    return el("p", { className: "control-state", "data-restore": "restored", text: `The backup from ${formatDateTime(restore.backupCreatedAt)} was restored on ${formatDateTime(restore.at)}.${restore.homeRestored ? " Its home folder came with it: this is the same home server, with the same name." : ""}` });
  return el("p", { className: "control-problem", "data-restore": "failed", "data-code": restore.code, text: `The restore on ${formatDateTime(restore.at)} didn't happen, and Kin kept the data it had. ${explain(restore.code)}` });
}

/** How each section a later task provides renders. */
export const SECTIONS = {
  backups: {
    title: "Backups",
    notBuilt: "Scheduled backups aren't part of this version yet. Until then, back up with “kin admin backup”, as the home server guide shows.",
    error: "Kin couldn't read the backup status.",
    tone: (value) => (value.state === "failed" || value.lastRestore?.outcome === "failed" || value.copy?.state === "failed" || (value.copy?.notPrivate && value.copy.state !== "off") ? "attention" : value.state === "ok" || value.state === "running" ? "good" : null),
    render: (value) => [
      el("p", { className: "control-state", text: explainBackupState(value.state) }),
      details([
        ["Last backup", value.lastBackupAt ? formatDateTime(value.lastBackupAt) : "None yet"],
        ["Next backup", backupNext(value)],
        ["Every day at", Number.isInteger(value.hour) ? formatHour(value.hour) : null],
        ["Kept", Array.isArray(value.backups) ? `${countOf(value.backups.length, "backup", "backups")} of the newest ${value.kept ?? 14}, ${formatBytes(value.totalBytes)} in all` : null],
        ["Second copy", copyRow(value.copy)],
      ]),
      ...(value.lastError ? [el("p", { className: "control-problem", "data-code": value.lastError.code, text: explain(value.lastError.code) })] : []),
      ...(value.copy?.state === "failed" && value.copy.lastError ? [el("p", { className: "control-problem", "data-code": value.copy.lastError.code, text: explain(value.copy.lastError.code) })] : []),
      ...(value.copy?.notPrivate && !["off", "waiting"].includes(value.copy.state) ? [el("p", { className: "control-problem", "data-code": "backup-copy-not-private", text: explain("backup-copy-not-private") })] : []),
      // Waiting can last: a Kin started without its launcher never copies.
      ...(["off", "waiting"].includes(value.copy?.state) ? [el("p", { className: "control-muted", "data-copy": value.copy.state, text: explainBackupCopyState(value.copy.state) })] : []),
      ...[lastRestore(value.lastRestore)].filter(Boolean),
      el("p", { className: "control-muted", text: "A backup holds this home server's keys as well as Kin's data: whoever has a copy could pretend to be your home server. Keep backups, and any drive they're copied to, as private as this computer." }),
    ],
  },
  updates: {
    title: "Version and updates",
    notBuilt: "Kin doesn't check for updates by itself yet.",
    error: "Kin couldn't read the update status.",
    tone: (value) => (value.state === "failed" || ["rolled-back", "failed"].includes(value.lastUpdate?.outcome) ? "attention" : null),
    render: (value) => [
      el("p", { className: "control-state", "data-state": value.state, text: updateState(value) }),
      details([
        ["Last checked", value.checkedAt ? formatDateTime(value.checkedAt) : null],
        ["Available", value.available ? `Kin ${value.available.version}, released ${formatDate(value.available.releasedAt)}` : null],
        ["Release notes", value.available?.page ? el("a", { href: value.available.page, rel: "noopener", text: "On the releases page" }) : null],
        ["Automatic updates", value.state === "off" ? null : value.autoUpdate === false ? "Off: updates wait for you" : "On: smaller updates install at night"],
      ]),
      ...(value.state === "failed" && value.lastError ? [el("p", { className: "control-problem", "data-code": value.lastError.code, text: explain(value.lastError.code) })] : []),
      ...[lastUpdate(value.lastUpdate)].filter(Boolean),
    ],
  },
};

function storageSection(status) {
  const { databaseBytes, freeBytes } = status.storage ?? {};
  return el("section", { className: "control-card", "data-section": "storage", "aria-labelledby": "status-storage" },
    el("h2", { id: "status-storage", text: "Storage" }),
    details([
      ["Kin's database", formatBytes(databaseBytes)],
      ["Free on this disk", formatBytes(freeBytes)],
    ]));
}

function countsSection(status) {
  const { households = 0, devices = 0 } = status.counts ?? {};
  const limits = status.limits ?? {};
  return el("section", { className: "control-card", "data-section": "counts", "aria-labelledby": "status-counts" },
    el("h2", { id: "status-counts", text: "Households and devices" }),
    el("p", { className: "control-muted", text: "Counts only. The control panel never shows what households keep in Kin." }),
    details([
      ["Households", countOf(households, "household", "households")],
      ["Trusted devices", countOf(devices, "device", "devices")],
      ["New households", limits.allowNew === false ? "Closed" : Number.isInteger(limits.maxHouseholds) ? `Up to ${countOf(limits.maxHouseholds, "household", "households")} on this server` : "No limit"],
    ]));
}

function versionSection(status) {
  return seamSection("updates", SECTIONS.updates.title, status.updates, SECTIONS.updates, [details([["Kin version", status.version]])]);
}

export class KinControlStatus extends HTMLElement {
  #status = null;

  get status() { return this.#status; }
  set status(value) {
    const same = this.#status && value && JSON.stringify({ ...this.#status, checkedAt: null }) === JSON.stringify({ ...value, checkedAt: null });
    this.#status = value;
    // Polling: only the "checked" time changed, so focus stays put.
    if (same) { const checked = this.querySelector(".control-checked"); if (checked) { checked.textContent = `Checked ${formatDateTime(value.checkedAt)}.`; return; } }
    this.render();
  }

  render() {
    const status = this.#status;
    if (!status) { this.replaceChildren(); return; }
    const summary = headline(status);
    this.replaceChildren(
      el("p", { className: "control-headline", "data-tone": summary.tone, text: summary.text }),
      el("div", { className: "control-grid" },
        relaySection(status),
        nameSection(status),
        certificateSection(status),
        seamSection("backups", SECTIONS.backups.title, status.backups, SECTIONS.backups),
        storageSection(status),
        countsSection(status),
        versionSection(status)),
      el("p", { className: "control-muted control-checked", text: `Checked ${formatDateTime(status.checkedAt)}.` }),
    );
  }
}

if (!customElements.get("kin-control-status")) customElements.define("kin-control-status", KinControlStatus);
