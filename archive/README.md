# Archive

Reference-only code. **Not part of any workspace, never built, never run.**

- `legacy-trading/` — the v2 Binance market maker, compound, auto-withdraw and user-stream code.
  Superseded by `packages/core` + `packages/exchange` + `apps/worker` because of the defects listed in
  `docs/MASTER-PLAN.md` §11 (≈129% quoted spread, biased edge sample, cosmetic halts,
  USDT-as-SOL withdrawal bug, no idempotency). Kept only to preserve history and ideas.
