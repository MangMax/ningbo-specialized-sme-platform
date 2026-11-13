import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { chmodSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import { targetSchema as s } from '../lib/platform/target-schema'
import { writeCollectionTarget, writeNewCollectionTarget, type NewCollectionTargetCommand } from '../lib/platform/collection-target-command'
import { writeApplyTarget } from '../lib/platform/apply-target-writer'
import { writeProcessTarget } from '../lib/platform/process-target-writer'
import { verifyReconcileSlot, reconcileSlotWriteInstalled } from '../lib/platform/reconcile-slot-write'
import { queryPlatformSlots, type LegacySlotCollection } from '../lib/platform/client'
import { slotPayloadRow } from '../lib/platform/reconcile-slot-capture'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { captureSourceSlot, completeReconcileSlotCapture } from '../upgrade/reconcile-slot-capture'
import { rowSnapshot } from '../lib/platform/sqlite-row-cells'
import { sourceFieldComparison } from '../lib/platform/source-extraction'
import { normalizePlatformRelation } from '../lib/platform/normalization'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import { preflightRosterImport, commitRosterImport } from '../server/utils/roster-import'
import { originalLegacyProvenanceInput } from '../lib/platform/legacy-provenance-command'
import { runPlatformReconcile } from '../server/utils/platform-reconcile'
import { reuseCollectedPlatformResult } from '../server/utils/platform-collection-reuse'
import { assertExpandRuntime } from '../db/schema-phase'
import type { RosterImportPlatformQuery, RosterImportRequest } from '../lib/roster-import-client'

const inputs = process.env.WRITE_766_INPUT, cases = process.env.WRITE_766_CASES, evidence = process.env.WRITE_766_EVIDENCE
if (!inputs || !cases || !evidence) throw new Error('Exclusive WRITE_766_INPUT/CASES/EVIDENCE required')
const time = '2026-11-13T04:00:00.000Z', uscc = '91330211000000088X'
const hash = (v: string|Buffer) => createHash('sha256').update(v).digest('hex')
const fallbackColumns = ['relation_key','name_raw','uscc_raw','province','status','batch','declare_kind','applied_at','award_batch_label','year']
let t: Database.Database, old: Database.Database, path: string, serial = 0
let db: ReturnType<typeof drizzle<typeof schema>>, oldDb: typeof db
const trace: string[] = []
function copy(from: string, name: string) {
  const p = join(cases!, name + '.sqlite')
  copyFileSync(from, p); chmodSync(p, 0o600)
  expect(statSync(p).nlink).toBe(1); expect(statSync(p).ino).not.toBe(statSync(from).ino)
  return p
}
beforeEach(context => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(time))
  path = copy(join(inputs!, 'complete.sqlite'), `target-${++serial}`)
  t = new Database(path, { verbose: sql => trace.push(String(sql)) }); t.pragma('foreign_keys=ON')
  old = new Database(copy(join(inputs!, 'schema0.sqlite'), `old-${serial}`)); old.pragma('foreign_keys=ON')
  db = drizzle(t, { schema }); oldDb = drizzle(old, { schema }); trace.length = 0
  writeFileSync(join(cases!, `test-${serial}.json`), JSON.stringify({ test: context.task.name, target: path }))
})
afterEach(() => {
  try {
    expect(t.pragma('foreign_key_check')).toEqual([])
    expect(trace.filter(q => /\b(?:from|join|into|update|delete from)\s+["`]?platform_(?:query|relation)["`]?(?=\s|$|\()/i.test(q))).toEqual([])
    writeFileSync(join(evidence!,`runtime-trace-${serial}.json`),JSON.stringify(trace))
  } finally { t.close(); old.close(); vi.useRealTimers() }
})
function request(q: RosterImportPlatformQuery[], key = 'new'): RosterImportRequest {
  return { sourceKind: 'platform_archive', sourceIdentity: 'write766', idempotencyKey: key, payload: { platformQueries: q } }
}
function commit(input: RosterImportRequest, target = db) { return commitRosterImport(target, input, [], { deferCandidateTasks: true }) }
function committed(input: RosterImportRequest, target = db) {
  expect(preflightRosterImport(target, input).preflight.conflicts).toEqual([])
  const result = commit(input, target)
  expect(result.status, JSON.stringify(result)).toBe('committed')
  return result
}
async function collection(source: 'apply_list'|'business_list' = 'business_list', rdjb: ''|'1'|'2'|'3' = source === 'apply_list' ? '' : '2', rows: Record<string, unknown>[] = [{ id: 'WRITE766', rdjb: '2', qymc: 'Capture', tyshxydm: uscc, cszt: 'done', year: 2024, sblx: '申请' }]) {
  const result = (await queryPlatformSlots({ uscc, cookie: 'offline=766', retries: 0, now: () => time,
    fetchImpl: async (_url, init) => {
      const page = Number(new URLSearchParams(init.body).get('pageNum'))
      return { ok: true, status: 200, text: async () => JSON.stringify({ zrarData: { grid: { [source === 'apply_list' ? 'applyGrid' : 'businessListGrid']: { page, pageSize: 50, maxCount: rows.length, pageSet: rows.slice((page - 1) * 50, page * 50) } } } }) }
    },
  }, source === 'apply_list' ? [{ interface: 'apply_list' }] : rdjb === '' ? [] : [{ interface: 'business_list', rdjb }]))[0]!
  return { interface: source, queryKey: uscc, rdjb, queriedAt: time, status: rows.length ? 'success' : 'no_record', rawResponse: result.raw,
    relations: rows.map((rawFields, i) => ({ sequenceNo: i + 1, relationKey: typeof rawFields.id === 'string' ? rawFields.id : null, nameRaw: typeof rawFields.qymc === 'string' ? rawFields.qymc : null, usccRaw: typeof rawFields.tyshxydm === 'string' ? rawFields.tyshxydm : null, rawFields })),
  } satisfies RosterImportPlatformQuery
}
function command(q: RosterImportPlatformQuery): NewCollectionTargetCommand {
  return { queryText: JSON.stringify(q), evidenceText: q.collectionEvidence == null ? null : JSON.stringify(q.collectionEvidence), createdAt: time,
    assignments: (q.relations ?? []).map(input => {
      const row = normalizePlatformRelation(q.interface, input)
      return { enterpriseId: null, nameRaw: typeof row.nameRaw === 'string' ? row.nameRaw.trim() || null : null, usccRaw: typeof row.usccRaw === 'string' ? row.usccRaw.trim() || null : null, matchBasis: 'none', verificationStatus: 'pending', origin: 'command', actor: { type: 'agent', id: '766' }, basis: '766 original' }
    }),
  }
}
function selected(q: RosterImportPlatformQuery) {
  return t.prepare('SELECT * FROM platform_collection WHERE query_key=? AND interface=? AND rdjb=? AND queried_at=?').get(q.queryKey, q.interface, q.rdjb ?? '', q.queriedAt) as { id: number; reconcile_slot_state: string; reconcile_slot_input_sha256: string; reconcile_slot_reason: string|null }
}
function protectedRows() {
  const tables = ['platform_collection','platform_business_observation','platform_observation_assignment','platform_legacy_query_alias','platform_legacy_relation_alias','platform_collection_archive_ref','platform_observation_archive_ref','platform_archive_value','platform_observation_fingerprint_basis','platform_apply_projection','platform_business_projection','platform_recognized_projection','platform_query_title_scope','platform_query_title_scope_error']
  return Object.fromEntries(tables.map(table => [table, t.prepare(`SELECT * FROM ${table} ORDER BY 1`).raw().all()]))
}
/** Independently reconstruct the specified ordered digest from the actual schema0 cells. */
function certifyAgainstOld(q: RosterImportPlatformQuery, expected: 'verified'|'miss') {
  const c = selected(q), oq = oldDb.select().from(schema.platformQuery).where(eq(schema.platformQuery.queriedAt, q.queriedAt)).all().find(r => r.interface === q.interface && r.rdjb === q.rdjb)!
  const rows = oldDb.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId, oq.id)).all().sort((a,b) => a.sequenceNo-b.sequenceNo)
  const qa = t.prepare('SELECT old_id id FROM platform_legacy_query_alias WHERE collection_id=?').get(c.id) as { id: number }
  const aliases = t.prepare('SELECT a.old_id id,o.id oid,o.sequence_no sequenceNo FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id WHERE collection_id=? ORDER BY o.sequence_no').all(c.id) as { id: number; oid: number; sequenceNo: number }[]
  const bytes = (table: string, field: string, id: number) => {
    const v = old.prepare(`SELECT typeof(${field}) storageClass,cast(${field} AS blob) bytes FROM ${table} WHERE id=?`).get(id) as { storageClass: string; bytes: Buffer|null }
    return { storageClass: v.storageClass, byteLength: v.bytes?.length ?? null, sha256: v.bytes === null ? null : hash(v.bytes) }
  }
  const expectedDigest = hash(JSON.stringify({ rule: 'legacy-reconcile-slot-v1', query: { id: qa.id, interface: oq.interface, rdjb: oq.rdjb, queryKey: oq.queryKey, queriedAt: oq.queriedAt }, rawResponse: bytes('platform_query','raw_response',oq.id),
    relations: rows.map((r, i) => ({ id: aliases[i]!.id, sequenceNo: r.sequenceNo, rawFields: bytes('platform_relation','raw_fields',r.id), fallbackCells: rowSnapshot(old,'platform_relation','id',r.id,fallbackColumns).map(({name,storageClass,hex}) => ({name,storageClass,hex})) })),
  }))
  expect(c.reconcile_slot_state).toBe(expected); expect(c.reconcile_slot_input_sha256).toBe(expectedDigest)
  for (const [i, row] of rows.entries()) {
    const a = aliases[i]!
    const actual = t.prepare("SELECT a.bytes FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND field='legacyRowSnapshot'").get(a.oid) as { bytes: Buffer }
    const cells = JSON.parse(actual.bytes.toString()).fields as { name: string; storageClass: string; hex: string }[]
    expect(fallbackColumns.map(name => cells.find(cell => cell.name === name))).toEqual(rowSnapshot(old,'platform_relation','id',row.id,fallbackColumns))
    const p = t.prepare(`SELECT * FROM ${q.interface === 'apply_list' ? 'platform_apply_projection' : 'platform_business_projection'} WHERE observation_id=?`).get(a.oid) as Record<string, unknown>
    for (const [key,value] of Object.entries(sourceFieldComparison(q.interface,row,row.rawFields,row.rawFields === null ? 'absent' : 'valid'))) expect(p[key.replace(/[A-Z]/g, c=>'_'+c.toLowerCase())],key).toEqual(value)
    const raw = t.prepare("SELECT a.bytes FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND field='rawFields'").get(a.oid) as { bytes: Buffer|null }
    expect(raw.bytes).toEqual(row.rawFields === null ? null : Buffer.from(JSON.stringify(row.rawFields)))
  }
  verifyReconcileSlot(t,c.id)
  writeFileSync(join(evidence!, `readback-${serial}.json`), JSON.stringify({ c, expectedDigest, aliases, rows }, null, 2))
}
it.each([['business_list','1'],['business_list','2'],['business_list','3'],['apply_list','']] as const)('captures actual %s slot %s materialization with typed originals and independent digest', async (source,rdjb) => {
  const typed = JSON.parse(`{"id":"TYPED766","qymc":" Capture ","tyshxydm":"${uscc}","n":1,"b":true,"x":null,"o":{"z":1,"a":false},"arr":[1,false],"__proto__":{"own":true},"constructor":"own","year":2024,"sblx":"申请","blank":""}`)
  const q = await collection(source,rdjb,[typed,{ qymc: 'No key', extra: [] }])
  committed(request([q]),oldDb); committed(request([q]))
  certifyAgainstOld(q,'verified')
  const raw = t.prepare('SELECT input_fingerprint f FROM platform_business_observation WHERE collection_id=? ORDER BY sequence_no').all(selected(q).id)
  expect(raw).toHaveLength(2)
  const before = protectedRows()
  committed(request([q],'full'))
  committed(request([{interface:q.interface,rdjb:q.rdjb,queryKey:q.queryKey,queriedAt:q.queriedAt,rawResponse:null,relations:q.relations}],'sentinel'))
  committed(request([{interface:q.interface,rdjb:q.rdjb,queryKey:q.queryKey,queriedAt:q.queriedAt,reuseExisting:true,relations:[{sequenceNo:2}]}],'reference'))
  expect(protectedRows()).toEqual(before)
})
it.each(['null','empty'] as const)('captures %s raw fallback after trim NULL and integer materialization', async variant => {
  const fallback = { id: 'FALLBACK', qymc: 'Capture', tyshxydm: uscc, szsfmc: 'P', cszt: 'done', whpc: 'B', sblx: 'apply', sqsj: 'D', personuuid: 'A', year: '2024' }
  const q: RosterImportPlatformQuery = await collection('business_list','2',[fallback])
  q.relations = [{sequenceNo:1,relationKey:' FALLBACK ',nameRaw:' Capture ',usccRaw:` ${uscc} `,province:' P ',status:' done ',batch:' B ',declareKind:'apply',appliedAt:' D ',awardBatchLabel:' A ',year:2024.9,aliasNameRaw:' ',rawFields:variant==='null'?null:{}}]
  committed(request([q]),oldDb); committed(request([q]))
  certifyAgainstOld(q,'verified')
  const projection=t.prepare('SELECT p.* FROM platform_business_projection p JOIN platform_business_observation o ON o.id=p.observation_id WHERE o.collection_id=?').get(selected(q).id) as Record<string,unknown>
  for(const [field,value] of Object.entries({province:'P',status:'done',batch:'B',declare_kind:'apply',applied_at:'D',award_batch_label:'A',year:2024})){
    expect(projection[`stored_${field}_kind`]).toBe(field==='year'?'number':'text')
    expect(projection[`stored_${field}`]).toBe(value)
    expect(projection[`parsed_${field}_kind`]).toBe('absent')
    expect(projection[`parsed_${field}`]).toBeNull()
    expect(projection[`reconciled_${field}`]).toBe(value)
    expect(projection[`${field}_conflict`]).toBe(0)
  }
  expect(slotPayloadRow(oldDb.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId,(old.prepare('SELECT max(id) id FROM platform_query').get() as {id:number}).id)).get()!)).toEqual(fallback)
  const before=protectedRows(); committed(request([q],'again'));expect(protectedRows()).toEqual(before)
})
it('binds independent public aliases instead of physical collection and observation IDs', async () => {
  reserveLegacyIds(drizzle(t,{schema:s}),{query:8000,relation:9000})
  const q=await collection()
  committed(request([q]),oldDb);const result=committed(request([q]))
  expect(result.items[0]!.ref).toBe('query:8001')
  const c=selected(q)
  expect(c.id).not.toBe(8001)
  const a=t.prepare('SELECT a.old_id alias,o.id physical FROM platform_legacy_relation_alias a JOIN platform_business_observation o ON o.id=a.observation_id WHERE o.collection_id=?').get(c.id) as {alias:number;physical:number}
  expect(a.alias).toBe(9001);expect(a.physical).not.toBe(9001)
  certifyAgainstOld(q,'verified')
  const before=protectedRows()
  committed(request([q],'alias-full'))
  committed(request([{interface:q.interface,queryKey:q.queryKey,rdjb:q.rdjb,queriedAt:q.queriedAt,reuseExisting:true,relations:[{sequenceNo:1}]}],'alias-reference'))
  expect(protectedRows()).toEqual(before)
})
it.each(['empty','success-empty','no-record-rows','bare','failed','partial','missing-page-raw','row-order','key-order'] as const)('persists %s capture result and never upgrades it on replay', async partition => {
  const q: RosterImportPlatformQuery = await collection('business_list','2',['empty','success-empty'].includes(partition)?[]:[{id:'A',a:1,b:2},{id:'B'}])
  if(partition==='success-empty')q.status='success'
  if(partition==='no-record-rows')q.status='no_record'
  if(partition==='bare')q.rawResponse='{}'
  if(partition==='failed')q.status='failed'
  if(partition==='partial')q.status='partial'
  if(['missing-page-raw','row-order','key-order'].includes(partition)){
    const envelope:LegacySlotCollection=JSON.parse(q.rawResponse!)
    if(partition==='missing-page-raw')envelope.pages[0]!.raw=''
    if(partition==='row-order')q.relations!.reverse().forEach((r,i)=>r.sequenceNo=i+1)
    if(partition==='key-order')q.relations![0]!.rawFields={b:2,a:1,id:'A'}
    q.rawResponse=JSON.stringify(envelope)
  }
  committed(request([q]),oldDb);committed(request([q]))
  certifyAgainstOld(q,partition==='empty'?'verified':'miss')
  const before=protectedRows();committed(request([q],'replay'));expect(protectedRows()).toEqual(before)
  if(partition!=='empty'){
    const changed={...q,status:'success' as const,rawResponse:(await collection()).rawResponse}
    expect(commit(request([changed],'upgrade')).status).toBe('failed')
    expect(protectedRows()).toEqual(before)
  }
})
it('preserves same version observations and their own materialized source comparisons', async () => {
  const q=await collection('business_list','2',[{id:'SAME',qymc:'Capture',year:2024,cszt:'done'},{id:'SAME',qymc:'Capture',year:2024,cszt:'done'}])
  const input: RosterImportPlatformQuery={...q,relations:q.relations.map((r,i)=>({...r,year:i===0?2024:undefined,status:i===0?' done ':undefined,province:i===0?' P ':undefined}))}
  committed(request([input]),oldDb);committed(request([input]));certifyAgainstOld(input,'verified')
  const observations=t.prepare('SELECT version_id FROM platform_business_observation WHERE collection_id=? ORDER BY sequence_no').all(selected(input).id)
  expect(observations).toHaveLength(2);expect(observations[0]).toEqual(observations[1])
})
it('retains ordinary payload metadata row order and source conflict refusals', async () => {
  const q=await collection('business_list','2',[{id:'A',qymc:'Capture'},{id:'B'}]);committed(request([q]))
  const before=protectedRows()
  for(const [key,bad] of Object.entries({
    raw:{...q,rawResponse:'changed'},metadata:{...q,failureReason:'changed'},subset:{...q,relations:[q.relations[0]!]},
    order:{...q,relations:[{...q.relations[1]!,sequenceNo:1},{...q.relations[0]!,sequenceNo:2}]},
    fields:{...q,relations:[{...q.relations[0]!,province:'changed'},q.relations[1]!]},
  })){
    expect(commit(request([bad],key)).status,key).toBe('failed');expect(protectedRows(),key).toEqual(before)
  }
  const saved=committed(request([q],'same-key'));expect(commit(request([q],'same-key'))).toEqual(saved)
})
it('retains original conflict priority before authenticating an existing corrupt capture', async () => {
  const q=await collection('business_list','2',[]);committed(request([q]))
  const c=selected(q),barrier=t.prepare("SELECT sql FROM sqlite_schema WHERE name='reconcile_slot_immutable'").get() as {sql:string}
  t.exec('DROP TRIGGER reconcile_slot_immutable');t.prepare('UPDATE platform_collection SET reconcile_slot_input_sha256=? WHERE id=?').run('0'.repeat(64),c.id);t.exec(barrier.sql)
  const before=protectedRows()
  expect(()=>writeCollectionTarget(drizzle(t,{schema:s}),command({...q,failureReason:'different original'}))).toThrow('query_payload_conflict')
  expect(()=>writeCollectionTarget(drizzle(t,{schema:s}),command(q))).toThrow('original capture drift')
  expect(protectedRows()).toEqual(before)
})
it('keeps missing raw new commands as rejected legacy references without inventing a null archive', async () => {
  const q: RosterImportPlatformQuery={...await collection(),rawResponse:null},before=protectedRows()
  expect(()=>writeNewCollectionTarget(drizzle(t,{schema:s}),command(q))).toThrow('Legacy reference sentinel')
  expect(protectedRows()).toEqual(before)
})
it.each(['capture','observation','receipt'] as const)('rolls back %s fault including caller-caught savepoint and retries same request', async fault => {
  const q=await collection(),before=protectedRows()
  const trigger=fault==='capture'?'BEFORE UPDATE OF reconcile_slot_state ON platform_collection':fault==='observation'?'BEFORE INSERT ON platform_business_observation':"BEFORE UPDATE ON import_receipt WHEN NEW.operation='commit' AND NEW.status='committed'"
  t.exec(`CREATE TRIGGER fault766 ${trigger} BEGIN SELECT RAISE(ABORT,'766 injected ${fault}'); END`)
  if(fault==='receipt'){
    t.transaction(()=>{ expect(()=>commit(request([q]))).toThrow('766 injected receipt') })()
  } else {
    t.transaction(()=>{
      expect(()=>writeNewCollectionTarget(drizzle(t,{schema:s}),command(q))).toThrow(`766 injected ${fault}`)
    })()
  }
  expect(protectedRows()).toEqual(before)
  expect(t.prepare("SELECT count(*) n FROM import_receipt WHERE status='committed' AND batch_id IN (SELECT id FROM import_batch WHERE source_identity='write766')").get()).toEqual({n:0})
  t.exec('DROP TRIGGER fault766')
  committed(request([q]));expect(selected(q).reconcile_slot_state).toBe('verified')
})
it.each(['apply_list','business_list'] as const)('allows independent %s writer without granting collection capture admission', async source => {
  const q=await collection(source)
  // A caller catches capture failure; the complete command leaves no partial collection.
  // Independently seeded collection uses the same actual collection writer, with an empty
  // row set and a miss. A separate uncaptured owner is needed for incremental sources.
  const id=drizzle(t).insert(s.platformCollection).values({interface:source,queryKey:'partial766',rdjb:q.rdjb,queriedAt:time,createdAt:time,status:'success',completeness:'unknown',provenanceState:'unknown',parseState:'absent',ruleVersion:'w4a-new-collection-v1'}).returning().get().id
  const {allocateLegacyAlias,insertArchiveValue,bindArchive,sealArchiveOwner}=await import('../lib/platform/target-archive')
  const td=drizzle(t,{schema:s});allocateLegacyAlias(td,{kind:'query',collectionId:id})
  for(const [field,value] of [['request',JSON.stringify({...q,queryKey:'partial766'})],['rawResponse',q.rawResponse],['collectionEvidence',null]] as const){
    const archiveId=insertArchiveValue(td,value==null?{storageClass:'null',bytes:null,createdAt:time}:{storageClass:'text',bytes:Buffer.from(value),createdAt:time})
    bindArchive(td,{kind:'collection',ownerId:id,field,archiveId})
  }
  sealArchiveOwner(td,{kind:'collection',ownerId:id})
  const input=command(q),writer=source==='apply_list'?writeApplyTarget:writeProcessTarget
  writer(td,{collectionId:id,row:q.relations[0]!,position:{sequenceNo:1,positionState:'unknown'},assignment:input.assignments[0]!})
  expect(t.prepare('SELECT reconcile_slot_state state FROM platform_collection WHERE id=?').get(id)).toEqual({state:'uncaptured'})
  expect(()=>verifyReconcileSlot(t,id)).toThrow('original capture unavailable')
})
it.each(['apply_list','business_list'] as const)('refuses independent %s appends to both verified and miss captures', async source => {
  for(const state of ['verified','miss'] as const){
    const q: RosterImportPlatformQuery={...await collection(source),queryKey:state==='verified'?uscc:'miss766'}
    if(state==='miss')q.rawResponse='bare'
    const input=command(q),result=writeNewCollectionTarget(drizzle(t,{schema:s}),input)
    expect(selected(q).reconcile_slot_state).toBe(state)
    const before=protectedRows(),writer=source==='apply_list'?writeApplyTarget:writeProcessTarget
    expect(()=>writer(drizzle(t,{schema:s}),{collectionId:result.collectionId,row:{...q.relations![0]!,sequenceNo:2},position:{sequenceNo:2,positionState:'unknown'},assignment:input.assignments[0]!})).toThrow('Immutable reconcile captured row set')
    expect(protectedRows()).toEqual(before)
  }
})
it('keeps recognized collection outside legacy slots', () => {
  const q=platformResultToImport({source:'queryBusList',status:'no_record',effectiveConditions:{uscc,combination:'and'},titleScope:{mode:'selected',rdjb:['2']},queriedAt:time,completedAt:time,rows:[],pages:[{source:'queryBusList',rdjb:'2',page:1,maxPage:1,fetchedCount:0,declaredTotal:0,status:'success',error:null}],fetchedCount:0,declaredTotal:0,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:10,maxRows:100,maxDurationMs:1000,pageSize:50}})
  committed(request([q]));expect(selected(q)).toMatchObject({reconcile_slot_state:'uncaptured',reconcile_slot_reason:'not_legacy_slot'})
  const before=protectedRows();committed(request([q],'recognized-replay'));expect(protectedRows()).toEqual(before)
})
it('keeps same-content fresh recency separate from original capture and coordinate replay', () => {
  const original={source:'businessList' as const,status:'success' as const,effectiveConditions:{uscc,combination:'and' as const},titleScope:{mode:'selected' as const,rdjb:['2']},queriedAt:time,completedAt:time,
    rows:[{id:'RECENCY766',rdjb:'2',qymc:'Capture',tyshxydm:uscc,cszt:'done'}],
    pages:[{source:'businessList' as const,rdjb:'2',page:1,maxPage:1,fetchedCount:1,declaredTotal:1,status:'success' as const,error:null}],
    fetchedCount:1,declaredTotal:1,completeness:'complete' as const,fullRange:true,unfinished:[],error:null,limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}}
  const typedOriginal={...original,dataRows:original.rows}
  const q=platformResultToImport(typedOriginal);committed(request([q]))
  const c=selected(q),digest=c.reconcile_slot_input_sha256
  expect(c.reconcile_slot_state).toBe('miss')
  const next={...typedOriginal,queriedAt:'2026-11-13T05:00:00.000Z',completedAt:'2026-11-13T05:00:00.000Z'}
  expect(reuseCollectedPlatformResult(db,next,1)).toBe(true)
  expect(t.prepare('SELECT queried_at,last_collected_at,reconcile_slot_input_sha256 digest,reconcile_slot_state state FROM platform_collection WHERE id=?').get(c.id)).toEqual({queried_at:time,last_collected_at:next.queriedAt,digest,state:'miss'})
  const before=protectedRows();committed(request([q],'coordinate-after-fresh'));expect(protectedRows()).toEqual(before)
})
it.each(['completion','column','barrier'] as const)('fails closed for corrupt variant %s without repairing it', async fault => {
  if(fault==='completion')t.prepare("UPDATE platform_migration_run SET state='running' WHERE run_id='capture'").run()
  if(fault==='column')t.exec('ALTER TABLE platform_collection RENAME COLUMN reconcile_slot_input_sha256 TO corrupt_digest')
  if(fault==='barrier')t.exec('DROP TRIGGER reconcile_slot_immutable')
  const q=await collection()
  const before=t.serialize()
  expect(()=>writeNewCollectionTarget(drizzle(t,{schema:s}),command(q))).toThrow('NOTREADY')
  expect(t.serialize()).toEqual(before)
})
it('authenticates migrated BLOB empty BLOB errors and fallback inputs without rewriting captures', () => {
  const source=new Database(join(inputs!,'schema0.sqlite'),{readonly:true})
  try{
    const all=t.prepare('SELECT id,reconcile_slot_state state FROM platform_collection ORDER BY id').all() as {id:number;state:string}[]
    const before=protectedRows()
    for(const c of all){
      expect(()=>verifyReconcileSlot(t,c.id)).not.toThrow()
      const expected=captureSourceSlot(source,t,c.id)
      expect(c.state).toBe(expected.state)
    }
    expect(protectedRows()).toEqual(before)
    const blobs=old.prepare("SELECT count(*) n FROM platform_relation WHERE typeof(status)='blob'").get() as {n:number}
    expect(blobs.n).toBeGreaterThanOrEqual(2)
  }finally{source.close()}
})
it('replays historical native BLOB conflicts through real complete and reference commands within the existing contract', () => {
  const queries=old.prepare("SELECT DISTINCT q.* FROM platform_query q JOIN platform_relation r ON r.query_id=q.id WHERE typeof(r.status)='blob' ORDER BY q.id").all() as {id:number;interface:'business_list';rdjb:string;query_key:string;queried_at:string}[]
  expect(queries).toHaveLength(2)
  const before=protectedRows()
  for(const q of queries){
    const rows=oldDb.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId,q.id)).all()
    const facts=t.prepare('SELECT p.stored_status_kind,p.stored_status,p.parsed_status,p.reconciled_status,p.status_conflict FROM platform_business_projection p JOIN platform_business_observation o ON o.id=p.observation_id JOIN platform_legacy_query_alias a ON a.collection_id=o.collection_id WHERE a.old_id=?').get(q.id)
    expect(facts).toEqual({stored_status_kind:'blob',stored_status:q.query_key.includes('empty')?Buffer.alloc(0):Buffer.from([0,255]),parsed_status:'done',reconciled_status:null,status_conflict:1})
    const ref={interface:q.interface,queryKey:q.query_key,rdjb:q.rdjb,queriedAt:q.queried_at,reuseExisting:true as const,relations:rows.map(r=>({sequenceNo:r.sequenceNo}))}
    writeCollectionTarget(drizzle(t,{schema:s}),command(ref))
    // Full command asserts lawful raw fields, never adds an illegal BLOB DTO.
    const full={interface:q.interface,queryKey:q.query_key,rdjb:q.rdjb,queriedAt:q.queried_at,rawResponse:(old.prepare('SELECT raw_response raw FROM platform_query WHERE id=?').get(q.id) as {raw:string}).raw,
      relations:rows.map(r=>({sequenceNo:r.sequenceNo,relationKey:r.relationKey,rawFields:r.rawFields}))}
    writeCollectionTarget(drizzle(t,{schema:s}),command(full))
  }
  expect(protectedRows()).toEqual(before)
})
it('retains old command rejection for native BLOB outside the legal input contract', async () => {
  const q: RosterImportPlatformQuery=await collection()
  const text=JSON.stringify(q),value=JSON.parse(text);value.relations[0].status=Buffer.from([0,255])
  const before=protectedRows()
  expect(()=>writeNewCollectionTarget(drizzle(t,{schema:s}),{...command(q),queryText:JSON.stringify(value)})).toThrow()
  expect(protectedRows()).toEqual(before)
})
it('runs the real schema0 service with four new complete slots and no fetch', async () => {
  const queries=await Promise.all([collection('business_list','1'),collection('business_list','2'),collection('business_list','3'),collection('apply_list','')])
  committed(request(queries),oldDb);committed(request(queries))
  for(const q of queries)certifyAgainstOld(q,'verified')
  const fetch=vi.fn(async()=>{throw new Error('No fetch allowed')})
  const report=await runPlatformReconcile({db:oldDb,titles:['specialized_sme'],usccs:[uscc],now:()=>new Date(time),cookie:null,fetchImpl:fetch,write:false})
  expect(report.targetCount).toBeGreaterThan(0);expect(fetch).not.toHaveBeenCalled()
  expect(report.queries).toMatchObject({network:0,reused:4})
  writeFileSync(join(evidence!,`schema0-service-${serial}.json`),JSON.stringify(report,null,2))
})
it('replays historical completion after real new writers assignments supplement decision and receipts without losing any row', async () => {
  const q=await collection('business_list','2',[{id:'LATER766',rdjb:'2',qymc:'Capture',tyshxydm:uscc,cszt:'done',year:'2024'}])
  const first=committed(request([q]))
  const followup=await collection('apply_list','',[{id:'LATER766',qymc:'Unknown pending',cszt:'waiting'}])
  committed(request([followup],'later-source'))
  const c=selected(q)
  const aliases=t.prepare('SELECT a.old_id rid,q.old_id qid,o.id oid FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id JOIN platform_legacy_query_alias q ON q.collection_id=o.collection_id WHERE o.collection_id=?').get(c.id) as {rid:number;qid:number;oid:number}
  expect(t.prepare('SELECT enterprise_id,verification_status FROM platform_observation_assignment WHERE observation_id=? AND revision=1').get(aliases.oid)).toEqual({enterprise_id:1,verification_status:'confirmed'})
  const pending=t.prepare('SELECT a.enterprise_id,a.verification_status FROM platform_observation_assignment a JOIN platform_business_observation o ON o.id=a.observation_id WHERE o.collection_id=?').get(selected(followup).id)
  expect(pending).toEqual({enterprise_id:null,verification_status:'pending'})
  // The two revision1 assignments above are actual writer outputs. This separate
  // legal revision exercises later ownership drift; it does not stand in for a writer.
  const original=drizzle(t).select().from(s.platformObservationAssignment).where(eq(s.platformObservationAssignment.observationId,aliases.oid)).get()!
  drizzle(t).insert(s.platformObservationAssignment).values({...original,revision:2,enterpriseId:null,verificationStatus:'pending',basis:'controlled subsequent assignment isolation'}).run()
  const rows=[{id:'LATER766',rdjb:'2',qymc:'Capture',tyshxydm:uscc,cszt:'done',year:'2024'}]
  const supplement={queryId:aliases.qid,interface:'business_list' as const,queryKey:uscc,rdjb:'2',queriedAt:time,sourceIdentity:'source766',sourceSha256:hash('766 supplement'),segmentIndex:0,
    collection:{source:'businessList' as const,status:'success' as const,effectiveConditions:{uscc,combination:'and' as const},titleScope:{mode:'selected' as const,rdjb:['2']},queriedAt:time,completedAt:time,rows,
      pages:[{source:'businessList' as const,rdjb:'2',page:1,maxPage:1,fetchedCount:1,declaredTotal:1,status:'success' as const,error:null}],
      fetchedCount:1,declaredTotal:1,completeness:'complete' as const,fullRange:true,unfinished:[],error:null,limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}},
    relations:[{sequenceNo:1,relationKey:'LATER766',rawFields:rows[0]!}]}
  const input=originalLegacyProvenanceInput(db,aliases.qid)
  const supplementRequest: RosterImportRequest={...request([],'supplement'),payload:{platformLegacyProvenance:[supplement]}}
  const preview=preflightRosterImport(db,supplementRequest)
  expect(preview.preflight.conflicts).toEqual([])
  expect(preview.preflight.platformLegacyProvenanceSources?.[0]?.inputFingerprint).toBe(hash(JSON.stringify({query:input.query,rows:input.rows})))
  expect(commit(supplementRequest).status).toBe('committed')
  const decision: RosterImportRequest={...request([],'decision'),sourceKind:'alias_evidence',payload:{differences:[{enterpriseName:'Capture',uscc,titleCode:'specialized_sme',direction:'missing_in_miit',status:'needs_review',reasonNote:'766 nonempty original decision',recordedAt:time,evidenceQueryId:aliases.qid,evidenceRelationId:aliases.rid}]}}
  committed(decision)
  expect(t.prepare('SELECT count(*) n FROM difference_reason WHERE reason_note=?').get('766 nonempty original decision')).toEqual({n:1})
  expect(t.prepare("SELECT count(*) n FROM platform_collection_legacy_provenance WHERE origin='supplement' AND collection_id=?").get(c.id)).toEqual({n:1})
  expect(t.prepare("SELECT count(*) n FROM import_receipt WHERE operation='commit' AND status='committed' AND batch_id>=?").get(first.batchId) as {n:number}).toMatchObject({n:4})
  verifyReconcileSlot(t,c.id)
  const tables=(t.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(r=>r.name)
  const snapshot=()=>{
    const audit=new Database(path,{readonly:true})
    try { return Object.fromEntries(tables.map(name=>[name,audit.prepare(`SELECT * FROM "${name}" ORDER BY 1`).raw().all()])) }
    finally { audit.close() }
  }
  const before=snapshot()
  const result=completeReconcileSlotCapture({source:join(inputs!,'schema0.sqlite'),target:path,runId:'capture',collectionRunId:'c'})
  expect(result).toMatchObject({state:'complete',copied_count:46})
  expect(snapshot()).toEqual(before)
  committed(request([{interface:q.interface,queryKey:q.queryKey,rdjb:q.rdjb,queriedAt:q.queriedAt,reuseExisting:true,relations:[{sequenceNo:1}]}],'after-completion'))
  expect(protectedRows()).toEqual(Object.fromEntries(Object.keys(protectedRows()).map(name=>[name,before[name]])))
  // Drift is a destructive probe only in this owned disposable DB, after the
  // lifecycle proof. It must fail both selected replay and historical completion.
  const barrier=t.prepare("SELECT sql FROM sqlite_schema WHERE name='reconcile_slot_immutable'").get() as {sql:string}
  t.exec('DROP TRIGGER reconcile_slot_immutable')
  t.prepare("UPDATE platform_collection SET reconcile_slot_input_sha256=? WHERE id=1").run('0'.repeat(64))
  t.exec(barrier.sql)
  expect(()=>verifyReconcileSlot(t,1)).toThrow('original capture drift')
  expect(()=>completeReconcileSlotCapture({source:join(inputs!,'schema0.sqlite'),target:path,runId:'capture',collectionRunId:'c'})).toThrow('Historical reconcile capture drift')
  writeFileSync(join(evidence!,`completion-${serial}.json`),JSON.stringify({result,queries:[selected(q),selected(followup)],supplement,first},null,2))
})
it('preserves nonvariant 71613 new full and reference replay and keeps ordinary guards closed', async () => {
  const shared='/Users/mang/.t3/acceptance/platform-complete-migration/shared-readonly-fixtures/71613'
  const manifest=JSON.parse(readFileSync(join(shared,'MANIFEST.json'),'utf8')) as {fixtures:{path:string;sha256:string}[]}
  const fixture=manifest.fixtures.find(f=>f.path.includes('/absent-'))!
  expect(hash(readFileSync(fixture.path))).toBe('894dd54385a7ebdfb6346477e1dfd6f8d71e45ab893ff065c0d1ffb43f1996a7')
  t.close();path=copy(fixture.path,`nonvariant-${serial}`)
  t=new Database(path,{verbose:q=>trace.push(String(q))});t.pragma('foreign_keys=ON');db=drizzle(t,{schema})
  expect(reconcileSlotWriteInstalled(t)).toBe(false)
  const q=await collection()
  committed(request([q]));const before=protectedRows()
  committed(request([q],'full-old'))
  committed(request([{interface:q.interface,queryKey:q.queryKey,rdjb:q.rdjb,queriedAt:q.queriedAt,reuseExisting:true,relations:[{sequenceNo:1}]}],'reference-old'))
  expect(protectedRows()).toEqual(before)
  expect(()=>assertExpandRuntime(t)).toThrow()
  expect(t.prepare("SELECT name FROM pragma_table_info('platform_collection') WHERE name LIKE 'reconcile_slot_%'").all()).toEqual([])
})
