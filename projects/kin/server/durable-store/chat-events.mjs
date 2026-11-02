// DurableStore chat relay (#111): encrypted chat events in their own relay
// stream (stream-events.mjs; chat-relay-service.mjs has the rules).
import { streamEventMethods } from "./stream-events.mjs";

export const chatEventMethods = streamEventMethods("chat", {
  label: "chat",
  conflictCode: "chat_relay_conflict",
  conflictMessage: "Chat changed meanwhile; retry.",
});
