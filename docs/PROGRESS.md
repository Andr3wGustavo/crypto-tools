# Cortex Farm — Progress & Evidence

Status: **72 / 100** (E2 and E3 proven; E4 code + tooling done, waiting on the VPS accounts for the 24 h proof; GO/NO-GO protocol pre-registrable; E5 done; E6 dashboard built and E2E-tested in a real browser, live-on-phone proof waits on the VPS + Tailscale; E1 waits only on the local `docker compose` check) · Plan: [MASTER-PLAN.md](MASTER-PLAN.md) · Branch: `rebuild/cortex-farm`

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

## E5 — API & Web3 auth → 64
- ✅ `apps/api` (Fastify 5 + Zod). It **never holds exchange keys**. It authenticates the operator, audits, and enqueues commands; the worker stays the single writer.
- ✅ **Sign-In With Solana**:
  - Message format: wallet-standard `signIn`, the one Phantom uses.
  - Parser: strict and canonical-only.
  - Signature: Ed25519 via `node:crypto`, no crypto dependency.
  - Nonce: single use, consumed before any other check; 5 min TTL; domain, URI and issue time all bound to it.
  - Allowlist: checked last, and the response gives no reason. Nonces are issued to any address, so the API is no allowlist oracle.
- ✅ **TOTP step-up** (RFC 6238, verified against the RFC 4226 and 6238 test vectors) for `resume` / `reset_halt` / `reset_kill`:
  - single use, enforced atomically with `SET NX`;
  - only steps newer than the last accepted one;
  - `pause` needs no TOTP: stopping must always be easy.
- ✅ **Sessions**: opaque 256-bit token; only its SHA-256 is stored, in Redis. Cookie is `httpOnly; Secure; SameSite=Strict`, TTL 12 h. Removing a wallet from the allowlist revokes its sessions.
- ✅ **CSRF**: cookie writes must carry the dashboard `Origin`.
- ✅ **Service tokens**: hashed and scoped. Discord gets `read+pause` only.
- ✅ **Hardening**: rate limits, generic error bodies, `no-store` / `nosniff` / `no-referrer`, every decision written to the `AuditLog` table.
- ✅ **Worker command intake** (`ops/command-source.ts`). Commands arrive on a Redis stream consumer group with XACK (at-least-once). A crash before the ack re-delivers the command.
  - **Recording**: each command becomes a recorded engine input, so replay stays bit-exact.
  - **Expiry**: `pause` applies even when stale; risky commands expire after 2 min.
  - **Rejects**: malformed entries and entries for another bot are acked and refused.
  - **Resilience**: Redis down means backoff plus an error count; the worker keeps running.
- ✅ **Prod**: `api` image target, built and pushed by CI. Compose service under the `api` profile, bound to `127.0.0.1:8080` behind `tailscale serve`. Config validation refuses to boot on a bad origin, wallet or TOTP secret. A provisioning CLI handles the TOTP secret and service tokens.
- ✅ **Evidence**:
  - 27 API tests + 5 command-source tests.
  - End-to-end test against a **real Redis** in CI: sign-in → pause + TOTP resume → applied in order, acked, outcomes published.
  - Bundled API smoke on the dev PC: `/healthz` 200, `/readyz` 503 without Redis (degrades, no crash), unauthenticated command 401, security headers present.
- ✅ **Fixed during E5 (caught by the tests)**:
  - **TOTP rejected every code**: `\d` inside a template-literal `RegExp` became `d`, so the regex never matched a digit.
  - **SIWS padding**: the parser accepted padded field values.
  - **Event-loop starvation**: the command loop could starve the event loop with a non-blocking client.
- ✅ **Read side** (done with E6): `GET /bots`, `/bots/:id`, `/bots/:id/{events,fills,series}`, `/audit`, `/system/info`, `/metrics` (prom-client, read-scoped), and `/ws` (below).
- ✅ **Typed client instead of OpenAPI codegen** (decision): the API and the dashboard share the versioned contracts in `packages/shared/src/dashboard.ts`, so a contract change breaks the typecheck of both sides at once, with no generator step. OpenAPI can be generated from the same schemas later if a third client needs it.

