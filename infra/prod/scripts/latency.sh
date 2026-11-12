#!/usr/bin/env bash
# Network latency from this host to the venues (run on a candidate VPS region before committing).
#   infra/prod/scripts/latency.sh [samples=20]
# Prints min / median of TCP connect, TLS handshake and time-to-first-byte per endpoint (ms).
set -Eeuo pipefail
N="${1:-20}"
endpoints=(
  "https://api.mexc.com/api/v3/time"
  "https://wbs-api.mexc.com/ws"
  "https://api.binance.com/api/v3/time"
  "https://stream.binance.com:9443/stream"
)
# min and median of one column (POSIX awk + sort: no gawk-only functions)
stat() { cut -d' ' -f"$1" | sort -n | awk '{ v[NR] = $1 } END { printf "%8.1f %8.1f", v[1], v[int((NR + 1) / 2)] }'; }

printf '%-40s %17s %17s %17s\n' endpoint 'connect min/p50' 'tls min/p50' 'ttfb min/p50'
for url in "${endpoints[@]}"; do
  samples="$(for _ in $(seq "$N"); do
    curl -s -o /dev/null -m 10 -w '%{time_connect} %{time_appconnect} %{time_starttransfer}\n' "$url" || true
  done | awk 'NF == 3 { printf "%.3f %.3f %.3f\n", $1 * 1000, ($2 - $1) * 1000, $3 * 1000 }')"
  [[ -n "$samples" ]] || { printf '%-40s unreachable\n' "${url:0:40}"; continue; }
  printf '%-40s %s %s %s\n' "${url:0:40}" "$(stat 1 <<<"$samples")" "$(stat 2 <<<"$samples")" "$(stat 3 <<<"$samples")"
done
if command -v chronyc >/dev/null; then
  echo "clock: $(chronyc tracking | grep -E 'System time|Leap status' | tr -s ' ' | paste -sd ';')"
else
  echo 'clock: chrony not installed'
fi
