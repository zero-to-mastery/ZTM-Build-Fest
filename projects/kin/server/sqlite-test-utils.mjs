import { DatabaseSync } from "node:sqlite";
import { sqlitePragma } from "./durable-store.mjs";

export function openTestDatabase(path, options = {}) {
  return new DatabaseSync(path, {
    readOnly: options.readonly ?? options.readOnly ?? false,
  });
}

export { sqlitePragma };
