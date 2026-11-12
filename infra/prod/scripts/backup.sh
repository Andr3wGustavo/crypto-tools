#!/usr/bin/env bash
# Off-site, encrypted backups (run hourly from /etc/cron.d/cortex as the cortex user).
#   - recordings + snapshots: incremental `rclone copy` of closed files (never `sync`: losing the
#     local disk must never delete the off-site copy). The recordings are the source of truth.
#   - Postgres: `pg_dump -Fc` once a day (it is derived data: rebuildable from the recordings).
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
log "recordings → ${REMOTE}market"
rclone copy "$ROOT/data/market" "${REMOTE}market" --min-age 2m --transfers 4 --checksum --log-level NOTICE

DAY="$(date -u +%F)"
DUMP="$LOCAL/pg-$DAY.dump"
if [[ ! -s "$DUMP" ]]; then
  log "pg_dump → $DUMP"
  docker exec cortex-postgres pg_dump -U cortex -d farm_shadow -Fc > "$DUMP.tmp"
  mv "$DUMP.tmp" "$DUMP"
  rclone copy "$DUMP" "${REMOTE}pg" --log-level NOTICE
  find "$LOCAL" -name 'pg-*.dump' -mtime +7 -delete
fi

log "ok"
[[ -n "${HEALTHCHECK_BACKUP_URL:-}" ]] && curl -fsS -m 10 "$HEALTHCHECK_BACKUP_URL" >/dev/null || true
