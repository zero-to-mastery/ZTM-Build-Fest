import { tomlRecords, tomlValue } from "./toml.js";

// Retain allowlisted identifiers only, never script bodies or arbitrary config.
export function readmeMetadata(path, source) {
  const result = {};
  if (path === "package.json") {
    const data = JSON.parse(source);
    const manager =
      typeof data.packageManager === "string" &&
      /^(npm|pnpm|yarn|bun)@\d[\w.+-]{0,100}$/.exec(data.packageManager);
    if (manager) result.packageManager = manager[1];
    result.scripts = ["test", "build"].filter(
      (key) =>
        typeof data.scripts?.[key] === "string" && data.scripts[key].trim(),
    );
    if (
      data.private !== true &&
      typeof data.name === "string" &&
      data.name.length <= 214 &&
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,100}$/.test(data.name)
    )
      result.packageName = data.name;
  } else if (path === "Cargo.toml" || path === "pyproject.toml") {
    const records = tomlRecords(source);
    const get = (key) => {
      const record = records.find((r) => r.path.join(".") === key);
      try {
        return record && tomlValue(record.raw);
      } catch {
        return undefined;
      }
    };
    const name =
      get(path === "Cargo.toml" ? "package.name" : "project.name") ||
      (path === "pyproject.toml" && get("tool.poetry.name"));
    const publish = get("package.publish");
    if (
      typeof name === "string" &&
      (path === "Cargo.toml"
        ? /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
        : /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/
      ).test(name) &&
      publish !== false &&
      !Array.isArray(publish)
    )
      result.packageName = name;
  }
  return result;
}
