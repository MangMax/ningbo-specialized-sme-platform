# File-to-record workflow

## Intake manifest

For every supplied file, record its original name, type, hash, suspected source, purpose, duplicate relationship and processing state. Do not create roster entries from administrative notice text alone; inspect its attachments and include the parts that actually contain enterprise names. Treat the three MIIT spreadsheets as current comparison snapshots. Exclude nurture-only or unrelated notice files unless the user includes them in the requested roster scope.

Assign one owner per file. For PDFs, page rendering is the prerequisite for OCR. Render pages in parallel across PDFs and submit all rendered page images concurrently when the provider allows it. Retry transient 5xx responses at the single-image request boundary; do not retry permanent 4xx responses. Preserve each successful page when another page fails.

When one file reaches OCR-ready state, hand off that file immediately with: file ID/path, source document purpose, page-image paths, OCR page results, likely title/event segments, match candidates, unresolved rows, and write API references. The correction worker continues independently while other PDFs render or OCR.

## Correction and matching

1. Parse OCR text into enterprise rows and attach each row to its actual page.
2. Compare rows against all three current export snapshots. Prefer a validated credit code; then use normalized exact names and sourced aliases. Keep the match method and candidate source.
3. Visually verify the source page for matched rows and unmatched rows. Confirm names, credit codes, row boundaries, page numbers and duplicated paragraphs. Do not visually re-read every unrelated page if OCR and export matching already narrows the proof set.
4. Correct OCR transcription from the page image. For missing credit codes, search public registry/official sources and retain URL plus retrieval date. Leave ambiguous candidates unresolved.
5. Parse the announcement body and attachment to determine title, award/review event, year and batch. If one PDF has multiple attachments or years, create separate event groups with their own evidence.
6. Write the original file, generated images, OCR output, corrected rows, event records and source evidence through the app's API/MCP contract. Replaying the same source batch must be idempotent.

## Roster write path (RL-11)

Roster entities — enterprises, confirmed aliases (曾用名), title events, source evidence, platform queries/relations, export snapshots, difference reasons/measures, and merges — are written through **one** path. Discover it live (`GET /_openapi.json` in dev, or MCP `tools/list`), but the shapes are frozen in `docs/roster-lifecycle-contract.md` §8:

- **HTTP**: `POST /api/roster/import/preflight` (read-only impact preview; writes no business data) then `POST /api/roster/import/commit` (single-batch transaction). Both need a token (`Authorization: Bearer <NUXT_API_TOKEN>`); with no token configured, writing is off. `idempotencyKey` in the body makes replay safe — the same source re-submitted never duplicates enterprises or events.
- **MCP**: `preflight_roster_batch` (read) and `save_roster_batch` (write, needs `NUXT_MCP_TOKEN`). After writing, verify with `list_enterprises` / `list_differences`.
- **One batch = one atomic write.** Either the whole batch is `committed`, or it is `failed` with per-item errors (`{ ok:false, kind, ref, error:{ code, field?, message } }`) and **no business rows written**. Never treat a partial batch as done.
- Include **every** in-scope official roster row, including rows unmatched to any export snapshot.
- Merging a no-credit-code enterprise into its canonical row is a `payload.merges` item (§8.4), not a direct `uscc_norm` update; the merge lineage (which records/events/evidence moved) is stored in `import_batch.item_results` and can be read back.
- A batch may reference enterprises it creates in the same payload; identities resolve at write time.
- Export snapshots: `year` / `collectedOn` come from the caller, never inferred from the file or its name.

Do not substitute direct SQLite writes or a one-off importer for this path.

## Completion report

Report counts at each boundary: input files; in-scope files; duplicate aliases skipped; PDF pages rendered; OCR pages succeeded/failed; rows parsed; rows matched/unmatched to each export; rows visually verified; enterprises/events written; credit codes researched/filled/ambiguous; API errors. Never describe OCR completion as import completion.
