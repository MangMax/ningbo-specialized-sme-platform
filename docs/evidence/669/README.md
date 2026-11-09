# #669 candidate evidence

Scope: public parse maintenance, additive migration0045, stable declarations and physical ranges.
Base: local `integration/667-file-segments`, initial/current inspected `2392a6fb129e0f85ba0cd2c3fdf4e0b4a8ea0f94`.
Prepared worktree: `/Users/mang/.t3/worktrees/app/t3-02eb55ae-553bdc35b51993ee`.
No production data, deployments, UI/browser-adapter edits, integration/main writes or issue closure.

The committed logs record precommit TDD/validation; exact committed HEAD is rerun before PR handoff,
with logs at `/tmp/669-final-*`. These are separate fresh executions, not inherited test evidence.

| Requirement | Evidence |
| --- | --- |
| Multiple physical ranges, overlap normalization, readback, replay/history, parse-state preservation | `669 persists normalized physical ranges with stable declaration identity and immutable replay` |
| Stable identity across coordinate changes; omission, clear, declaration ABA and withdrawal | `669 preserves omitted ranges across coordinate edits clears explicitly and invalidates ABA and withdrawal plans` |
| Illegal/over-page ranges atomic refusal; unverified ranges, cross-file/removed declaration rejection; Office limitation; no invented OCR pages | `669 rejects invalid unverified cross-file and removed ranges atomically without inventing OCR lineage` |
| Physical content/version ABA rejection and frozen receipt replay | `669 rejects physical content ABA and preserves frozen receipts after source replacement` |
| Forged page count refusal, range edits, old-shaped modern PUT omission and public discovery | `669 verifies supplied counts edits ranges and keeps omission compatibility without false source rebinding` |
| Old clients, source facts and bytes, historical input versions, audit rollback | Existing parse-maintenance-105-http, parse-input-310, mcp-surface, file-parts and agent-http regressions |
| Additive migration with no UPDATE/backfill | `db/migrations/0045_file_declaration_ranges.sql`; runs on real isolated SQLite in HTTP suite |
| OpenAPI/MCP documentation | `docs/file-segment-ranges-669.md`, HTTP route metadata and shared Zod discovery |

Command: `pnpm exec vitest run tests/parse-maintenance-105-http.test.ts tests/parse-input-310.test.ts tests/file-parts.test.ts tests/mcp-surface.test.ts tests/agent-http.test.ts --maxWorkers=1`.
Fresh precommit: 5 files, 153 passed; `pnpm typecheck`, `pnpm build`, isolated production OpenAPI all exit0.
TDD first red: new preflight field rejected400. Second red: range contentVersion missing.
Build initial FAIL: owned test dev server held Nuxt lock; after tests exited normally, subsequent build passed.
Production check uses `/tmp/669-prod/roster.db`, empty controlled file/incoming directories; no repository/business database.

Remaining acceptance: independent review/CI, #668/#670 UI desktop390px, #671 event synchronization and parent #667 final integrated list/detail/export acceptance UNRUN here.
Full repository suite UNRUN. No review delegates were started.

Range provenance is a physical location declaration, never OCR-use lineage or per-enterprise verification.
Source inspection is a consistency check with the existing #311 external writer race boundary, not a filesystem lock.
The generic file list still uses its legacy parts projection; #670 should use public parse `declarations` for range identity.
