import { githubRepository } from "../badges/providers/github.js";
import { projectTypes } from "./project-types.js";
import { ATTENTION_KEY, validateAttention } from "./attention-storage.js";

export const AUDIT_DECISIONS_KEY = "readme-studio:audit-decisions:v1";
const LIMIT = 5000;
const TYPE_IDS = new Set(projectTypes.map(({ id }) => id));
const validRevision = (value) =>
  value === "missing-root" || /^sha:(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value);
const hasDecisions = (record) =>
  !!record.attention || !!record.projectType || !!record.dismissals?.length;

function validate(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > LIMIT
  )
    throw Error("Unsupported or damaged audit decisions.");
  const seen = new Set();
  return value.repositories.map((record) => {
    if (!record || typeof record.repository !== "string")
      throw Error("Invalid audit decision record.");
    const repository = githubRepository(record.repository).toLowerCase();
    if (seen.has(repository)) throw Error("Invalid audit decision record.");
    seen.add(repository);

    let attention;
    if (record.attention !== undefined) {
      const [entry] = validateAttention({
        version: 1,
        entries: [{ repository, ...record.attention }],
      });
      attention = {
        kind: entry.kind,
        revision: entry.revision,
        until: entry.until,
      };
    }

    let projectType;
    if (record.projectType !== undefined) {
      if (
        !record.projectType ||
        !TYPE_IDS.has(record.projectType.id) ||
        !validRevision(record.projectType.observedRevision)
      )
        throw Error("Invalid saved project type.");
      projectType = {
        id: record.projectType.id,
        observedRevision: record.projectType.observedRevision,
      };
    }

    if (!Array.isArray(record.dismissals) || record.dismissals.length > 100)
      throw Error("Invalid saved dismissals.");
    const findingIds = new Set();
    const dismissals = record.dismissals.map((dismissal) => {
      if (
        !dismissal ||
        typeof dismissal.id !== "string" ||
        !dismissal.id ||
        dismissal.id.length > 500 ||
        findingIds.has(dismissal.id) ||
        !validRevision(dismissal.revision)
      )
        throw Error("Invalid saved dismissal.");
      findingIds.add(dismissal.id);
      return { id: dismissal.id, revision: dismissal.revision };
    });
    if (!attention && !projectType && !dismissals.length)
      throw Error("Empty audit decision record.");
    return {
      repository,
      ...(attention ? { attention } : {}),
      ...(projectType ? { projectType } : {}),
      dismissals,
    };
  });
}

function legacyRecords(raw) {
  return validateAttention(JSON.parse(raw)).map(
    ({ repository, kind, revision, until }) => ({
      repository,
      attention: { kind, revision, until },
      dismissals: [],
    }),
  );
}

function attentionEntries(records) {
  return records.flatMap((record) =>
    record.attention
      ? [{ repository: record.repository, ...record.attention }]
      : [],
  );
}

export class AuditDecisions {
  constructor(storage = () => localStorage) {
    this.storage = storage;
    this.read();
  }

  read() {
    this.raw = null;
    this.source = "new";
    try {
      const storage = this.storage();
      const current = storage.getItem(AUDIT_DECISIONS_KEY);
      if (current !== null) {
        this.raw = current;
        if (current.length > 2_000_000)
          throw Error("Audit decisions are too large.");
        this.records = validate(JSON.parse(current));
      } else {
        this.source = "legacy";
        const legacy = storage.getItem(ATTENTION_KEY);
        this.raw = legacy;
        if (legacy?.length > 2_000_000)
          throw Error("Attention settings are too large.");
        this.records = legacy === null ? [] : legacyRecords(legacy);
      }
      this.entries = attentionEntries(this.records);
      this.error = "";
    } catch {
      this.records = [];
      this.entries = [];
      this.error =
        "Audit decisions could not be read. Original storage is untouched. Review still works; download recovery data before resetting these decisions.";
    }
    return this.records;
  }

  record(repository, records = this.records) {
    const key = githubRepository(repository).toLowerCase();
    let record = records.find((item) => item.repository === key);
    if (!record) {
      record = { repository: key, dismissals: [] };
      records.push(record);
    }
    return record;
  }

  mutate(change) {
    this.read();
    if (this.error) throw Error(this.error);
    const records = structuredClone(this.records);
    change(records);
    this.write(records.filter(hasDecisions));
  }

  set(repository, kind, revision, now = Date.now()) {
    if (kind === "minimal" && !validRevision(revision))
      throw Error(
        "Refresh the audit to obtain a README revision before marking it intentionally minimal.",
      );
    this.mutate((records) => {
      const record = this.record(repository, records);
      if (kind)
        record.attention = {
          kind,
          revision,
          until: kind === "ignore" ? now + 7 * 86400000 : 0,
        };
      else delete record.attention;
    });
  }

  setProjectType(repository, id, observedRevision) {
    if (!TYPE_IDS.has(id) || !validRevision(observedRevision))
      throw Error(
        "Refresh the audit to obtain a README revision before saving a project type.",
      );
    this.mutate((records) => {
      this.record(repository, records).projectType = { id, observedRevision };
    });
  }

  projectType(repository) {
    const key = githubRepository(repository).toLowerCase();
    return (
      this.records.find((record) => record.repository === key)?.projectType ||
      null
    );
  }

  resetProjectType(repository) {
    this.mutate((records) => {
      delete this.record(repository, records).projectType;
    });
  }

  setDismissal(repository, id, revision) {
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 500 ||
      id.startsWith("readme:") ||
      !validRevision(revision)
    )
      throw Error("Refresh the audit before saving this dismissal.");
    this.mutate((records) => {
      const record = this.record(repository, records);
      record.dismissals = record.dismissals.filter((item) => item.id !== id);
      record.dismissals.push({ id, revision });
    });
  }

  dismissals(repository) {
    const key = githubRepository(repository).toLowerCase();
    return new Map(
      (
        this.records.find((record) => record.repository === key)?.dismissals ||
        []
      ).map(({ id, revision }) => [id, revision]),
    );
  }

  removeDismissal(repository, id) {
    this.mutate((records) => {
      const record = this.record(repository, records);
      record.dismissals = record.dismissals.filter((item) => item.id !== id);
    });
  }

  resetAudit(repository) {
    this.mutate((records) => {
      const record = this.record(repository, records);
      delete record.projectType;
      record.dismissals = [];
    });
  }

  write(records) {
    const clean = validate({ version: 1, repositories: records });
    try {
      this.storage().setItem(
        AUDIT_DECISIONS_KEY,
        JSON.stringify({ version: 1, repositories: clean }),
      );
    } catch {
      throw Error(
        "Audit decisions could not be saved. Your decision was not applied; browser storage may be full or unavailable.",
      );
    }
    this.records = clean;
    this.entries = attentionEntries(clean);
    this.raw = JSON.stringify({ version: 1, repositories: clean });
    this.source = "new";
    this.error = "";
  }

  reset() {
    this.write([]);
  }
}

export function applyAuditDecisions(state, decisions, repository) {
  const key = githubRepository(repository).toLowerCase();
  const projectType = decisions.projectType(key);
  if (projectType) state.typeOverrides.set(key, projectType.id);
  else state.typeOverrides.delete(key);
  const dismissals = decisions.dismissals(key);
  if (dismissals.size) state.dismissed.set(key, dismissals);
  else state.dismissed.delete(key);
  return projectType;
}
