// Authentication is never part of the project schema. Source strings are kept
// verbatim: this is a metadata boundary, not a secret scanner for user prose.
export function portableData(value, depth = 0) {
  if (depth > 60) throw Error("Project metadata is nested too deeply.");
  if (Array.isArray(value)) return value.map((v) => portableData(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(__proto__|constructor|prototype|token|accesstoken|access_token|refreshtoken|refresh_token|csrf|secret|client_secret|authorization|cookie|session|credentials|api[_-]?key|providerkey|private[_-]?key|password)$/i.test(
              key,
            ),
        )
        .map(([k, v]) => [k, portableData(v, depth + 1)]),
    );
  return value;
}
