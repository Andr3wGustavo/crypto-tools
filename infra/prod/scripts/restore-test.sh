#!/usr/bin/env bash
# Backup RESTORE TEST — a backup is only real once it has been restored.
#   infra/prod/scripts/restore-test.sh            (as the cortex user, on the VPS or any Docker host)
# 1. Pulls the encrypted off-site copy of every run directory into a scratch dir.
# 2. verify-run on each: genesis replay and newest valid snapshot + tail must reach the same
#    state digest (proves recordings and snapshots restored intact and consistent).
# 3. Restores the newest Postgres dump into a throwaway TimescaleDB and counts rows.
# Exit 0 only if everything passes. Nothing on the live system is touched.
set -Eeuo pipefail

ROOT="${CORTEX_ROOT:-/srv/cortex}"
REMOTE="${CORTEX_BACKUP_REMOTE:-cortex-crypt:}"
TAG="$(cat "$ROOT/deploy/current")"
IMAGE="ghcr.io/andr3wgustavo/cortex-worker:$TAG"
SCRATCH="$(mktemp -d /tmp/cortex-restore-XXXXXX)"
PG="cortex-restore-test-$$"
cleanup() { docker rm -f "$PG" >/dev/null 2>&1 || true; rm -rf "$SCRATCH"; }
trap cleanup EXIT
log() { echo "[restore-test $(date -u +%FT%TZ)] $*"; }

log "pulling ${REMOTE}market → $SCRATCH/market"
rclone copy "${REMOTE}market" "$SCRATCH/market" --transfers 8 --log-level NOTICE
chmod -R a+rX "$SCRATCH"

failures=0
runs=0
while IFS= read -r meta; do
  run="$(dirname "$meta")"
  rel="${run#"$SCRATCH"/}"
  runs=$((runs + 1))
  if docker run --rm --network none -v "$SCRATCH:/restore:ro" "$IMAGE" node dist/verify-run.js "/restore/$rel" > "$SCRATCH/verify.json"; then
    log "OK   $rel  $(grep -o '"records": [0-9]*' "$SCRATCH/verify.json")  $(grep -o '"genesisDigest": "[0-9a-f]\{16\}' "$SCRATCH/verify.json")"
  else
    failures=$((failures + 1))
    log "FAIL $rel"; cat "$SCRATCH/verify.json"
  fi
done < <(find "$SCRATCH/market" -name meta.json | sort)
[[ $runs -gt 0 ]] || { log "no run directories in the backup"; exit 1; }

dump="$(rclone lsf "${REMOTE}pg" --files-only | sort | tail -n 1)"
[[ -n "$dump" ]] || { log "no Postgres dump in the backup"; exit 1; }
rclone copy "${REMOTE}pg/$dump" "$SCRATCH/pg" --log-level NOTICE
docker run -d --name "$PG" --network none -e POSTGRES_USER=cortex -e POSTGRES_PASSWORD=restore -e POSTGRES_DB=farm_shadow \
  -v "$SCRATCH/pg:/dump:ro" timescale/timescaledb:2.17.2-pg16 >/dev/null
for _ in $(seq 60); do docker exec "$PG" pg_isready -U cortex -d farm_shadow >/dev/null 2>&1 && break; sleep 1; done
docker exec "$PG" psql -q -U cortex -d farm_shadow -c 'SELECT timescaledb_pre_restore();' >/dev/null
if docker exec "$PG" pg_restore -U cortex -d farm_shadow --no-owner "/dump/$dump"; then
  docker exec "$PG" psql -q -U cortex -d farm_shadow -c 'SELECT timescaledb_post_restore();' >/dev/null
  log "Postgres dump $dump restored; row counts:"
  docker exec "$PG" psql -U cortex -d farm_shadow -At -c \
    "SELECT relname || ': ' || n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname;"
else
  failures=$((failures + 1)); log "FAIL pg_restore $dump"
fi

if [[ $failures -eq 0 ]]; then log "RESTORE TEST PASSED ($runs runs + $dump)"; else log "RESTORE TEST FAILED ($failures)"; exit 1; fi
