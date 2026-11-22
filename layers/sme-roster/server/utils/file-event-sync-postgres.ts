import { eq, getTableName, sql, type Table } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { recordEvidence as RecordEvidenceTable } from '../../../../db/postgresql/ledger-tables'
import type { RegisteredDeclaration } from './registered-declaration-summary'
import type { OfficialEventRow, RosterRecordRow } from './roster-event-version-model'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { importBatch } from '../../../../db/postgresql/import-tables'
import { record, recordEvidence, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { officialEvidenceRowRevision as officialRevision } from '../../../../db/postgresql/official-evidence-tables'
import { fileDeclaration669, rosterFileClassification } from '../../../../db/postgresql/roster-file-tables'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { preflightPostgresParse } from './parse-maintenance-postgres'
import { loadPostgresEventCorrectionInputs, preflightPostgresEventCorrections, commitPostgresEventCorrections } from './roster-event-correction-postgres'
import { projectEventCorrectionPlan, validateEventCorrectionTargets } from './roster-event-correction-model'
import { lockPostgresRosterImportKey } from './roster-export-import-postgres'
import { runPostgresSerializableTransaction } from './postgres-serializable-transaction'
import { failFileEventSync as fail, FILE_EVENT_SYNC_CHUNK as chunkSize, FILE_EVENT_SYNC_LIMIT as limit, fileEventSyncHash as hash, fileEventSyncPhysical, fileEventSyncResult as result, proposeFileEventSync, withoutFileSyncCollisions, type FileEventSyncPlan, type FileSyncEventSources, type SyncRequest } from './file-event-sync-model'

type Db = NodePgDatabase
type Operation = FileEventSyncPlan['operations'][number]
const numberIds = (ids: readonly number[]) => sql`${sql.param(ids)}::bigint[]`

// Stored plans fingerprint JSON.stringify output. Preserve the original logical column order
// and JSON casts independently of the PostgreSQL table's column declaration order.
function fingerprintRow<T>(shape: Table, table: Table) {
  return sql<T>`${postgresRosterRow(shape, getTableName(table))}`
}

async function snapshot(db: Db, id: number, dir: string, request: SyncRequest) {
  const fileTable = rosterFileClassification
  const [file] = await db.select({
    id: storedFile.id, relPath: storedFile.relPath, displayName: storedFile.displayName, filename: storedFile.filename,
    ext: storedFile.ext, bytes: sql<number>`${storedFile.bytes}::float8`, sha256: storedFile.sha256,
    source: fileTable.source, kind: fileTable.kind, year: fileTable.year, batch: fileTable.batch,
    titleCode: fileTable.titleCode, categoryState: fileTable.categoryState, parseState: fileTable.parseState,
    createdAt: storedFile.createdAt, removedAt: storedFile.removedAt,
  }).from(storedFile).innerJoin(fileTable, eq(fileTable.fileId, storedFile.id)).where(eq(storedFile.id, id))
  if (!file || file.removedAt) fail('file_unavailable','文件不存在或已移出',404)
  const source = fileEventSyncPhysical((await preflightPostgresParse(db,id,{kind:'file'},dir)).inputRef,dir)
  const declarations = (await db.select({ row: fingerprintRow<RegisteredDeclaration>(fileDeclaration669, fileDeclaration669) })
    .from(fileDeclaration669).where(eq(fileDeclaration669.fileId, id))
    .orderBy(sql`${fileDeclaration669.declarationId} COLLATE "C"`).limit(1001))
    .map(({ row }) => ({ ...row, active: Boolean(row.active) }))
  const refs = await db.select().from(recordEvidence).where(eq(recordEvidence.sourceFile, file.relPath))
    .orderBy(recordEvidence.id).limit(limit + 1)
  if (refs.length>limit || declarations.length>1000) fail('capacity','超过3000出处或1000声明；须先缩小文件维护范围，不截断',413)
  const eventIds = [...new Set(refs.map(row=>row.recordEventId))].sort((a,b)=>a-b)
  const owners = await db.select({
    event: fingerprintRow<OfficialEventRow>(recordEvent, recordEvent),
    record: fingerprintRow<RosterRecordRow>(record, record),
    enterprise: { id: enterprise.id, name: enterprise.name },
  }).from(recordEvent).innerJoin(record, eq(record.id, recordEvent.recordId))
    .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    .where(sql`${recordEvent.id} = ANY(${numberIds(eventIds)})`).orderBy(recordEvent.id)
  const byEvent = db.select({
    id: recordEvidence.id, row: fingerprintRow<typeof RecordEvidenceTable.$inferSelect>(recordEvidence, recordEvidence).as('row'),
  }).from(recordEvidence).where(sql`${recordEvidence.recordEventId} = ids.id`)
    .orderBy(recordEvidence.id).limit(301).as('evidence_by_event')
  const evidence = (await db.select({ row: byEvent.row }).from(sql`unnest(${numberIds(eventIds)}) ids(id)`)
    .innerJoinLateral(byEvent, sql`TRUE`).orderBy(byEvent.id)).map(({ row }) => row)
  const siblingIds = [...new Set(owners.map(row=>row.record.id))]
  const byRecord = db.select({
    id: recordEvent.id, row: fingerprintRow<OfficialEventRow>(recordEvent, recordEvent).as('row'),
  }).from(recordEvent).where(sql`${recordEvent.recordId} = ids.id`).orderBy(recordEvent.id).limit(limit + 1).as('events_by_record')
  const siblings = (await db.select({ row: byRecord.row }).from(sql`unnest(${numberIds(siblingIds)}) ids(id)`)
    .innerJoinLateral(byRecord, sql`TRUE`).orderBy(byRecord.id)).map(({ row }) => row)
  const official = (await db.select({ row: fingerprintRow<Omit<FileSyncEventSources['official'][number], 'sourceBindingKnown'> & { sourceBindingKnown: number }>(officialRevision, officialRevision) })
    .from(officialRevision).where(sql`${officialRevision.evidenceId} = ANY(${numberIds(evidence.map(row => row.id))})`)
    .orderBy(officialRevision.evidenceId, officialRevision.revision)).map(({ row }) => row)
  const evidenceByEvent = Map.groupBy(evidence,row=>row.recordEventId)
  const siblingsByRecord = Map.groupBy(siblings,row=>row.recordId)
  const officialByEvidence = Map.groupBy(official,row=>row.evidenceId)
  const sources = owners.map(({event,record}):FileSyncEventSources=>{
    const references = evidenceByEvent.get(event.id) ?? []
    const history = references.flatMap(row=>officialByEvidence.get(row.id) ?? [])
      .map(row=>({ ...row,sourceBindingKnown:Boolean(row.sourceBindingKnown) }))
    const peerEvents = siblingsByRecord.get(record.id) ?? []
    if (references.length>300) fail('capacity','单事件出处超过300',413)
    if (history.length>limit || peerEvents.length>limit) fail('capacity','事件历史或同记录事件超过3000；须先缩小维护范围',413)
    return { event,record,evidence:references,siblings:peerEvents,official:history }
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
  const lookup = db.select({ id: importBatch.id, plan: sql<FileEventSyncPlan | null>`${importBatch.preflightResult}::json` })
    .from(importBatch).where(eq(importBatch.idempotencyKey, key))
  const [batch] = await (writing ? lookup.for('update') : lookup)
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
  return runPostgresSerializableTransaction(db,async tx=>{
    await lockPostgresRosterImportKey(tx,old.key)
    const replay = await bound(tx,id,request,true)
    if (replay.plan) return result(replay.plan)
    const s = await snapshot(tx,id,dir,request)
    const requestHash = hash({id,request})
    const plan:FileEventSyncPlan = { protocol:'file-event-sync-671-v1',requestHash,planHash:hash({requestHash,...s}),
      ...s,expectedFingerprint:s.fingerprint,chunks:Math.ceil(s.operations.length/chunkSize),completed:[],updated:0,receipts:{} }
    await tx.insert(importBatch).values({
      idempotencyKey: old.key, sourceKind: 'event_correction', sourceIdentity: 'file-event-sync:' + id,
      status: 'preflight', createdAt: new Date().toISOString(), preflightResult: JSON.stringify(plan),
    })
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
    return await runPostgresSerializableTransaction(db,async tx=>{
      await lockPostgresRosterImportKey(tx,old.key)
      const { batch,plan } = await bound(tx,id,request,true)
      if (!batch || !plan || plan.planHash!==planHash) fail('plan_mismatch','预检计划不存在')
      if (plan.completed.includes(chunk)) return plan.receipts[chunk]!
      if (chunk!==plan.completed.length || chunk>=plan.chunks) fail('chunk_order','必须顺序执行未完成块')
      await tx.select({ id: storedFile.id }).from(storedFile).where(eq(storedFile.id, id)).for('update')
      if ((await snapshot(tx,id,dir,request)).fingerprint!==(plan.expectedFingerprint ?? plan.fingerprint)) {
        fail('stale_membership','完整候选成员、事件或出处已变化；请使用新的幂等键重新预检')
      }
      const correction = { ...request,idempotencyKey:`file-event-sync-chunk:${id}:${request.idempotencyKey}:${chunk}`,
        sourceIdentity:`file-event-sync:${id}:${planHash}`,operations:plan.operations.slice(chunk*chunkSize,(chunk+1)*chunkSize) }
      const preflight = await preflightPostgresEventCorrections(tx,correction)
      await commitPostgresEventCorrections(tx,correction,(preflight as { planHash?: string }).planHash!)
      plan.expectedFingerprint = (await snapshot(tx,id,dir,request)).fingerprint
      plan.failedEvents = 0
      plan.updated += correction.operations.length
      plan.completed.push(chunk)
      const receipt = structuredClone(result(plan))
      plan.receipts[chunk] = receipt
      await tx.update(importBatch).set({
        preflightResult: JSON.stringify(plan), summary: JSON.stringify(receipt),
        status: plan.completed.length === plan.chunks ? 'committed' : 'preflight',
      }).where(eq(importBatch.id, batch.id))
      return receipt
    })
  } catch (error) {
    if ((error as {statusCode?:number}).statusCode) throw error
    const progress = await db.transaction(async tx=>{
      const { batch,plan } = await bound(tx,id,request,true)
      if (!batch || !plan || plan.completed.includes(chunk)) return
      plan.failedEvents = plan.operations.slice(chunk*chunkSize,(chunk+1)*chunkSize).length
      const summary = result(plan)
      await tx.update(importBatch).set({ preflightResult: JSON.stringify(plan), summary: JSON.stringify(summary) })
        .where(eq(importBatch.id, batch.id))
      return summary
    })
    throw Object.assign(new Error('同步失败，本块已回滚；已完成块保留，可用原请求续跑'),{statusCode:500,code:'transaction_failed',progress})
  }
}
