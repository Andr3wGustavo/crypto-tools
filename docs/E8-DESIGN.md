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
