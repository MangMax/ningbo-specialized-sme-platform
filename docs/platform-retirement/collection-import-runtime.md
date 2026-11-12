# Explicit collection import runtime (#751)

The existing `preflightRosterImport`, `commitRosterImport` and `replayRosterImport` services accept an explicitly injected SQLite database at 71612. Schema0 retains its original branch. The global database and worker guards remain closed.

`roster-import.ts` uses the existing target collection/replay comparator for persisted and staged natural keys. `collection-import-target.ts` composes the accepted three source writers, projection summaries and `captureQueryRevision113`. The existing receipt owner contains source creation, assignments, 113, candidate task staging, the final batch and final receipt in its caller transaction. A replay of an existing coordinate does not advance `last_collected_at`, add observations or capture another revision.

Source creation infers assignment by explicit enterprise ID, then exact USCC. Unknown identity remains pending. The original request and evidence are archived before source extraction. Persisted reference membership and alias resolution use collection/observation coordinates and separate external aliases. Business preview fields use the observation's source projection. Original archives remain with replay, fingerprint and evidence owners.

The internal collection command and three source writers accept an optional existing `batchId`. The coordinator supplies it to retain `platform_business_observation.batch_id`. When supplied, it participates in the existing canonical command input and independent reconstruction. Commands that omit it keep their previous fingerprint bytes. No public request field, hash normalization, schema or ledger is added. Ordinary recognized first indexing reconstructs the authenticated witness context in its private staging database through the existing witness owner.

Alias admission retains original name/USCC, current assignment and interface checks. Difference import retains its original recognized subject/title/successful-page checks and managed102 protection. Candidate membership does not authorize query-only difference evidence. Public query/relation IDs convert once to the physical difference FK namespaces; stored request hashes and historical JSON stay unchanged. The other two interfaces retain their original difference-import admission rules.

## Verification seam

`tests/platform-collection-import-751.test.ts` runs the full offline migration chain through 71612 on synthetic SQLite. Its oracles include the schema0 import service, literal IDs/counts, original 113 rows and receipt bytes, physical FK/assignment rows, source archives and SQL traces. External aliases 8001/9001 intentionally differ from target IDs 1/1.

The handler test runs actual H3 import routes and MCP import handlers with the same injected database and explicit service execution. It reads the accepted recognized-directory handler, external observation references, the difference handler and 113 impact readback. Executor dispatch/worker admission is replaced only at the existing test injection seam. This is not compiled Nuxt, served OpenAPI, MCP dispatcher/auth registration or global runtime acceptance.

The generic `/api/platform/queries` and its evidence route still use `lib/platform/read.ts` and `lib/platform/evidence-read.ts`. They remain a global archive-reader cutover boundary. A target import is readable through the accepted source-specific target services; it does not establish generic archive-list visibility.

## Remaining legacy owners

| Owner | Remaining implementation |
| --- | --- |
| Historical `platformRecordObservations` repair | `roster-import.ts` historical planning and `projectionItem`; `platform-business-record.ts` legacy original/index routines |
| `platformLegacyProvenance` supplementation | `roster-import.ts` provenance planning; `platform-legacy-provenance.ts` |
| Enterprise merge/attribution correction commands | `roster-import.ts` merge planning/execution, legacy relation transfer and lifecycle conflict readers; their separate correction owners |
| Schema0 collection imports | Original `writePlatformQuery`, `reusedPlatformQuery`, legacy original adapter and schema0 field verifier |
| Live fresh-result reuse | `reuseCollectedPlatformResult`, including `last_collected_at` advancement |
| Global transport and archive reads | Generic query/evidence reads, live/batch jobs, worker entry and FK transfer, ordinary database registration |

These locations remain deliberate handoff boundaries. This slice does not complete W4, #706, qualification #738–742, other FK transfers or physical DROP. Full application wire, builds, browser, CI, real business databases and production are separate acceptance lanes.
