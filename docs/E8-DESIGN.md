# E8: live execution (design)

Goal: the same strategy that ran in shadow sends **real** orders to MEXC, unattended, with losses bounded. The live gate stays **closed** (`TRADING_MODE=live` refused) until the pre-registered protocol says GO **and** the operator opens it explicitly. This document is the contract for the implementation; any deviation is recorded here first.

## 1. Principles (non-negotiable)

1. **One engine, three modes.** Replay, shadow and live run the same deterministic core. The engine never performs I/O.
   - In live, everything the exchange tells us (order acks, rejects, fills, balances) becomes a **recorded input**.
   - So a live session replays bit-for-bit, like shadow.
2. **The exchange is the source of truth.** Our ledger must explain the exchange balances. A divergence ⇒ halt, cancel all, alert, and a human decides.
3. **Fail-closed everywhere.** Unknown order state, a lost user stream, a skewed clock, rate limiting, or any unexpected error ⇒ stop quoting and cancel all. Never "keep quoting and hope".
4. **Idempotent by construction.** Every order carries a deterministic `clientOrderId` (the order FSM already does this). After a crash we ask the exchange about each one by that id; nothing is sent twice blindly.
5. **Loss budget is a hard wall.** D1 = US$15 capital, US$3 loss budget. Reaching it ⇒ kill (sticky; a human must reset it with 2FA).

## 2. Data flow

```
 MEXC public WS ──► book/trade records ─┐
 MEXC user WS   ──► exec records ───────┤                ┌─► actions: place / cancel
 REST snapshots ──► balances records ───┼─► LiveEngine ──┤
 clock / health / commands ─────────────┘   (pure)       └─► outputs: ledger, reconcile, edge…
                                                  │
                     recorder ◄── every input ────┘
 actions ──► LiveExecutor (async I/O, rate-limited) ──► MEXC REST
                │ results (ack / reject / error) come back only as exec records
```

- **New input records:**
  - `{t:'exec', kind:'ack'|'reject'|'canceled'|'fill', …}` from the user stream, or from REST responses normalised into the same shape;
  - `{t:'balances', quote, base}` from periodic REST account snapshots.
- **Shared core:** `ShadowEngine` becomes `Engine` with an `ExecutionVenue`.
  - Shadow wires `SimVenue` (the current `SimExecutor`, synchronous, inside the engine).
  - Live wires `ExternalVenue`: actions are emitted, and the results arrive later as records.
  - Shadow outputs and digests must stay **identical**. The E3 digest is the regression test.

## 3. Components

| Component | Responsibility | Tests |
|---|---|---|
| `MexcUserStream` | `listenKey` create → keepalive every 30 min → re-create on expiry; private WS (`spot@private.orders/deals/account.v3.api.pb`); decode protobuf → exec records; staleness watchdog | fake WS + fake REST: rotation, expiry, decode of captured frames |
| `LiveExecutor` | sends place (`LIMIT_MAKER` = post-only) and cancel; token bucket per endpoint weight; maps REST errors to exec records (post-only reject ⇒ `reject`, unknown order on cancel ⇒ query) | fake exchange: latency, 429, timeouts, duplicate acks |
| `OrderReconciler` | every N s and after any unknown: open orders + account vs engine state; resolves `UNKNOWN` by `queryOrder(clientOrderId)`; divergence ⇒ halt input | fake exchange in every combination of lost ack / lost fill / late cancel |
| `Boot (live)` | before quoting: cancel all on the symbol → account snapshot → reconcile → only then `resume` is possible | crash at each step, then reboot |
| `Shutdown (live)` | stop quoting → cancel all → wait for the acks (bounded) → final account snapshot → snapshot the state | SIGTERM during a fill |
| Live gate | `TRADING_MODE=live` requires: a protocol file with status GO and a valid seal, a `LIVE_ACK=<run id>` typed by the operator, trade-only keys (withdrawal disabled: checked via API when possible), a bound IP, and pairs restricted | config tests: every missing piece refuses to boot |

## 4. Failure modes and the response to each

| Situation | Response |
|---|---|
| User stream silent > 30 s (no keepalive pong) | pause quoting, cancel all via REST, re-create the `listenKey`, reconcile, then resume |
| Place timed out (unknown whether it rested) | order → `UNKNOWN`; no new quote on that side until `queryOrder` resolves it |
| Cancel says "unknown order" | query: if filled, the fill comes through deals/query; if never placed, close it locally |
| Fill seen in REST but not in the stream | the reconciler injects it as an exec record (deduplicated by `tradeId`) |
| Balances differ from the ledger beyond 1 tick of value | halt (sticky) + alert + require a human |
| 429 / rate limit | back off; if quoting cannot be maintained safely, pause |
| Clock skew > 1 s vs MEXC | pause (signatures and TTLs become unreliable) |
| Loss budget reached | kill: cancel all, sticky, alert |

## 5. Rollout (each step gated by evidence)

