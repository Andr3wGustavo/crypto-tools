#!/usr/bin/env bash
# Deploy a CI-built tag to this VPS, with automatic rollback.
#   /srv/cortex/repo/infra/prod/scripts/deploy.sh <12-hex tag>
#
# 1. check out the commit (compose files must match the images)   4. roll every container
# 2. pull the images                                               5. wait for every healthcheck
# 3. run the (additive) schema migration                              (fresh heartbeat from THIS version)
# If step 4/5 fails, the previous tag is redeployed the same way and the script exits 1.
# Workers drain on SIGTERM (final snapshot) and resume exactly on boot, so a roll loses nothing.
set -Eeuo pipefail

TAG="${1:-}"
[[ "$TAG" =~ ^[0-9a-f]{12}$ ]] || { echo "usage: deploy.sh <12-hex image tag>" >&2; exit 2; }

ROOT="${CORTEX_ROOT:-/srv/cortex}"
REPO="$ROOT/repo"
ENV_FILE="$ROOT/cortex.env"
STATE="$ROOT/deploy"
mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

log() { echo "[deploy $(date -u +%FT%TZ)] $*"; }
compose() {
  local tag="$1"; shift
  IMAGE_TAG="$tag" CORTEX_DATA="$ROOT/data" docker compose --env-file "$ENV_FILE" \
    -f "$REPO/infra/prod/compose.prod.yaml" -f "$REPO/infra/prod/compose.pairs.yaml" "$@"
}
checkout() {
  git -C "$REPO" fetch --quiet --prune origin '+refs/heads/*:refs/remotes/origin/*'
  local sha
  sha="$(git -C "$REPO" rev-parse --verify --quiet "$1^{commit}")" || { log "commit $1 not found in origin"; return 1; }
  git -C "$REPO" checkout --quiet --detach "$sha"
}
roll() {
  local tag="$1"
  checkout "$tag" &&
    compose "$tag" --profile migrate pull --quiet &&
    compose "$tag" --profile migrate run --rm migrate &&
    compose "$tag" up -d --remove-orphans --wait --wait-timeout 300
}

PREV="$(cat "$STATE/current" 2>/dev/null || true)"
log "deploying $TAG (previous: ${PREV:-none})"
if roll "$TAG"; then
  echo "$TAG" > "$STATE/current"
  echo "$(date -u +%FT%TZ) $TAG ok (from ${PREV:-none})" >> "$STATE/history"
  compose "$TAG" ps --format 'table {{.Name}}\t{{.Status}}'
  log "deployed $TAG — all workers healthy"
  exit 0
fi

log "deploy of $TAG FAILED"
compose "$TAG" ps --format 'table {{.Name}}\t{{.Status}}' || true
echo "$(date -u +%FT%TZ) $TAG FAILED (from ${PREV:-none})" >> "$STATE/history"
if [[ -n "$PREV" && "$PREV" != "$TAG" ]]; then
  log "rolling back to $PREV"
  if roll "$PREV"; then
    log "rollback to $PREV ok"
    echo "$(date -u +%FT%TZ) $PREV rollback ok" >> "$STATE/history"
  else
    log "ROLLBACK FAILED — manual intervention needed (dead-man will alert)"
  fi
fi
exit 1
