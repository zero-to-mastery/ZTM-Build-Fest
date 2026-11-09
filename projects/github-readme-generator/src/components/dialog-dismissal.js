// Route every dismissal through the owner's unsaved-edit guard and focus return.
export function bindDialogDismissal(dialog, dismiss) {
  let startedOutside = false;
  const outside = (event) => {
    const bounds = dialog.getBoundingClientRect();
    return (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    );
  };
  dialog.addEventListener("cancel", (event) => {
    if (event.target !== dialog) return;
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("pointerdown", (event) => {
    startedOutside = event.isPrimary && event.button === 0 && outside(event);
  });
  dialog.addEventListener("pointercancel", () => {
    startedOutside = false;
  });
  dialog.addEventListener("click", (event) => {
    const shouldDismiss = startedOutside && outside(event);
    startedOutside = false;
    if (shouldDismiss) dismiss();
  });
  dialog.addEventListener("close", () => {
    startedOutside = false;
  });
}
