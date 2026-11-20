/** Full-read budgets belong to selected evidence, never to business predicates. */
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from './target-schema'
import { assertPlatformFullReadBudget } from './evidence-contract'
import type { SelectedLegacyProvenance, SelectedProvenanceOwner } from './target-legacy-provenance'

export function assertTargetDisplayBudget<S extends Record<string, unknown>>(
  tx: BetterSQLite3Database<S>, selected: readonly SelectedProvenanceOwner[], legacy: SelectedLegacyProvenance, includeRaw = false,
) {
  const r = s.platformCollectionArchiveRef, v = s.platformArchiveValue
  const budget = selected.map(row => {
    const expression = legacy.get(row.collection.id)?.collection ?? sql`NULL`
    const bytes = tx.get<{ n: number }>(sql`select
      coalesce((select ${v.byteLength} from ${r} join ${v} on ${v.id}=${r.archiveId}
        where ${r.ownerId}=${row.collection.id} and ${r.field}='collectionEvidence'),0) +
      coalesce(length(cast(json_remove(${expression}, '$.rows') as blob)),0) +
      ${includeRaw ? sql`coalesce((select ${v.byteLength} from ${r} join ${v} on ${v.id}=${r.archiveId}
        where ${r.ownerId}=${row.collection.id} and ${r.field}='rawResponse'),0)` : sql`0`} +
      coalesce((select sum(1024 + coalesce(length(cast(e.name as blob)),0) +
        coalesce((select sum(length(json_extract(cell.value,'$.hex')) / 2)
          from platform_observation_archive_ref ar join platform_archive_value av on av.id=ar.archive_id,
            json_each(cast(av.bytes as text),'$.fields') cell
          where ar.owner_id=ob.id and ar.field='legacyRowSnapshot'
            and json_extract(cell.value,'$.name') in ('raw_fields','source_text','name_raw','alias_name_raw',
              'uscc_raw','relation_key','province','status','batch','declare_kind','applied_at','award_batch_label')),0))
        from platform_business_observation ob
        join platform_observation_assignment ca on ca.observation_id=ob.id
          and ca.revision=(select max(na.revision) from platform_observation_assignment na where na.observation_id=ob.id)
        left join enterprise e on e.id=ca.enterprise_id where ob.collection_id=${row.collection.id}),0) as n`)!.n
    return bytes
  })
  assertPlatformFullReadBudget(budget)
}
