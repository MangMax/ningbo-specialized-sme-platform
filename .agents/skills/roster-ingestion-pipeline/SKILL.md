---
name: roster-ingestion-pipeline
description: 'Use for cleaning and importing Ningbo SME designation rosters in this app: classify source files, render PDFs to page images, run OCR, verify and correct all roster rows, enrich identity evidence, investigate designation differences, and submit agent-confirmed causes through the app API/MCP workflow.'
---

# Roster ingestion pipeline

Use for roster-file intake, platform evidence collection and enterprise identity or designation-difference investigations. Preserve official rows and keep collection, import and adjudication outcomes separate.

## Choose the workflow

- Files: follow [`workflow.md`](references/workflow.md). Classify announcements versus platform snapshots; resolve duplicates under `lib/file-store-scope.ts` and `files/README.md`. Render every PDF page before OCR; parse office text directly. Hand off each ready file without waiting for unrelated files. Visually verify every official row, including export matches.
- Missing identity: follow [`uscc-recovery.md`](references/uscc-recovery.md). Search names and keywords across platform and public sources; candidates require an evidence chain before confirmation. Missing codes never block official-row import.
- Platform collection: discover `GET /api/platform/capabilities` or MCP `get_platform_capabilities`; use app REST/MCP single or batch queries per [`platform-query.md`](references/platform-query.md). Preserve every relation, page and unfinished range. Credentials stay on the server; never reveal Cookie or call platform URLs directly.
- Differences/full refresh: follow [`difference-investigation.md`](references/difference-investigation.md). Collect all requested enterprises, but skip cause investigation for actual no-difference cases. Agents establish causes/measures; software only records query facts and explicit decisions. Partial/failed queries are not no-difference.

## Coordinate and write

Use [`orchestration.md`](references/orchestration.md) for handoffs, completion and retries: one owner per enterprise across files/titles, at most two investigators and two process-global platform requests, one writer. Workers do not delegate. Reuse completed evidence and retry only gaps.

Before writes, inspect current OpenAPI or MCP tools/list. Preflight, commit and read back through the unified app API/MCP; never direct-write SQLite. Preserve idempotency on retries. Explicitly import `queryBusList` as `recognized_list`; preserve segments/times/pages and reconcile IDs per [`platform-query.md`](references/platform-query.md). Unsupported writes remain pending; do not fabricate source types to pass validation.

See [`decisions.md`](references/decisions.md) for event/source semantics and `docs/roster-lifecycle-contract.md` in the repository for payload rules. Announcements establish designation history; exports represent platform snapshots. Preserve unmatched official rows and nullable unknowns. Names in issue #35 are research leads, not confirmed identity evidence.

Keep business DBs, source files, uploads, credentials and case evidence outside Git. Report file/page/OCR, official events, identity, query coverage, import receipts and adjudication as distinct outcomes.
