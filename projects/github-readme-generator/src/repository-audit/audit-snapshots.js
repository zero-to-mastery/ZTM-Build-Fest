import { githubRepository } from "../badges/providers/github.js";
import { githubUsername } from "../state/github-profile.js";
import { readmeRevision } from "./attention.js";
import { improvementPlan } from "./improvement-plan.js";
import { projectTypes } from "./project-types.js";

export const AUDIT_SNAPSHOTS_KEY = "readme-studio:audit-snapshots:v1";
export const AUDIT_RULES = 1;
export const PLAN_RULES = 1;
const ACCOUNT_LIMIT = 5;
const TOTAL_LIMIT = 20;
const REPOSITORY_LIMIT = 1000;
const FINDING_LIMIT = 60;
const URL_LIMIT = 20;
const STORAGE_LIMIT = 2_000_000;
const MAX_DATE = 8_640_000_000_000_000;
const PROJECT_TYPES = new Set(projectTypes.map((type) => type.id));
const README_STATES = new Set([
  "missing",
  "stub",
  "minimal",
  "basic",
  "detailed",
  "documentation-heavy",
]);
const validRevision = (value) =>
  value === "" ||
  value === "missing-root" ||
  /^sha:(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value);

const canonical = (value) => githubRepository(value).toLowerCase();
const linkFinding = (id) => id.startsWith("link:") || id.startsWith("image:");

function findingIdentity(finding) {
  const identity = { id: finding.id };
  if (linkFinding(finding.id) && typeof finding.url === "string")
    identity.url = finding.url.slice(0, 2000);
  return identity;
}

export function createAuditSnapshot({
  account,
  records,
  typeOverrides = new Map(),
  capturedAt = Date.now(),
}) {
  const username = githubUsername(account).toLowerCase();
  const repositories = records
    .filter((record) => record?.result && record?.repo?.full_name)
    .slice(0, REPOSITORY_LIMIT)
    .map((record) => {
      const repository = canonical(record.repo.full_name);
      const manual = typeOverrides.has(repository);
      const projectType = manual
        ? typeOverrides.get(repository)
        : record.result.suggestion?.id || "generic";
      const plan = improvementPlan(record, {
        override: manual ? projectType : "auto",
        limit: FINDING_LIMIT,
      });
      const findings = plan?.recommendations || [];
      return {
        repository,
        revision: readmeRevision(record),
        observedAt: record.checkedAt,
        state: plan.state,
        projectType: plan.type.id,
        manualType: manual,
        historyChecked: record.review?.historyChecked === true,
        linksChecked: record.review?.linksChecked === true,
        findings: [
          ...new Map(
            findings
              .slice(0, FINDING_LIMIT)
              .map((finding) => [finding.id, findingIdentity(finding)]),
          ).values(),
        ],
      };
    });
  return validateSnapshot({
    id: `${username}:${capturedAt}`,
    account: username,
    capturedAt,
    auditRules: AUDIT_RULES,
    planRules: PLAN_RULES,
    repositories,
  });
}

export function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot.id !== "string" ||
    snapshot.id.length > 300 ||
    !Number.isSafeInteger(snapshot.capturedAt) ||
    snapshot.capturedAt < 0 ||
    snapshot.capturedAt > MAX_DATE ||
    !Number.isSafeInteger(snapshot.auditRules) ||
    snapshot.auditRules < 1 ||
    !Number.isSafeInteger(snapshot.planRules) ||
    snapshot.planRules < 1 ||
    !Array.isArray(snapshot.repositories) ||
    snapshot.repositories.length > REPOSITORY_LIMIT
  )
    throw Error("Invalid audit snapshot.");
  const account = githubUsername(snapshot.account).toLowerCase();
  if (snapshot.id !== `${account}:${snapshot.capturedAt}`)
    throw Error("Invalid audit snapshot identity.");
  const seen = new Set();
  const repositories = snapshot.repositories.map((record) => {
    const repository = canonical(record.repository);
    if (
      seen.has(repository) ||
      !validRevision(record.revision) ||
      !Number.isSafeInteger(record.observedAt) ||
      record.observedAt < 0 ||
      record.observedAt > MAX_DATE ||
      !README_STATES.has(record.state) ||
      !PROJECT_TYPES.has(record.projectType) ||
      typeof record.manualType !== "boolean" ||
      typeof record.historyChecked !== "boolean" ||
      typeof record.linksChecked !== "boolean" ||
      !Array.isArray(record.findings) ||
      record.findings.length > FINDING_LIMIT
    )
      throw Error("Invalid audit snapshot repository.");
    seen.add(repository);
    const ids = new Set();
    let urls = 0;
    const findings = record.findings.map((finding) => {
      if (
        !finding ||
        typeof finding.id !== "string" ||
        !finding.id ||
        finding.id.length > 500 ||
        ids.has(finding.id) ||
        (finding.url !== undefined &&
          (!linkFinding(finding.id) ||
            typeof finding.url !== "string" ||
            finding.url.length > 2000)) ||
        (linkFinding(finding.id) && finding.url === undefined)
      )
        throw Error("Invalid audit snapshot finding.");
      ids.add(finding.id);
      if (finding.url !== undefined && ++urls > URL_LIMIT)
        throw Error("Invalid audit snapshot finding URLs.");
      return finding.url === undefined
        ? { id: finding.id }
        : { id: finding.id, url: finding.url };
    });
    return {
      repository,
      revision: record.revision,
      observedAt: record.observedAt,
      state: record.state,
      projectType: record.projectType,
      manualType: record.manualType,
      historyChecked: record.historyChecked,
      linksChecked: record.linksChecked,
      findings,
    };
  });
  return {
    id: snapshot.id,
    account,
    capturedAt: snapshot.capturedAt,
    auditRules: snapshot.auditRules,
    planRules: snapshot.planRules,
    repositories,
  };
}

