#!/usr/bin/env python3
"""Builds a throwaway HOME of dummy projects, sessions and agents for orb's demo.

Usage: ORB_BIN=<orb> setup.py
"""
import json, os, re, shutil, sqlite3, subprocess, time, uuid
from datetime import datetime, timezone

KIT = os.path.dirname(os.path.abspath(__file__))
ROOT = "/private/tmp/orbdemo"
HOME = f"{ROOT}/home"
REAL = os.path.expanduser("~")
ORB = os.environ["ORB_BIN"]
NOW = int(time.time() * 1000)
MIN, HOUR, DAY = 60_000, 3_600_000, 86_400_000

shutil.rmtree(ROOT, ignore_errors=True)
os.makedirs(HOME)
ENV = {"HOME": HOME, "PATH": f"{KIT}/fakebin:/opt/homebrew/bin:/usr/bin:/bin", "LANG": "en_US.UTF-8",
       "GIT_AUTHOR_NAME": "Jordan Lee", "GIT_AUTHOR_EMAIL": "jordan.lee@fastmail.com",
       "GIT_COMMITTER_NAME": "Jordan Lee", "GIT_COMMITTER_EMAIL": "jordan.lee@fastmail.com"}


def w(path, text):
    path = os.path.join(HOME, path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text.lstrip("\n"))


def git(cwd, *args, when=None):
    env = dict(ENV)
    if when:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = when
    subprocess.run(["git", "-C", os.path.join(HOME, cwd), *args], env=env, check=True, capture_output=True)


