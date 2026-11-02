#!/usr/bin/env python3
"""Stand-in `claude` and `pi` for recording orb's demo: scripted sessions.

Each session lives in ~/.fakeagent/sessions/<id>.json: its directory, what it
has shown so far, and what it does next (a turn still running, an approval
prompt, a question). Replies to new prompts come from ~/.fakeagent/replies.json,
matched by a word in the prompt. A script step can run a shell command, such
as the real `orb` CLI against the demo's orb, and show what it printed.

`claude` reports itself the way orb expects Claude Code to: the hook orb
installed runs on start and end, `claude agents --json --all` lists the live
processes with their status, and the transcript gets prompts, replies and an
ai-title. `pi` writes its pane file and session file the way orb's pi
extension and pi do.

Usage: fakeagent.py claude|pi [args...]
"""
import json, os, re, select, shutil, signal, subprocess, sys, termios, textwrap, time, tty, uuid
from datetime import datetime, timezone

HOME = os.environ["HOME"]
DIR = os.path.join(HOME, ".fakeagent")
SESSIONS = os.path.join(DIR, "sessions")
LIVE = os.path.join(DIR, "live")
PANE = os.environ.get("ORB_PANE_ID")

ORANGE, GREY, WHITE, GREEN, RED, BLUE, CYAN, YELLOW = (
    "\x1b[38;2;215;119;87m", "\x1b[38;2;153;153;153m", "\x1b[38;2;230;230;230m", "\x1b[38;2;78;186;101m",
    "\x1b[38;2;255;107;128m", "\x1b[38;2;130;170;255m", "\x1b[38;2;134;225;252m", "\x1b[38;2;255;199;119m")
BOLD, R = "\x1b[1m", "\x1b[0m"
SPIN = "·✢✳✶✻✽✻✶✳✢"
VERBS = ["Pondering", "Reticulating", "Crafting", "Noodling", "Percolating", "Simmering"]
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def append(path, line):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(line, separators=(",", ":")) + "\n")


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def claude_transcript(cwd, sid):
    return os.path.join(HOME, ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd), sid + ".jsonl")


def pi_transcript(cwd, sid):
    found = [p for p in sorted(os.listdir(pi_dir(cwd))) if p.endswith(f"_{sid}.jsonl")] if os.path.isdir(pi_dir(cwd)) else []
    if found:
        return os.path.join(pi_dir(cwd), found[0])
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    return os.path.join(pi_dir(cwd), f"{stamp}_{sid}.jsonl")


def pi_dir(cwd):
    return os.path.join(HOME, ".pi", "agent", "sessions", "--" + cwd.lstrip("/").replace("/", "-").replace(":", "-") + "--")


