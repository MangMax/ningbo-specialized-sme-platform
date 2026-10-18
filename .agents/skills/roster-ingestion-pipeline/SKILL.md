---
name: roster-ingestion-pipeline
description: 'Use for cleaning and importing Ningbo SME designation rosters in this app: classify source files, render PDFs to page images, run OCR, verify and correct all roster rows, enrich identity evidence, and write results through the app API/MCP workflow.'
---

# Roster ingestion pipeline

Use this skill when a user supplies roster files or asks to clean files already uploaded to the app. It is a repeated, evidence-backed workflow: preserve every row in an in-scope official roster, keep identity research separate from roster completeness, and write through the app's current contract.

Read [`references/workflow.md`](references/workflow.md) for the file-to-record sequence; [`references/orchestration.md`](references/orchestration.md) for shared agent limits, handoffs and retry rules; [`references/decisions.md`](references/decisions.md) for source and event semantics; and [`references/uscc-recovery.md`](references/uscc-recovery.md) for identity research and missing codes.

Before each new write workflow, inspect the running app's OpenAPI document or MCP `tools/list`. The current contract is authoritative. The stable entity payload examples live in [`docs/roster-lifecycle-contract.md`](../../../docs/roster-lifecycle-contract.md) and [`docs/adr/2026-10-16-roster-lifecycle-model.md`](../../../docs/adr/2026-10-16-roster-lifecycle-model.md).

## Run

1. Inventory files, classify official announcement attachments separately from platform comparison snapshots, and identify duplicates. Apply the single file-store rule in `lib/file-store-scope.ts` and `files/README.md`.
2. Extract every PDF page and direct text from office documents. Start OCR as soon as a page image is ready; hand off a file when its page results are ready without waiting for unrelated files.
3. Correct every formal roster row against its source page. Matching helps locate candidates; it never filters rows out or replaces visual source review.
4. Inspect app `GET /api/platform/capabilities` or MCP `get_platform_capabilities`, then use app `POST /api/platform/query` / `query_platform` for single queries or the batch submit/status/item/retry workflow in [`references/platform-query.md`](references/platform-query.md). Platform credentials stay on the server; routine investigation never reads/reveals Cookie or calls the platform directly. Research missing identity fields with [`references/uscc-recovery.md`](references/uscc-recovery.md). Search results and names create candidates; evidence, not name similarity, closes identity.
5. Confirm any identity changes from evidence; independently preflight and import supported file, event, identity and platform evidence through the current REST/MCP contract. Missing codes do not block importing official roster rows.
6. Reconcile and report file metadata, pages, OCR, official rows/events, identity and write outcomes as separate states. Use [`references/orchestration.md`](references/orchestration.md) for completion and failure handling.

## Guardrails

- Published announcements and attachments are designation evidence; platform exports are current-state comparison snapshots. Keep all official rows, including rows unmatched to exports.
- Keep file/metadata, page/OCR, event and identity status distinct. Use the source page for each official row.
- Treat the four company names supplied as leads in issue #35 as candidates only until independent sources close the identity chain.
- Assign each enterprise exactly one investigator across files; at most two identity investigations and two process-global platform requests run at once. Batch workers share the app limiter, including legacy calls and retry backoff.
- Keep credentials, business databases, source documents and uploaded files outside Git. Never substitute direct SQLite writes for the unified import API.
