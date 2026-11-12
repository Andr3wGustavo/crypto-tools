# Cortex Farm — Progress & Evidence

Status: **55 / 100** (E2 and E3 proven; E4 code + tooling done, waiting on the VPS accounts for the 24 h proof; GO/NO-GO protocol pre-registrable; E1 waits only on the local `docker compose` check) · Plan: [MASTER-PLAN.md](MASTER-PLAN.md) · Branch: `rebuild/cortex-farm`

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
- ✅ (core) double-entry ledger, average-cost PnL, treasury + capital ladder, risk manager (kill/halt/pause/reduce-only) with tests — `e077537`; ledger and treasury property tests, one test per risk rule
- ✅ Exact state codec (`packages/core/src/state/codec.ts`): ±Infinity, NaN, -0, `undefined`, Map, Set round-trip bit-exactly; refuses shapes it cannot restore (functions, nested class instances, missing/unknown fields). Mutation-tested: dropping the simulator from the restore makes 3 tests fail
- ✅ Engine snapshot/restore: `ShadowEngine.snapshot()/restore()`; config-hash identity of the experiment; every ledger transaction re-validated on restore; restore at any cut point = uninterrupted run (outputs hash and full-state digest). The clientOrderId `seq` survives restarts (no duplicate ids — required before live)
- ✅ Boot restore (`apps/worker/src/state/boot.ts`): newest valid snapshot + replay of the recorded tail; the cursor (file, line, sha256 of the record) must exist on disk, otherwise the snapshot is quarantined and an older one (or genesis) is used. Snapshots are atomic (tmp → fsync → rename), every 60 s and on shutdown; one run directory per configuration (`cfg-<hash12>`)
- ✅ Recorder: file order = record order across restarts even if the wall clock steps back (floor key + monotonic segment)
- ✅ Process health is a recorded input (`health` every 5 s: event-loop lag p99, data-feed errors/min, MEXC clock offset) → the risk rules for lag/error rate/clock skew are now live and replayable; operator commands are recorded inputs too
- ✅ Continuous reconciliation (shadow): exact ledger vs strategy balances after every fill; divergence ⇒ sticky risk halt + `reconcile` event (persisted)
- ✅ Drain on shutdown (stop inputs → close recording → final snapshot → sinks) with a 15 s hard exit; fail-closed on engine exceptions, `uncaughtException` and `unhandledRejection` (a partial state is never snapshotted)
- ✅ Fixed: an exception thrown by the trading loop inside a WebSocket handler was swallowed as a "decode error" (MEXC and Binance streams) — handler errors now propagate and fail closed
- ✅ Fixed: MEXC clock sync used one sample that included the TLS handshake (offset 500–750 ms, RTT ≤ 937 ms); now min-RTT of 5 samples → offset ≈ 52 ms, RTT ≈ 300 ms. Without this the clock-skew rule would have paused the shadow for nothing
- ✅ Fixed: Redis sink kept reconnecting and logging forever after a failed init; errors are now throttled to 1 log/min
- ✅ **E3 proof — live kill -9 / restart, state bit-exact** (2026-11-11, MEXC SOLUSDT + Binance, bundled worker): process 1 ran 3.5 min, snapshots every 45 s, killed with `taskkill /F` 22 s after the last snapshot → process 2 restored `snap-…9889` + replayed the 2 090-record tail in 436 ms → state digest `a0b113fc…` = an independent genesis replay of the crashed segment (11 979 records) → ran 3 min live, drained → final digest `9d48738f1de5e5b8…` = full genesis replay of both segments (24 764 records, 82 places, 81 cancels) → a third boot restored with 0 records to replay. Equity matched (15 → 15; no fills in this window — 1-tick spread — so the fill path of the restart proof is covered by the synthetic kill/restart test, which has fills)
- ⬜ Live reconciliation against the exchange (balances/open orders) — belongs to the live executor (E8)

