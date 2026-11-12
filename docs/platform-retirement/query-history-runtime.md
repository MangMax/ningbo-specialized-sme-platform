# Generic platform history on an injected target

`listPlatformQueries` and `readPlatformQueryEvidence` accept an explicitly injected, completed 71612 database. Schema0 keeps its existing readers. `queryHistoryTarget` checks the target version and existing completion flags. Global database admission, imports through workers, and worker guards retain their existing closed state.

## Selection and display owners

`target-query-read.ts` selects collections through external query aliases. SQLite computes filter intersections, status counts, stable time and external-ID order, and the requested page. Enterprise membership uses the latest observation assignment. USCC membership uses the original assignment identity or the query key. Query title membership retains the direct title and existing collection scope index rules, including the scoped malformed-archive error.

Summary reads collection metadata and observation counts. They do not load relation projections or archive bodies. Full reads check the existing 4 MiB query and 8 MiB page budgets before hydration. SQLite computes selected original relation-cell sizes from the existing snapshot owner. Collection archive lengths come from archive metadata. Legacy provenance header reads skip cell bodies in SQLite before applying the original `json_remove(collection, '$.rows')` budget expression.

The accepted relation display owner now lives in `lib/platform/target-relation-display.ts`. The correspondence server wrapper retains its sanitization policy. Generic history receives original display fields, current attribution, source positions, and source-owned reconciled fields and conflicts. Source projections retain their observation ownership even when observations share a content version. Page hydration batches collection and observation owners.

`target-query-display.ts` supplies selected collection evidence and legacy metadata, including collections with no observations. JSON decoding occurs after selection for display. Archive JSON does not determine business membership, counts, or order.

## Exact evidence and complexity

The public evidence entry delegates target reads to the accepted `readTargetPlatformEvidence` owner. `evidence-contract.ts` holds the common input and result types, 65536-byte chunk limit, and full-read budgets. Neither evidence reader imports the other for its contract.

Raw response and collection evidence slices stay in SQLite. Relation evidence still materializes the complete original relation snapshot and computed DTO before slicing. Provenance still validates or materializes complete request and envelope owners. This change does not claim chunk-sized complexity for relation or provenance reads. No snapshot format, hash input, or original archive byte changes.

## Handler and cache boundary

The existing H3 and MCP handlers call the same public readers on the same injected target database. The REST summary cache retains its read-only observer, `data_version`, file identity, transaction bypass, no-store, and resource limits. The handler tests execute actual H3 handlers and direct MCP tool handlers. They do not prove compiled Nuxt registration, served OpenAPI, MCP dispatch or auth wiring, or global runtime admission.

## Remaining owners

The final Z owner retains global guard enabling and schema0 branch retirement. Historical observation repair and provenance supplementation, enterprise merge and attribution commands, fresh live reuse and `last_collected_at`, live and batch jobs, worker admission, other foreign-key transfer and table removal, and served discovery remain separate work. Qualification, formal facts, UI, exports, real databases, production, and deployment are outside #752.

The focused acceptance source is `tests/platform-query-history-runtime-752.test.ts`. It covers the recorded empty-list counterexample, ordinary imports, independent schema0 and literal oracles, migrated history, all generic filters, attribution, exact evidence, budgets, batching, handlers, cache commits and rollback, and request snapshots. Execution receipts and failure history belong to the implementation's external acceptance directory.
