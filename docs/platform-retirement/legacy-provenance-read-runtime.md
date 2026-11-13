# Selected legacy provenance reads

Issue #757 implements the generic evidence and selected display part of the [lifecycle contract](legacy-provenance-lifecycle.md). `queryHistoryTarget` admits an explicitly injected 71613 database only after `requireLegacyProvenanceReady`. The ordinary runtime and worker guards remain closed. The original schema0 readers remain available.

`resolveSelectedLegacyProvenance` receives collections already selected through public query aliases. It authenticates the original T04/W4a sealed field set with the unchanged `provenancePresence` before reading the successor index. A T04 envelope requires its matching index, archive pointer, original query alias and all six original scalar metadata values. Missing or conflicting lifecycle facts throw. A supplement requires an exclusive TEXT archive. It never extends the sealed ref set or substitutes absence for a broken owner.

T04 scalar expressions retain the original eight-cell SQLite types and bytes. Header reads skip collection bodies inside SQLite. Supplement collection expressions read the independent archive. `field=legacyProvenance` slices the original collection bytes, including rows, with the existing base64, offset, NULL and 65536-byte limits. Relation evidence still serializes the original snapshot with current attribution. Supplement display does not rewrite that snapshot.

Generic history and the shared relation display evaluate the existing query/page byte calculation before payload hydration. The limits remain 4 MiB per query and 8 MiB per page. `json_remove(collection,'$.rows')` determines the provenance charge and list metadata, including its original SQLite errors. Metadata is decoded once per selected collection in a request-local resolver result. Original display archive hash checks remain after budgeting. This implementation does not promise chunk-sized internal memory for T04, selected archive authentication, command request authentication or relation snapshots.

Summary reads do not load provenance, archive bodies or relation payloads. Count, stable pagination, budget evaluation, metadata and selected display share the caller's synchronous read transaction. Resolver results are never cached between requests. The existing readonly summary observer keeps its `data_version`, transaction bypass and no-store behavior.

## Concrete consumer split

The generic query/evidence readers, `readTargetRelationDisplay` and the sanitized `readTargetRelationEvidenceDisplay` wrapper form this candidate. They display supplement pages only after selection and use the original `legacySourcePositionForSequence`.

The full enterprise and source routes require a separate selected-attachment slice:

- `lib/roster/enterprise-roster.ts` selects platform history directly from the old query/relation tables. Its platform selection must first obtain structured target owners while retaining its existing limits, membership, sort and qualification inputs. Only the selected evidence attachment may then use this resolver.
- `server/utils/record-correspondence-read.ts:sourceReader` already calls the shared display on its accepted target branch. Its entry and correspondence-link closure still call `correspondenceTarget`, whose shared read/write admission stops at 71612. Read admission and the exact authorized link closure need their own acceptance. Extending that shared guard here would also admit correspondence writes.
- Candidate and comparison source facts, coverage/proof, decision validity, 113/114 and qualification remain with their current owners. Supplement display values are not business facts and must not drive those consumers. Tests compare candidate selection, comparison query/identity sets and generic filter/count results before and after supplementation. They also compare immutable business, decision and 113/114 rows. Those checks do not claim complete enterprise/source authorization or qualification-route execution on 71613.

W command/fingerprint/receipt work is independent. Parent acceptance owns the same-database W+R HTTP composition. Actual H3 REST handlers and MCP handler functions are tested here; compiled Nuxt wire, served OpenAPI, dispatcher authentication, browser, production and global enablement remain separate evidence lanes. Historical failures and custody disclosures in the lifecycle contract remain in force.
