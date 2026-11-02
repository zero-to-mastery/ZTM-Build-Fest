#!/bin/bash
# Runs Kin and Caddy together; if either stops, the container stops so
# Railway restarts it.
#
# Before Kin starts it also protects the data:
#   1. Refuses to start unless $KIN_DATA_DIR is a mounted volume, so a missing
#      volume can't silently wipe every household on the next deploy.
#   2. Once per Railway deployment, snapshots the database exactly as the
#      previous deployment left it (snapshot.mjs runs no Kin code, so no
#      migration) into $KIN_DATA_DIR/backups, keeping the newest
#      $KIN_BACKUPS_KEEP (default 10). Restarts and crash loops within one
#      deployment don't add copies, so they can't push good backups out.
#   3. If KIN_RESTORE_FROM names a backup, restores it once (README: "Roll back
#      or move data").
# It also clears database locks left by a container that was killed before
# Kin could release them (Railway force-stops the old container on redeploy).
set -euo pipefail
: "${KIN_ORIGIN:?Set the KIN_ORIGIN variable to the public https:// address, for example https://kin.yourdomain.com}"
export PORT="${PORT:-8080}"
data="${KIN_DATA_DIR:?KIN_DATA_DIR must be set}"
backups="$data/backups"
database="$data/kin.sqlite"
log() { printf '{"event":"%s","message":"%s"}\n' "$1" "$2"; }

# As PID 1 this shell ignores SIGTERM unless it handles it. Bash runs the trap
# after the current step, so a stop never interrupts a backup or restore
# halfway (which would leave Kin's lock files behind).
trap 'log shutdown_started "Stopping before Kin started."; exit 143' TERM INT

keep="${KIN_BACKUPS_KEEP:-10}"
if ! [[ "$keep" =~ ^[1-9][0-9]{0,2}$ ]]; then
  log backups_keep_invalid "KIN_BACKUPS_KEEP must be a whole number from 1 to 999; keeping 10."
  keep=10
fi

if ! mountpoint -q "$data"; then
  if [ "${KIN_ALLOW_EPHEMERAL_DATA:-}" = "true" ]; then
    log data_ephemeral "$data is not a volume. Every redeploy erases all households (KIN_ALLOW_EPHEMERAL_DATA=true)."
  else
    log startup_failed "$data is not a mounted volume, so every redeploy would erase all households. Attach a Railway volume at $data, or set KIN_ALLOW_EPHEMERAL_DATA=true to accept that."
    exit 1
  fi
fi

# Railway mounts volumes owned by root; Kin runs as the node user.
mkdir -p "$data" "$backups"
chown node:node "$data" "$backups"
as_node() { setpriv --reuid=node --regid=node --init-groups -- "$@"; }

# Kin refuses to open a database whose lock file exists, and never guesses that
# a lock is stale. Here one is: Railway mounts a volume on one deployment at a
# time, and nothing in this container has started yet, so a lock can only be
# left by a previous container that was stopped before Kin released it.
for lock in "$database.service.lock" "$database.maintenance.lock"; do
  if [ -e "$lock" ]; then
    held_for="$(grep -o '"operation":"[a-z-]*"' "$lock" 2>/dev/null | cut -d'"' -f4 || true)"
    rm -f -- "$lock"
    log stale_lock_removed "Removed $(basename "$lock") (${held_for:-unknown} lock) left by a previous container."
  fi
done

deployment="${RAILWAY_DEPLOYMENT_ID:-}"
deployed_marker="$backups/.deployment-${deployment:-none}"
if [ ! -f "$database" ]; then
  log database_new "No database in $data yet; Kin starts with no households."
elif [ -n "$deployment" ] && [ -e "$deployed_marker" ]; then
  log backup_skipped "Already backed up for this deployment."
else
  backup="$backups/kin-$(date -u +%Y%m%dT%H%M%S%3NZ).sqlite"
  if as_node node /app/snapshot.mjs "$database" "$backup"; then
    log backup_created "$backup"
    rm -f -- "$backups"/.deployment-*
    [ -z "$deployment" ] || as_node touch "$deployed_marker"
  else
    log backup_failed "Couldn't back up $database before starting; starting anyway."
  fi
fi

if [ -n "${KIN_RESTORE_FROM:-}" ]; then
  marker="$backups/.restored-$(basename "$KIN_RESTORE_FROM")"
  if [ -e "$marker" ]; then
    log restore_skipped "$KIN_RESTORE_FROM was already restored. Remove KIN_RESTORE_FROM, or delete $marker to restore it again."
  else
    # A backup made from a root shell is root-owned; Kin restores as node.
    [ ! -f "$KIN_RESTORE_FROM" ] || chown node:node "$KIN_RESTORE_FROM"
    as_node node /app/server/admin.mjs restore "$KIN_RESTORE_FROM" --acknowledge-deletion-history
    as_node touch "$marker"
    log restore_finished "Restored $KIN_RESTORE_FROM. Remove KIN_RESTORE_FROM so it isn't applied again."
  fi
fi

# Keep the newest $keep startup backups, never the one named by KIN_RESTORE_FROM.
protect="$(realpath -m -- "${KIN_RESTORE_FROM:-/nonexistent}")"
for old in $(ls -1t "$backups"/kin-*.sqlite 2>/dev/null | tail -n "+$((keep + 1))" || true); do
  [ "$(realpath -m -- "$old")" = "$protect" ] || rm -f -- "$old"
done

# start.mjs runs the service inside Node's permission model (reads /app,
# reads and writes only the data directory) and forwards TERM to it.
as_node node /app/server/start.mjs &
kin=$!
as_node caddy run --config /app/Caddyfile --adapter caddyfile &
caddy=$!

stop() { kill -TERM "$kin" "$caddy" 2>/dev/null || true; }
trap stop TERM INT
status=0
wait -n "$kin" "$caddy" || status=$?
stop
wait || true
exit "$status"