class Agent:
    """One interactive session drawn full screen and driven by its script."""

    def __init__(self, harness, sid, source):
        self.harness, self.sid, self.source = harness, sid, source
        self.path = os.path.join(SESSIONS, sid + ".json")
        cwd = os.path.realpath(os.getcwd())
        self.s = load(self.path, None) or {"cwd": cwd, "model": None, "log": [], "mode": "idle", "queue": []}
        self.s["cwd"] = cwd
        self.transcript = self.s.get("transcript") or (
            claude_transcript(cwd, sid) if harness == "claude" else pi_transcript(cwd, sid))
        self.s["transcript"] = self.transcript
        if harness == "pi" and not os.path.exists(self.transcript):
            append(self.transcript, {"type": "session", "version": 3, "id": sid, "timestamp": now_iso(), "cwd": cwd})
        self.buf = ""
        self.proc = None
        self.started = time.time()
        self.next_at = time.time() + 1.0
        self.verb = VERBS[len(self.s["log"]) % len(VERBS)]

    # --- reporting to orb ---

    def status(self):
        mode = self.s["mode"]
        if mode == "busy":
            return {"status": "busy"}
        if mode == "ask":
            return {"status": "waiting", "waitingFor": "permission prompt"}
        if mode == "question":
            return {"status": "waiting", "waitingFor": "user question"}
        return {"status": "idle"}

    def report(self, event=None):
        save(self.path, self.s)
        if self.harness == "claude":
            save(os.path.join(LIVE, f"{os.getpid()}.json"), {"sessionId": self.sid, **self.status()})
            if event:
                hook = os.path.join(HOME, ".orb", "hooks", "orb-agent-state.sh")
                name = {"start": "SessionStart", "end": "SessionEnd"}[event]
                payload = {"hook_event_name": name, "session_id": self.sid, "transcript_path": self.transcript,
                           "cwd": self.s["cwd"], "source": self.source, "reason": "prompt_input_exit"}
                if os.path.exists(hook):
                    subprocess.run(["sh", hook], input=json.dumps(payload), text=True)
        elif PANE and PANE.isdigit():
            event = event or ("working" if self.s["mode"] == "busy" else "idle")
            save(os.path.join(HOME, ".orb", "panes", f"{PANE}.json"),
                 {"agent": "pi", "event": event, "session_id": self.sid, "transcript": self.transcript,
                  "source": self.source, "at": int(time.time() * 1000)})

    def record(self, role, content):
        if self.harness == "claude":
            if role == "user":
                branch = subprocess.run(["git", "-C", self.s["cwd"], "branch", "--show-current"],
                                        capture_output=True, text=True).stdout.strip() or None
                append(self.transcript, {"type": "user", "timestamp": now_iso(), "gitBranch": branch,
                                         "message": {"role": "user", "content": content}})
            else:
                append(self.transcript, {"type": "assistant", "timestamp": now_iso(),
                                         "message": {"role": "assistant", "content": content}})
        else:
            blocks = [{"type": "text", "text": content}] if role == "user" else content
            append(self.transcript, {"type": "message", "timestamp": now_iso(),
                                     "message": {"role": role, "content": blocks}})

    # --- the script ---

    def begin(self, events):
        self.s["queue"] = list(events)
        self.s["mode"] = "busy"
        self.started = time.time()
        self.verb = VERBS[len(self.s["log"]) % len(VERBS)]
        self.next_at = time.time() + 1.0
        self.report()

    def submit(self, text):
        self.s["log"].append(["user", text])
        self.record("user", text)
        replies = load(os.path.join(DIR, "replies.json"), [])
        events = next((r["events"] for r in replies if r["match"].lower() in text.lower()),
                      [["text", "Done. I made the change and the tests pass."]])
        if self.harness == "claude" and not any(e[0] == "title" for e in events) and len(self.s["log"]) == 1:
            events = [["title", text[:1].upper() + text[1:60]]] + events
        self.begin(events)

    def step(self):
        if self.s["mode"] != "busy" or time.time() < self.next_at:
            return
        if self.proc:
            if self.proc.poll() is None:
                return
            out, err = self.proc.communicate()
            text = (out or err).strip()
            if self.proc_var:
                self.s.setdefault("vars", {})[self.proc_var] = json.loads(out)["pane"]
            self.proc = None
            self.s["log"].append(["result", text])
            self.next_at = time.time() + 0.5
            save(self.path, self.s)
            return
        if not self.s["queue"]:
            self.s["mode"] = "idle"
            self.report()
            return
        kind, *rest = self.s["queue"].pop(0)
        delay = 0.3
        if kind == "file":
            path = os.path.join(self.s["cwd"], rest[0])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(rest[1])
            delay = 0
        elif kind == "title":
            if self.harness == "claude":
                append(self.transcript, {"type": "ai-title", "aiTitle": rest[0]})
            delay = 0
        elif kind == "sleep":
            delay = rest[0]
        elif kind == "run":
            command = rest[0].format(**self.s.get("vars", {}))
            self.s["log"].append(["tool", f"Bash({command})"])
            self.record("assistant", [{"id": uuid.uuid4().hex[:12], "type": "tool_use", "name": "Bash",
                                       "input": {"command": command}}])
            self.proc = subprocess.Popen(["sh", "-c", command], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         stdin=subprocess.DEVNULL, text=True)
            self.proc_var = rest[1] if len(rest) > 1 else None
            delay = 0
        elif kind == "loop":
            self.s["queue"] = rest[0] + [["loop", rest[0]]]
            delay = 0
        elif kind in ("ask", "question"):
            self.s["pending"] = rest[0]
            self.s["mode"] = kind
            self.report()
            return
        elif kind == "text":
            self.s["log"].append(["text", ""])
            self.s["queue"][:0] = [["more", w] for w in rest[0].split(" ")]
            self.record("assistant", [{"type": "text", "text": rest[0]}])
            delay = 0
        elif kind == "more":
            self.s["log"][-1][1] = (self.s["log"][-1][1] + " " + rest[0]).strip()
            delay = 0.03
        else:
            self.s["log"].append([kind, rest[0]])
            if kind == "tool":
                name, _, arg = rest[0].partition("(")
                block = ({"type": "tool_use", "name": name, "input": {"command": arg.rstrip(")")}}
                         if self.harness == "claude" else
                         {"type": "toolCall", "name": name.lower(), "arguments": {"path": arg.rstrip(")")}})
                self.record("assistant", [{"id": uuid.uuid4().hex[:12], **block}])
            delay = 1.0 if kind in ("tool", "result") else 0.3
        self.next_at = time.time() + delay
        save(self.path, self.s)

    def key(self, data):
        if b"\r" in data and data != b"\r":
            for i, part in enumerate(data.split(b"\r")):
                if i:
                    self.key(b"\r")
                if part:
                    self.key(part)
            return
        mode = self.s["mode"]
        if mode == "ask":
            if data in (b"1", b"\r"):
                pending = self.s.pop("pending")
                self.s["log"].append(["tool", pending["tool"]])
                self.begin(pending["then"])
            return
        if data == b"\r":
            text = self.buf.strip()
            self.buf = ""
            if not text:
                return
            if mode == "question":
                pending = self.s.pop("pending")
                self.s["log"].append(["user", text])
                self.record("user", text)
                self.begin(pending["then"])
            elif mode == "idle":
                self.submit(text)
        elif data in (b"\x7f", b"\x08"):
            self.buf = self.buf[:-1]
        elif not data.startswith(b"\x1b"):
            self.buf += "".join(c for c in data.decode(errors="ignore") if c.isprintable())

    # --- drawing ---

    def body(self, w):
        out = []
        for kind, text in self.s["log"]:
            wrap = textwrap.wrap(text, w - 2) or [""]
            if kind == "user":
                if self.harness == "claude":
                    out += [f"{GREY}{'> ' if i == 0 else '  '}{l}{R}" for i, l in enumerate(wrap)]
                else:
                    out += [f"\x1b[48;2;52;53;65m {l}{' ' * max(0, w - len(l) - 1)}{R}" for l in wrap]
            elif kind == "text":
                lead = f"{WHITE}⏺{R} " if self.harness == "claude" else ""
                out += [f"{lead}{l}" if i == 0 else f"{'  ' if lead else ''}{l}" for i, l in enumerate(wrap)]
            elif kind == "tool":
                name, _, arg = text.partition("(")
                if self.harness == "claude":
                    first, *more = textwrap.wrap(f"{name}({arg}", w - 2) or [""]
                    out.append(f"{GREEN}⏺{R} {BOLD}{name}{R}{first[len(name):]}")
                    out += [f"  {l}" for l in more]
                else:
                    out.append(f"\x1b[48;2;40;50;40m {BOLD}{name.lower()}{R}\x1b[48;2;40;50;40m {arg.rstrip(')')} {R}")
            elif kind == "result":
                out += [f"{GREY}  {'⎿ ' if i == 0 else '  '} {l}{R}" for i, l in enumerate(text.split("\n"))]
            elif kind == "diff":
                for l in text.split("\n"):
                    color = GREEN if l.startswith("+") else RED if l.startswith("-") else GREY
                    out += [f"    {color}{piece}{R}" for piece in textwrap.wrap(l, w - 6, subsequent_indent="  ") or [l]]
            out.append("")
        return out

    def box(self, color, rows, box):
        out = [color + "╭" + "─" * box + "╮" + R]
        for row in rows:
            plain = ANSI.sub("", row)
            indent = " " * (len(plain) - len(plain.lstrip()))
            for text in [row] if len(plain) <= box - 2 else textwrap.wrap(plain, box - 2, subsequent_indent=indent + "   "):
                vis = len(ANSI.sub("", text))
                out.append(f"{color}│{R} {text}{' ' * max(0, box - 1 - vis)}{color}│{R}")
        return out + [color + "╰" + "─" * box + "╯" + R]

    def claude_lines(self, w):
        box = w - 2
        cwd = self.s["cwd"].replace(HOME, "~")
        out = self.box(ORANGE, [f"{ORANGE}✻{R} {BOLD}Welcome to Claude Code!{R}", "",
                                f"{GREY}  /help for help, /status for your current setup{R}", "",
                                f"{GREY}  cwd: {cwd}{R}"], box) + [""]
        out += self.body(w)
        mode, pending = self.s["mode"], self.s.get("pending")
        if mode == "busy":
            secs = int(time.time() - self.started)
            glyph = SPIN[int(time.time() * 8) % len(SPIN)]
            out += [f"{ORANGE}{glyph} {self.verb}…{R} {GREY}({secs}s · ↓ {secs * 137 + 212} tokens · esc to interrupt){R}", ""]
        if mode == "ask":
            first = pending["command"].split()[0]
            out += self.box(BLUE, [f"{BOLD}{pending['kind']}{R}", "", f"  {pending['command']}",
                                   f"  {GREY}{pending['why']}{R}", "", "Do you want to proceed?",
                                   f"{BLUE}❯ 1. Yes{R}", f"  2. Yes, and don't ask again for {first} commands",
                                   "  3. No, and tell Claude what to do differently (esc)"], box)
            return out
        if mode == "question":
            out += self.box(BLUE, [f"{BOLD}☐ {pending['header']}{R}", "", pending["question"], ""]
                            + [f"{BLUE}❯{R} {i + 1}. {o}" if i == 0 else f"  {i + 1}. {o}"
                               for i, o in enumerate(pending["options"])]
                            + [f"  {len(pending['options']) + 1}. Type something: {self.buf}\x1b[7m \x1b[27m"], box)
            return out
        shown = self.buf[-(box - 4):]
        out += self.box(GREY, [f"> {shown}\x1b[7m \x1b[27m"], box)
        model = (self.s.get("model") or "claude-opus-5-5").split("-")
        label = f"{model[1].title()} {'.'.join(model[2:4])}" if len(model) > 2 else "Opus 5.5"
        left = "  ? for shortcuts"
        out.append(f"{GREY}{left}{' ' * max(1, w - len(left) - len(label))}{label}{R}")
        return out

    def pi_lines(self, w):
        out = [f"{BOLD}{CYAN}π{R} {BOLD}pi{R} {GREY}v0.71.0{R}",
               f"{GREY}escape interrupt · ctrl+c clear · / commands · ! bash · ctrl+o expand{R}", ""]
        out += self.body(w)
        if self.s["mode"] == "busy":
            glyph = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[int(time.time() * 10) % 10]
            out += [f"{CYAN}{glyph}{R} {GREY}Working... (esc to interrupt){R}", ""]
        rule = f"{GREY}{'─' * w}{R}"
        out += [rule, f"{self.buf[-(w - 2):]}\x1b[7m \x1b[27m", rule]
        branch = subprocess.run(["git", "-C", self.s["cwd"], "branch", "--show-current"],
                                capture_output=True, text=True).stdout.strip()
        cwd = self.s["cwd"].replace(HOME, "~") + (f" ({branch})" if branch else "")
        model = self.s.get("model") or "claude-sonnet-5-5"
        out.append(f"{GREY}{cwd[:w]}{R}")
        stats = "↑12k ↓3.1k $0.042 4.1%/200k" if w > 60 else ""
        out.append(f"{GREY}{stats}{' ' * max(1, w - len(stats) - len(model))}{model}{R}")
        return out

    def draw(self):
        cols, rows = shutil.get_terminal_size()
        w = max(20, cols - 2)
        lines = (self.claude_lines(w) if self.harness == "claude" else self.pi_lines(w))
        lines = lines[-rows:]
        frame = "".join(" " + l + "\x1b[K\r\n" for l in lines[:-1]) + " " + lines[-1] + "\x1b[K\x1b[J"
        sys.stdout.write("\x1b[?2026h\x1b[H" + frame + "\x1b[?2026l")
        sys.stdout.flush()

    def run(self):
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        tty.setraw(fd)
        sys.stdout.write("\x1b[?1049h\x1b[?25l")
        quit = []
        for sig in (signal.SIGHUP, signal.SIGTERM):
            signal.signal(sig, lambda *_: quit.append(True))
        signal.signal(signal.SIGWINCH, lambda *_: None)
        self.report("start")
        if self.s["mode"] == "busy":
            self.next_at = time.time() + 1.0
        try:
            while not quit:
                try:
                    ready, _, _ = select.select([fd], [], [], 0.05)
                except InterruptedError:
                    ready = []
                if ready:
                    data = os.read(fd, 1024)
                    if not data or data in (b"\x03", b"\x04"):
                        break
                    self.key(data)
                self.step()
                self.draw()
        finally:
            try:
                os.remove(os.path.join(LIVE, f"{os.getpid()}.json"))
            except OSError:
                pass
            if not quit:
                self.report("end")
            save(self.path, self.s)
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
            sys.stdout.write("\x1b[?25h\x1b[?1049l")
            sys.stdout.flush()


def claude_agents():
    out = []
    for name in sorted(os.listdir(LIVE)) if os.path.isdir(LIVE) else []:
        pid = int(name.split(".")[0])
        if alive(pid):
            out.append({"pid": pid, "kind": "interactive", **load(os.path.join(LIVE, name), {})})
        else:
            os.remove(os.path.join(LIVE, name))
    print(json.dumps(out))


def flag(args, *names):
    for name in names:
        if name in args and args.index(name) + 1 < len(args):
            return args[args.index(name) + 1]
    return None


def main():
    harness, args = sys.argv[1], sys.argv[2:]
    if harness == "claude" and args[:1] == ["agents"]:
        return claude_agents()
    if harness == "claude" and args[:1] in (["stop"], ["rm"]):
        return
    if "--version" in args or "-v" in args:
        return print("2.1.90 (Claude Code)" if harness == "claude" else "0.71.0")
    resume = flag(args, "--resume", "-r", "--session-id")
    Agent(harness, resume or str(uuid.uuid4()), "resume" if resume else "startup").run()


main()
