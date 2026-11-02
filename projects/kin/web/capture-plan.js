// A Today capture may need several existing commands: create the item, set
// its planning date, pin it. This module decides which of those operations
// are still outstanding for a given draft against the current projection, so
// a retry after partial success resumes against the same record instead of
// creating a duplicate or claiming success early.

export function remainingCaptureSteps(state, draft) {
  if (!draft?.id) throw new TypeError("A capture draft needs a client-generated item id.");
  const item = state?.items?.find((record) => record.itemId === draft.id) ?? null;
  const steps = [];
  if (!item) steps.push({ type: "add", id: draft.id, text: draft.text, classification: draft.classification });
  const wantsDate = Number.isSafeInteger(draft.planningDate) ? draft.planningDate : null;
  if (wantsDate != null && (item?.planningDate ?? null) !== wantsDate)
    steps.push({ type: "set-item-planning-date", itemId: draft.id, planningDate: wantsDate });
  const pinned = Boolean(state?.pins?.some((pin) => pin.targetKind === "item" && pin.targetId === draft.id));
  if (draft.pinned && !pinned) steps.push({ type: "pin", targetKind: "item", targetId: draft.id });
  return steps;
}

// Describes what did get saved when a later step fails, without overstating.
export function describePartialCapture(failedStep, destinationLabel) {
  if (failedStep.type === "add" || failedStep.type === "create-routine") return "Couldn't save. Your text is still here.";
  if (failedStep.type === "set-item-planning-date") return `Saved to ${destinationLabel}. Couldn't set the date.`;
  if (failedStep.type === "pin") return `Saved to ${destinationLabel}. Couldn't pin it.`;
  return `Saved to ${destinationLabel}. One more step didn't finish.`;
}