## E4 — Production VPS + 24/7 shadow → 58
- ✅ **Pair scanner** (pulled forward from E7), pre-registered: pure gates/metrics/ranking in `packages/core/src/scanner` (9 tests incl. properties) + CLI `apps/worker/src/scan.ts`. Static gates (USDT, tradable, no ST flag, no leveraged tokens, maker 0 %, min notional fits the inventory cap, 24 h volume, Binance listing) → whole-market book sampled every 5 s → spread in ticks, capturable half spread after pennying, realised 1-min vol (Σr²/Σdt), recent trade rate, **reference basis check** (same ticker on Binance but a different token ⇒ rejected). The report's `paramsHash` pre-registers the selection
- ✅ Fixed: `mexcSymbolInfo` rejected 1 418 of 1 790 MEXC symbols (`baseSizePrecision = "0"`); step now falls back to `10^-baseAssetPrecision`
- ✅ Fixed: `ShadowEngine.restore` accepted a balanced ledger that does not explain the strategy balances (e.g. empty) — restore now reconciles on load (found by the new `verify-run` test)
- ✅ Heartbeat per worker (atomic file: feeds age, status, version) + **dead-man sidecar** → healthchecks.io (success / `fail` with reasons). Live check (DOTUSDT, 2026-11-12): heartbeat written, healthcheck `healthy (test123)`, wrong version refused, missing worker reported
- ✅ `verify-run` = backup restore test: genesis replay vs newest valid snapshot + tail must reach the same digest, run dir untouched. On the real E3 recording: 24 971 records, both digests `8437d0b77ddf…`
- ✅ Production stack: one isolated container per pair generated from the pre-registered scan (`pairs-cli` → `infra/prod/pairs.json` + `compose.pairs.yaml`), Postgres pool capped per worker, healthcheck = fresh heartbeat from **this** image version ⇒ `docker compose up --wait` is the smoke test; `docker compose config` validated
- ✅ CI pushes multi-arch `cortex-worker` + `cortex-migrate` images to GHCR; manual **Deploy (VPS)** workflow over Tailscale SSH; `deploy.sh` checkout → migrate → roll → wait healthy → **automatic rollback** to the previous tag
- ✅ `bootstrap.sh` (unattended upgrades, swap, chrony + Oracle NTP, Docker log rotation + live-restore, SSH keys only, fail2ban, Tailscale), hourly encrypted off-site backup (`rclone` crypt, copy never sync), `restore-test.sh`, `latency.sh`; runbook `docs/runbooks/vps.md`
- ⏸ Oracle account (Tokyo, PAYG) + Tailscale + healthchecks.io + backup bucket — **user**
- ⬜ On the VPS: latency numbers, 60-min pre-registration scan → commit `pairs.json`, deploy, restore test, rollback test, chaos tests, **24 h without intervention**
- ✅ **Pre-registered multi-pair GO/NO-GO protocol** (pulled forward from E7/E10), fixed **before** the window opens. Core: `packages/core/src/stats/edge-protocol.ts`. Decision rule:
  - **Correction:** Bonferroni over pairs × looks.
  - **Fixed looks only:** 7, 14 and 21 days, each judged on exactly its own span, which kills optional stopping.
  - **Autocorrelation:** AR(1) variance inflation.
  - **Data quality:** a look with too many gaps cannot decide.
  - **Futility stop:** a pair with no realistic chance of GO is stopped early.
  - **Fail-closed:** at the last look, a pair with no data, or a config changed mid-window, is NO-GO.

  Simulated guarantees, measured:

  | Case | False-GO rate with the rule | Without it |
  |---|---|---|
  | 8 pairs at the worst null (μ = ε) | **1.7 %** | 28 % (no correction) |
  | AR(1) inventory, ρ = 0.5 | **4.5 %** | 20 % (no adjustment) |

  - **Power:** a GO at look 1 needs about 3.2 bps/h with σ = 10 and 8 pairs (`minimumDetectableEdge`).
  - **Protocol file:** `infra/prod/protocol.json` is generated by `pairs-cli` and hash-sealed. It records the pairs, the rule, the registration time and the **content fingerprint of the judged code** (core + engine, test files and CRLF ignored).
  - **Build:** the same fingerprint is injected into the bundle at build time; a test checks that the TS and build implementations agree.
  - **Evaluator** (`evaluate.ts`, bundled): replays every pair with the image's code and applies the rule. It is official only when the fingerprints match.
  - **End-to-end check:** run on the E3 recording, `official: true`, bundle fingerprint = TS fingerprint.
