import { readmeMetadata } from "./readme-metadata.js";
import { tomlRecords, tomlValue } from "./toml.js";
export const MANIFEST_LIMIT = 256_000;
export const DETECTION_LIMIT = 200;
export const manifests = Object.freeze([
  { path: "package.json", ecosystem: "Node" },
  { path: "Cargo.toml", ecosystem: "Rust" },
  { path: "pyproject.toml", ecosystem: "Python" },
  { path: "requirements.txt", ecosystem: "Python" },
  { path: "go.mod", ecosystem: "Go" },
]);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const pythonName = (raw) => {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$/);
  if (!match) return null;
  let rest = match[2].trim();
  if (rest.startsWith("[")) {
    const extras = rest.match(/^\[[A-Za-z0-9._,\s-]+\]/);
    if (!extras) return null;
    rest = rest.slice(extras[0].length).trim();
  }
  if (rest && !/^(?:[<>=!~;@#]|\(\s*[<>=!~])/.test(rest)) return null;
  return match[1].toLowerCase().replace(/[-_.]+/g, "-");
};
export function analyzeManifest(path, source) {
  const descriptor = manifests.find((m) => m.path === path);
  if (!descriptor) throw Error("Unsupported manifest path.");
  if (
    typeof source !== "string" ||
    new TextEncoder().encode(source).length > MANIFEST_LIMIT
  )
    throw Error("Manifest exceeds the 256 KB analysis limit.");
  source = source.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const signals = [];
  const entries = [],
    notes = [],
    seen = new Set();
  const note = (value) => {
    if (!notes.includes(value)) notes.push(value);
  };
  const add = (name, role, evidence, line = null) => {
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 200 ||
      /[\s<>"'\x00-\x1f]/.test(name)
    ) {
      note("Some dependency names could not be interpreted.");
      return;
    }
    const key = JSON.stringify([name, role, evidence]);
    if (seen.has(key)) return;
    seen.add(key);
    if (entries.length >= DETECTION_LIMIT) {
      note("Only the first 200 declarations per manifest are shown.");
      return;
    }
    entries.push({
      name,
      role,
      evidence: String(evidence).slice(0, 300),
      line,
    });
  };
  const python = (raw, role, evidence, line) => {
    const name = pythonName(raw);
    if (name) add(name, role, evidence, line);
    else
      note(
        "Some Python requirements use unsupported syntax; they were not inferred.",
      );
  };
  if (path === "package.json") {
    const data = JSON.parse(source);
    if (!object(data)) throw Error("package.json must contain an object.");
    for (const [engine, id] of [
      ["node", "nodejs"],
      ["bun", "bun"],
      ["deno", "deno"],
    ]) {
      if (
        object(data.engines) &&
        typeof data.engines[engine] === "string" &&
        data.engines[engine].trim()
      )
        signals.push({ id, evidence: "engines." + engine });
    }
    for (const [field, role] of [
      ["dependencies", "runtime"],
      ["devDependencies", "development"],
      ["peerDependencies", "peer"],
      ["optionalDependencies", "optional"],
    ]) {
      if (data[field] === undefined) continue;
      if (!object(data[field])) throw Error(field + " must be an object.");
      for (const [name, value] of Object.entries(data[field])) {
        if (typeof value !== "string")
          throw Error("Invalid Node dependency declaration.");
        const alias = value.match(/^npm:((?:@[^/]+\/)?[^@]+)(?:@|$)/)?.[1];
        add(
          alias || name,
          role,
          field + (alias ? " (alias: " + name + ")" : ""),
        );
      }
    }
    if (data.workspaces)
      note(
        "Workspace members are not followed; only root declarations were read.",
      );
  } else if (path === "Cargo.toml") {
    const groups = new Map();
    for (const record of tomlRecords(source)) {
      const index = record.path.findIndex((p) =>
        ["dependencies", "dev-dependencies", "build-dependencies"].includes(p),
      );
      if (index < 0 || ![0, 1, 2].includes(index)) continue;
      if (index === 1 && record.path[0] !== "workspace") continue;
      if (index === 2 && record.path[0] !== "target") continue;
      const tail = record.path.slice(index + 1);
      if (!tail.length) continue;
      const groupKey = JSON.stringify(record.path.slice(0, index + 2));
      const value = tomlValue(record.raw);
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          name: tail[0],
          section: record.path.slice(0, index + 1),
          value: Object.create(null),
          line: record.line,
        };
        groups.set(groupKey, group);
      }
      if (tail.length === 1) group.value = value;
      else if (tail.length === 2 && object(group.value))
        group.value[tail[1]] = value;
      else throw Error("Unsupported Cargo dependency structure.");
    }
    const workspace = new Map(
      [...groups.values()]
        .filter((group) => group.section.join(".") === "workspace.dependencies")
        .map((group) => [group.name, group]),
    );
    for (const group of groups.values()) {
      if (group.section[0] === "workspace") continue;

      if (typeof group.value !== "string" && !object(group.value))
        throw Error("Invalid Cargo dependency declaration.");
      const section = group.section.join(".");
      const role = section.endsWith("dev-dependencies")
        ? "development"
        : section.endsWith("build-dependencies")
          ? "build"
          : "runtime";
      const inherited = object(group.value) && group.value.workspace === true;
      let value = group.value;
      if (inherited) {
        const shared = workspace.get(group.name);
        if (
          !shared ||
          (typeof shared.value !== "string" && !object(shared.value))
        ) {
          note(
            "Unresolved workspace references were omitted from direct dependency results.",
          );
          continue;
        }
        value = shared.value;
      }
      add(
        object(value) && typeof value.package === "string"
          ? value.package
          : group.name,
        role === "runtime" &&
          object(group.value) &&
          group.value.optional === true
          ? "optional"
          : role,
        section + (inherited ? " (inherited from workspace.dependencies)" : ""),
        group.line,
      );
    }
    if (/\[workspace(?:\]|\.)/.test(source))
      note("Workspace members and local path dependencies are not followed.");
    note(
      "Optional and target-specific declarations do not prove a dependency is active in a build. Unused workspace declarations are excluded.",
    );
  } else if (path === "pyproject.toml") {
    const records = tomlRecords(source);
    // Poetry runtime dependencies declared `optional = true`, inline or as a
    // [tool.poetry.dependencies.<name>] table. They are extras, so they are
    // optional like Cargo optional dependencies, never runtime.
    const poetryOptional = new Set();
    for (const { path: p, raw } of records)
      if (p[0] === "tool" && p[1] === "poetry" && p[2] === "dependencies") {
        if (p.length === 4) {
          const value = tomlValue(raw);
          if (object(value) && value.optional === true)
            poetryOptional.add(p[3]);
        } else if (
          p.length === 5 &&
          p[4] === "optional" &&
          tomlValue(raw) === true
        )
          poetryOptional.add(p[3]);
      }
    for (const record of records) {
      const p = record.path,
        joined = p.join(".");
      let role = "";
      if (joined === "project.dependencies") role = "runtime";
      else if (
        p[0] === "project" &&
        p[1] === "optional-dependencies" &&
        p.length === 3
      )
        role = "optional";
      else if (joined === "build-system.requires") role = "build";
      else if (p[0] === "dependency-groups" && p.length === 2)
        role = "development";
      if (role) {
        const values = tomlValue(record.raw);
        if (!Array.isArray(values))
          throw Error("Python dependency declarations must be arrays.");
        for (const value of values) python(value, role, joined, record.line);
      } else if (
        p[0] === "tool" &&
        p[1] === "poetry" &&
        (p[2] === "dependencies" ||
          p[2] === "dev-dependencies" ||
          (p[2] === "group" && p[4] === "dependencies"))
      ) {
        tomlValue(record.raw); // Read data only; reject unsupported declaration syntax.
        const name = p[2] === "group" ? p[5] : p[3];
        if (name && name !== "python")
          add(
            name.toLowerCase().replace(/[-_.]+/g, "-"),
            p[2] !== "dependencies"
              ? "development"
              : poetryOptional.has(name)
                ? "optional"
                : "runtime",
            p.slice(0, -1).join("."),
            record.line,
          );
      } else if (
        joined === "project.dynamic" &&
        tomlValue(record.raw).some((v) => /dependencies/.test(v))
      )
        note(
          "Dynamic Python dependencies require execution and are intentionally not resolved.",
        );
    }
    note(
      "Only declarative project, Poetry, dependency-group and build-system dependencies are read; setup.py is never executed.",
    );
  } else if (path === "requirements.txt") {
    note(
      "Requirements are explicitly declared entries; generated freeze files may also list transitive packages. No dependency graph is inferred.",
    );
    source.split("\n").forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      if (line.startsWith("-") || /\\$/.test(line)) {
        note(
          "Requirements options, includes and continuation lines are not followed.",
        );
        return;
      }
      python(line, "runtime", "requirements.txt", index + 1);
    });
  } else {
    let block = "";
    source.split("\n").forEach((raw, index) => {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!line) return;
      if (line === ")") {
        if (!block) throw Error("Unmatched go.mod block.");
        block = "";
        return;
      }
      const open = line.match(/^(\w+)\s*\($/);
      if (open) {
        if (block) throw Error("Nested go.mod block.");
        block = open[1];
        return;
      }
      const declaration =
        block === "require"
          ? line
          : !block && /^require\s+/.test(line)
            ? line.replace(/^require\s+/, "").trim()
            : null;
      if (declaration !== null) {
        const match = declaration.match(/^("[^"]+"|[^\s]+)\s+v\S+$/);
        if (!match) throw Error("Unsupported go.mod require declaration.");
        if (/\/\/\s*indirect\b/.test(raw)) {
          note(
            "Indirect Go requirements were excluded from direct dependency results.",
          );
          return;
        }
        add(match[1].replace(/^"|"$/g, ""), "runtime", "require", index + 1);
      }
      if (/^replace\b|^exclude\b/.test(line))
        note(
          "Go replacement/exclusion directives are not resolved; names shown are require declarations.",
        );
    });
    if (block) throw Error("Unterminated go.mod block.");
  }
  return {
    version: 1,
    path,
    ecosystem: descriptor.ecosystem,
    entries,
    notes,
    signals,
    readme: readmeMetadata(path, source),
  };
}
