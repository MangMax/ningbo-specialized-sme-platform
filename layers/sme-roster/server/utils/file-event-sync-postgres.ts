import { sql, type SQL, type Table } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { preflightPostgresParse } from './parse-maintenance-postgres'
import { loadPostgresEventCorrectionInputs, preflightPostgresEventCorrections, commitPostgresEventCorrections } from './roster-event-correction-postgres'
import { projectEventCorrectionPlan, validateEventCorrectionTargets } from './roster-event-correction'
import { lockPostgresRosterImportKey } from './roster-export-import-postgres'
import { runPostgresCorrespondenceTransaction } from './record-correspondence-write-postgres'
import { failFileEventSync as fail, FILE_EVENT_SYNC_CHUNK as chunkSize, FILE_EVENT_SYNC_LIMIT as limit,
  fileEventSyncHash as hash, fileEventSyncPhysical, fileEventSyncResult as result, proposeFileEventSync,
  withoutFileSyncCollisions, type FileEventSyncPlan, type FileSyncEventSources, type SyncRequest } from './file-event-sync'

type Db = NodePgDatabase
type Operation = FileEventSyncPlan['operations'][number]
const numberIds = (ids: readonly number[]) => sql`${sql.param(ids)}::bigint[]`

async function records<T extends Table>(db: Db, table: T, from: SQL) {
  const { rows } = await db.execute<{ row:T['$inferSelect'] }>(sql`SELECT ${postgresRosterRow(table,'p')} AS row ${from}`)
  return rows.map(value=>value.row)
}

