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

## Completion report

Report counts at each boundary: input files; in-scope files; duplicate aliases skipped; PDF pages rendered; OCR pages succeeded/failed; rows parsed; rows matched/unmatched to each export; rows visually verified; enterprises/events written; credit codes researched/filled/ambiguous; API errors. Never describe OCR completion as import completion.
