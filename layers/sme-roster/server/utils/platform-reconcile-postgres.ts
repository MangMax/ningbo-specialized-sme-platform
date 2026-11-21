import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { getPostgresComparison } from '../../lib/comparison'
import type { LegacySlotCollection } from '../../lib/platform/client'
import type { KnownEnterprise } from '../../lib/platform/payload'
import type { ReconcileQueryEvidence } from '../../lib/platform/reconcile'
import { snapshotStoredReplayInput } from '../../lib/platform/reconcile-replay-input'
import { RECONCILE_SLOT_RULE, slotLegacyRow, slotPayloadRow } from '../../lib/platform/reconcile-slot-capture'
import type { RosterImportPlatformQuery } from '../../lib/roster-import-client'
import { readPostgresObservationComparisonFacts } from './record-correspondence-target-postgres'
import { readPostgresFingerprintQueries, readPostgresRelationFingerprints } from './postgres-platform-fingerprint'
import { createPostgresImportSteps, executePostgresImportSteps } from './roster-mixed-import-postgres'
import { executePostgresRosterImport } from './roster-export-import-postgres'
import {
  isFreshReconcileDecision, projectReconcileTargets, runPlatformReconcileWithStore, type ReconcileRunOptions, type StoredSlot,
} from './platform-reconcile'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type SelectedSlot = { id: number; uscc: string; archiveId: string | null; boundArchiveId: string | null; status: string; queriedAt: string }

async function readSlot(tx: Tx, selected: SelectedSlot, cutoffIso: string): Promise<StoredSlot | undefined> {
  if ((selected.status !== 'success' && selected.status !== 'no_record') || selected.queriedAt < cutoffIso) return
  const { query,collection: captured } = (await readPostgresFingerprintQueries(tx,[selected.id])).get(selected.id)!
  if (query.interface !== 'apply_list' && query.interface !== 'business_list') return
  if (query.status !== 'success' && query.status !== 'no_record') return
  if (captured.reconcileSlotState === 'uncaptured') throw new Error('Reconcile capture target NOTREADY: selected slot uncaptured')
  if (captured.reconcileSlotRule !== RECONCILE_SLOT_RULE) throw new Error('Reconcile capture target NOTREADY: unsupported rule')
  if (captured.reconcileSlotState === 'miss') return
  if (captured.reconcileSlotState === 'error') throw new SyntaxError((captured.reconcileSlotReason ?? '').replace(/^SyntaxError: /, ''))
  if (query.rawResponse === null || selected.archiveId === null || selected.archiveId !== selected.boundArchiveId ||
    captured.reconcileSlotRowCount === null) throw new Error('Missing selected reconcile original response')
  const originals = (await readPostgresRelationFingerprints(tx,{queryId:query.id,archiveReplay:true}))
    .sort((a,b)=>a.relation.sequenceNo-b.relation.sequenceNo)
  if (originals.length !== captured.reconcileSlotRowCount) throw new Error('Reconcile selected observation count drift')
  if ((query.status === 'no_record') !== (originals.length === 0)) return
  const facts = await readPostgresObservationComparisonFacts(tx, originals.map(row=>({
    observationId:row.observationId,interface:query.interface,
  })))
  const payloadRows = originals.map(row=>slotPayloadRow(row.relation))
  const rows: ReconcileQueryEvidence['relations'] = originals.map((row,index)=>{
    const { relation, observationId } = row
    const projection = facts.get(observationId)
    if (!projection) throw new Error('Missing reconcile observation source facts')
    const evidence = { ...projection, rdjb:query.rdjb,sequenceNo:relation.sequenceNo,relationKey:relation.relationKey,
      nameRaw:row.originalName,usccRaw:row.originalUscc,rawFields:payloadRows[index]! }
    if (query.interface === 'business_list') return { ...evidence,interface:query.interface,sourceKind:'platform_business' }
    if (evidence.status !== null && typeof evidence.status !== 'string') throw new Error('Invalid apply stored status cell')
    return { ...evidence,interface:'apply_list',status:evidence.status,sourceKind:'platform_apply' }
  })
  const { id,interface: source,rdjb,queriedAt,status,failureReason } = query
  const bySequence = new Map(originals.map(({relation})=>[relation.sequenceNo,{
    values:relation as unknown as NonNullable<RosterImportPlatformQuery['relations']>[number],ref:'relation:'+relation.id,
  }] as const))
  return {
    kind:'stored',
    original:snapshotStoredReplayInput(query,{
      ref:'query:'+id,metadata:query,relationCount:originals.length,relationAt:seq=>bySequence.get(seq),
    },[...bySequence.keys()]),
    titleCode:query.titleCode,
    collection:JSON.parse(query.rawResponse) as LegacySlotCollection,
    raw:'',payloadRows,rawRows:originals.map(row=>slotLegacyRow(row.relation)),
    evidence:{interface:source,rdjb,queriedAt,status,completeness:'complete',failureReason,relations:rows},
  }
}

