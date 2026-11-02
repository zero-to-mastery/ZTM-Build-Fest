# `vde` behavior baseline (Phase 0)

Recorded against `develop` @ `ff77e79`, in a sandbox with zsh 5.9, jq, OpenSSH and a **fake `docker`**
(load average, disk usage and docker are faked so runs are deterministic). **381 cases**; a fresh full
run matches all 381. Nothing here is a judgement that the behavior is *right*; it is what `vde` does
today, which a parser-backed rewrite must either preserve or change on purpose.

## How it was verified (Executed)
- Two full runs were compared and the recording was corrected until they were identical (the only
  randomness found was the SSH key fingerprint/randomart printed by `ssh-keygen` during create/rebuild).
- A full `check` against the golden files then matched 381/381.
- Sensitivity: 7 deliberate breakages (wrong delegate argument, `up -d` -> `up`, `docker stop` ->
  `docker kill`, changed usage exit code, renamed `--force` flag, extra exec argument, modified
  `vde-rebuild`) were each detected.

## What is pinned
Per case: exit code, normalized stdout/stderr, every `docker` argv, files added/removed/modified in the
repo copy and in `$HOME`, and the fake host's final container/image state.
- **40 "real" cases** run the actual scripts against the fake docker: start, stop, restart, remove/rm/delete,
  create, rebuild, port, help forms, no-args and unknown command.
- **341 "stub" cases** replace every delegate script with a recorder, so they pin the router contract:
  which script is called, with which arguments, after alias/cluster/default/all expansion.

## Router contract: what each delegate receives
Targets are either passed raw (as typed) or resolved (aliases, clusters, `default`, `all` expanded).
Where a cell says `web` or `all`, the delegate got the raw word; where it lists names, expansion happened.
(`-f` and `-q` are swallowed by `bin/vde` itself; `-f` is re-added as `--force` only for the three `ssh-*` commands.)

| Command | Delegate script | `python` | `web` (cluster) | `default` | `all` | `-f python` | `--opt python` |
|---|---|---|---|---|---|---|---|
| init | vde-init | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| foundling | vde-path-of-the-foundling | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| path-of-the-foundling | vde-path-of-the-foundling | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| nuke | nuke-vde | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| ssh-setup | ssh-setup | `python` | `web` | `default` | `all` | `python --force` | `--opt python` |
| ssh-sync | ssh-sync | `python` | `web` | `default` | `all` | `python --force` | `--opt python` |
| ssh-agent-setup | ssh-agent-setup | `python` | `web` | `default` | `all` | `python --force` | `--opt python` |
| list | list-vms | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| add | add-vm-type | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| uninstall | uninstall-vm-type | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| validate | validate-schemas.zsh | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| prune | vde-prune.zsh | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| rebuild-cache | vde-rebuild-cache | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| sync-version | vde-sync-version | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| sync-context | vde-sync-context | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| audit | vde-gospel-audit.zsh | `-` | `-` | `-` | `-` | `-` | `-` |
| check-tetrad | vde-check-tetrad.zsh | `-` | `-` | `-` | `-` | `-` | `-` |
| spine-check | vde-check-tetrad.zsh | `-` | `-` | `-` | `-` | `-` | `-` |
| heal | vde-heal-docs.zsh | `-` | `-` | `-` | `-` | `-` | `-` |
| info | vde-info | `python` | `python postgres` | `jupyterlab postgres` | `32 names` | `python` | `--opt python` |
| ps | vde-ps | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| status | vde-ps | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| inspect | vde-inspect | `python` | `python postgres` | `jupyterlab postgres` | `32 names` | `python` | `--opt python` |
| logs | vde-logs | `python` | `python postgres` | `jupyterlab postgres` | `32 names` | `python` | `--opt python` |
| images | vde-images | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| networks | vde-networks | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| stats | vde-stats | `python` | `python postgres` | `jupyterlab postgres` | `32 names` | `python` | `--opt python` |
| health | vde-health | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| cluster | vde-cluster | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| vision | vde-vision | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| matrix-audit | vde-matrix-audit.zsh | `python` | `web` | `default` | `all` | `python` | `--opt python` |
| matrix-rebuild | vde-matrix-rebuild.zsh | `python` | `web` | `default` | `all` | `python` | `--opt python` |

Commands that resolve targets before delegating (from the goldens): `info`, `inspect`, `logs`, `stats`
(see the cases `route.info.*` etc.). `audit`, `check-tetrad`, `spine-check` and `heal` receive no
arguments at all in every case. `exec`/`enter`/`ssh` pass the first resolved target, then the remaining
words (`vde exec python ls -la /tmp` -> `python ls -la /tmp`); a cluster name yields only its first member.
Re-check any cell with `python3 characterize.py list` and the matching `golden/route.<cmd>.<variant>.json`.

## Behaviors a rewrite must preserve or consciously change
All verified in the golden files:
1. **`vde dns-check` always fails** with `shift: shift count must be <= $#` (exit 1), with or without
   arguments (`route.dns-check.*`).
2. **`audit`, `check-tetrad`, `spine-check`, `heal` never receive arguments.** The flag loop consumes every
   argument before they are dispatched (`route.audit.*`, `route.heal.*`, ...).
3. **`vde` with no arguments** exits 1 with the same `shift` error instead of printing usage
   (`router.noargs`).
4. **An unknown command** prints "Unknown command. Run 'vde help' for usage." and exits **0**
   (`router.unknown`).
5. **`start nosuchvm`** prints an error ("Unknown VM type or alias") to stdout and exits **0**
   (`start.unknown`), while **`stop`/`restart`/`remove` of an unknown VM exit 1** (`stop.unknown`,
   `restart.unknown`, `remove.unknown`).
6. **Stopping a VM that is not running exits 1**, as does removing one with no container
   (`stop.python.images`, `remove.python.images`). This looks accidental (a trailing
   `[[ -n ... ]] && ...` under `set -e`), but tests may depend on it.
7. **`restart` re-invokes `./bin/vde start`**, so the compose call gets a relative `--env-file ./env-files/...`
   path, unlike a direct `start`, which records an absolute path (`restart.python.running` vs
   `start.python.images`).
8. **`-q` did not reduce the startup log lines** in `start.quiet` (5 stderr lines either way), because
   logging initializes before the flag loop sets `VDE_QUIET`.
9. **`port` with an unknown VM or no argument** prints nothing and exits 0 (`port.unknown`, `port.noargs`).
10. **`rebuild python --no-cache`**: the router has no notion of this flag; it reaches `vde-rebuild` as an
    ordinary argument and ends up as `docker compose ... build --no-cache` (`rebuild.python.nocache`).

## Limits (not characterized)
- Delegate scripts in "stub" mode are not exercised; their own behavior is unchanged by a router rewrite but
  is not pinned here (except `vde-rebuild`, which runs for real in the create/rebuild/start cases).
- Real Docker behavior, interactive flows (`enter`, `exec` with a TTY), `function-trace` output (it prints
  internal function names, so it is expected to change in a refactor), and multi-process lock contention.
- The baseline depends on `ssh-keygen` being installed (create/rebuild generate a key) and on `jq`.

## Running it
```
python3 characterize.py check  --repo /path/to/vde-system            # compare to golden
python3 characterize.py check  --repo ... --only route.info          # subset
python3 characterize.py stable --repo ...                            # prove determinism
python3 characterize.py record --repo ...                            # (re)record golden
```
