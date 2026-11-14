#!/usr/bin/env bash
# Off-site, encrypted backups (run hourly from /etc/cron.d/cortex as the cortex user).
#   - recordings + snapshots (shadow `market/`, live `live/`) and the withdrawer's journal
#     (`withdraw/`): incremental `rclone copy` of closed files (never `sync`: losing the local disk
#     must never delete the off-site copy). The recordings are the source of truth.
#   - Postgres: `pg_dump -Fc` of farm_shadow and farm_live once a day (derived data: rebuildable
#     from the recordings with persist-backfill, but much faster to restore).
# The remote must be an rclone *crypt* remote named in CORTEX_BACKUP_REMOTE (default cortex-crypt:),
# so the provider only ever sees ciphertext. Optional: HEALTHCHECK_BACKUP_URL is pinged on success.
set -Eeuo pipefail

ROOT="${CORTEX_ROOT:-/srv/cortex}"
# shellcheck disable=SC1091
set -a; source "$ROOT/cortex.env"; set +a
REMOTE="${CORTEX_BACKUP_REMOTE:-cortex-crypt:}"
LOCAL="$ROOT/backups"
mkdir -p "$LOCAL"
log() { echo "[backup $(date -u +%FT%TZ)] $*"; }
fail() { log "FAILED: $*"; [[ -n "${HEALTHCHECK_BACKUP_URL:-}" ]] && curl -fsS -m 10 --data-raw "$*" "$HEALTHCHECK_BACKUP_URL/fail" >/dev/null || true; exit 1; }
trap 'fail "line $LINENO"' ERR

# Closed files only: the active segment is still being appended (it is picked up next hour).
for dir in market live withdraw; do
  [[ -d "$ROOT/data/$dir" ]] || continue
  log "$dir → ${REMOTE}$dir"
  rclone copy "$ROOT/data/$dir" "${REMOTE}$dir" --min-age 2m --transfers 4 --checksum --log-level NOTICE
done

DAY="$(date -u +%F)"
for db in farm_shadow farm_live; do
  DUMP="$LOCAL/pg-$db-$DAY.dump"
  [[ -s "$DUMP" ]] && continue
  docker exec cortex-postgres psql -U cortex -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -qx 1 || continue
  log "pg_dump $db → $DUMP"
  docker exec cortex-postgres pg_dump -U cortex -d "$db" -Fc > "$DUMP.tmp"
  mv "$DUMP.tmp" "$DUMP"
  rclone copy "$DUMP" "${REMOTE}pg" --log-level NOTICE
done
find "$LOCAL" -name 'pg-*.dump' -mtime +7 -delete

log "ok"
[[ -n "${HEALTHCHECK_BACKUP_URL:-}" ]] && curl -fsS -m 10 "$HEALTHCHECK_BACKUP_URL" >/dev/null || true
