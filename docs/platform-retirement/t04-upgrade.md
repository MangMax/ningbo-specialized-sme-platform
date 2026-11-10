# T04: isolated collection upgrade

This is an **offline upgrade tool**, not a runtime writer. No server/lib runtime module imports `upgrade/`. It requires the accepted T01/T02/T03 expand schema and migration 0051 on the target. No original business database is an authorized target.

## Operation

Use Node 24 and the existing dependency directory. No install or build is needed. Run from the checkout root:

```sh
node upgrade/run.mjs isolated-upgrade \
  /isolated/frozen-source.sqlite /isolated/new-target.sqlite \
  /existing/new-evidence-directory t04-run-1 100
```

The source must already be an offline, consistent SQLite backup made with SQLite's backup mechanism or from a quiesced, closed database. Do not copy/hash the main file of an active WAL database. This tool does not freeze production or infer whether a business database may be migrated. It rejects nonempty WAL/journal sidecars, identical paths/inodes, missing files, and less than 8 GiB available disk. Source opens readonly and must use rollback journal mode (delete, truncate or persist); persistent WAL is rejected even when no WAL sidecar currently exists. A shared read lock is acquired before validation and held throughout CLI copying, manifest generation and transfer, preventing SQLite writers from committing or switching to WAL. Source file hashes additionally protect each target commit. No source DDL, PRAGMA changes or data writes are made.

A nonexistent target is exclusively created as a copy, then migrated using repository migrations. An existing target is a **resume**, never automatically migrated. Both files must remain offline. On resume use the same run ID and a fresh existing evidence directory (files use exclusive create). The CLI writes a source field manifest, receipt, and query/page mapping. Failure preserves all outputs and partial checkpoints; no cleanup runs.

The library entry is `upgradeCollections({source,target,runId,batchSize})`. Batch size is 1–1000; all source query and relation IDs are checked as positive safe integers before any target migration writes. Completion requires complete source query PK coverage by collections and aliases, with matching counts. Query and relation maxima reserve T02 alias namespaces. Historical collection IDs equal query IDs; no relation alias, observation or assignment is allocated. Source/schema/field-manifest/target-schema/transform bindings persist in `platform_migration_run`; a single collections/query checkpoint stores the last ordered PK, count and chained digest. Every batch's collection, child facts, sealed archives, alias, scope binding and checkpoint commit in one synchronous Drizzle transaction. A failed batch rolls back; replay checks all migrated target facts and archive bytes against the saved digest. No offset, REPLACE, or swallowed archive/alias conflicts.

## Facts and limits

Query natural key, status, failure reason, original timestamps and recency are copied using original SQLite storage/bytes, including invalid UTF8 TEXT. Evidence status/errors remain separate from query status/failure. NULL, empty, malformed JSON, Unicode and BLOB archives are preserved without JSON reserialization. JSON5 normalization occurs only inside this upgrade boundary; invalid UTF8/non-object/malformed evidence gets invalid parse state and retains its bytes. Typed values are conservative: safe integers/text/booleans are represented; real/array/object condition values retain kind only. Absent parse input is distinguishable by collection parse/provenance state. Invalid or missing numeric facts remain NULL; unknown positions do not become verified. Original pages/unfinished ordinals, repeated and zero-row pages remain distinct. Sequence ranges accumulate successful page counts in original order; failure rows with contradictory positive counts make subsequent positions unknown.

`collectionEvidence` and `rawResponse` archives are their original SQLite fields (including NULL). A standalone historical request is **not persisted by the old query/provenance schema**; no request is reconstructed or fabricated. Conditions and limits come only from evidence or explicit supplement, never from queryKey, row count or request-budget guesses. All original evidence bytes include any request-like material actually captured there.

`legacyProvenance` is a BLOB envelope with header `T04-PROVENANCE\n`, followed by these fixed fields in order: query_id, source_identity, source_sha256, segment_index, collection, input_fingerprint, import_batch_id, created_at. Each field is `name storageClass byteLength\n`, exact SQLite CAST-to-BLOB bytes, then newline. NULL has class null and length zero. This preserves the entire supplement row, including the untouched collection JSON text, without claiming it was original evidence. If evidence and supplement both exist, original evidence wins for extraction and provenance state is conservatively conflict; no silent fallback on invalid original evidence. Missing query owners stay in the isolated old copy/manifest and are reported unresolved; no owner is guessed. Original FK violations are listed in the receipt; new violations fail acceptance. Unresolved facts block future cutover.

## Transition and SQL exceptions

T01 still has query_id PK/FK plus nullable collection_id on the existing scope/error tables. The target must retain the **exact legacy query/provenance/scope/error copy**. T04 explicitly updates only collection_id on existing scope/error rows; membership, error markers, old query data and all old triggers stay unchanged. It neither creates a second scope table nor pretends the final-only FK exists. Independent frozen migration0027 SQL in tests verifies JSON5 text-only and second-parse membership/error behavior. T05 must rebuild the final scope/error keys and remove old triggers/FKs after the writer transition.

Normal CRUD, ordering, joins and checkpoints use Drizzle. Native SQLite is limited to schema/PRAGMA/file integrity, original storage/byte manifests, fixed source-field reads and JSON5 normalization at this upgrade boundary. `CAST`/`typeof`/hex byte expressions cannot be replaced by JS strings without losing bytes; regression tests include this counterexample. No new dependency or generic migration framework is introduced.

T05 still owns all observation/assignment/source projection transfer and final FK work. Public writers/readers, runtime selectors, historical hash algorithms and business decisions are untouched. Real historical datasets, production, full build/full suite/public HTTP/MCP/workbooks/performance remain UNRUN. Fixture success is not historical migration completion; #705/B409 inherited FAIL remains unchanged.
