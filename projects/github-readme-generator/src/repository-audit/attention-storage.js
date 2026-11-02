import { githubRepository } from "../badges/providers/github.js";
export const ATTENTION_KEY = "readme-studio:attention:v1";
const LIMIT = 5000;
const validRevision = (v) =>
  v === "missing-root" || /^sha:(?:[a-f\d]{40}|[a-f\d]{64})$/.test(v);

export function validateAttention(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > LIMIT
  )
    throw Error("Unsupported or damaged attention settings.");
  const seen = new Set();
  return value.entries.map((entry) => {
    if (!entry || typeof entry.repository !== "string")
      throw Error("Invalid attention entry.");
    const repository = githubRepository(entry.repository).toLowerCase();
    if (
      seen.has(repository) ||
      !["minimal", "ignore"].includes(entry.kind) ||
      typeof entry.revision !== "string" ||
      !(
        validRevision(entry.revision) ||
        (entry.kind === "ignore" && entry.revision === "")
      ) ||
      !Number.isSafeInteger(entry.until) ||
      entry.until < 0 ||
      entry.until > 8640000000000000 ||
      (entry.kind === "minimal" && entry.until !== 0)
    )
      throw Error("Invalid attention entry.");
    seen.add(repository);
    return {
      repository,
      kind: entry.kind,
      revision: entry.revision,
      until: entry.until,
    };
  });
}

export class AttentionPreferences {
  constructor(storage = () => localStorage) {
    this.storage = storage;
    this.read();
  }
  read() {
    this.raw = null;
    try {
      this.raw = this.storage().getItem(ATTENTION_KEY);
      if (this.raw?.length > 2_000_000)
        throw Error("Attention settings are too large.");
      this.entries =
        this.raw === null ? [] : validateAttention(JSON.parse(this.raw));
      this.error = "";
    } catch {
      this.entries = [];
      this.error =
        "Attention settings could not be read. Original storage is untouched. Queue review still works; download recovery data before resetting these settings.";
    }
    return this.entries;
  }
  set(repository, kind, revision, now = Date.now()) {
    this.read(); // Merge the latest other-tab decisions; never overwrite unreadable data.
    if (this.error) throw Error(this.error);
    if (kind === "minimal" && !validRevision(revision))
      throw Error(
        "Refresh the audit to obtain a README revision before marking it intentionally minimal.",
      );
    const key = githubRepository(repository).toLowerCase();
    const entries = this.entries.filter((entry) => entry.repository !== key);
    if (kind)
      entries.push({
        repository: key,
        kind,
        revision,
        until: kind === "ignore" ? now + 7 * 86400000 : 0,
      });
    this.write(entries);
  }
  write(entries) {
    const clean = validateAttention({ version: 1, entries });
    try {
      this.storage().setItem(
        ATTENTION_KEY,
        JSON.stringify({ version: 1, entries: clean }),
      );
    } catch {
      throw Error(
        "Attention settings could not be saved. Your decision was not applied; browser storage may be full or unavailable.",
      );
    }
    this.entries = clean;
    this.error = "";
  }
  reset() {
    this.write([]);
    this.raw = null;
  }
}

export function rememberAttentionPreference(
  preferences,
  repository,
  kind,
  revision,
) {
  preferences.set(repository, kind, revision);
  const name = repository.split("/").at(-1);
  return kind === "minimal"
    ? `${name} marked intentionally minimal for this README revision.`
    : kind === "ignore"
      ? `${name} ignored for seven days or until its README changes.`
      : `${name} returned to the queue.`;
}
