# Multi-agent orchestration

Use one coordinator for the run. The coordinator owns the shared queue and limits; worker agents do not create more agents.

## Shared concurrency limits

These are global limits for the whole run, not per agent:

| Work | Default in flight |
|---|---:|
| Independent source files | 3 |
| OCR page-image requests | 4–6 |
| Identity investigations | 2 |
| Platform requests | 2 |
| App writer | 1 |
| Independent acceptance reader | 1 |

Use a lower cap when the provider or app limit is lower. Keep a single shared queue for OCR and platform calls so parallel workers cannot multiply the request rate. A file owner may start independent page requests within that queue.

## Partition work and reuse evidence

- Assign one owner to each source file. When that file's OCR output is ready, hand it to correction immediately; other files can keep rendering or using the shared OCR queue.
- An OCR-ready handoff includes every page result or an explicit per-page failure. Label a file partial when any page failed; do not call missing pages complete.
- Assign exactly one investigator per enterprise and share the same batchId/itemId with every file owner. Group identity investigations by enterprise ID, then by confirmed unified social credit code when no ID is available. Share one evidence log across every file row in that group.
- A same-name result without a confirmed ID remains a candidate. Keep separate candidate subjects separate; do not share an identity decision or merge based on name alone.
- One writer owns each import batch. Serialize changes to the same enterprise even when evidence came from different files. The independent acceptance reader receives the finished evidence pack and does not edit the batch.

## Handoff packages and completion criteria

| Stage | Handoff package | Complete when |
|---|---|---|
| Intake | Source identity and hash; original filename and file-store ID/path; source type and purpose; notice/attachment; page count; duplicate and scope decision. | Every supplied file is classified and every in-scope official attachment is identified. |
| OCR | File ID; page-image references and exact page numbers; OCR text per page; failed page requests and retry count; likely row ranges; current file status. | Every page is successful or explicitly failed. Send the file to correction as soon as this boundary is reached. |
| Correction | Every official row with source file/page, source transcription, corrected text, visual-check result, export match candidates and unresolved fields. | Every formal row was checked against its source page. Unreadable or ambiguous text remains explicit; no official row is dropped. |
| Identity | Enterprise ID or confirmed code when known; published row/page; separate candidate names/codes; exact local, platform and public queries; source URLs and check times; filters, page counts/totals and completion state; supported evidence references. | Candidate discovery is distinguishable from confirmation. Each resolved decision has a closed evidence chain; other cases remain pending. |
| Write | Source identity/hash; one idempotency key; exact contract version and supported payload; preflight response; commit receipt and item results. | The entire atomic batch is committed, or its rollback and per-item errors are recorded. |
| Acceptance | Source-to-output counts; every official row and source page; event fields; identity state; page/OCR state; batch receipt and duplicate-candidate result. | A separate reader confirms the evidence for each acceptance dimension. Any unresolved business error blocks acceptance. |

Keep metadata/file-store state, page/render/OCR state, event metadata and enterprise identity as separate fields in each handoff. A file can be stored while its pages are incomplete; an official row can be imported while its code remains pending.

## Retry and recovery

- Retry only the failed unit. For a transient OCR failure, retry that page image and retain successful page outputs. Do not repeat every page because one request failed.
- For live platform work use [`platform-query.md`](./platform-query.md). Submit multiple independent queries through app REST/MCP; route results by stable itemId, not name/code or array order. Explicitly retry only unfinished itemIds/pages after reviewing failures; preserve completed segments/rows/times. The app enforces a global max2 across batches, singles, legacy calls and backoff. The identity-investigator cap remains2, independent of batch item count.
- A platform timeout, expired session, HTTP 200 login page or incomplete pagination is failed/partial evidence, not a zero-row result. Preserve the exact query and page boundary.
- The unified import is all-or-nothing. On a rejected batch, preserve completed OCR, correction and research artifacts, fix the reported item, and retry the same source with the same idempotency key; the current commit contract permits a failed batch to retry with that key.
- If a commit response is lost, first look up the receipt by its exact idempotency key where the live contract exposes a read. The current public REST/MCP surface has no standalone batch-lookup route; repeating the same key through commit returns the prior committed receipt or safely retries a failed batch. Never mint a new key to resolve an unknown result.
- A required identity or source-evidence field that cannot be supported by the current contract stays pending and becomes a scoped issue. Do not bypass validation, fabricate a count, or mark a real business error accepted.
- One failed acceptance dimension does not abandon the run. Keep successful outputs, retry or correct only the affected unit, then rerun the relevant acceptance check. Record non-blocking gaps separately; unresolved business errors block acceptance.

For credential-free single, batch, expired-session, second-page-failure and same-code multi-relationship walkthroughs, run the behavioral examples in [`../examples/README.md`](../examples/README.md). Check observed app routes and results, not source text alone.

## Required scenario walkthroughs

Use these paths to check that the handoffs preserve evidence and recover locally:

| Scenario | Expected handling |
|---|---|
| Multi-page PDF while other files are still running | Use the shared OCR cap; hand off that file once each page is successful or explicitly failed. Keep successful pages and verify every official row against its page. |
| One enterprise appears in several files | Reuse the investigation by enterprise ID or confirmed code; keep each file's own row and page evidence. A matching name alone only links candidates. |
| Publicly evidenced old name and a platform current name | Search the old name and variants in public sources, capture the old-name-to-code evidence, then query the platform by code for the current name. Apply the current `cross_source` requirements in [`uscc-recovery.md`](./uscc-recovery.md); if the full name-query count is unavailable or the current validator rejects the case, leave it pending and track #6. |
| Current payload is rejected | Record the preflight/commit error and the atomic rollback. Preserve prior stage outputs, correct only the rejected evidence or field, and retry the same-source batch with its original key. If the rule itself is unsupported, open or update the relevant issue instead of bypassing it. |
| Commit response is lost | Resolve the result using the original idempotency key and current receipt behavior. Confirm committed/failed before starting any new batch; do not make a new key. |
| Existing event or evidence coordinate is wrong | Follow the existing-record correction boundary in [`workflow.md`](./workflow.md). Track unsupported event, attachment or list-number corrections in #34 as pending; use the page-only endpoint only for a confirmed PDF page correction. Preserve completed files, OCR, research and imports while the correction is tracked. |

Names called out as examples in issue #35 (海尔施、众鑫、华盛、展慈) are walkthrough leads only. Do not write a name history, alias or identity conclusion for them without independent evidence.