## E6 — Web3 dashboard → 80
- ✅ **Contracts** (`@cortex/shared`): `BotView` v1, `SeriesPoint`, `BotEvent`, live and WebSocket messages. They are wire types, decoupled from the engine internals.
- ✅ **Worker publisher** (`ops/bot-view.ts` + `sinks/redis-sink.ts`):
  - the view at most 1/s; a chart point every 5 s, 24 h kept; event and fill streams; live pub/sub tagged with stream ids;
  - ordered and bounded (drops and counts, never blocks the engine);
  - read-only: a test proves the replay digest is identical with and without it.
- ✅ **Live hub** (`apps/api/src/hub.ts`): one Redis subscription for all clients, coalesced ticks at about 4 Hz.
  - A snapshot on every (re)connect, so a missed delta can never leave the screen wrong.
  - The upgrade is authorised before the socket opens: session or read token, plus an Origin check against cross-site WebSocket hijacking.
  - Sessions are revalidated every 30 s (logout or revocation → 4401). A slow consumer is closed (4408) instead of buffering. The feed is read-only.
  - It starts even with Redis down (a bug found by the bundle smoke test, fixed and tested).
- ✅ **Dashboard** (`apps/web`): Vite + React 19 + Tailwind v4 + TanStack Query + Lightweight Charts, served by the API **from the same origin**. That means no CORS, a strict CSP (`script-src 'self'`, `font-src 'self'`, `frame-ancestors 'none'`) and a single container.
  - **Pages**: Overview (KPIs, Revert-style position cards with the quote band, sparkline, P(edge>0)), Bot detail (live price with the MEXC/Binance/fair/our-quotes lines and fill markers, PnL waterfall, risk, edge with the "uncorrected" caveat, orders, events, health, controls), Risk Center (pause-all kill switch, incidents), Fills (paging + CSV), Logs (live, filters, search), System, Cash & Treasury (honest D0 state), Settings (session, audit log).
  - **Commands**: pause is one click; resume and resets go through a TOTP modal.
  - **Sign-in**: Phantom. The page refuses to sign any message that is not a sign-in for its own domain and address.
  - **Built from these specs**: mobile-first, loading/empty/disconnected states, pt-BR.
- ✅ **Dev server** (`npm run dev:dashboard`): the real API and the real engine, fed by a real recording (or a seeded synthetic market). It lets the dashboard run with no Docker, Redis or Postgres.
- ✅ **Evidence**:
  - 206 unit and integration tests (169 before).
  - 5 Playwright E2E runs (desktop 1440×900 and Pixel 7): Phantom sign-in through the UI, every page, no console errors (so no CSP violations), no horizontal scroll, and the command flow (pause → wrong 2FA code refused → valid code → resumed, confirmed in the log).
  - CI job `e2e` uploads the screenshots. Samples are in [docs/e6](e6/).
- ✅ **Bugs the tests caught**:
  - Vite inlined fonts as `data:` URIs, which the CSP blocked. Fixed by never inlining assets (the CSP was not relaxed).
  - `/system` was both an API route and a dashboard page, so a reload showed JSON. The API route moved to `/system/info`, with a regression test over every page path.
  - On mobile the header overflowed: `hidden` lost to the Pill's `inline-flex`.
  - The same fill showed twice: it has a different stream id in the events and fills streams. It is now deduplicated by `fillId`.
  - The API would not start with Redis down.
  - A relative `API_WEB_DIR` crashed the static server.
- ⏸ **Proof per the plan**: live screenshots on the PC and the phone through Tailscale (needs the VPS, E4).
- ⬜ Later (E7): Edge Lab, Simulator and Pair Scanner pages. Treasury on-chain (wallet balance, withdrawals with Solscan links) arrives with E9.

