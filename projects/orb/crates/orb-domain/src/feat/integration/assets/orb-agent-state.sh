#!/bin/sh
# Installed by `orb integration install`, which overwrites it.
# Claude Code runs it on SessionStart and SessionEnd. Inside an orb pane
# (ORB_PANE_ID set) it writes the session to ~/.orb/panes/<pane>.json.
# Subagents, Cursor's Claude-compatible events, and the end of a session
# that /clear or /resume replaces are skipped. Always exits 0.
[ -n "${ORB_PANE_ID:-}" ] || exit 0
[ -z "${CURSOR_VERSION:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
program=$(cat <<'PY'
import json, os, sys, time
pane, panes = sys.argv[1], sys.argv[2]
try:
    hook = json.load(sys.stdin)
    name = hook.get("hook_event_name")
    sid = hook.get("session_id")
    if not pane.isdigit() or "cursor_version" in hook or hook.get("agent_id") \
            or not isinstance(sid, str) or not sid:
        sys.exit(0)
    if name == "SessionStart":
        event = "start"
    elif name == "SessionEnd" and hook.get("reason") not in ("clear", "resume"):
        event = "end"
    else:
        sys.exit(0)
    report = {"agent": "claude", "event": event, "session_id": sid,
              "at": int(time.time() * 1000)}
    if isinstance(hook.get("transcript_path"), str) and hook["transcript_path"]:
        report["transcript"] = hook["transcript_path"]
    if event == "start" and isinstance(hook.get("source"), str):
        report["source"] = hook["source"]
    os.makedirs(panes, exist_ok=True)
    tmp = os.path.join(panes, ".%s.%d.tmp" % (pane, os.getpid()))
    with open(tmp, "w") as out:
        json.dump(report, out)
    os.replace(tmp, os.path.join(panes, pane + ".json"))
except Exception:
    pass
PY
)
python3 -c "$program" "$ORB_PANE_ID" "$HOME/.orb/panes" || true
exit 0
