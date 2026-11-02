const encoder = new TextEncoder();
const isControl = (value, allowed = "") =>
  [...value].some((character) =>
    /\p{Cc}/u.test(character) && !allowed.includes(character),
  );
const byteLength = (value) => encoder.encode(value).length;

export const MAX_REFERENCE_FIELDS = 16;
export const MAX_REFERENCE_TITLE_BYTES = 128;
export const MAX_REFERENCE_LABEL_BYTES = 64;
export const MAX_REFERENCE_VALUE_BYTES = 1024;
export const MAX_PLAYBOOK_ENTRIES = 16;
export const MAX_PLAYBOOK_TITLE_BYTES = 128;
export const MAX_PLAYBOOK_ENTRY_BYTES = 256;

export function validateReferenceRecord(titleValue, fieldValues) {
  const title = typeof titleValue === "string" ? titleValue.trim() : "";
  const fields = fieldValues.map((field) => ({
    ...field,
    label: typeof field.label === "string" ? field.label.trim() : "",
    value: typeof field.value === "string" ? field.value : "",
  }));
  const errors = {
    title: !title
      ? "Enter a reference title."
      : isControl(title)
        ? "This title can't contain control characters."
        : byteLength(title) > MAX_REFERENCE_TITLE_BYTES
          ? "This title is too long."
          : "",
    count:
      fields.length === 0
        ? "Add at least one field."
        : fields.length > MAX_REFERENCE_FIELDS
          ? `Reference records can have up to ${MAX_REFERENCE_FIELDS} fields.`
          : "",
    fields: fields.map((field) => ({
      label: !field.label
        ? "Field labels can't be empty."
        : isControl(field.label)
          ? "Field labels can't contain control characters."
          : byteLength(field.label) > MAX_REFERENCE_LABEL_BYTES
            ? "This field label is too long."
            : "",
      value: isControl(field.value, "\n\r\t")
        ? "Field values can contain line breaks and tabs, but no other control characters."
        : byteLength(field.value) > MAX_REFERENCE_VALUE_BYTES
          ? "This field value is too long."
          : "",
    })),
  };
  return {
    valid:
      !errors.title &&
      !errors.count &&
      errors.fields.every((field) => !field.label && !field.value),
    title,
    fields,
    errors,
  };
}

export function validatePlaybook(titleValue, entryValues) {
  const title = typeof titleValue === "string" ? titleValue.trim() : "";
  const entries = entryValues.map((entry) =>
    typeof entry === "string" ? entry.trim() : "",
  );
  const errors = {
    title: !title
      ? "Enter a name for this checklist."
      : isControl(title)
        ? "This checklist name can't contain control characters."
        : byteLength(title) > MAX_PLAYBOOK_TITLE_BYTES
          ? "This checklist name is too long."
          : "",
    count:
      entries.length === 0
        ? "Add at least one step."
        : entries.length > MAX_PLAYBOOK_ENTRIES
          ? `A reusable checklist can have up to ${MAX_PLAYBOOK_ENTRIES} steps.`
          : "",
    entries: entries.map((entry) =>
      !entry
        ? "Checklist steps can't be empty."
        : isControl(entry)
          ? "Checklist steps can't contain control characters."
          : byteLength(entry) > MAX_PLAYBOOK_ENTRY_BYTES
            ? "This step is too long."
            : "",
    ),
  };
  return {
    valid: !errors.title && !errors.count && errors.entries.every((error) => !error),
    title,
    entries,
    errors,
  };
}
