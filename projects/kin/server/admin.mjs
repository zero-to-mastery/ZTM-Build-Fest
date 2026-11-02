import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireDatabaseMaintenanceLock,
  DurableStore,
  DurableStoreError,
} from "./durable-store.mjs";
import { resolveDurablePath } from "./path-safety.mjs";
import { configuredDatabasePath } from "./permissions.mjs";
import { writeFileSync } from "node:fs";
import { FeedbackService } from "./feedback-service.mjs";
import { GitHubIssues, parseGitHubConfig } from "./feedback-github.mjs";
import { FEEDBACK_KINDS, FEEDBACK_STATUSES, STATUS_LABELS, isReference } from "../web/feedback/format.js";

// The service's own database: KIN_DATABASE_PATH, else kin.sqlite in
// KIN_DATA_DIR, else the mode's default data directory (server/mode.mjs).
const defaultDatabasePath = () => configuredDatabasePath();

export async function runAdminCommand(args) {
  const [command, ...parameters] = args;
  if (command === "backup" && parameters.length === 1) {
    const destination = resolveDurablePath(parameters[0]);
    const databasePath = resolveDurablePath(defaultDatabasePath());
    const result = await DurableStore.createBackup(
      databasePath,
      destination,
    );
    console.log(`Verified Kin backup created at ${result}`);
    return;
  }
  if (
    command === "restore" &&
    parameters.length === 2 &&
    parameters[1] === "--acknowledge-deletion-history"
  ) {
    const source = resolveDurablePath(parameters[0]);
    const databasePath = resolveDurablePath(defaultDatabasePath());
    const result = await DurableStore.restoreBackup(
      source,
      databasePath,
      { acknowledgeDeletionHistory: true },
    );
    console.log(
      [
        result.previousDatabasePath
          ? `Kin database restored. The previous database and WAL sidecars, if any, were preserved at ${result.previousDatabasePath}.`
          : `Kin database restored at ${result.databasePath}.`,
        `Preserved ${result.preservedDeletionCount} newer household lifecycle tombstone(s) from the existing target.`,
        `Preserved current authority for ${result.preservedAuthorityCount} active household(s).`,
        "A backup restored without its later deletion ledger may contain older data; this command cannot detect deletions absent from both databases.",
      ].join("\n"),
    );
    return;
  }
  if (
    (command === "household-status" ||
      command === "household-verify-purged") &&
    parameters.length === 1
  ) {
    const databasePath = resolveDurablePath(defaultDatabasePath());
    const store = new DurableStore(databasePath, { readonly: true });
    try {
      const status = store.householdPurgeStatus(parameters[0]);
      if (command === "household-verify-purged" && !status.purged)
        throw new DurableStoreError(
          "The Kin household has not been fully purged.",
        );
      console.log(JSON.stringify(status, null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (
    command === "household-purge" &&
    parameters.length === 3 &&
    parameters[1] === "--confirm-household-id" &&
    parameters[0] === parameters[2]
  ) {
    const householdId = parameters[0];
    const databasePath = resolveDurablePath(defaultDatabasePath());
    // Disposed in reverse: the store closes, then the lock is released,
    // whatever the purge throws (#106).
    using _maintenance = acquireDatabaseMaintenanceLock(databasePath, "household-purge");
    using store = new DurableStore(databasePath);
    const status = store.forcePurgeHousehold(householdId, Date.now());
    console.log(
      [
        `Kin household ${householdId} was purged and its deletion tombstone was verified.`,
        JSON.stringify(status, null, 2),
        "This does not erase browser storage, offline devices, exports, or separately retained backups.",
      ].join("\n"),
    );
    return;
  }
  if (command?.startsWith("feedback-")) return feedbackCommand(command, parameters);
  throw new DurableStoreError(`Usage: node server/admin.mjs backup <destination> | restore <backup-file> --acknowledge-deletion-history | household-status <household-id> | household-purge <household-id> --confirm-household-id <household-id> | household-verify-purged <household-id> | ${FEEDBACK_USAGE}`);
}

// Problem reports and suggestions (ADR 0021 §3, #637). These commands are
// safe while the service runs: the service keeps nothing about reports in
// memory, so they open the database beside it (SQLite's own locking orders
// the writes) instead of taking the service lock.
const FEEDBACK_USAGE = "feedback-list [--kind problem|suggestion] [--status received|planned|done|wont-do] [--limit n] | feedback-show <reference> [--screenshot <file>] | feedback-set-status <reference> received|planned|done|wont-do | feedback-forward <reference> | feedback-purge [<reference> --confirm-reference <reference>]";

function option(parameters, name) {
  const index = parameters.indexOf(name);
  if (index === -1) return undefined;
  const value = parameters[index + 1];
  if (value === undefined || value.startsWith("--")) throw new DurableStoreError(`Usage: ${FEEDBACK_USAGE}`);
  parameters.splice(index, 2);
  return value;
}

const statusArgument = (value) => (value === "wont-do" ? "wont_do" : value);

async function feedbackCommand(command, parameters) {
  const usage = () => new DurableStoreError(`Usage: ${FEEDBACK_USAGE}`);
  if (!["feedback-list", "feedback-show", "feedback-set-status", "feedback-forward", "feedback-purge"].includes(command)) throw usage();
  if (command === "feedback-purge" && parameters.length === 0) return purgeExpiredFeedback();
  const databasePath = resolveDurablePath(defaultDatabasePath());
  const writes = ["feedback-set-status", "feedback-forward", "feedback-purge"].includes(command);
  // Forwarding needs the operator's configuration; check it before opening.
  const github = command === "feedback-forward" ? parseGitHubConfig({
    repo: process.env.KIN_FEEDBACK_GITHUB_REPO, token: process.env.KIN_FEEDBACK_GITHUB_TOKEN, api: process.env.KIN_FEEDBACK_GITHUB_API,
  }) : null;
  if (command === "feedback-forward" && !github)
    throw new DurableStoreError("Set KIN_FEEDBACK_GITHUB_REPO and KIN_FEEDBACK_GITHUB_TOKEN to forward reports to GitHub.");
  using store = new DurableStore(databasePath, writes ? { acquireProcessLock: false } : { readonly: true });
  const feedback = new FeedbackService({ store, github: github ? new GitHubIssues(github) : null, log: () => {} });
  if (command === "feedback-list") {
    const args = [...parameters];
    const kind = option(args, "--kind");
    const status = option(args, "--status");
    const limit = option(args, "--limit");
    if (args.length || (kind && !FEEDBACK_KINDS.includes(kind)) || (status && !FEEDBACK_STATUSES.includes(statusArgument(status))) ||
      (limit !== undefined && !/^[1-9][0-9]{0,4}$/.test(limit)))
      throw usage();
    const rows = feedback.list({ kind: kind ?? null, status: status ? statusArgument(status) : null, limit: Number(limit ?? 50) });
    for (const row of rows)
      console.log([row.reference, new Date(row.createdAt).toISOString(), row.kind, row.status, row.memberId ? "member" : "not signed in",
        row.forwardState === "forwarded" ? `issue #${row.githubIssue}` : `forward: ${row.forwardState}`, row.hasScreenshot ? "screenshot" : "", row.title]
        .filter(Boolean).join("\t"));
    if (!rows.length) console.log("No reports or suggestions.");
    return;
  }
  const [reference, ...rest] = parameters;
  if (!isReference(reference)) throw usage();
  if (command === "feedback-show") {
    const args = [...rest];
    const screenshotPath = option(args, "--screenshot");
    if (args.length) throw usage();
    const shown = feedback.show(reference);
    if (!shown) throw new DurableStoreError("There is no report or suggestion with that reference.");
    console.log(JSON.stringify(shown, null, 2));
    if (screenshotPath) {
      const screenshot = store.feedbackScreenshot(reference);
      if (!screenshot) throw new DurableStoreError("That report has no screenshot.");
      const target = resolveDurablePath(screenshotPath);
      // Never overwrite: the operator names a new file.
      writeFileSync(target, screenshot.bytes, { flag: "wx", mode: 0o600 });
      console.log(`Screenshot (${screenshot.type}, ${screenshot.bytes.length} bytes) written to ${target}`);
    }
    return;
  }
  if (command === "feedback-set-status") {
    if (rest.length !== 1 || !FEEDBACK_STATUSES.includes(statusArgument(rest[0]))) throw usage();
    if (!feedback.setStatus(reference, statusArgument(rest[0]))) throw new DurableStoreError("There is no report or suggestion with that reference.");
    console.log(`${reference} is now ${STATUS_LABELS[statusArgument(rest[0])]}. The sender sees it in What I've sent.`);
    return;
  }
  if (command === "feedback-forward") {
    if (rest.length) throw usage();
    const row = store.feedback(reference);
    if (!row) throw new DurableStoreError("There is no report or suggestion with that reference.");
    // A row that gave up (or never had forwarding) is tried afresh.
    const fresh = row.forwardState === "off" || row.forwardState === "failed" ? { ...row, forwardState: "pending" } : row;
    if (!(await feedback.forwardOne(fresh))) throw new DurableStoreError("GitHub did not accept the report; it will be retried by the service.");
    console.log(`${reference} is GitHub issue #${store.feedback(reference).githubIssue}.`);
    return;
  }
  // feedback-purge: everything past retention, or one report on request.
  if (rest.length === 2 && rest[0] === "--confirm-reference" && rest[1] === reference) {
    if (!store.deleteFeedback(reference)) throw new DurableStoreError("There is no report or suggestion with that reference.");
    console.log(`${reference} was deleted from the service. A copy forwarded to GitHub stays there until it is deleted on GitHub.`);
    return;
  }
  throw usage();
}

async function purgeExpiredFeedback() {
  const databasePath = resolveDurablePath(defaultDatabasePath());
  using store = new DurableStore(databasePath, { acquireProcessLock: false });
  const purged = new FeedbackService({ store, log: () => {} }).purgeExpired();
  console.log(`Purged ${purged} report(s) and suggestion(s) older than 180 days.`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runAdminCommand(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof DurableStoreError
        ? error.message
        : "Kin database operation failed.",
    );
    process.exitCode = 1;
  });
}
