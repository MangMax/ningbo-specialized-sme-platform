# Comparison lightweight read contract (#133 M1)

`GET /api/comparison?view=summary` is an explicit opt-in. Omitting `view`, or
passing `view=full`, returns the existing full DTO without adding a discriminator
or dropping/truncating fields. The comparison page uses the explicit summary
for its list and fetches full evidence only after expansion.

## Summary DTO

The envelope retains `rows`, `total`, `counts`, `curatedCounts`, `platform` and
`reconcile`, and adds `view: "summary"`. `counts` and `curatedCounts` remain global;
`total`, `platform.withEvidence/withExplanation/withoutExplanation` and
`reconcile.generatedAt/matched` use the filtered scope **before pagination**.
Existing title/direction/district/q/showCurated/page/pageSize semantics and ordering
are retained, including confirmed-only alias search. No query means no stored
query, not a successful empty result. Query status never determines disposition.

Each summary row has these fields (TypeScript: `ComparisonSummaryRow` in
`lib/comparison-summary.ts`):

- `enterpriseId`, `name`, `nameNorm`, `uscc`, `district`, `titleCode`, `direction`, `curated`.
- `evidenceIncluded: false`, `detailUrl`.
- `explanation: { code: string } | null`: presence/code of the legacy cache entry,
  not its note, evidence, or any substitute for a database decision.
- `assessment`: `queryCoverage.status`, `assessment`, and `explanationValidity.status`,
  projected from the existing query-assessment/lifecycle owners for the selected page.
  These are independent facts: a failed query or withdrawn decision must not be
  displayed as the legacy disposition's default `not_queried`. No coverage source
  objects or decision history are included; withdrawn decisions do not display
  historical reason/measure fields as current instructions.
  The state reader selects only decision ID, status and lifecycle action in SQL;
  it does not hydrate reason/measure notes, actor/basis or qualification JSON and
  then discard them. Full and summary readers share the status rules.
- `platform.aliasCount`, `confirmedAliasCount`, `queryCount`, `sourceRelationCount`.
- `platform.disposition`: `explanationId`, `status`, `reasonCode`, `measureCode`,
  `verificationStatus`, `recordedAt`, `evidenceQueryId`, `evidenceRelationId`.

Notes, moved-in details, aliases, queries, collection results, relations, raw fields,
row evidence and old cache originals are deliberately absent from this DTO. They
are not represented as empty arrays/null facts. `sourceRelationCount` counts **all**
source rows of the included queries, including unassigned/pending rows. It does
not confirm ownership. Its name is distinct from legacy `platform.relationCount`:
that field counts the relations actually hydrated by the full legacy reader.

## Expansion and originals (M2 handoff)

1. Fetch the advertised `detailUrl` on expansion. It specifies `view=full`,
   `enterpriseId`, `title`, `direction`, and `showCurated=true`, so a curated row
   remains recoverable. The response uses the old envelope and full row DTO,
   including notes, aliases, disposition details, complete hydrated query/relationship
   objects and old `explanation` evidence. Empty `rows` means this coordinate no
   longer exists; do not silently display another enterprise. The new
   `enterpriseId` filter intersects all other filters in either view; unknown IDs
   return zero rows. Invalid view/enterprise IDs return HTTP 400.
2. For query archive metadata use existing `/api/platform/queries?view=summary&queryId=ID`.
   For every original source row, independently of legacy hydration, page
   `/api/platform/queries/ID/evidence?field=relations&page=N&pageSize=200` to its
   `total`; read each `relationId` with `field=relation`. Use `field=rawResponse`
   and `field=collectionEvidence` for their originals. These existing endpoints
   return at most 65536 UTF-8 bytes per base64 chunk: concatenate all bytes before
   decoding and continue while `hasMore`. They preserve null versus empty and
   perform no external platform request.
3. Existing `/api/roster/enterprises/ID` retains official recognition/history and
   source/file/page navigation. The comparison remains the historical source-set
   difference, not record-level correspondence or current-title adjudication.
4. Preserve list filters/page/scroll during expansion; show loading/error/retry
   states separately from no evidence. M2 must verify desktop and 390px flows.

There is no legacy comparison-list MCP tool to update. Existing record-level
comparison MCP tools have different explicit-source contracts and are unchanged;
existing platform archive MCP tools remain the archive access path.

## Read boundary and evidence limits

The summary reads record/enterprise scalar projections through the existing
comparison/curation reader. Alias/search, decision and query-membership metadata
are narrow SQL projections without query/raw JSON or relation fields. Filtering
and global aggregates use those scalar rows; only the selected page receives
source-relation counts and response DTOs. Membership is the union of related
enterprise and its own USCC/name query key, without inferring identity from it.
Historical decision selection remains the legacy latest-recorded-at rule.

This is not SQL LIMIT pagination of the base difference/curation calculation:
global counts and the external curation JSON still require that scalar scope.
The legacy reconcile JSON is still parsed to preserve cache presence/counts.
The full default path and single-row expansion remain potentially large.
No list or container SLO follows from unit/HTTP fixture tests. Full-distribution
bytes, latency, raw-growth, c2/c5 resources, final-SHA UI use, and parent acceptance
remain to be measured by the parent workflow.
