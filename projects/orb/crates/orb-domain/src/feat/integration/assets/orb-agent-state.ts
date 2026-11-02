// Installed by `orb integration install`, which overwrites it.
// Inside an orb pane (ORB_PANE_ID set) it writes this pi session and its
// state to ~/.orb/panes/<pane>.json: start, working, idle, and end on quit.
// Only the interactive (tui) session reports; subagents run in json mode.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const pane = process.env.ORB_PANE_ID;
const dir = join(homedir(), ".orb", "panes");

export default function (pi: any) {
  if (!pane || !/^\d+$/.test(pane)) return;
  let root = false;
  let source: string | undefined;
  const report = (event: string, ctx: any) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) return;
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${pane}.${process.pid}.tmp`);
      writeFileSync(
        tmp,
        JSON.stringify({
          agent: "pi",
          event,
          session_id: sessionId,
          transcript: ctx.sessionManager.getSessionFile(),
          source,
          at: Date.now(),
        }),
      );
      renameSync(tmp, join(dir, `${pane}.json`));
    } catch {}
  };
  pi.on("session_start", (event: any, ctx: any) => {
    if (ctx.mode !== "tui") return;
    root = true;
    source = event.reason;
    report("start", ctx);
  });
  pi.on("agent_start", (_event: any, ctx: any) => {
    if (root) report("working", ctx);
  });
  pi.on("agent_settled", (_event: any, ctx: any) => {
    if (root) report("idle", ctx);
  });
  pi.on("session_shutdown", (event: any, ctx: any) => {
    if (root && event.reason === "quit") report("end", ctx);
  });
}
