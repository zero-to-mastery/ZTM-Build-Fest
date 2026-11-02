// Central YAML subset: all strings/keys are JSON-quoted (valid YAML 1.2).
// No user input can introduce indentation, YAML tags, or new mapping keys.
export function yaml(value, level = 0) {
  const indent = "  ".repeat(level);
  if (Array.isArray(value))
    return value.length
      ? value
          .map((v) =>
            typeof v === "object" && v !== null
              ? `${indent}-\n${yaml(v, level + 1)}`
              : `${indent}- ${JSON.stringify(v)}`,
          )
          .join("\n")
      : `${indent}[]`;
  if (value && typeof value === "object")
    return Object.keys(value).length
      ? Object.entries(value)
          .map(([k, v]) => {
            const prefix = `${indent}${JSON.stringify(k)}:`;
            return v && typeof v === "object" && Object.keys(v).length
              ? `${prefix}\n${yaml(v, level + 1)}`
              : `${prefix} ${JSON.stringify(v)}`;
          })
          .join("\n")
      : `${indent}{}`;
  return indent + JSON.stringify(value);
}
