#!/usr/bin/env bash
# One-time VPS bootstrap — Ubuntu 24.04 (arm64 Oracle Ampere A1 or amd64). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/Andr3wGustavo/crypto-tools/rebuild/cortex-farm/infra/prod/scripts/bootstrap.sh -o bootstrap.sh
#   less bootstrap.sh            # read it first
#   sudo TS_AUTHKEY=tskey-auth-… bash bootstrap.sh
# Idempotent: safe to re-run. It does NOT close public SSH: do that in the Oracle security list
# only after `tailscale ssh cortex@<host>` works (see docs/runbooks/vps.md).
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

BRANCH="${CORTEX_BRANCH:-rebuild/cortex-farm}"
REPO_URL="${CORTEX_REPO_URL:-https://github.com/Andr3wGustavo/crypto-tools.git}"
HOSTNAME_TS="${TS_HOSTNAME:-cortex-tokyo}"
ROOT=/srv/cortex
log() { echo -e "\n== $*"; }
export DEBIAN_FRONTEND=noninteractive

log "packages + unattended security upgrades"
apt-get update -q
apt-get -yq -o Dpkg::Options::=--force-confold upgrade
apt-get install -yq ca-certificates curl gnupg git jq chrony fail2ban unattended-upgrades rclone
dpkg-reconfigure -f noninteractive unattended-upgrades

log "swap (2 GiB) — a memory spike must slow us down, not OOM-kill a worker mid-drain"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -q -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/90-cortex.conf

log "time sync (chrony; Oracle's link-local NTP first) — the strategy's clock-skew rule depends on it"
mkdir -p /etc/chrony/sources.d
echo 'server 169.254.169.254 iburst prefer' > /etc/chrony/sources.d/oracle.sources
systemctl enable --now chrony && systemctl restart chrony

log "Docker Engine + compose plugin (official repo), log rotation, live-restore"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" }, "live-restore": true }
JSON
systemctl enable --now docker && systemctl restart docker

log "operator user 'cortex' (docker group, same SSH keys as the cloud default user)"
id cortex >/dev/null 2>&1 || useradd -m -s /bin/bash -G docker cortex
usermod -aG docker cortex
install -d -m 700 -o cortex -g cortex /home/cortex/.ssh
for u in ubuntu opc; do
  [[ -f /home/$u/.ssh/authorized_keys ]] && cat /home/$u/.ssh/authorized_keys >> /home/cortex/.ssh/authorized_keys
done
if [[ -f /home/cortex/.ssh/authorized_keys ]]; then
  sort -u -o /home/cortex/.ssh/authorized_keys /home/cortex/.ssh/authorized_keys
  chown cortex:cortex /home/cortex/.ssh/authorized_keys && chmod 600 /home/cortex/.ssh/authorized_keys
fi

log "SSH hardening (keys only, no root) — validated before reload"
cat > /etc/ssh/sshd_config.d/10-cortex.conf <<'SSH'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
X11Forwarding no
MaxAuthTries 3
SSH
sshd -t && systemctl reload ssh
systemctl enable --now fail2ban

log "Tailscale (private network + SSH; the dashboard/API will only listen there)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
if [[ -n "${TS_AUTHKEY:-}" ]]; then
  tailscale up --ssh --authkey "$TS_AUTHKEY" --hostname "$HOSTNAME_TS"
else
  echo "TS_AUTHKEY not set: run 'sudo tailscale up --ssh --hostname $HOSTNAME_TS' and log in"
fi

log "layout $ROOT"
install -d -o cortex -g cortex "$ROOT" "$ROOT/backups" "$ROOT/deploy"
# Containers run as uid 1000 (user 'node' in the image): the data volume must be theirs.
install -d -o 1000 -g 1000 "$ROOT/data" "$ROOT/data/market" "$ROOT/data/health"
if [[ ! -d "$ROOT/repo/.git" ]]; then
  sudo -u cortex git clone --quiet --branch "$BRANCH" "$REPO_URL" "$ROOT/repo"
fi
if [[ ! -f "$ROOT/cortex.env" ]]; then
  umask 077
  cat > "$ROOT/cortex.env" <<ENV
# Cortex Farm production env — chmod 600, never committed.
POSTGRES_PASSWORD=$(openssl rand -hex 24)
LOG_LEVEL=info
# healthchecks.io ping URLs (dead-man for the workers, and for the hourly backup)
HEALTHCHECK_URL=
HEALTHCHECK_BACKUP_URL=
# rclone crypt remote for off-site backups (configure with: sudo -u cortex rclone config)
CORTEX_BACKUP_REMOTE=cortex-crypt:
ENV
  chown cortex:cortex "$ROOT/cortex.env"
fi
chmod 600 "$ROOT/cortex.env"

log "hourly backup cron"
cat > /etc/cron.d/cortex <<CRON
SHELL=/bin/bash
17 * * * * cortex $ROOT/repo/infra/prod/scripts/backup.sh >> $ROOT/backups/backup.log 2>&1
CRON
chmod 644 /etc/cron.d/cortex

log "done. Next (docs/runbooks/vps.md):"
cat <<NEXT
  1. tailscale ssh cortex@$HOSTNAME_TS     (works?) → remove the public port-22 rule in the Oracle security list
  2. edit $ROOT/cortex.env (HEALTHCHECK_URL, HEALTHCHECK_BACKUP_URL)
  3. sudo -u cortex rclone config           (remote + crypt remote 'cortex-crypt')
  4. $ROOT/repo/infra/prod/scripts/latency.sh
  5. $ROOT/repo/infra/prod/scripts/deploy.sh <tag>   (as cortex)
NEXT