- ✅ **Fixed (data loss): the recorder's `close()` waited only for the current file.**
  - **Failure:** an hour rotated out just before a drain/deploy could lose its tail.
  - **Reproduced:** only 232 of 60 000 records survived; after the fix, 60 000.
  - **Hidden by a second bug, now fixed:** the reader silently accepted a gzip without its trailer. It now checks ISIZE and reports `gzip trailer missing`. The check correctly flags the E3 segment killed with `taskkill /F`.
  - **Regression check:** the E3 digest is still `8437d0b77ddf…`.

## Findings to act on
- **Replay throughput ≈ 13 k records/s** on the dev PC (real E2 hour, 144 178 records in 11 s). A 21-day official evaluation therefore takes up to about 1.5 h per pair at SOL-level activity. Acceptable offline. If it becomes a bottleneck, profile the engine hot path before optimising: the result must stay bit-exact.
- **First real scan** (2026-11-12 10:24 UTC, 20 min, 240 whole-market samples, 0 failures, from the dev PC): 1 790 symbols → 64 pass the static gates → 32 eligible → top 8 = IO, KAITO, BONK, ZRO, CRV, TAO, QNT, W. The majors are untradeable for a penny-inside maker on MEXC (SOL/ETH/XRP/DOGE/ADA: 1-tick spread; BTC: 14 ticks but 0.01 bps). The eligible pairs quote **15–100 bps wide on MEXC while Binance is tight**, often with a −10…−30 bps basis: MEXC is the lagging venue, so much of its flow is likely arbitrage against stale quotes (adverse selection). That is exactly what the lead-lag toxicity filter and the conservative simulator have to survive: **a wide spread is an opportunity only if the shadow says so**. The ranking changed a lot between a 30 s smoke and the 20 min scan (3 of 8 overlap) ⇒ the pre-registration scan on the VPS uses 60 min.
- MEXC SOLUSDT on 2026-11-11 (1 h, 5 679 trades): spread **1 tick = 1.19 bps** (p10 = p50 = p90), not the 12.5 bps of the 11-09 snapshot. Empirical P(touch within 30 s): 35/39 % at 1 bp, 18/17 % at 3 bps, 13/15 % at 5 bps, 2/7 % at 8 bps → fitted k ≈ 0.35–0.45 /bp, consistent with the configured k = 0.4, so the quoting math is coherent; the market itself (1-tick spread, deep queue) yields ~1–4 fills/h, i.e. ~300 fills would take days on one pair. **Decision:** no by-eye re-tuning of the pre-registered parameters (that would be p-hacking the GO gate); E4 shadow runs 5–10 pairs chosen by measured spread-in-ticks / touch rate / k (scanner logic pulled forward from E7).
- Dev PC has 8 GB RAM and runs Dropbox (~0.9 GB) + several Claude Code sessions (~0.36 GB each): Claude Code reaped a background task under memory pressure on 2026-11-11. Close idle sessions before starting Docker locally; 24/7 shadow belongs on the VPS (E4).
- Local `.env` migrated to the new template (Discord/Gemini values kept). The old file is kept as ignored `.env.v2.bak` and holds a legacy **Binance API key** — revoke it on Binance if unused, then delete the backup.
- The GitHub repo is **public**: never commit `.env`, keys or recordings (all are gitignored).
