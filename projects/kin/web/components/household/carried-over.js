// Devices carried over from the old address (ADR 0026 §6, #769): after a
// move to a home server, the household's old devices arrive without a way
// to sign in here. People & devices marks them, and an admin removes them
// together. This is the wording for that, built before anything is asked of
// the server, so the confirmation can stay open as long as the admin needs.

/** Where a carried-over device came from; the sign-in list says this too. */
export const CARRIED_OVER_ORIGIN = "From the old address";

/** The status beside a device carried over from the old address. */
export const CARRIED_OVER_STATUS = `${CARRIED_OVER_ORIGIN} · can't sign in here`;

/** The bulk-removal button: "Remove the 2 devices from the old address". */
export function carriedOverButtonLabel(count) {
  return count === 1 ? "Remove the device from the old address" : `Remove the ${count} devices from the old address`;
}

/** "Sam", "Sam and Robin", "Sam, Robin and Household member 2". */
export function joinNames(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The confirmation for removing the devices from the old address. `count`
 * is how many there are; `waiting` names (as People & devices labels them)
 * the members whose only devices are from the old address, so haven't
 * signed in here yet.
 */
export function carriedOverConfirmation({ count, waiting = [] }) {
  const lines = [count === 1
    ? "Remove the device from the old address? It can't sign in here."
    : `Remove the ${count} devices from the old address? None of them can sign in here.`];
  if (!waiting.length) {
    lines.push(count === 1
      ? "The person it belongs to has signed in here on another device."
      : "Everyone they belong to has signed in here on another device.");
  } else {
    lines.push(`${joinNames(waiting)} ${waiting.length === 1 ? "hasn't" : "haven't"} signed in here yet.`);
    lines.push("This doesn't remove anyone from the household. They can still sign in here with their password or backup code; anyone who has neither needs a recovery invitation from you.");
    lines.push("Until they sign in, they won't appear among the people you can assign things to.");
  }
  return lines.join(" ");
}