function validateItems(items) {
  const ids = new Set();
  const accounts = new Map();
  const clean = items.map(validateSnapshot);
  for (const snapshot of clean) {
    const count = (accounts.get(snapshot.account) || 0) + 1;
    if (ids.has(snapshot.id) || count > ACCOUNT_LIMIT)
      throw Error("Unsupported or damaged audit snapshots.");
    ids.add(snapshot.id);
    accounts.set(snapshot.account, count);
  }
  return clean;
}

export function compareAuditSnapshots(before, after) {
  const added = [],
    resolved = [],
    unknown = [];
  const earlier = new Map(
    before.repositories.map((item) => [item.repository, item]),
  );
  const later = new Map(
    after.repositories.map((item) => [item.repository, item]),
  );
  for (const repository of new Set([...earlier.keys(), ...later.keys()])) {
    const a = earlier.get(repository),
      b = later.get(repository);
    let reason = "";
    if (!a || !b) reason = "Repository was not assessed in both snapshots.";
    else if (b.observedAt <= a.observedAt)
      reason = "Repository was not re-read for the later snapshot.";
    else if (
      before.auditRules !== after.auditRules ||
      before.planRules !== after.planRules
    )
      reason = "Audit or plan rules changed between snapshots.";
    else if (a.projectType !== b.projectType || a.manualType !== b.manualType)
      reason = "Project type changed between snapshots.";
    if (reason) {
      unknown.push({ repository, reason });
      continue;
    }
    const aIds = new Map(a.findings.map((item) => [item.id, item]));
    const bIds = new Map(b.findings.map((item) => [item.id, item]));
    for (const id of new Set([...aIds.keys(), ...bIds.keys()])) {
      if (linkFinding(id) && (!a.linksChecked || !b.linksChecked)) {
        unknown.push({
          repository,
          id,
          reason: "Links were not checked in both snapshots.",
        });
      } else if (
        id.startsWith("history:") &&
        (!a.historyChecked || !b.historyChecked)
      ) {
        unknown.push({
          repository,
          id,
          reason: "History was not checked in both snapshots.",
        });
      } else if (!aIds.has(id)) added.push({ repository, id });
      else if (!bIds.has(id)) resolved.push({ repository, id });
    }
  }
  return { added, resolved, unknown };
}

export class AuditSnapshots {
  constructor(storage = () => localStorage) {
    this.storage = storage;
    this.read();
  }
  read() {
    this.raw = null;
    try {
      const raw = this.storage().getItem(AUDIT_SNAPSHOTS_KEY);
      this.raw = raw;
      if (raw?.length > STORAGE_LIMIT)
        throw Error("Audit snapshots are too large.");
      const value = raw === null ? { version: 1, items: [] } : JSON.parse(raw);
      if (
        value.version !== 1 ||
        !Array.isArray(value.items) ||
        value.items.length > TOTAL_LIMIT
      )
        throw Error("Unsupported or damaged audit snapshots.");
      this.items = validateItems(value.items);
      this.error = "";
    } catch {
      this.items = [];
      this.error =
        "Audit snapshots could not be read. Original storage is untouched. Download recovery data before resetting snapshots.";
    }
    return this.items;
  }
  save(snapshot) {
    this.read();
    if (this.error) throw Error(this.error);
    const clean = validateSnapshot(snapshot);
    let items = this.items.filter((item) => item.id !== clean.id);
    const account = items.filter((item) => item.account === clean.account);
    let evicted = 0;
    if (account.length >= ACCOUNT_LIMIT) {
      const oldest = account.sort((a, b) => a.capturedAt - b.capturedAt)[0];
      items = items.filter((item) => item.id !== oldest.id);
      evicted = 1;
    }
    if (items.length >= TOTAL_LIMIT)
      throw Error(
        "Delete an audit snapshot before saving another account's capture.",
      );
    items.push(clean);
    const raw = JSON.stringify({ version: 1, items });
    if (raw.length > STORAGE_LIMIT)
      throw Error("Delete audit snapshots before saving this capture.");
    try {
      this.storage().setItem(AUDIT_SNAPSHOTS_KEY, raw);
    } catch {
      throw Error(
        "Audit snapshot could not be saved. Browser storage may be full or unavailable.",
      );
    }
    this.items = items;
    this.raw = raw;
    return { snapshot: clean, evicted };
  }
  remove(id) {
    this.read();
    if (this.error) throw Error(this.error);
    this.write(this.items.filter((item) => item.id !== id));
  }
  write(items) {
    const raw = JSON.stringify({ version: 1, items });
    try {
      this.storage().setItem(AUDIT_SNAPSHOTS_KEY, raw);
    } catch {
      throw Error(
        "Audit snapshots could not be updated. Browser storage may be full or unavailable.",
      );
    }
    this.items = items;
    this.raw = raw;
    this.error = "";
  }
  reset() {
    this.write([]);
  }
}
