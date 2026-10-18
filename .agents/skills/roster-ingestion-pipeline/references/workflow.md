# File-to-record workflow

## Intake manifest

For every supplied file, record its original name, type, hash, source, purpose, duplicate relationship and processing state. Classify published announcements and their roster attachments as designation evidence; classify the three MIIT spreadsheets as current-state comparison snapshots. Do not create roster rows from notice prose alone: inspect the attachments and include all in-scope official rows, including rows unmatched to exports.

The file-store decision has one source of truth: [`lib/file-store-scope.ts`](../../../../lib/file-store-scope.ts), with its prose table in [`files/README.md`](../../../../files/README.md). Read both before deciding whether a file belongs in the store. Do not hand-place or hand-delete files around that rule.

Before reprocessing an existing file or batch, inspect its current app state and reuse completed, verified outputs. Add or repair only missing items; do not restart a complete import without a specific gap.

## Extract and hand off

- Render every PDF page to a page-addressable image. Extract DOCX/XLSX text directly; do not OCR office documents.
- Submit OCR page images through the shared limit in [`orchestration.md`](./orchestration.md). A successful page remains usable when another page fails.
- Assign one owner per file. Hand a file to correction as soon as all page outcomes are known; list failed pages explicitly and keep the file partial until they are recovered or accepted as unresolved.
- Include the source file ID/path, attachment, page count, page-image references, OCR text per page, failures, likely row ranges and current status in the handoff.

## Correct and verify

1. Parse OCR text into enterprise rows and retain the exact source file and page for each row.
2. Compare against all three current export snapshots. A valid code is a strong matching key; current names and confirmed aliases generate candidates. Keep matched, unmatched and ambiguous rows.
3. Visually verify every official roster row against its cited source page, including OCR text, code, row boundary and page number. OCR narrows where to inspect; it does not replace source review.
4. Correct transcription only to what the source page supports. Keep event metadata and enterprise identity separate from page-level correction.
5. Determine title, event type, year and batch from the announcement body and attachment. Platform application/maintenance fields do not establish formal event year or batch; see [`decisions.md`](./decisions.md).
6. For missing codes, follow [`uscc-recovery.md`](./uscc-recovery.md). A row with a missing code remains part of the official roster and can be imported with identity pending.

## Write through the current app contract

Before a write, inspect the running app's `/_openapi.json` or MCP `tools/list`; use the current schema and [`docs/roster-lifecycle-contract.md`](../../../../docs/roster-lifecycle-contract.md) as the payload reference.

Confirm the intended app/database target and its current baseline or recoverable backup before the first mutation. Keep backups outside Git. If the target or recovery point cannot be verified, stop before writing.

- Use TUS for file transfer, then the app's file registration, page-image, OCR and parse interfaces. `record_evidence.source_file` must be a file-store-relative path to a file that is already in the store.
- Write roster entities and supported platform evidence through the unified import: HTTP `POST /api/roster/import/preflight` then `/commit`, or MCP `preflight_roster_batch` then `save_roster_batch`. Preserve one source identity, hash and idempotency key for the batch.
- Investigate all three live sources through the app REST/MCP surface in [`platform-query.md`](./platform-query.md). Query results are read-only evidence candidates, not writes. Only complete requested ranges can establish a measured zero; retain every relationship and original query time. The stored platform evidence enum still supports only `business_list` (businessList) and `apply_list` (queryList). Live queryBusList is available but has no stored evidence type: keep that provenance separately/pending and never relabel it as a supported stored interface.
- Store public-source and platform evidence only in payload shapes the current contract accepts. The supported public-source backfill and merge shapes are described in contract §§8.4 and 8.10. Follow the stricter `cross_source` gate in [`uscc-recovery.md`](./uscc-recovery.md).
- One batch is atomic: a failed commit writes no business rows. Do not substitute direct SQLite writes or a one-off importer. If a result is uncertain, follow the same-key recovery in [`orchestration.md`](./orchestration.md).

### Correcting existing events and evidence (#34)

The current unified import is not a correction API for stored `record_event` fields or existing evidence coordinates. For a confirmed error in event year, `decidedYear`, `reviewOutcome`, batch, `attachment` or `listNo`, first record the applicable `eventId`, `evidenceId` and `enterpriseId`; source file ID and content hash; exact expected old value and proposed value; original source-page evidence; and the confirmation basis. Track unsupported corrections in #34 and keep them pending. Do not change the idempotency key and reimport to create a replacement event, and do not bypass the contract with SQLite or direct SQL.

The existing `POST /api/roster/evidence/pages` endpoint (contract §8.11) applies only to a verified PDF actual-page correction on an existing evidence row. It updates `page` only; it cannot change event metadata, `attachment` or `listNo`. The request locates a unique row by file-store-relative `sourceFile`, `listNo`, and `enterpriseId` or `enterpriseName`; include `basis`. First submit the exact entry with `dryRun: true`, then compare the returned `evidenceId` and `previous` value with the correction record and confirm the single assignment against the source page. Apply only the same confirmed entry with `dryRun: false`, then verify the response. The route does not accept an expected-old-value precondition, so if the target or current value may have changed since preview, rerun the dry run; if uniqueness or the confirmed page cannot be established, leave it pending. Do not treat this page-only route as a general correction API.

After an import, read the duplicate-name candidate report at `GET /api/roster/import/duplicate-candidates?batchKey=…` (contract §7.8). Candidates without supported platform relation evidence remain pending; do not merge by name.

## Completion report

Report counts and status separately for input/in-scope files, duplicate files, rendered pages, OCR success/failure, parsed official rows, visual verification, export matches, events, identity research, written batches and API errors. Distinguish file/metadata state, page/OCR state, event metadata, identity and write state. Never describe OCR completion as import completion or a missing code as a missing roster row.