export function runPostgresPlatformReconcile(db: NodePgDatabase, options: Omit<ReconcileRunOptions,'db'|'targetSlots'|'writer'>) {
  return runPlatformReconcileWithStore(options,{
    prepare: (filter,cutoffIso)=>db.transaction(async tx=>{
      const directions = filter.directions?.length ? filter.directions : [undefined]
      const comparison = []
      for (const direction of directions) comparison.push(...(await getPostgresComparison(tx,{title:filter.titles,direction})).rows)
      const { rows: enterprises } = await tx.execute<Pick<KnownEnterprise, 'id' | 'name' | 'nameNorm' | 'uscc'>>(sql`
        SELECT id::float8 AS id,name,name_norm AS "nameNorm",uscc_norm AS uscc FROM enterprise ORDER BY id`)
      const collected = projectReconcileTargets(comparison,enterprises,filter)
      const reused = new Map([...collected.byUscc.keys()].map(uscc=>[uscc,new Map<string,StoredSlot>()]))
      if (!reused.size) return {collected,reused}
      const { rows } = await tx.execute<SelectedSlot>(sql`
        SELECT DISTINCT ON (c.query_key,c.interface,c.rdjb) q.old_id::float8 AS id,c.query_key AS uscc,c.status,c.queried_at AS "queriedAt",
          a.archive_id AS "archiveId",c.reconcile_slot_raw_archive_id AS "boundArchiveId"
        FROM platform_collection c JOIN platform_legacy_query_alias q ON q.collection_id=c.id
        LEFT JOIN platform_collection_archive_ref a ON a.owner_id=c.id AND a.field='rawResponse' AND a.sealed=1
        WHERE c.query_key=ANY(${sql.param([...reused.keys()])}::text[])
          AND ((c.interface='business_list' AND c.rdjb IN ('1','2','3')) OR (c.interface='apply_list' AND c.rdjb=''))
        ORDER BY c.query_key,c.interface,c.rdjb,c.queried_at DESC,q.old_id DESC`)
      for (const row of rows) {
        const slot = await readSlot(tx,row,cutoffIso)
        if (slot) reused.get(row.uscc)!.set(slot.evidence.interface+'|'+slot.evidence.rdjb,slot)
      }
      return {collected,reused}
    },{isolationLevel:'repeatable read',accessMode:'read only'}),
    async freshDecision(target,cutoffIso,complete) {
      const { rows:[latest] } = await db.execute<{verificationStatus:string;recordedAt:string;status:string}>(sql`
        SELECT verification_status AS "verificationStatus",recorded_at AS "recordedAt",status
        FROM difference_reason WHERE enterprise_id=${target.enterpriseId} AND title_code=${target.titleCode} AND direction=${target.direction}
        ORDER BY recorded_at DESC,id DESC LIMIT 1`)
      return isFreshReconcileDecision(latest,cutoffIso,complete)
    },
    writer:()=>({
      async preflight(request) {
        const result = await executePostgresRosterImport(db,'preflight',request,(tx,batch)=>
          executePostgresImportSteps(tx,batch,'preflight',createPostgresImportSteps('preflight',request)))
        if (result.status !== 'preflight') throw new Error('Reconcile import preflight did not return a plan')
        return result
      },
      async commit(request) {
        const result = await executePostgresRosterImport(db,'commit',request,(tx,batch)=>
          executePostgresImportSteps(tx,batch,'commit',createPostgresImportSteps('commit',request)))
        if (result.status !== 'committed') throw new Error('Reconcile import batch did not commit')
        return result
      },
    }),
  })
}