def commit(cwd, msg, files, days_ago):
    for path, text in files.items():
        w(f"{cwd}/{path}", text)
    git(cwd, "add", "-A")
    git(cwd, "commit", "-qm", msg, when=f"{int(time.time()) - days_ago * 86400} +0000")


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def jsonl(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.writelines(json.dumps(line, separators=(",", ":")) + "\n" for line in lines)


# --- dotfiles ---
w(".gitconfig", "[user]\n\tname = Jordan Lee\n\temail = jordan.lee@fastmail.com\n[init]\n\tdefaultBranch = main\n")
w(".demorc", r"""
export BASH_SILENCE_DEPRECATION_WARNING=1
PS1='\[\e[38;2;130;170;255m\]\w\[\e[0m\] \[\e[38;2;195;232;141m\]❯\[\e[0m\] '
""")
w("bin/orb", f'#!/bin/sh\n[ $# -gt 0 ] && exec "{ORB}" "$@"\nexec python3 "{KIT}/keys.py" "{ORB}"\n')
os.chmod(f"{HOME}/bin/orb", 0o755)
w("Library/Application Support/lazygit/config.yml",
  "disableStartupPopups: true\ngui:\n  showRandomTip: false\n  nerdFontsVersion: \"3\"\n")
os.makedirs(f"{HOME}/.config", exist_ok=True)
os.makedirs(f"{HOME}/.local/share", exist_ok=True)
for link in [".config/nvim", ".local/share/nvim"]:
    if os.path.exists(f"{REAL}/{link}"):
        os.symlink(f"{REAL}/{link}", f"{HOME}/{link}")

# --- dummy repos ---
os.makedirs(f"{HOME}/dev")
for repo in ["payments-api", "storefront", "shipit"]:
    git("dev", "init", "-q", repo)

commit("dev/payments-api", "Initial commit: axum skeleton", {
    "Cargo.toml": '[package]\nname = "payments-api"\nversion = "0.3.0"\nedition = "2024"\n\n[dependencies]\naxum = "0.8"\ntokio = { version = "1", features = ["full"] }\nserde = { version = "1", features = ["derive"] }\n',
    "README.md": "# payments-api\n\nOrders, refunds and payment intents for the storefront.\n",
    "src/main.rs": 'mod auth;\nmod routes;\n\n#[tokio::main]\nasync fn main() {\n    let app = routes::router();\n    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();\n    axum::serve(listener, app).await.unwrap();\n}\n',
}, 21)
commit("dev/payments-api", "Add /v1/orders endpoints", {
    "src/routes.rs": 'mod orders;\n\npub fn router() -> axum::Router {\n    axum::Router::new().nest("/v1/orders", orders::router())\n}\n',
    "src/routes/orders.rs": 'use axum::{Json, Router, routing::get};\n\npub fn router() -> Router {\n    Router::new().route("/", get(list).post(create))\n}\n\nasync fn list() -> Json<Vec<String>> {\n    Json(vec![])\n}\n\nasync fn create() -> &\'static str {\n    "created"\n}\n',
}, 14)
commit("dev/payments-api", "Token refresh for service accounts", {
    "src/auth.rs": 'pub mod token;\n',
    "src/auth/token.rs": '/// A short-lived access token and when it expires.\npub struct Token {\n    pub value: String,\n    pub expires_at: u64,\n}\n\nimpl Token {\n    pub fn needs_refresh(&self, now: u64) -> bool {\n        now + 30 >= self.expires_at\n    }\n}\n',
}, 6)
commit("dev/payments-api", "Load config from environment", {
    "src/config.rs": 'pub struct Config {\n    pub port: u16,\n    pub database_url: String,\n}\n',
}, 2)
git("dev/payments-api", "branch", "release/0.3")

commit("dev/storefront", "Scaffold Vite + React app", {
    "package.json": '{\n  "name": "storefront",\n  "private": true,\n  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest" },\n  "dependencies": { "react": "^19.1.0", "react-dom": "^19.1.0" }\n}\n',
    "README.md": "# storefront\n\nCustomer-facing shop and account pages.\n",
    "src/App.tsx": 'import { Settings } from "./settings/Settings";\n\nexport function App() {\n  return <Settings />;\n}\n',
}, 30)
commit("dev/storefront", "Settings page", {
    "src/settings/Settings.tsx": 'import { ThemeToggle } from "./ThemeToggle";\n\nexport function Settings() {\n  return (\n    <section>\n      <h1>Settings</h1>\n      <ThemeToggle />\n    </section>\n  );\n}\n',
    "src/settings/ThemeToggle.tsx": 'import { useState } from "react";\n\nexport function ThemeToggle() {\n  const [dark, setDark] = useState(false);\n  return <button onClick={() => setDark(!dark)}>{dark ? "Dark" : "Light"}</button>;\n}\n',
}, 9)
commit("dev/storefront", "Charts on the overview page", {
    "src/overview/Overview.tsx": 'import { LineChart } from "big-chart-lib";\n\nexport function Overview() {\n  return <LineChart data={[]} />;\n}\n',
}, 3)
git("dev/storefront", "branch", "feat/onboarding")

commit("dev/shipit", "Initial commit", {
    "go.mod": "module shipit\n\ngo 1.25\n",
    "README.md": "# shipit\n\nDeploy, roll back and check on services from the terminal.\n",
    "main.go": 'package main\n\nimport "shipit/cmd"\n\nfunc main() { cmd.Execute() }\n',
    "cmd/status.go": 'package cmd\n\nimport "fmt"\n\nfunc status() { fmt.Println("all systems go") }\n',
}, 40)
commit("dev/shipit", "Deploy command with --dry-run", {"cmd/deploy.go": 'package cmd\n\nfunc deploy(service string, dryRun bool) error { return nil }\n'}, 20)
commit("dev/shipit", "Rollback to the previous release", {"cmd/rollback.go": 'package cmd\n\nfunc rollback(service string) error { return nil }\n'}, 11)
commit("dev/shipit", "v0.4.0", {"CHANGELOG.md": "## v0.4.0\n\n- `shipit status --watch`\n"}, 5)
git("dev/shipit", "branch", "feat/watch-mode")
git("dev/shipit", "branch", "release/0.4")

w("dev/rfcs/index.md", "# RFCs\n\nDesign docs for upcoming platform work.\n")
w("dev/rfcs/roadmap.md", "# Roadmap\n\n- Beta in Q4\n")
for d in ["Desktop", "Documents", "Downloads", "dotfiles"]:
    os.makedirs(f"{HOME}/{d}", exist_ok=True)
w("notes/todo.md", "- renew TLS certs\n- review storefront PR\n")

# --- orb's store: let orb create it now, as its start-up sweep would prune a worktree no session uses yet ---
subprocess.run([ORB], env=ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=10)

# --- a worktree orb made earlier, and a Research folder ---
WT = f"{HOME}/.orb/worktrees"
RATE = f"{WT}/payments-api/orb-7f3a9c21"
os.makedirs(f"{WT}/payments-api")
git("dev/payments-api", "worktree", "add", "-q", "-b", "orb/rate-limiting-for-orders", RATE)
RESEARCH = f"{HOME}/.orb/research/pricing-teardown"
w(".orb/research/pricing-teardown/AGENTS.md", "# Research: pricing teardown\n\nCompare competitor pricing pages.\n")
w(".orb/research/pricing-teardown/report.md", "# Pricing teardown\n\n_Draft._\n")

subprocess.run([ORB, "integration", "install"], env=ENV, check=True, capture_output=True)

# --- agents: their scripts, transcripts and the fake agent's session files ---
ASK_FLAKY = {
    "kind": "Bash command", "command": "cargo test token_refresh -- --test-threads 1",
    "why": "Run the token refresh test in a loop to reproduce the flake",
    "tool": "Bash(cargo test token_refresh -- --test-threads 1)",
    "then": [["result", "running 50 tests\ntest result: FAILED. 47 passed; 3 failed"],
             ["text", "Reproduced: 3 of 50 runs fail. I'll inject the clock instead of reading SystemTime."],
             ["tool", "Update(src/auth/token.rs)"], ["result", "Updated with 12 additions and 3 removals"],
             ["diff", "-fn needs_refresh(&self, now: u64)\n+fn needs_refresh(&self, clock: &impl Clock)\n+    let now = clock.now();"],
             ["tool", "Bash(cargo test token_refresh)"], ["result", "test result: ok. 50 passed; 0 failed"],
             ["text", "Fixed. The test now uses a frozen clock and passes 50 out of 50 runs."]],
}
QUESTION_BUNDLE = {
    "header": "Bundle", "question": "big-chart-lib is 61% of the bundle and only Overview uses it. What should I do?",
    "options": ["Lazy-load the Overview page", "Swap big-chart-lib for a lighter chart library"],
    "then": [["tool", "Update(src/App.tsx)"], ["result", "Updated with 5 additions and 1 removal"],
             ["diff", "-import { Overview } from \"./overview\";\n+const Overview = lazy(() => import(\"./overview\"));"],
             ["tool", "Bash(npm run build)"], ["result", "dist/index.js           612 kB\ndist/Overview-3f9a.js  1.41 MB (lazy)"],
             ["text", "The first load is now 612 kB. The chart library only downloads when someone opens Overview."]],
}
RATE_LOOP = [["tool", "Bash(cargo test rate_limit)"], ["sleep", 4],
             ["result", "test result: ok. 14 passed; 0 failed"],
             ["tool", "Update(src/routes/limit.rs)"], ["sleep", 3], ["result", "Updated with 6 additions and 2 removals"],
             ["tool", "Bash(cargo clippy -- -D warnings)"], ["sleep", 5], ["result", "Finished `dev` profile in 3.42s"]]

# (key, harness, title, cwd, mode, ago, log, extra)
AGENTS = {
    "rate": ("claude", "Rate limiting for /v1/orders", RATE, "busy", 1 * MIN,
             [["user", "Rate limiting for /v1/orders: 100 req/min per API key"],
              ["tool", "Read(src/routes/orders.rs)"], ["result", "Read 14 lines"],
              ["text", "I'll add a token-bucket layer keyed by API key and cover it with tests."],
              ["tool", "Write(src/routes/limit.rs)"], ["result", "Wrote 58 lines to src/routes/limit.rs"]],
             {"queue": [["loop", RATE_LOOP]]}),
    "flaky": ("claude", "Fix flaky token refresh test", RATE, "ask", 6 * MIN,
              [["user", "Fix the flaky token refresh test, it fails about 1 in 20 runs on CI"],
               ["tool", "Read(src/auth/token.rs)"], ["result", "Read 11 lines"],
               ["text", "needs_refresh compares against the wall clock, so a slow CI runner can cross the 30 s window mid-test. Let me reproduce it by running the test in a loop."]],
              {"pending": ASK_FLAKY}),
    "bundle": ("claude", "Shrink the bundle below 1 MB", f"{HOME}/dev/storefront", "question", 12 * MIN,
               [["user", "Shrink the bundle below 1 MB"],
                ["tool", "Bash(npx vite-bundle-visualizer)"],
                ["result", "big-chart-lib  1.4 MB  (61%)\nreact-dom       142 kB\n… 18 more"]],
               {"pending": QUESTION_BUNDLE}),
    "dark": ("pi", "Dark mode toggle for settings", f"{HOME}/dev/storefront", "idle", 25 * MIN,
             [["user", "Dark mode toggle for settings, following the system theme by default"],
              ["tool", "Read(src/settings/ThemeToggle.tsx)"],
              ["tool", "Edit(src/settings/ThemeToggle.tsx)"],
              ["text", "The toggle now starts from prefers-color-scheme and remembers the user's choice in localStorage."]],
             {}),
    "json": ("claude", "Add --json output to status", f"{HOME}/dev/shipit", "idle", 40 * MIN,
             [["user", "Add --json output to shipit status"],
              ["tool", "Update(cmd/status.go)"], ["result", "Updated with 18 additions and 2 removals"],
              ["tool", "Bash(go test ./...)"], ["result", "ok      shipit/cmd    0.388s"],
              ["text", "`shipit status --json` prints one object per service with its version, health and last deploy."]],
             {}),
    "pricing": ("claude", "Compare competitor pricing pages", RESEARCH, "idle", 3 * HOUR,
                [["user", "Compare competitor pricing pages for usage-based plans"],
                 ["tool", "Task(investigator: pricing pages)"], ["result", "Found 6 sources"],
                 ["text", "Four of the six competitors bill per seat with a usage cap; two bill purely on usage. The report has the table and sources."]],
                {}),
    "notes": ("claude", "Write v0.4 release notes", f"{HOME}/dev/shipit", "idle", 4 * DAY,
              [["user", "Write the v0.4 release notes"], ["text", "Done. CHANGELOG.md has the v0.4.0 notes."]], {}),
    "axum": ("claude", "Bump axum to 0.8", f"{HOME}/dev/payments-api", "idle", 6 * DAY,
             [["user", "Bump axum to 0.8 and fix what breaks"], ["text", "Done. Two route signatures changed; tests pass."]], {}),
}

SIDS = {}
for key, (harness, title, cwd, mode, ago, log, extra) in AGENTS.items():
    sid = str(uuid.uuid4())
    SIDS[key] = sid
    at = NOW - ago - 10 * MIN
    if harness == "claude":
        path = f"{HOME}/.claude/projects/{re.sub(r'[^A-Za-z0-9]', '-', cwd)}/{sid}.jsonl"
        lines = [{"type": "ai-title", "aiTitle": title}]
        for i, (kind, text) in enumerate(log):
            stamp = iso(at + i * 20_000)
            if kind == "user":
                lines.append({"type": "user", "timestamp": stamp, "message": {"role": "user", "content": text}})
            elif kind == "text":
                lines.append({"type": "assistant", "timestamp": stamp,
                              "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
            elif kind == "tool":
                name, _, arg = text.partition("(")
                lines.append({"type": "assistant", "timestamp": stamp, "message": {"role": "assistant", "content": [
                    {"type": "tool_use", "id": uuid.uuid4().hex[:12], "name": name, "input": {"command": arg.rstrip(")")}}]}})
    else:
        dirname = "--" + cwd.lstrip("/").replace("/", "-") + "--"
        path = f"{HOME}/.pi/agent/sessions/{dirname}/{iso(at).replace(':', '-').replace('.', '-')}_{sid}.jsonl"
        lines = [{"type": "session", "version": 3, "id": sid, "timestamp": iso(at), "cwd": cwd}]
        for i, (kind, text) in enumerate(log):
            stamp = iso(at + i * 20_000)
            if kind == "user":
                lines.append({"type": "message", "timestamp": stamp,
                              "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
            elif kind == "text":
                lines.append({"type": "message", "timestamp": stamp,
                              "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
            elif kind == "tool":
                name, _, arg = text.partition("(")
                lines.append({"type": "message", "timestamp": stamp, "message": {"role": "assistant", "content": [
                    {"type": "toolCall", "id": uuid.uuid4().hex[:12], "name": name.lower(), "arguments": {"path": arg.rstrip(")")}}]}})
    jsonl(path, lines)
    state = {"cwd": cwd, "model": None, "log": log, "mode": mode, "queue": [], "transcript": path, **extra}
    os.makedirs(f"{HOME}/.fakeagent/sessions", exist_ok=True)
    with open(f"{HOME}/.fakeagent/sessions/{sid}.json", "w") as f:
        json.dump(state, f)

WEB = [["sleep", 1.5], ["result", "Fetched 46 kB"]]
REPLIES = [
    {"match": "colonist", "events": [
        ["title", "Compare auth providers"],
        ["text", "I'll start one colonist per provider and have each price it for 10k users."],
        ["run", "orb session create --name okta", "okta"],
        ["run", "orb agent start --kind claude --pane {okta} && orb agent prompt {okta} 'Price Okta for 10k users'"],
        ["run", "orb session create --name auth0", "auth0"],
        ["run", "orb agent start --kind claude --pane {auth0} && orb agent prompt {auth0} 'Price Auth0 for 10k users'"],
        ["run", "orb session create --name clerk", "clerk"],
        ["run", "orb agent start --kind claude --pane {clerk} && orb agent prompt {clerk} 'Price Clerk for 10k users'"],
        ["text", "Three colonists are on it. I'll read each one's answer with orb agent reply when it finishes."]]},
    {"match": "okta", "events": [
        ["tool", "WebFetch(okta.com/pricing)"], *WEB, ["sleep", 6],
        ["text", "Okta: about $2,300 a month at 10k users, SSO and MFA included."]]},
    {"match": "auth0", "events": [
        ["tool", "WebFetch(auth0.com/pricing)"], *WEB,
        ["question", {"header": "Plan", "question": "Auth0's B2C plans stop at 20k users. Price the B2C or the B2B plan?",
                      "options": ["B2C Professional", "B2B Essentials"],
                      "then": [["text", "Auth0 B2B Essentials: about $1,500 a month at 10k users."]]}]]},
    {"match": "clerk", "events": [
        ["tool", "WebFetch(clerk.com/pricing)"], *WEB,
        ["ask", {"kind": "Bash command", "command": "npm view @clerk/clerk-js version",
                 "why": "Check Clerk's latest SDK release", "tool": "Bash(npm view @clerk/clerk-js version)",
                 "then": [["result", "5.71.2"], ["text", "Clerk: $825 a month at 10k users; SDK 5.71.2."]]}]]},
]
with open(f"{HOME}/.fakeagent/replies.json", "w") as f:
    json.dump(REPLIES, f, indent=1)

# --- orb's store: seed the schema orb created above ---
db = sqlite3.connect(f"{HOME}/.orb/userdata/state.sqlite")
assert db.execute("PRAGMA user_version").fetchone()[0] >= 15, "orb didn't create its store"

PROJECTS = dict(db.execute("SELECT title, id FROM projects").fetchall())
for i, name in enumerate(["payments-api", "storefront", "shipit"]):
    PROJECTS[name] = db.execute("INSERT INTO projects (root, title, created_at) VALUES (?, ?, ?)",
                                (f"{HOME}/dev/{name}", name, NOW - 30 * DAY + i)).lastrowid

pane_ids = iter(range(1, 100))


def session(project, kind, cwd, name, branch, tabs, activity, visited, pinned=False, settled_ago=None):
    """tabs: [(tab name, layout builder, [pane agent keys or None for a shell])]"""
    sid = db.execute(
        """INSERT INTO sessions (project_id, kind, dir, name, branch, created_at, pinned_at, settled_override,
           settled_at, last_activity_at, last_visited_at, active_tab) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
        (PROJECTS[project], kind, cwd, name, branch, NOW - DAY, NOW - HOUR if pinned else None,
         "settled" if settled_ago else None, NOW - settled_ago if settled_ago else None,
         NOW - activity, NOW - visited)).lastrowid
    for position, (tab_name, layout, agents) in enumerate(tabs):
        ids = []
        for key in agents:
            pane = next(pane_ids)
            ids.append(pane)
            harness = AGENTS[key][0] if key else None
            resume = None if not key else (f"claude --resume {SIDS[key]}" if harness == "claude"
                                           else f"pi --session-id {SIDS[key]}")
            db.execute("INSERT INTO panes (id, session_id, cwd, resume) VALUES (?, ?, ?, ?)", (pane, sid, cwd, resume))
            if key:
                harness, title, tcwd, mode, ago, _, _ = AGENTS[key]
                state = json.load(open(f"{HOME}/.fakeagent/sessions/{SIDS[key]}.json"))
                db.execute(
                    """INSERT INTO threads (project_id, short_id, session_id, title, cwd, transcript_path, created_at,
                       turn_started_at, branch, last_activity_at, last_visited_at, ai_titled, harness, pane_id,
                       orb_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                    (PROJECTS[project], SIDS[key], SIDS[key], title, tcwd, state["transcript"], NOW - ago - HOUR,
                     NOW - ago if mode != "idle" else None, branch, NOW - ago, NOW - visited, harness, pane, sid))
        db.execute("INSERT INTO tabs (session_id, position, name, layout, focus_pane) VALUES (?, ?, ?, ?, ?)",
                   (sid, position, tab_name, json.dumps(layout(ids)), ids[0]))
    return sid


def one(ids):
    return {"pane": ids[0]}


def right(ids):
    return {"split": "right", "ratio": 0.5, "first": {"pane": ids[0]}, "second": {"pane": ids[1]}}


def right_then_down(ids):
    return {"split": "right", "ratio": 0.5, "first": {"pane": ids[0]},
            "second": {"split": "down", "ratio": 0.6, "first": {"pane": ids[1]}, "second": {"pane": ids[2]}}}


session("payments-api", "plain", RATE, None, "orb/rate-limiting-for-orders",
        [("agents", right_then_down, ["rate", "flaky", None]), ("server", one, [None])],
        activity=1 * MIN, visited=1 * MIN, pinned=True)
session("storefront", "plain", f"{HOME}/dev/storefront", None, "main",
        [(None, right, ["bundle", "dark"])], activity=12 * MIN, visited=30 * MIN)
session("shipit", "plain", f"{HOME}/dev/shipit", None, "main",
        [(None, one, ["json"])], activity=40 * MIN, visited=HOUR)
session("Research", "colony", RESEARCH, "pricing-teardown", None,
        [(None, one, ["pricing"])], activity=3 * HOUR, visited=3 * HOUR)
session("shipit", "plain", f"{HOME}/dev/shipit", "v0.4-release-notes", "main",
        [(None, one, ["notes"])], activity=4 * DAY, visited=4 * DAY, settled_ago=4 * DAY - HOUR)
session("payments-api", "plain", f"{HOME}/dev/payments-api", "axum-0.8", "main",
        [(None, one, ["axum"])], activity=6 * DAY, visited=6 * DAY, settled_ago=6 * DAY - HOUR)

db.execute("INSERT OR REPLACE INTO ui (id, sidebar_width) VALUES (1, 40)")
db.commit()
print("demo home ready at", HOME)