async function snapshot(db: Db, id: number, dir: string, request: SyncRequest) {
  const { rows:[stored] } = await db.execute<{ file:{ relPath:string; removedAt:string | null } }>(sql`
    SELECT json_build_object('id',f.id,'relPath',f.rel_path,'displayName',f.display_name,'filename',f.filename,
      'ext',f.ext,'bytes',f.bytes,'sha256',f.sha256,'source',c.source,'kind',c.kind,'year',c.year,'batch',c.batch,
      'titleCode',c.title_code,'categoryState',c.category_state,'parseState',c.parse_state,'createdAt',f.created_at,'removedAt',f.removed_at) AS file
    FROM stored_file f JOIN roster_file_classification c ON c.file_id=f.id WHERE f.id=${id}`)
  if (!stored || stored.file.removedAt) fail('file_unavailable','文件不存在或已移出',404)
  const file = stored.file
  const source = fileEventSyncPhysical((await preflightPostgresParse(db,id,{kind:'file'},dir)).inputRef,dir)
  const declarations = (await records(db,schema.fileDeclaration669,sql`FROM file_declaration_669 p WHERE file_id=${id}
    ORDER BY declaration_id COLLATE "C" LIMIT 1001`)).map(row=>({ ...row,active:Boolean(row.active) }))
  const refs = await records(db,schema.recordEvidence,sql`FROM record_evidence p WHERE source_file=${file.relPath}
    ORDER BY id LIMIT ${limit+1}`)
  if (refs.length>limit || declarations.length>1000) fail('capacity','超过3000出处或1000声明；须先缩小文件维护范围，不截断',413)
  const eventIds = [...new Set(refs.map(row=>row.recordEventId))].sort((a,b)=>a-b)
  const { rows: owners } = await db.execute<Pick<FileSyncEventSources,'event'|'record'> & { enterprise:{id:number;name:string} }>(sql`
    SELECT ${postgresRosterRow(schema.recordEvent,'v')} AS event,${postgresRosterRow(schema.record,'r')} AS record,
      json_build_object('id',e.id,'name',e.name) AS enterprise FROM record_event v JOIN record r ON r.id=v.record_id
    JOIN enterprise e ON e.id=r.enterprise_id WHERE v.id=ANY(${numberIds(eventIds)}) ORDER BY v.id`)
  const evidence = await readPostgresRosterRowsById(db,schema.recordEvidence,sql`FROM unnest(${numberIds(eventIds)}) ids(id)
    CROSS JOIN LATERAL (SELECT * FROM record_evidence WHERE record_event_id=ids.id ORDER BY id LIMIT 301) p`)
  const siblingIds = [...new Set(owners.map(row=>row.record.id))]
  const siblings = await readPostgresRosterRowsById(db,schema.recordEvent,sql`FROM unnest(${numberIds(siblingIds)}) ids(id)
    CROSS JOIN LATERAL (SELECT * FROM record_event WHERE record_id=ids.id ORDER BY id LIMIT ${limit+1}) p`)
  const official = await records(db,schema.officialEvidenceRowRevision,sql`FROM official_evidence_row_revision p
    WHERE evidence_id=ANY(${numberIds(evidence.map(row=>row.id))}) ORDER BY evidence_id,revision`)
  const { rows: correspondences } = await db.execute<{ eventId:number; row:FileSyncEventSources['correspondences'][number] }>(sql`
    SELECT ids.id::float8 AS "eventId",${postgresRosterRow(schema.recordCorrespondence,'p')} AS row
    FROM unnest(${numberIds(eventIds)}) ids(id) CROSS JOIN LATERAL (
      SELECT * FROM record_correspondence WHERE event_id=ids.id OR predecessor_event_id=ids.id ORDER BY id LIMIT 301
    ) p ORDER BY ids.id,p.id`)
  const evidenceByEvent = Map.groupBy(evidence,row=>row.recordEventId)
  const siblingsByRecord = Map.groupBy(siblings,row=>row.recordId)
  const officialByEvidence = Map.groupBy(official,row=>row.evidenceId)
  const correspondenceByEvent = Map.groupBy(correspondences,row=>row.eventId)
  const sources = owners.map(({event,record}):FileSyncEventSources=>{
    const references = evidenceByEvent.get(event.id) ?? []
    const history = references.flatMap(row=>officialByEvidence.get(row.id) ?? [])
      .map(row=>({ ...row,sourceBindingKnown:Boolean(row.sourceBindingKnown) }))
    const peerEvents = siblingsByRecord.get(record.id) ?? []
    const relations = (correspondenceByEvent.get(event.id) ?? []).map(row=>row.row)
    if (references.length>300) fail('capacity','单事件出处超过300',413)
    if (history.length>limit || peerEvents.length>limit) fail('capacity','事件历史或同记录事件超过3000；须先缩小维护范围',413)
    if (relations.length>300) fail('capacity','事件对应影响超过300',413)
    return { event,record,evidence:references,siblings:peerEvents,official:history,correspondences:relations }
  })
  const rows:FileEventSyncPlan['rows'] = []
  const operations:Operation[] = []
  const active = declarations.filter(row=>row.active)
  const proposals = sources.map((facts,index)=>proposeFileEventSync(facts,owners[index]!.enterprise,source,file.relPath,active))
  const proposedIds = proposals.flatMap(({op})=>op ? [op.eventId] : [])
  const correctionInputs = proposedIds.length ? await loadPostgresEventCorrectionInputs(db,proposedIds) : null
  for (const {row,op} of proposals) {
    rows.push(row)
    if (!op) continue
    try {
      const correction = { ...request,sourceIdentity:'file-event-sync:'+id,operations:[op] }
      validateEventCorrectionTargets(correction)
      projectEventCorrectionPlan(correction,correctionInputs!)
      row.status = 'update'
      row.reason = '仅补未知正式年月'
      operations.push(op)
    } catch (error) {
      if (!(error as {statusCode?:number}).statusCode) throw error
      row.reason = (error as Error).message
    }
  }
  return { fingerprint:hash({ file,source,declarations,refs,sources }),rows,
    operations:withoutFileSyncCollisions(rows,operations,sources) }
}

async function bound(db: Db, id: number, request: SyncRequest, writing = false) {
  const key = `file-event-sync:${id}:${request.idempotencyKey}`
  const { rows:[batch] } = await db.execute<{ id:number; plan:FileEventSyncPlan | null }>(sql`
    SELECT id::float8 AS id,preflight_result::json AS plan FROM import_batch WHERE idempotency_key=${key}
    ${writing ? sql`FOR UPDATE` : sql.empty()}`)
  const plan = batch?.plan
  if (batch && (plan?.protocol!=='file-event-sync-671-v1' || plan.requestHash!==hash({id,request}))) {
    fail('idempotency_conflict','幂等键已被不同请求使用')
  }
  return { key,batch,plan }
}

