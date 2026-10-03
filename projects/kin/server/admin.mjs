import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DurableStore, DurableStoreError } from "./durable-store.mjs";
import { resolveDurablePath } from "./path-safety.mjs";

const dataDirectory =
  process.env.KIN_DATA_DIR ?? resolve(import.meta.dirname, "..", ".kin-data");
const defaultDatabasePath = resolve(
  process.env.KIN_DATABASE_PATH ?? join(dataDirectory, "kin.sqlite"),
);

export async function runAdminCommand(args) {
  const [command, ...parameters] = args;
  if (command === "backup" && parameters.length === 1) {
    const destination = resolveDurablePath(parameters[0]);
    const databasePath = resolveDurablePath(defaultDatabasePath);
    const result = await DurableStore.createBackup(
      databasePath,
      destination,
    );
    console.log(`Verified Kin backup created at ${result}`);
    return;
  }
  if (command === "restore" && parameters.length === 1) {
    const source = resolveDurablePath(parameters[0]);
    const databasePath = resolveDurablePath(defaultDatabasePath);
    const result = await DurableStore.restoreBackup(
      source,
      databasePath,
    );
    console.log(
      result.previousDatabasePath
        ? `Kin database restored. The previous database and WAL sidecars, if any, were preserved at ${result.previousDatabasePath}.`
        : `Kin database restored at ${result.databasePath}.`,
    );
    return;
  }
  throw new DurableStoreError(
    "Usage: node server/admin.mjs backup <destination> | restore <backup-file>",
  );
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