## AFK operations (pulled forward, before E7)
Priority is now the unattended farm. E7 (the Edge Lab, Simulator and Scanner pages) is not on its critical path; the official GO/NO-GO evaluator already exists as a CLI.
- ✅ **Alerter** (`apps/worker/src/alerts/*`, `alerter-main.ts`, compose service `alerter`). It posts to a Discord webhook (push on the phone).
  - **Events**: halt, kill, reconcile divergence, command applied or refused.
  - **Conditions**: stale bot, dead MEXC feed, drawdown ≥ 3%, error burst, automatic pause lasting more than 60 s. Each is announced when it starts and when it clears, with a reminder every 6 h while it lasts.
  - **Daily digest** at 08:00 BRT.
  - **Reliability**: consumer group per bot stream (a restart resumes, at-least-once). The queue is bounded and batches 10 embeds per message, honours 429 `retry_after`, and never logs the webhook URL. Its own healthchecks ping means a dead alerter is noticed too.
  - **Evidence**: 9 unit tests + 1 real-Redis integration test (CI). Bundle smoke with Redis down: it logs and backs off, no crash.
  - **Bug caught by the tests**: drops that happened while a batch was in flight were lost from the "N dropped" notice.
- ⬜ **E8 live execution** (next): MEXC user-data stream, a live executor with the simulator's contract, reconciliation against the exchange, crash recovery by clientOrderId, cancel-all on boot and shutdown. Still refused until the GO.

## Findings to act on
- **Replay throughput ≈ 13 k records/s** on the dev PC (real E2 hour, 144 178 records in 11 s). A 21-day official evaluation therefore takes up to about 1.5 h per pair at SOL-level activity. Acceptable offline. If it becomes a bottleneck, profile the engine hot path before optimising: the result must stay bit-exact.
- **First real scan** (2026-11-12 10:24 UTC, 20 min, 240 whole-market samples, 0 failures, from the dev PC): 1 790 symbols → 64 pass the static gates → 32 eligible → top 8 = IO, KAITO, BONK, ZRO, CRV, TAO, QNT, W. The majors are untradeable for a penny-inside maker on MEXC (SOL/ETH/XRP/DOGE/ADA: 1-tick spread; BTC: 14 ticks but 0.01 bps). The eligible pairs quote **15–100 bps wide on MEXC while Binance is tight**, often with a −10…−30 bps basis: MEXC is the lagging venue, so much of its flow is likely arbitrage against stale quotes (adverse selection). That is exactly what the lead-lag toxicity filter and the conservative simulator have to survive: **a wide spread is an opportunity only if the shadow says so**. The ranking changed a lot between a 30 s smoke and the 20 min scan (3 of 8 overlap) ⇒ the pre-registration scan on the VPS uses 60 min.
- MEXC SOLUSDT on 2026-11-11 (1 h, 5 679 trades): spread **1 tick = 1.19 bps** (p10 = p50 = p90), not the 12.5 bps of the 11-09 snapshot. Empirical P(touch within 30 s): 35/39 % at 1 bp, 18/17 % at 3 bps, 13/15 % at 5 bps, 2/7 % at 8 bps → fitted k ≈ 0.35–0.45 /bp, consistent with the configured k = 0.4, so the quoting math is coherent; the market itself (1-tick spread, deep queue) yields ~1–4 fills/h, i.e. ~300 fills would take days on one pair. **Decision:** no by-eye re-tuning of the pre-registered parameters (that would be p-hacking the GO gate); E4 shadow runs 5–10 pairs chosen by measured spread-in-ticks / touch rate / k (scanner logic pulled forward from E7).
- Dev PC has 8 GB RAM and runs Dropbox (~0.9 GB) + several Claude Code sessions (~0.36 GB each): Claude Code reaped a background task under memory pressure on 2026-11-11. Close idle sessions before starting Docker locally; 24/7 shadow belongs on the VPS (E4).
- Local `.env` migrated to the new template (Discord/Gemini values kept). The old file is kept as ignored `.env.v2.bak` and holds a legacy **Binance API key** — revoke it on Binance if unused, then delete the backup.
- The GitHub repo is **public**: never commit `.env`, keys or recordings (all are gitignored).
