# Cortex Farm — Progress & Evidence

Status: **22 / 100** · Plan: [MASTER-PLAN.md](MASTER-PLAN.md) · Branch: `rebuild/cortex-farm`

Legend: ✅ done (with evidence) · 🔄 in progress · ⬜ not started · ⏸ blocked on user

## E0 — Repository rescue → 22
- ✅ Rules saved to memory (build gate, repo location, master plan, user profile) — `~/.claude/projects/*/memory/`
- ✅ Backup of the Dropbox folder (477 entries incl. `.git`, `.env`, conflicted copies) — `C:\dev\backups\crypto-dropbox-backup-2026-11-08.tar.gz`
- ✅ Clean clone of GitHub `2d9c5a5` into `C:\dev\crypto-tools`; `.env` copied; `CONTEXT.md` archived to `docs/archive/`
- ✅ `npm ci` + `prisma generate` + `tsc --noEmit` → exit 0 (was 59 errors in the Dropbox working tree)
- ⏸ Rename the old Dropbox folder to `_OLD_corrupted` — must be done by the user after closing this VS Code session (it is the session's working directory)