export async function preflightPostgresFileEventSync(db: Db, id: number, request: SyncRequest, dir: string) {
  const old = await bound(db,id,request)
  if (old.plan) return result(old.plan)
  await preflightPostgresParse(db,id,{kind:'file',verifyPhysicalPages:true},dir)
  return runPostgresCorrespondenceTransaction(db,async tx=>{
    await lockPostgresRosterImportKey(tx,old.key)
    const replay = await bound(tx,id,request,true)
    if (replay.plan) return result(replay.plan)
    const s = await snapshot(tx,id,dir,request)
    const requestHash = hash({id,request})
    const plan:FileEventSyncPlan = { protocol:'file-event-sync-671-v1',requestHash,planHash:hash({requestHash,...s}),
      ...s,expectedFingerprint:s.fingerprint,chunks:Math.ceil(s.operations.length/chunkSize),completed:[],updated:0,receipts:{} }
    await tx.execute(sql`INSERT INTO import_batch(idempotency_key,source_kind,source_identity,status,created_at,preflight_result)
      VALUES(${old.key},'event_correction',${'file-event-sync:'+id},'preflight',${new Date().toISOString()},${JSON.stringify(plan)})`)
    return result(plan)
  })
}

export async function commitPostgresFileEventSync(db: Db,id: number,request: SyncRequest,planHash: string,chunk: number,dir: string) {
  const old = await bound(db,id,request)
  if (!old.plan || old.plan.planHash!==planHash) fail('plan_mismatch','需要原始预检计划')
  if (old.plan.completed.includes(chunk)) return old.plan.receipts[chunk]!
  try { await preflightPostgresParse(db,id,{kind:'file',verifyPhysicalPages:true},dir) }
  catch (error) {
    const completed = (await bound(db,id,request)).plan
    if (completed?.planHash===planHash && completed.completed.includes(chunk)) return completed.receipts[chunk]!
    throw error
  }
  try {
    return await runPostgresCorrespondenceTransaction(db,async tx=>{
      await lockPostgresRosterImportKey(tx,old.key)
      const { batch,plan } = await bound(tx,id,request,true)
      if (!batch || !plan || plan.planHash!==planHash) fail('plan_mismatch','预检计划不存在')
      if (plan.completed.includes(chunk)) return plan.receipts[chunk]!
      if (chunk!==plan.completed.length || chunk>=plan.chunks) fail('chunk_order','必须顺序执行未完成块')
      await tx.execute(sql`SELECT id FROM stored_file WHERE id=${id} FOR UPDATE`)
      if ((await snapshot(tx,id,dir,request)).fingerprint!==(plan.expectedFingerprint ?? plan.fingerprint)) {
        fail('stale_membership','完整候选成员、事件或出处已变化；请重新预检')
      }
      const correction = { ...request,idempotencyKey:`file-event-sync-chunk:${id}:${request.idempotencyKey}:${chunk}`,
        sourceIdentity:`file-event-sync:${id}:${planHash}`,operations:plan.operations.slice(chunk*chunkSize,(chunk+1)*chunkSize) }
      const preflight = await preflightPostgresEventCorrections(tx,correction)
      await commitPostgresEventCorrections(tx,correction,(preflight as {planHash:string}).planHash)
      plan.expectedFingerprint = (await snapshot(tx,id,dir,request)).fingerprint
      plan.failedEvents = 0
      plan.updated += correction.operations.length
      plan.completed.push(chunk)
      const receipt = structuredClone(result(plan))
      plan.receipts[chunk] = receipt
      await tx.execute(sql`UPDATE import_batch SET preflight_result=${JSON.stringify(plan)},
        status=${plan.completed.length===plan.chunks ? 'committed' : 'preflight'},summary=${JSON.stringify(receipt)} WHERE id=${batch.id}`)
      return receipt
    })
  } catch (error) {
    if ((error as {statusCode?:number}).statusCode) throw error
    const progress = await db.transaction(async tx=>{
      const { batch,plan } = await bound(tx,id,request,true)
      if (!batch || !plan || plan.completed.includes(chunk)) return
      plan.failedEvents = plan.operations.slice(chunk*chunkSize,(chunk+1)*chunkSize).length
      const summary = result(plan)
      await tx.execute(sql`UPDATE import_batch SET preflight_result=${JSON.stringify(plan)},summary=${JSON.stringify(summary)} WHERE id=${batch.id}`)
      return summary
    })
    throw Object.assign(new Error('同步失败，本块已回滚；已完成块保留，可用原请求续跑'),{statusCode:500,code:'transaction_failed',progress})
  }
}
