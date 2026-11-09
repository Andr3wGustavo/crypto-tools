# crypto-tools / Cortex Farm — agent instructions

- **Canonical path:** `C:\dev\crypto-tools`. Never work in the old Dropbox copy (corrupted `.git`). Never put this repo in Dropbox/OneDrive.
- **Plan:** `docs/MASTER-PLAN.md` (approved 2026-11-08). **Progress + evidence:** `docs/PROGRESS.md` — update it whenever a checklist item is done.
- **Build gate:** big new phases start only after the user writes "OK CLAUDE" or approves a plan.
- **Language:** talk to the user in PT-BR; code, comments, commits and identifiers in English.
- **Safety invariants (never break):**
  - `TRADING_MODE` defaults to `shadow`; live trading requires explicit `live` + 2FA.
  - Trading keys are trade-only (no withdrawal permission); withdraw uses a separate key with strict limits.
  - No secrets in git (`.env` is ignored; only `.env.example`).
  - Unknown error in the trading loop ⇒ cancel all + pause (fail-closed).
  - Never promise profit; the system measures edge and bounds loss.
- **Architecture:** pure deterministic core (`packages/core`) shared by replay/shadow/live; single-writer worker; append-only event log; double-entry ledger; exchange is the source of truth.
- **Commands:** `npm ci`, `npm run typecheck`, `npm test`, `docker compose -f infra/compose.yaml up -d`.
- **Commits:** conventional commits in English; work on a branch, not directly on `main`.
