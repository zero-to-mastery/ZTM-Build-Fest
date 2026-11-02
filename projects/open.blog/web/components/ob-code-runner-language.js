// Shared by the public runner and Admin authoring UI. Keep this contract in
// parity with openblog_core::config::normalize_code_runner_language.
export function normalizeCodeRunnerLanguage(value) {
  const normalized = String(value || "")
    .replace(/^[\t-\r ]+|[\t-\r ]+$/g, "")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return /^[a-z][a-z0-9_+#.-]{0,31}$/.test(normalized) ? normalized : null;
}
