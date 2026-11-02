# Research conventions

Read by the orchestrator and every subagent. Subagents: read this first, every time.

## Folder layout

```
~/.orb/research/<slug>/     one per problem; cwd for every agent
  AGENTS.md                 orchestrator rules (frozen copy)
  CLAUDE.md -> AGENTS.md    symlink
  SOURCES.md                this investigation's sources registry
  .env                      tokens, sourced by scripts only, gitignored
  .claude/settings.json     denies Read(./.env)
  .claude/agents/           investigator, falsifier, simulator (frozen copy)
  .pi/agents/               investigator, falsifier, simulator for pi (frozen copy)
  .research/                CONVENTIONS.md, REPORT_TEMPLATE.md (frozen copy)
  STATE.md                  orchestrator only (the falsifier never reads it)
  PROBLEM.md                question, decision, premise ledger, target metric
  HYPOTHESES.md
  EVIDENCE.md               index, one line per evidence entry
  evidence/<prefix>.md      one file per agent task
  rounds/R<n>.md            falsifier reports, plus rounds/R<n>-checks/
  scripts/                  every query, replay and repro, re-runnable
  data/raw/  data/provided/  data/sim/      gitignored; may contain IPs and user agents
  REPORT.md
```

No agent ever edits `AGENTS.md`/`CLAUDE.md`, `.claude/` or `.pi/` during an investigation.

**Who writes what:**

- **Orchestrator:** `STATE.md`, `PROBLEM.md`, `HYPOTHESES.md`, the `EVIDENCE.md` index, `REPORT.md`, `SOURCES.md`, and creates `.env` placeholders.
- **Investigator and simulator:** their own `evidence/<prefix>.md`, `scripts/<prefix>*` and `data/{raw,sim}/<prefix>/`.
- **Falsifier:** `rounds/R<n>.md`, `rounds/R<n>-checks/`, `evidence/R<n>f.md`.

Never edit another agent's files. Source discoveries go in your return, and the orchestrator records them.

## Evidence

Entry format, in `evidence/<prefix>.md`:

```
### E-<prefix>-<n>: <short title>
- Fact: <1–2 sentences, numbers with units and window>
- Type: measured | derived | estimated | ceiling | code-traced | vendor-defined | user-reported
- Source: <SOURCES.md entry>
- How: <script path or exact command/query; for code, file:line @ commit>
- Inputs: <evidence IDs, for derived/estimated/ceiling>
- Window: <YYYY-MM-DD..YYYY-MM-DD local> (UTC <…>)
- Caveats: <sampling, filters, known gotchas>
- Bears on: <P#, H#>
```

**Types**

- **measured:** read directly from a system with a query you can re-run.
- **derived:** arithmetic on measured values. List the inputs.
- **estimated:** output of a model, simulation or statistical correction. List the assumptions in the entry.
- **ceiling:** an upper bound ("up to"). Never rank it against an estimate without saying so.
- **code-traced:** reasoned from reading code, not observed at runtime.
- **vendor-defined:** rests on a vendor's metric semantics, such as what a CDN's `stale` cache status means. Verify the semantics against docs or an experiment, or it stays a premise.
- **user-reported:** the user said it or provided it. Record the provenance.

`EVIDENCE.md` index line, maintained by the orchestrator:

```
E-cdn-3 | measured | origin renders 1.62M/day (Aug 25–Sep 23, local) | evidence/cdn.md
```

## Premises

Everything assumed and not yet verified is a premise. That includes assumptions agents introduce mid-investigation.

The ledger lives in `PROBLEM.md`:

```
| ID | Premise | Type | Status | Check | Evidence |
```

- **Types:** metric, vendor-defined, baseline, importance, causal, solution, scope.
- **Status:** unverified, verified, contradicted, partial, or untestable (with the reason).

If your conclusion depends on an assumption that isn't in the ledger, list it under "New premises" in your return. The most dangerous ones hide in vendor metric definitions and in "obviously" steps.

## Hypotheses (`HYPOTHESES.md`)

