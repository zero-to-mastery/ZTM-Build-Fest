// DurableStore board relay (#317, ADR 0011): encrypted fridge events in a
// relay stream of their own (stream-events.mjs; board-relay-service.mjs has
// the rules).
import { streamEventMethods } from "./stream-events.mjs";

export const boardEventMethods = streamEventMethods("board", {
  label: "fridge",
  conflictCode: "board_relay_conflict",
  conflictMessage: "The fridge changed meanwhile; retry.",
});