1. **Paper on the real API:** keys with trade permission, orders priced **far from the market** (they never fill) → place / cancel / reconcile / crash-recovery for 24 h with zero divergence.
2. **One minimal supervised cycle:** about US$1–2 notional on the best GO pair, operator watching.
3. **D1:** US$15 and the US$3 loss budget, live vs shadow compared daily (same data, same decisions, except the fills).

## 6. What the operator must do (when GO)

- MEXC: KYC + 2FA; a trade-only API key bound to the VPS IP and restricted to the GO pairs (no withdrawal); deposit US$15.
- Type the `LIVE_ACK` value printed by the evaluator for the GO run. It is a deliberate, auditable act.

## 7. Implementation status (2026-11-13)

| Component | Where | Status |
|---|---|---|
| Private push decoding | `packages/exchange/src/mexc/private.ts` | ✅ order / fill / balance; REST order and myTrades replies map to the same events |
| `MexcUserStream` | `packages/exchange/src/mexc/user-stream.ts` | ✅ listenKey validated before every reconnect, 30 min keepalive, per-channel ack required before `up`, silence / refusal / undecodable frame ⇒ `down` |
| `LiveExecutor` | `packages/exchange/src/mexc/live-executor.ts` | ✅ per-order ordering, token bucket, 429 block, reject vs unknown, cancel retries, coalescing |
| `LiveEngine` | `apps/worker/src/live/live-engine.ts` | ✅ the reconciler logic lives here (pure): UNKNOWN queries, outcome timeouts, orphan cancel, sync judgment |
| `LiveSession` (I/O, boot, shutdown) | `apps/worker/src/live/live-session.ts` | ✅ |
| Live gate | `apps/worker/src/live/live-gate.ts` | ✅ |
| Live process | `apps/worker/src/live-main.ts` → `dist/worker/live.js`, compose profile `live` | ✅ built; never started by default |
| Rollout step 1 (paper on the real API) | `LIVE_PAPER_OFFSET_BPS` | ✅ ready, waits for keys |

## 8. Decisions taken during implementation (deviations from §1–§6)

1. **Separate `LiveEngine` instead of one `Engine` with a venue.** The shadow engine is untouched,
   so its decisions are frozen by construction. Both share the same strategy, ledger and edge
   estimator; the live engine only replaces the simulator with exchange events.
   - Proof: the E3 recording still replays to output hash `febef904…`, and a 60 min synthetic run
     with 78 fills to `90fbc0c2…`, pinned as a golden test.
2. **Strategy live hooks:** a `venue` hold event and an `UNKNOWN` order status. A side with an
   unknown order is frozen: no new quote, no cancel, funds stay locked. Shadow never emits either.
   - The strategy gained one state field (`venueHold`), so `ENGINE_STATE_VERSION` is 2.
   - The **experiment identity** uses the separate `ENGINE_BEHAVIOR_VERSION` (still 1). Recordings stay replayable; old snapshots are ignored.
3. **Live code lives outside the fingerprinted scope** (`apps/worker/src/live/`). The fingerprint
   that makes an evaluation official pins `packages/core` and the shadow engine only. A fix to the
   live I/O never invalidates a registered experiment; a change to the strategy does, as it should.
4. **Venue hold precedence:** `fatal` (sticky until `reset_halt`) > `opening` > `stream_down` >
   `syncing` > `rate_limited` (10 s) > `clock` (30 s).
   - `fatal` covers:
     - auth failure;
     - a foreign order or fill on the pair;
     - a fee charged in a third asset;
     - more capital than configured, or inventory on the account at opening.
   - The alerter raises a fatal hold as critical at once, and a transient hold only if it lasts more than 60 s.
5. **Opening books the real balances.** The strategy sees no prices before the opening sync, so the
   loss budget is measured from what is really on the account.
   - Refuses more than 1.1 × `LIVE_CAPITAL_QUOTE` of quote.
   - Refuses inventory worth at least the minimum order at start.
   - **One live bot per account** (or sub-account): the ledger must explain the whole balance.
6. **Syncs are epoch-tagged.** A snapshot taken before the latest user-stream change is ignored.
   - A balance mismatch first holds and re-syncs.
   - Only **two consecutive** mismatches halt (sticky). A fill landing between two REST calls cannot cause a false halt.
7. **A restart is an input** (`stream down: restart`) recorded first after boot, never a side effect
   of `restore()`. So a resumed run equals a replay of its recording, bit for bit.
8. **Key permissions and IP binding cannot be proven over the MEXC API.** They are an explicit operator
   attestation (`LIVE_KEY_ATTESTED=trade-only,no-withdraw,ip-bound`), checked in the MEXC UI. The account itself must be able to trade with SPOT permission.
9. **`clientId` is not guaranteed in deal pushes:** fills are matched by `orderId` learned from the
   place reply / order pushes. A fill of an unknown order is still booked (it is our money), then re-synced.
