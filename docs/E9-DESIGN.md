# E9 — Treasury and auto-withdraw with hard limits

Status: **built and tested** (2026-11-13). Real use needs E8 live (after GO) plus the operator steps in
`docs/runbooks/vps.md` §6d.

## 1. Money model

On MEXC there is one USDT balance. The live engine's exact ledger splits it into buckets:

| Account | Meaning |
|---|---|
| `cash:USDT` | what the strategy trades (the only balance it sees) |
| `treasury:USDT` | protected profit: never traded, never covers a loss |
| `withdrawing:USDT` | treasury reserved for a withdrawal in flight (still on the exchange) |
| `external:USDT` | sent to the owner's Solana treasury wallet (net of fees) |
| `expense:fees:USDT` | trading and withdrawal fees |

**Skim** (every minute, only while the venue is healthy and the books were just confirmed by a sync):
`target = (1 − ρ) · max(0, min(realized PnL, MTM profit to date))`, with ρ = 0.5. The amount
`target − skimmed so far` moves cash → treasury, rounded down to the cent and capped by quote not
committed to resting buys. The treasury never gives back: later losses only lower the target.

A skim reaches the strategy as a `transfer` event. Start, peak and day-start equity move by the same
amount, so a skim is never a fake drawdown. The edge window is adjusted the same way, because a
transfer is not a trading return. Promotion (treasury → cash) is off in live. Moving up a capital
step (D1 → D2) is an operator decision.

## 2. Withdrawal FSM

```
PENDING ──► SENT ──► CONFIRMED          PENDING: reserved (treasury → withdrawing), not submitted
   │          │                         SENT: may have been submitted (journal written BEFORE the call)
   └──► FAILED ◄┘                       CONFIRMED: settled (withdrawing → external + fee)
                                        FAILED: definitive (refused before sending / MEXC FAILED|CANCEL)
                                                → reserve back to the treasury
```

- Terminal states never change. A repeated report is a no-op.
- An impossible report is `fatal:withdraw_conflict` and needs a human: CONFIRMED → FAILED, or a
  different amount (`fatal:withdraw_amount`).
- An ambiguous outcome (timeout, 5xx, lost answer) **stays SENT**. It is never assumed failed,
  because that would release a reserve whose money may still leave, which is the legacy
  double-withdraw bug.
- While a withdrawal is in flight, the sync accepts the USDT balance anywhere between "debited"
  and "not yet debited". After it is final, the check is strict again.

## 3. The five locks (+1)

| # | Lock | Where enforced |
|---|---|---|
| 1 | **Separate withdraw-only key**, IP-bound, in a **separate process** that never holds the trading key. `WITHDRAW_ENABLED=true` exists only there; the live gate refuses it. | withdrawer gate (`withdraw-gate.ts`) |
| 2 | **Destination** = one Solana treasury address from the withdrawer's own config. It must be in the MEXC withdrawal address book, checked at start and before every submit. The trading process cannot choose the address. | withdrawer |
| 3 | **Amount and frequency**: min = max(US$20, network min + fee); 1 per 24 h; daily cap (≤ 1000). Checked by the engine from its own records and again by the withdrawer from the **MEXC history**, which includes manual withdrawals. Failed attempts count toward the cooldown, so there is no retry loop. | engine + withdrawer |
| 4 | **Only confirmed profit**: cash equity ≥ principal, which makes every treasury unit net profit, and drawdown ≤ 2% from the peak. | engine |
| 5 | **Never in shadow, halt, pause, venue hold or a pending reconciliation**: the last sync must be balanced, within 2.5 sync periods. Shadow has no withdrawal path at all. | engine (+ withdrawer refuses non-live) |
| +1 | **One in flight**. The reserve is debited before the request and restored only on a definitive FAILED. A PENDING one is *aborted*, never sent, if a lock closes before it goes out. | engine FSM |

## 4. Channel (live ⇄ withdrawer)

Two Redis streams, `cortex:withdraw:req` and `cortex:withdraw:evt`, carry messages authenticated
with HMAC-SHA256 (`WITHDRAW_CHANNEL_SECRET`). Writing to Redis therefore cannot ask for a
withdrawal or fake a FAILED.

- Requests are `submit | status | abort`. The engine re-asks every 60 s until the withdrawal is
  final, so delivery is at-least-once and every answer is idempotent.
- The withdrawer's write-ahead journal (`/data/withdraw/journal.ndjson`, fsync'd) and MEXC's
  `withdrawOrderId` (= our id, also sent as the remark) guarantee that an id is submitted at most once.
- A withdrawer report is a recorded engine input, so live sessions still replay exactly.

No withdrawer running ⇒ a request waits, is aborted as stale (> 10 min) when the withdrawer
starts, and is retried after the 24 h cooldown. Withdrawals are switched on by running the
`withdrawer` service (`--profile withdraw`), not by a flag in the trading process.

## 5. Unresolved withdrawals (human step)

If a submitted withdrawal is not found in the MEXC history after 30 min, the withdrawer logs an
error and keeps answering SENT. Check MEXC → Withdraw history, then run:

```
docker compose run --rm withdrawer node dist/withdraw.js resolve <id> confirmed <fee>
docker compose run --rm withdrawer node dist/withdraw.js resolve <id> failed
```

## 6. Assumptions and honest limits

- MEXC takes the withdrawal fee **from** the amount: the API docs and UI show "received = amount − fee".
  If it were charged on top, the first sync after settlement would differ by the fee and the bot
  would halt (fail-closed). That is why the first real withdrawal is supervised.
- The history may report the gross amount or the amount received; both settle the reserve exactly.
- At D1 (US$15) with ~0.3%/day the treasury needs **years** to reach US$20. E9 is the machinery for
  D2/D3; it does not change the economics.

## 7. Evidence

- Core: transfer event (no fake drawdown), skim rule, FSM transitions, ledger reserve/settle/release.
- Engine (9 tests): skim; happy path; failure + cooldown; each lock; abort; conflict/amount fatal;
  cap + cooldown; replay + restore through a withdrawal in flight.
- Withdrawer (14): gate, idempotency, timeouts (never re-sent, never auto-failed), refusals,
  limits from the MEXC history, address book, journal, HMAC channel.
- **End to end:** engine ⇄ signed channel ⇄ real Withdrawer ⇄ fake MEXC. Sent once despite many
  re-asks, confirmed, books equal to the exchange at every sync.
- Shadow golden hash unchanged (shadow decisions are bit-identical).
