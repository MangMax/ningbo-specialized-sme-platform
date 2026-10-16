---
name: roster-ingestion-pipeline
description: Use for cleaning and importing Ningbo SME designation rosters in this app: classify source files, render PDFs to page images, run OCR, verify and correct all roster rows, enrich identity evidence, and write results through the app API/MCP workflow.
---

# Roster ingestion pipeline

Use this skill whenever the user provides roster files or asks an agent to clean files already uploaded to the app. Coordinate by file: separate workers may process independent files; when one file's OCR is ready, hand that file to an independent correction/import worker immediately. Do not wait for every PDF to finish first.

Read [`references/workflow.md`](references/workflow.md) for the file-to-record sequence and [`references/decisions.md`](references/decisions.md) when classifying sources or resolving roster/business questions. Read the current app API/OpenAPI or MCP tool schemas before each new write workflow; the actual contract is authoritative.

For roster/lifecycle entities — enterprises, aliases (曾用名), title events, platform relations, difference reasons and export snapshots — the **frozen data contract** is [`docs/roster-lifecycle-contract.md`](../../../docs/roster-lifecycle-contract.md) (decision record: [`docs/adr/2026-10-16-roster-lifecycle-model.md`](../../../docs/adr/2026-10-16-roster-lifecycle-model.md)). Read it before writing any roster row: it fixes table/column names, enum values, unique/idempotency keys, read and write API shapes, and the platform-query status machine (未查询 / 查询失败 / 无记录 / 已确认无差异 / 待核实 are distinct).

## Required sequence

1. **Inventory** the input files by name, type, content hash, source and document purpose. Classify each as official roster evidence, platform comparison snapshot, OCR artifact, or out of scope. Detect duplicate `.doc`/`.docx` copies and duplicate paragraphs before creating records. Keep the previewable canonical copy when two files have identical contents.
2. **Extract by type.** Render PDFs to one PNG per page, then submit image OCR requests concurrently across pages and independent PDFs. Start at 300 DPI; raise toward 400 only for small or faint print when the API budget permits. Extract DOCX/XLSX text directly; do not OCR office documents. Preserve original files, page images, and page-addressable OCR output.
3. **Handoff per file.** As soon as a file's OCR/text is complete, provide an independent worker that file's source ID, pages, OCR output and current match status. Keep the remaining file jobs running concurrently.
4. **Match, then verify.** Match OCR rows against the three current platform export snapshots using valid credit codes, normalized names and sourced aliases. Capture matched and unmatched rows with source page numbers. Visually inspect the corresponding page for every proposed match and every unresolved row; use OCR to narrow which pages need review, not to skip proof. Correct only what the source page supports.
5. **Complete the roster.** Read the notice body and attachment to identify title, event, year and batch. Include every row from an in-scope official roster, including rows unmatched to exports. Research missing credit codes and save URL/date/evidence; flag ambiguous cases.
6. **Write through app APIs.** Use the app's TUS endpoint for file transfer and its published REST/MCP interfaces for registration, page images, OCR, parse results, categories, roster events and comparison evidence. Discover exact tool names and payloads from the running app. The roster write path is live: `POST /api/roster/import/preflight` then `/commit` (HTTP, token required) or the MCP `preflight_roster_batch` / `save_roster_batch` tools; shapes are frozen in `docs/roster-lifecycle-contract.md` §8 (merges in §8.4). If the running app has no roster write endpoint, stop before that write and update RL-11; do not silently substitute direct SQLite writes or a one-off importer.
7. **Reconcile and report.** Verify file/page/OCR/record counts, idempotent source identity, duplicate handling, event year/batch, source attachment/page and API result. Report completed files separately from OCR-only, correction-pending, API-write-pending and manually unresolved files.

## Guardrail

- Keep credentials in runtime secret/configuration storage; never place tokens or cookies in tickets, source files, logs or reports.
