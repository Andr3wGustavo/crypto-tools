# Cortex Farm — Progress & Evidence

Status: **40 / 100** (E2 proven; E1 waits only on the local `docker compose` check) · Plan: [MASTER-PLAN.md](MASTER-PLAN.md) · Branch: `rebuild/cortex-farm`

Legend: ✅ done (with evidence) · 🔄 in progress · ⬜ not started · ⏸ blocked on user

## E0 — Repository rescue → 22
- ✅ Rules saved to memory (build gate, repo location, master plan, user profile) — `~/.claude/projects/*/memory/`
- ✅ Backup of the Dropbox folder (477 entries incl. `.git`, `.env`, conflicted copies) — `C:\dev\backups\crypto-dropbox-backup-2026-11-08.tar.gz`
- ✅ Clean clone of GitHub `2d9c5a5` into `C:\dev\crypto-tools`; `.env` copied; `CONTEXT.md` archived to `docs/archive/`
- ✅ `npm ci` + `prisma generate` + `tsc --noEmit` → exit 0 (was 59 errors in the Dropbox working tree)
- ⏸ Rename the old Dropbox folder to `_OLD_corrupted` — user, after closing every editor/terminal opened there

## E1 — Foundation & local infra → 30
- ✅ Monorepo (npm workspaces): `packages/{core,exchange,db,shared}`, `apps/{worker,sentinel}` — commit `e077537`
- ✅ `infra/compose.yaml`: Postgres 16 + TimescaleDB 2.17, Redis 7.4 (AOF, noeviction), loopback-only ports, healthchecks — `6f1e625`
- ✅ Prisma schema (events, double-entry ledger, order FSM, fills, equity hypertable, treasury, risk, config versions, audit) + migration `0001_init` — CI job `migrate` applies it on a real TimescaleDB (run 43003379972 ✅)
- ✅ Strict config (Zod, `TRADING_MODE` defaults to shadow, `live` refused until E8, strict booleans); pino logger
- ✅ Vitest + fast-check; GitHub Actions CI: typecheck, tests + coverage, prisma validate, migrate — run 43003379972 ✅
- ✅ Production build: esbuild bundle (`npm run build:worker`) + multi-arch image `infra/docker/worker.Dockerfile` (amd64/arm64, non-root, tini) + CI `image` job — `f82133d`. Bundled replay = tsx replay hash (`e8ce589e…`)
- ✅ `~/.wslconfig` caps the WSL2/Docker VM at 2.5 GB (root cause of the 2026-11-09 OOM + failed image pull on the 8 GB PC)
- 🔄 `docker compose up` healthy on the dev PC + `migrate deploy`

## E2 — Market data, execution, shadow → 42
- ✅ MEXC: signed REST v3 (clock sync, exchangeInfo, fees), protobuf WS (vendored official protos), 23 h rotation, keepalive, stale watchdog
- ✅ Binance bookTicker reference stream (lead price only)
- ✅ Deterministic core: fair price + lead-lag toxicity, A-S in bps, quote builder (post-only, penny, sanity fail-closed), inventory decay, order FSM with deterministic clientOrderId
- ✅ SimExecutor (latency on place and cancel, post-only rejects, conservative queue) — queue-ahead now capped by displayed size (`fix(sim)`), 2 new tests
- ✅ Gzip NDJSON recorder + replay CLI; crash-safe segments + 1 s sync flush + truncation-tolerant reader (`551f2a0`, 5 crash tests)
- ✅ Live smoke on real MEXC+Binance data (2026-11-11, 3 min): 10 299 records, loop lag p99 ≈ 45 ms, data age < 1 s; **live hash = replay hash** `e8ce589e7995c31e…`
- ✅ **Formal E2 proof — 1 h live shadow, replay bit-exact** (2026-11-11 10:24–11:24 UTC, MEXC SOLUSDT + Binance ref): 144 178 records, 281 places, 279 cancels, 1 fill, PnL +0.0020203610120628 USDT; live hash = replay hash `5b37d8c5c7a52ef1d585b30d920f7dafe8930e34820ce1b6d29e9d33099c848b` (replayed with the pre-fix bundle, identical to the code that ran live). The process survived the harness killing its parent shell and finished on its own.
- ✅ Same hour replayed with the queue-cap fix: 4 fills instead of 1 → the old queue model under-counted fills ~4× (pessimistic and toxic-biased). 85/85 tests green.

## E3 — Accounting, treasury, risk → 52
- ✅ (core) double-entry ledger, average-cost PnL, treasury + capital ladder, risk manager (kill/halt/pause/reduce-only) with tests — `e077537`
- ⬜ Boot restore (snapshot + tail replay; also restores the clientOrderId `seq`, required before live), drain on shutdown, kill/restart with equity matching
- ⬜ Continuous reconciliation (live), persisted state

## Findings to act on
- MEXC SOLUSDT on 2026-11-11 (1 h, 5 679 trades): spread **1 tick = 1.19 bps** (p10 = p50 = p90), not the 12.5 bps of the 11-09 snapshot. Empirical P(touch within 30 s): 35/39 % at 1 bp, 18/17 % at 3 bps, 13/15 % at 5 bps, 2/7 % at 8 bps → fitted k ≈ 0.35–0.45 /bp, consistent with the configured k = 0.4, so the quoting math is coherent; the market itself (1-tick spread, deep queue) yields ~1–4 fills/h, i.e. ~300 fills would take days on one pair. **Decision:** no by-eye re-tuning of the pre-registered parameters (that would be p-hacking the GO gate); E4 shadow runs 5–10 pairs chosen by measured spread-in-ticks / touch rate / k (scanner logic pulled forward from E7).
- Dev PC has 8 GB RAM and runs Dropbox (~0.9 GB) + several Claude Code sessions (~0.36 GB each): Claude Code reaped a background task under memory pressure on 2026-11-11. Close idle sessions before starting Docker locally; 24/7 shadow belongs on the VPS (E4).
- Local `.env` migrated to the new template (Discord/Gemini values kept). The old file is kept as ignored `.env.v2.bak` and holds a legacy **Binance API key** — revoke it on Binance if unused, then delete the backup.
- The GitHub repo is **public**: never commit `.env`, keys or recordings (all are gitignored).