```
### H<n>: <claim in one sentence>
- Kind: cause | lever
- Mechanism:
- Predictions: if true we'd see … (each checkable; name the source)
- Kill criteria:
- Share of effect: how much of the problem it could explain (ceiling E-…, estimate E-…)
- Lever only: ceiling, estimate, effort, risk
- Status: open | survived R<n> (attacks tried) | killed R<n> (by E-…) | killed by ceiling | needs experiment <id>
```

H0 (measurement artifact) is always on the list.

## Numbers

- **One primary window** per investigation, stated in `PROBLEM.md`.
  - Use other windows only when needed, and label every number with its window.
  - Never compare across windows without normalizing and saying so.
- **Timezone.** Prose uses the local timezone stated in `PROBLEM.md`; scripts and evidence give local and UTC.
- **Per-day values** say how they were derived: total ÷ days, or median of daily values.
- **Ranges beat single points.** Give worst / average / best day, or low / likely / high with how each was made.
- **Decomposition tables** have a total row and an "unexplained / other" row.
- **Labels.** Ceilings say "up to". Estimates say how they were estimated. Code-traced numbers say "from code, not measured".
- Every number traces to an evidence ID.

## Sources: discovery order

For any data need, go down this list and stop at the first step that works:

1. **`SOURCES.md`.** Is the source known? Check its gotchas and its last-confirmed date.
2. **Credentials** (see Credentials below).
   1. This folder's `.env` variable names, not values.
   2. Env var names; never print their values.
   3. CLI identity: the cloud or CDN CLI's who-am-I command.
   4. Configured MCP servers.
3. **Infer from code and config.** Cite file:line. Look at:
   - instrumentation libraries (APM tracer, error tracker, analytics SDK);
   - infrastructure (infrastructure-as-code, container task definitions, CDN/edge config and worker code);
   - logger and exporter config.
4. **Return the need** with your best guess of where it lives and the evidence behind that guess.

**User-provided files** go in `data/provided/<name>` with a sidecar, `<name>.meta.md`, recording:

- what the file is
- source or dashboard URL
- filters
- window and timezone
- when it was exported

A screenshot without visible filters and window counts as `user-reported`, not `measured`.

### Credentials (`.env`)

- Tokens live in this folder's `.env` as `NAME=value`. Scripts load it with `set -a; . ./.env; set +a`.
- **Never open `.env`**: no Read, no `cat`, no `grep` that shows values, and never print a variable's value. To check a variable is set without printing it: `sh -c '. ./.env; [ -n "$NAME" ] && echo set || echo empty'`.
- Never write a token into `scripts/`, evidence or any other file.
- Ask for read-only scopes.

## Safety

**Allowed without asking:**

- read any registered repo
- run local scripts
- read-only queries to production APIs (e.g. a CDN's or APM's analytics API)
- web search and fetch

**Needs the user's explicit OK, relayed by the orchestrator:** anything that writes to a shared system. That includes:

- CDN/edge rules, WAF changes or cache purges
- deploys
- staging load tests
- cache or DB writes
- ticket or wiki writes
- `git push` anywhere

**Never:**

- open `.env`, or print or write a token or other secret (see Credentials);
- modify files in product repos. For instrumented repros, use `git worktree add data/sim/<name>/wt <ref>` or a copy;
- keep raw data containing IPs or user agents outside `data/`.

Be kind to rate limits: save raw query outputs and reuse them.

## `STATE.md` format

```
# STATE: <slug>
- Session: open since <ts local> | closed <ts local>
- Phase: <n> <name>    Round: <k>/3
- Decision this serves: <from PROBLEM.md>
- Leading answer: <one line>. Could still flip if: <…>
- Next action: <concrete enough for a fresh session>
- Waiting on user: <open question numbers, or "none">; last asked: #<n>
- Decision-invariance (last round): <result>

## Log
- <ts local> <phase transition or loop, one line>
```

## Return format for "Needs from user" (all agents)

```
- NEED: <exact data: metric, window (local), filters>
  Why: <premise/hypothesis it decides>
  Likely location: <guess>, because <file:line or other evidence>
  Options: CSV export | screenshot with filters + window visible | MCP/token for <source>
  Blocking: yes | no
```
