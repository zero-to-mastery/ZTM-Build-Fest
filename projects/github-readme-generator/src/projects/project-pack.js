import { normalizeProject } from "./project-model.js";
import { publicRepository, importedFields } from "./github-project.js";
import { githubRepository } from "../badges/providers/github.js";
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const fail = () => {
  throw new Error(
    "Invalid project pack. Use a version 1 project-showcase file with up to 100 projects.",
  );
};
function portableProject(raw) {
  if (!object(raw) || raw.schemaVersion !== 1 || typeof raw.name !== "string")
    fail();
  const model = normalizeProject({});
  for (const [k, v] of Object.entries(model))
    if (
      typeof v === "string" &&
      raw[k] !== undefined &&
      (typeof raw[k] !== "string" || raw[k].length > 100000)
    )
      fail();
  for (const k of ["highlights", "technologies", "links", "badges"])
    if (raw[k] !== undefined && (!Array.isArray(raw[k]) || raw[k].length > 200))
      fail();
  for (const [key, fields] of [
    ["highlights", ["title", "description"]],
    ["technologies", ["name", "id", "logo", "brandColor"]],
    ["links", ["name", "url"]],
  ])
    for (const item of raw[key] || []) {
      if (
        !object(item) ||
        fields.some((k) => item[k] !== undefined && typeof item[k] !== "string")
      )
        fail();
    }
  const p = normalizeProject(raw);
  p.metadata = {};
  if (raw.metadata?.github) {
    const g = raw.metadata.github;
    githubRepository(`${g.owner}/${g.repo}`);
    if (
      typeof g.lastFetched !== "string" ||
      !Number.isFinite(Date.parse(g.lastFetched))
    )
      fail();
    const generated = {};
    for (const k of importedFields)
      if (Object.hasOwn(g.generatedFields || {}, k)) {
        if (k === "technologies") {
          if (
            !Array.isArray(g.generatedFields[k]) ||
            g.generatedFields[k].length > 200
          )
            fail();
          generated[k] = normalizeProject({
            technologies: g.generatedFields[k],
          }).technologies;
        } else {
          if (typeof g.generatedFields[k] !== "string") fail();
          generated[k] = g.generatedFields[k];
        }
      }
    p.metadata.github = {
      owner: g.owner,
      repo: g.repo,
      lastFetched: g.lastFetched,
      generatedFields: generated,
    };
    if (g.snapshot) {
      const snapshot = publicRepository(g.snapshot);
      if (
        snapshot.full_name.toLowerCase() !==
        `${g.owner}/${g.repo}`.toLowerCase()
      )
        fail();
      snapshot.lastFetched = g.lastFetched;
      p.metadata.github.snapshot = snapshot;
    }
  }
  return p;
}
export function readProjectPack(input) {
  if (typeof input === "string" && input.length > 5_000_000)
    throw new Error("Project pack exceeds the 5 MB limit.");
  let value;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    fail();
  }
  if (
    !object(value) ||
    value.type !== "project-showcase" ||
    value.version !== 1 ||
    !Array.isArray(value.projects) ||
    value.projects.length > 100
  )
    fail();
  return {
    version: 1,
    type: "project-showcase",
    projects: value.projects.map(portableProject),
  };
}
export const exportProjectPack = (projects) =>
  readProjectPack({ version: 1, type: "project-showcase", projects });
export function mergeProjectPack(existing, pack) {
  const ids = new Set(existing.map((p) => p.id)),
    names = new Set(existing.map((p) => p.name.toLowerCase()));
  return readProjectPack(pack).projects.map((p) => {
    if (!p.id || ids.has(p.id)) p.id = crypto.randomUUID();
    ids.add(p.id);
    const base = p.name || "Untitled project";
    let name = base,
      n = 2;
    while (names.has(name.toLowerCase())) name = `${base} (${n++})`;
    p.name = name;
    names.add(name.toLowerCase());
    return p;
  });
}
