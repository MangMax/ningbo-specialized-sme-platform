import { createRuntimeSchema } from '../../../db/create-runtime'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler } from 'h3'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import * as schema from '../../../db/schema'
import type { OfficialPublishedRow, RosterImportPayload, RosterImportRequest, RosterImportRecord } from '../../../layers/sme-roster/lib/roster-import-client'
import { minimalPdf } from '../../support/minimal-pdf'
import { commitRosterImport, preflightRosterImport, readImportBatchOutcome } from '../../../layers/sme-roster/server/utils/roster-import'

const current = vi.hoisted((): { db?: BetterSQLite3Database<typeof schema>; filesDir: string } => ({ filesDir: '' }))
vi.mock('@db', () => ({ useDb: () => { if (!current.db) throw new Error('Synthetic database unavailable'); return current.db } }))
type Execute = typeof import('../../../layers/sme-roster/server/utils/import-execution')['importExecutor']['execute']
// Only off-process admission is replaced; production H3 routes, commands and SQLite run unchanged.
vi.mock('../../../layers/sme-roster/server/utils/import-execution', () => ({ importExecutor: { execute: async (...[db, action, request, errors, context, source]: Parameters<Execute>) => action === 'preflight' ? preflightRosterImport(db, request, errors, { ...context, ...source }) : commitRosterImport(db, request, errors, { ...context, ...source }) } }))
const closes: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
afterAll(() => vi.unstubAllGlobals())
const router = createRouter()
let itemsMetadata: unknown
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-c-api', mcpToken: 'synthetic-c-mcp', filesDir: current.filesDir }))
  router.post('/api/roster/import/preflight', (await import('../../../server/api/roster/import/preflight.post')).default)
  router.post('/api/roster/import/commit', (await import('../../../server/api/roster/import/commit.post')).default)
  router.post('/api/roster/evidence/corrections/preflight', (await import('../../../server/api/roster/evidence/corrections/preflight.post')).default)
  router.post('/api/roster/evidence/corrections/commit', (await import('../../../server/api/roster/evidence/corrections/commit.post')).default)
  router.get('/api/roster/evidence/:id', (await import('../../../server/api/roster/evidence/[id].get')).default)
  router.get('/api/roster/events/:id', (await import('../../../server/api/roster/events/[id].get')).default)
  vi.stubGlobal('defineRouteMeta', (meta: unknown) => { itemsMetadata = meta; return meta })
  router.get('/api/roster/import/receipts/items', (await import('../../../server/api/roster/import/receipts/items.get')).default)
})
const resultSchema = z.object({ status: z.string().optional(), batchId: z.number().optional(), items: z.array(z.object({ kind: z.string(), detail: z.unknown() }).passthrough()).optional(), preflight: z.object({ conflicts: z.array(z.unknown()), officialEvidencePlanHash: z.string().optional() }).optional() }).passthrough()
const exactSchema = z.object({ evidenceId: z.number(), eventId: z.number(), recordId: z.number(), enterpriseId: z.number(), version: z.string(), event: z.object({ revision: z.number() }) })
const factRow = z.object({ evidenceId: z.number(), revision: z.number(), capturedRecordId: z.number(), capturedEnterpriseId: z.number(), nameRaw: z.string().nullable(), usccRaw: z.string().nullable(), districtRaw: z.string().nullable(), sourceDocumentId: z.number().nullable(), currentOwner: z.object({ recordId: z.number(), enterpriseId: z.number() }).nullable() }).passthrough()
const latestSchema = z.object({ official: z.object({ availability: z.string(), row: factRow.nullable() }).passthrough() })
const historySchema = z.object({ official: z.object({ rows: z.array(factRow), nextBeforeRevision: z.number().nullable() }) })
const eventSchema = z.object({ official: z.object({ rows: z.array(factRow), nextAfterEvidenceId: z.number().nullable(), uncaptured: z.literal('unknown_legacy') }) })
const snapshotSchema = z.object({ formatVersion: z.literal(1), source: z.enum(['private_batch','redacted_receipt']), batchId: z.number(), receiptId: z.number().nullable(), itemIndex: z.number(), oldRecordId: z.number(), storedRedacted: z.boolean(), responseRedacted: z.literal(true), availability: z.string(), snapshot: z.object({ id: z.number(), enterpriseId: z.number(), titleCode: z.string(), source: z.string(), nameRaw: z.string().nullable(), usccRaw: z.string().nullable(), district: z.string().nullable(), qualityFlags: z.array(z.string()).nullable() }).optional(), nextCursor: z.string().nullable().optional(), eventIds: z.array(z.number()).optional() })
const bytes = 'synthetic official source\n', digest = createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const dir = mkdtempSync('/tmp/issue351-h3-'), filesDir = join(dir, 'files'); mkdirSync(filesDir)
  writeFileSync(join(filesDir, 'notice.txt'), bytes); writeFileSync(join(filesDir, 'other.txt'), 'different content\n')
  const sqlite = new Database(join(dir, 'synthetic.sqlite')); sqlite.pragma('foreign_keys=ON')
  closes.push(() => { expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1); sqlite.close() })
  const db = drizzle(sqlite, { schema }); createRuntimeSchema(sqlite)
  // Only infrastructure catalog uses SQL. Domain state is established through public commands below.
  for (const [id, path, body] of [[1,'notice.txt',bytes],[2,'other.txt','different content\n']] as const) {
    sqlite.prepare("INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(?,?,?,'txt',?,?,'synthetic')").run(id,path,path,Buffer.byteLength(body),createHash('sha256').update(body).digest('hex'))
    sqlite.prepare("INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (?, 'jxj', 'announcement', 'specialized_sme')").run(id)
  }
  current.db = db; current.filesDir = filesDir
  const server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0,'127.0.0.1',resolve) })
  closes.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned TCP listener absent')
  const trace: unknown[] = []; closes.push(() => writeFileSync(join(dir,'public-commands.json'),JSON.stringify(trace,null,2)))
  const http = async (path: string, body?: unknown, token: string | null = 'synthetic-c-api') => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`,{ method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? {authorization:'Bearer '+token} : {}), 'content-type':'application/json' }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) })
    const output: unknown = await response.json(); trace.push({path,body,status:response.status,output})
    return {status:response.status,body:output}
  }
  const request = (payload: RosterImportPayload,key: string): RosterImportRequest => ({idempotencyKey:key,sourceKind:'announcement',sourceIdentity:'synthetic-c',payload})
  const commit = async (payload: RosterImportPayload,key: string) => {
    const input=request(payload,key),plan=await http('/api/roster/import/preflight',input); expect(plan.status).toBe(200)
    const parsed=resultSchema.parse(plan.body); expect(parsed.preflight?.conflicts).toEqual([])
    const bound=parsed.preflight?.officialEvidencePlanHash ? {...input,payload:{...payload,officialEvidencePlanHash:parsed.preflight.officialEvidencePlanHash}} : input
    const result=await http('/api/roster/import/commit',bound); expect(result.status).toBe(200)
    const committed=resultSchema.parse(result.body); expect(committed.status,JSON.stringify(committed)).toBe('committed')
    return {result:committed,bound}
  }
  const row = (nameRaw: string | null,listNo=1): OfficialPublishedRow => ({nameRaw,usccRaw:'原统代',districtRaw:'原属地',declaration:{kind:'independent',sourceDocument:{source:'jxj',title:'Declared publication',docNumber:null,issueDate:null,path:'notice.txt'},basis:'Independent publication verified'},storedFileId:1,path:'notice.txt',sha256:digest,bytes:Buffer.byteLength(bytes),attachment:null,sectionKey:'名单',listNo,page:null,sourceBindingKnown:true,actor:{type:'agent',id:'synthetic-c'},basis:'Exact published row'})
  const record = (name:string,year:number,publishedRow?:OfficialPublishedRow,uscc?:string): RosterImportRecord => ({enterprise:{name,...(uscc?{uscc}:{})},titleCode:'specialized_sme',events:[{eventType:'award',year,evidence:[{sourceFile:'notice.txt',attachment:null,listNo:publishedRow?.listNo??year,page:null,...(publishedRow?{publishedRow}:{})}]}]})
  const announcement = (records:RosterImportRecord[]):RosterImportPayload => ({announcement:{sourceDocument:{source:'jxj',title:'Declared publication'},records}})
  const evidenceIds = () => z.array(z.object({id:z.number(),record_event_id:z.number(),list_no:z.number()})).parse(sqlite.prepare('SELECT id,record_event_id,list_no FROM record_evidence ORDER BY id').all())
  const exact = async(id:number) => {const r=await http('/api/roster/evidence/'+id);expect(r.status).toBe(200);return exactSchema.parse(r.body)}
  const correct = async(id:number,publishedRow:OfficialPublishedRow|undefined,key:string) => {
    const target=await exact(id)
    const stored=z.object({n:z.number()}).parse(sqlite.prepare('SELECT coalesce(max(revision),0) n FROM official_evidence_row_revision WHERE evidence_id=?').get(id))
    const command={idempotencyKey:key,actor:{type:'agent',id:'synthetic-c'},basis:'Verified correction',operations:[{evidenceId:id,eventId:target.eventId,recordId:target.recordId,enterpriseId:target.enterpriseId,expectedVersion:target.version,coordinate:{sourceFile:publishedRow?.path??'other.txt',attachment:null,listNo:publishedRow?.listNo??1,page:null},...(publishedRow?{publishedRow,expectedRowRevision:stored.n}:{})}]}
    const pre=await http('/api/roster/evidence/corrections/preflight',command);expect(pre.status,JSON.stringify(pre.body)).toBe(200)
    const hash=z.object({planHash:z.string()}).parse(pre.body).planHash
    const done=await http('/api/roster/evidence/corrections/commit',{request:command,planHash:hash});expect(done.status).toBe(200)
    return done
  }
  const seedMerge = async () => {
    await commit(announcement([record('2021旧名',2021,row('2021旧名'),undefined)]),'old')
    await commit(announcement([record('2024现名',2024,row('2024新名',2),'91330211255994457P')]),'new')
    const old=evidenceIds()[0]!,origin=await exact(old.id)
    const merge=await commit({merges:[{fromEnterpriseId:origin.enterpriseId,intoUscc:'91330211255994457P',note:'Verified historical legal merge'}]},'merge')
    const index=merge.result.items!.findIndex(i=>i.kind==='merge')
    const batchId=merge.result.batchId!
    const receipt=z.object({id:z.number()}).parse(sqlite.prepare('SELECT id FROM import_receipt WHERE batch_id=? ORDER BY id DESC LIMIT 1').get(batchId))
    return {old,origin,merge,index,batchId,receiptId:receipt.id,selector:`source=private_batch&batchId=${batchId}&itemIndex=${index}&oldRecordId=${origin.recordId}`}
  }
  return {dir,db,sqlite,http,commit,row,record,announcement,evidenceIds,exact,correct,seedMerge}
}

it('reads 2021 old and 2024 new published names independently through exact public evidence and event',async()=>{
  const f=await fixture();await f.commit(f.announcement([f.record('现用名',2021,f.row(' 2021旧名\u0000🙂 ')),f.record('现用名',2024,f.row('2024新名',2))]),'years')
  const ids=f.evidenceIds();const old=await f.http(`/api/roster/evidence/${ids[0]!.id}?official=latest`),newer=await f.http(`/api/roster/evidence/${ids[1]!.id}?official=latest`)
  expect(old.status).toBe(200);expect(newer.status).toBe(200)
  expect(latestSchema.parse(old.body).official.row).toMatchObject({nameRaw:' 2021旧名\u0000🙂 ',usccRaw:'原统代',districtRaw:'原属地',path:'notice.txt',sha256:digest,bytes:Buffer.byteLength(bytes),sectionKey:'名单',listNo:1})
  expect(latestSchema.parse(newer.body).official.row).toMatchObject({nameRaw:'2024新名',listNo:2})
  expect(eventSchema.parse((await f.http(`/api/roster/events/${ids[0]!.record_event_id}?official=latest`)).body).official.rows).toMatchObject([{nameRaw:' 2021旧名\u0000🙂 '}])
})
it('keeps legacy anonymous reads unchanged and rejects sensitive opt-in before any database read',async()=>{
  const f=await fixture();await f.commit(f.announcement([f.record('Canonical',2021)]),'legacy');const id=f.evidenceIds()[0]!.id
  const original=await f.http('/api/roster/evidence/'+id,undefined,null);expect(original.status).toBe(200);expect(original.body).not.toHaveProperty('official')
  f.sqlite.pragma('query_only=ON');const spy=vi.spyOn(f.db,'transaction'),get=vi.spyOn(f.db,'get'),all=vi.spyOn(f.db,'all')
  for(const path of [`/api/roster/evidence/${id}?official=latest`,`/api/roster/events/1?official=latest`,'/api/roster/import/receipts/items?projection=snapshot&source=private_batch&batchId=1&itemIndex=0&oldRecordId=1']){const r=await f.http(path,undefined,null);expect(r.status).toBe(401);expect(r.body).toMatchObject({error:{code:'unauthorized'}})}
  expect(spy).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();expect(all).not.toHaveBeenCalled();spy.mockRestore();get.mockRestore();all.mockRestore()
  const legacy=await f.http(`/api/roster/evidence/${id}?official=latest`);expect(latestSchema.parse(legacy.body).official).toMatchObject({availability:'unknown_legacy',row:null})
  expect(eventSchema.parse((await f.http('/api/roster/events/1?official=latest')).body).official).toMatchObject({rows:[],uncaptured:'unknown_legacy'})
})
it('reads descending revision pages and never inherits raw on cross-content correction',async()=>{
  const f=await fixture();await f.commit(f.announcement([f.record('Canonical',2021,f.row('旧名'))]),'seed');const id=f.evidenceIds()[0]!.id
  const original=latestSchema.parse((await f.http(`/api/roster/evidence/${id}?official=latest`)).body).official.row!
  await f.correct(id,{...f.row('新核旧名'),declaration:{kind:'existing',sourceDocumentId:original.sourceDocumentId!,basis:'Same declaration verified'}},'rev2')
  const first=historySchema.parse((await f.http(`/api/roster/evidence/${id}?official=history&pageSize=1`)).body).official
  expect(first.rows).toMatchObject([{revision:2,nameRaw:'新核旧名'}]);expect(first.nextBeforeRevision).toBe(2)
  const second=historySchema.parse((await f.http(`/api/roster/evidence/${id}?official=history&pageSize=1&beforeRevision=2`)).body).official
  expect(second.rows).toMatchObject([{revision:1,nameRaw:'旧名'}]);expect(second.nextBeforeRevision).toBeNull()
  await f.correct(id,{...f.row(null),usccRaw:null,districtRaw:null,declaration:{kind:'existing',sourceDocumentId:original.sourceDocumentId!,basis:'New content explicitly verified'},storedFileId:2,path:'other.txt',sha256:createHash('sha256').update('different content\n').digest('hex'),bytes:Buffer.byteLength('different content\n')},'cross-content');expect(latestSchema.parse((await f.http(`/api/roster/evidence/${id}?official=latest`)).body).official.row).toMatchObject({revision:3,nameRaw:null,usccRaw:null,districtRaw:null,path:'other.txt'})
})
it('selects the exact private merge snapshot with captured origin after the old live owners are deleted',async()=>{
  const f=await fixture(),s=await f.seedMerge(),before=f.sqlite.prepare('SELECT item_results FROM import_batch WHERE id=?').get(s.batchId)
  const result=await f.http('/api/roster/import/receipts/items?projection=snapshot&'+s.selector);expect(result.status).toBe(200)
  expect(snapshotSchema.parse(result.body)).toMatchObject({source:'private_batch',batchId:s.batchId,receiptId:null,itemIndex:s.index,oldRecordId:s.origin.recordId,storedRedacted:false,responseRedacted:true,availability:'available',snapshot:{id:s.origin.recordId,enterpriseId:s.origin.enterpriseId,nameRaw:'2021旧名'}})
  expect(result.body).not.toHaveProperty('eventIds');expect(f.sqlite.prepare('SELECT id FROM record WHERE id=?').get(s.origin.recordId)).toBeUndefined()
  const fact=latestSchema.parse((await f.http(`/api/roster/evidence/${s.old.id}?official=latest`)).body).official.row!
  expect(fact.capturedRecordId).toBe(s.origin.recordId);expect(fact.currentOwner?.recordId).not.toBe(s.origin.recordId)
  expect(f.sqlite.prepare('SELECT item_results FROM import_batch WHERE id=?').get(s.batchId)).toEqual(before)
  const publicOutputs=[s.merge.result,(await f.http('/api/roster/import/commit',s.merge.bound)).body,readImportBatchOutcome(f.db,'merge')]
  for(const output of publicOutputs){expect(JSON.stringify(output)).not.toContain('fromRecordSnapshot');expect(JSON.stringify(output)).not.toContain('eventIds');expect(JSON.stringify(output)).toContain('snapshotRef')}
})
it('does not fallback from an explicitly redacted receipt to the retained private batch',async()=>{
  const f=await fixture(),s=await f.seedMerge()
  const r=await f.http(`/api/roster/import/receipts/items?projection=snapshot&source=redacted_receipt&receiptId=${s.receiptId}&itemIndex=${s.index}&oldRecordId=${s.origin.recordId}`)
  expect(r.status).toBe(200);expect(snapshotSchema.parse(r.body)).toMatchObject({source:'redacted_receipt',receiptId:s.receiptId,storedRedacted:true,responseRedacted:true,availability:'not_retained'});expect(r.body).not.toHaveProperty('snapshot')
})
it.each(['source=private_batch&batchId=1&receiptId=1&itemIndex=0&oldRecordId=1','source=private_batch&batchId=1&oldRecordId=1','source=redacted_receipt&batchId=1&itemIndex=0&oldRecordId=1','source=private_batch&batchId=1&itemIndex=-1&oldRecordId=1','source=private_batch&batchId=1&itemIndex=0&oldRecordId=1&pageSize=51','source=private_batch&batchId=1&itemIndex=0&oldRecordId=1&maxBytes=65537','source=private_batch&batchId=1&itemIndex=0&oldRecordId=1&extra=1'])('rejects invalid exact snapshot selector case %s',async query=>{const f=await fixture();const r=await f.http('/api/roster/import/receipts/items?projection=snapshot&'+query);expect(r.status).toBe(400);expect(r.body).toMatchObject({error:{code:'invalid_query'}})})

/** Instruments values actually returned by the native driver, not helper stubs. */
function observeDriver(sqlite:Database.Database) {
  const results:{sql:string;params:unknown[];result:unknown}[]=[],prepare=sqlite.prepare.bind(sqlite)
  const spy=vi.spyOn(sqlite,'prepare').mockImplementation((query:string)=>{
    const statement=prepare(query),get=statement.get.bind(statement),all=statement.all.bind(statement)
    statement.get=(...params:unknown[])=>{const result=get(...params);results.push({sql:query,params,result});return result}
    statement.all=(...params:unknown[])=>{const result=all(...params);results.push({sql:query,params,result});return result}
    return statement
  })
  return {results,restore:()=>spy.mockRestore()}
}

it('paginates multiple independent evidence captures at default twenty and maximum fifty without nested histories',async()=>{
  const f=await fixture(),record=f.record('Canonical',2021)
  record.events![0]!.evidence=Array.from({length:51},(_,i)=>({sourceFile:'notice.txt',attachment:null,listNo:i+1,page:null,publishedRow:f.row('row '+(i+1),i+1)}))
  record.events![0]!.evidence!.push({sourceFile:'notice.txt',attachment:null,listNo:999,page:null})
  await f.commit(f.announcement([record]),'multiple')
  const eventId=f.evidenceIds()[0]!.record_event_id
  const first=await f.http(`/api/roster/events/${eventId}?official=latest&maxBytes=65536`);expect(first.status).toBe(200)
  const page=eventSchema.parse(first.body).official;expect(page.rows.map(r=>r.nameRaw)).toEqual(Array.from({length:20},(_,i)=>'row '+(i+1)));expect(page.nextAfterEvidenceId).toBe(20);expect(page.uncaptured).toBe('unknown_legacy')
  const second=eventSchema.parse((await f.http(`/api/roster/events/${eventId}?official=latest&pageSize=50&afterEvidenceId=20&maxBytes=65536`)).body).official
  expect(second.rows.map(r=>r.nameRaw)).toEqual(Array.from({length:31},(_,i)=>'row '+(i+21)));expect(second.nextAfterEvidenceId).toBeNull()
  const full=eventSchema.parse((await f.http(`/api/roster/events/${eventId}?official=latest&pageSize=50&maxBytes=65536`)).body).official;expect(full.rows).toHaveLength(50);expect(full.nextAfterEvidenceId).toBe(50)
  for(const row of full.rows) expect(row).not.toHaveProperty('history')
  const empty=eventSchema.parse((await f.http(`/api/roster/events/${eventId}?official=latest&afterEvidenceId=999&maxBytes=65536`)).body).official;expect(empty.rows).toEqual([])
  expect((await f.http(`/api/roster/events/${eventId}?official=latest&pageSize=51`)).status).toBe(400)
  expect(z.object({evidence:z.array(z.unknown())}).parse(first.body).evidence).toHaveLength(52)
})
it('paginates fifty-one genuine published revisions with independent descending boundary oracles',async()=>{
  const f=await fixture();await f.commit(f.announcement([f.record('Canonical',2021,f.row('revision 1'))]),'seed')
  const id=f.evidenceIds()[0]!.id,origin=latestSchema.parse((await f.http(`/api/roster/evidence/${id}?official=latest`)).body).official.row!
  for(let revision=2;revision<=51;revision++) await f.correct(id,{...f.row('revision '+revision),declaration:{kind:'existing',sourceDocumentId:origin.sourceDocumentId!,basis:'Same declaration'}},'revision-'+revision)
  const first=historySchema.parse((await f.http(`/api/roster/evidence/${id}?official=history&maxBytes=65536`)).body).official
  expect(first.rows.map(r=>r.revision)).toEqual(Array.from({length:20},(_,i)=>51-i));expect(first.nextBeforeRevision).toBe(32)
  const max=historySchema.parse((await f.http(`/api/roster/evidence/${id}?official=history&pageSize=50&maxBytes=65536`)).body).official
  expect(max.rows.map(r=>r.revision)).toEqual(Array.from({length:50},(_,i)=>51-i));expect(max.nextBeforeRevision).toBe(2)
  const last=historySchema.parse((await f.http(`/api/roster/evidence/${id}?official=history&beforeRevision=2`)).body).official;expect(last.rows).toMatchObject([{revision:1,nameRaw:'revision 1'}]);expect(last.nextBeforeRevision).toBeNull()
})

it('pages a gigantic retained event array by bound index without loading arrays or unrelated batch JSON into JS',async()=>{
  const f=await fixture(),s=await f.seedMerge()
  // Explicit extreme legacy fixture, extending the already genuine command-produced fold.
  const array=Array.from({length:20001},(_,i)=>100001+i)
  const eventPath=`$[${s.index}].detail.lineage.recordsFolded[0].eventIds`
  f.sqlite.prepare('UPDATE import_batch SET item_results=json_set(item_results,?,json(?)) WHERE id=?').run(eventPath,JSON.stringify(array),s.batchId)
  const observer=observeDriver(f.sqlite)
  const first=await f.http('/api/roster/import/receipts/items?projection=eventIds&'+s.selector);expect(first.status).toBe(200)
  const page=snapshotSchema.parse(first.body);expect(page.eventIds).toEqual(Array.from({length:20},(_,i)=>100001+i));expect(page.nextCursor).toEqual(expect.any(String));expect(first.body).not.toHaveProperty('snapshot')
  const second=await f.http('/api/roster/import/receipts/items?projection=eventIds&pageSize=50&'+s.selector+'&cursor='+page.nextCursor)
  expect(snapshotSchema.parse(second.body).eventIds).toEqual(Array.from({length:50},(_,i)=>100021+i))
  observer.restore()
  const native=observer.results.filter(r=>r.sql.includes('WITH source_row'))
  expect(native).toHaveLength(2)
  for(const result of native){expect(Buffer.byteLength(JSON.stringify(result.result))).toBeLessThan(2000);expect(result.result).not.toHaveProperty('items');expect(result.result).not.toHaveProperty('fold');expect(result.result).not.toHaveProperty('selected_json')}
  const query=native[0]!,plan=f.sqlite.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.params)
  expect(JSON.stringify(plan)).toMatch(/SEARCH b USING INTEGER PRIMARY KEY/)
  expect(query.sql).toMatch(/LIMIT 2/);expect(query.sql).toMatch(/ORDER BY CAST\(key AS INTEGER\)/)
  expect(query.sql).not.toMatch(/substr\(/i)
  // Unrelated giant batch stays inside SQLite and cannot affect this exact response.
  f.sqlite.prepare("INSERT INTO import_batch(idempotency_key,source_kind,source_identity,status,item_results,created_at) VALUES('extreme-unrelated','announcement','synthetic','committed',?,'synthetic')").run(JSON.stringify([{detail:{huge:'UNRELATED'.repeat(700000)}}]))
  expect((await f.http('/api/roster/import/receipts/items?projection=eventIds&'+s.selector)).body).toEqual(first.body)
  writeFileSync(join(f.dir,'sql-observations.json'),JSON.stringify({native,plan},null,2))
})
it('rejects cursor reuse across source source-ID item and old-record bindings before querying',async()=>{
  const f=await fixture(),s=await f.seedMerge(),eventPath=`$[${s.index}].detail.lineage.recordsFolded[0].eventIds`
  f.sqlite.prepare('UPDATE import_batch SET item_results=json_set(item_results,?,json(?)) WHERE id=?').run(eventPath,'[1,2,3]',s.batchId)
  const first=snapshotSchema.parse((await f.http('/api/roster/import/receipts/items?projection=eventIds&pageSize=1&'+s.selector)).body)
  const observer=observeDriver(f.sqlite)
  for(const selector of [`source=redacted_receipt&receiptId=${s.receiptId}&itemIndex=${s.index}&oldRecordId=${s.origin.recordId}`,s.selector.replace('batchId='+s.batchId,'batchId=999999'),s.selector.replace('itemIndex='+s.index,'itemIndex=999'),s.selector.replace('oldRecordId='+s.origin.recordId,'oldRecordId=999')]) {
    const result=await f.http('/api/roster/import/receipts/items?projection=eventIds&'+selector+'&cursor='+first.nextCursor);expect(result.status).toBe(400);expect(result.body).toMatchObject({error:{code:'invalid_query'}})
  }
  observer.restore();expect(observer.results).toEqual([])
  for(const afterIndex of [3,999999]) {const cursor=Buffer.from(JSON.stringify({source:'private_batch',sourceId:s.batchId,itemIndex:s.index,oldRecordId:s.origin.recordId,afterIndex})).toString('base64url');expect((await f.http('/api/roster/import/receipts/items?projection=eventIds&'+s.selector+'&cursor='+cursor)).status).toBe(400)}
  const tail=Buffer.from(JSON.stringify({source:'private_batch',sourceId:s.batchId,itemIndex:s.index,oldRecordId:s.origin.recordId,afterIndex:1})).toString('base64url')
  expect(snapshotSchema.parse((await f.http('/api/roster/import/receipts/items?projection=eventIds&'+s.selector+'&cursor='+tail)).body)).toMatchObject({eventIds:[3],nextCursor:null})
})

for(const [label,path,value,code,status] of [
  ['wrong snapshot record','fromRecordSnapshot.id',999,'selector_mismatch',409],
  ['wrong historical owner','fromRecordSnapshot.enterpriseId',999,'selector_mismatch',409],
  ['invalid into record','intoRecordId',0,'selector_mismatch',409],
  ['fractional into record','intoRecordId',1.5,'selector_mismatch',409],
  ['text from record','fromRecordId','1','selector_mismatch',409],
  ['wrong name type','fromRecordSnapshot.nameRaw',5,'selector_mismatch',409],
  ['invalid quality flag','fromRecordSnapshot.qualityFlags',[1],'selector_mismatch',409],
  ['oversized field','fromRecordSnapshot.nameRaw','X'.repeat(4001),'field_limit',413],
  ['UTF16 oversized field','fromRecordSnapshot.nameRaw','🙂'.repeat(2001),'field_limit',413],
  ['NUL oversized field','fromRecordSnapshot.nameRaw','\0'+'X'.repeat(4000),'field_limit',413],
] as const) it('rejects explicit historical corruption '+label,async()=>{
  const f=await fixture(),s=await f.seedMerge(),jsonPath=`$[${s.index}].detail.lineage.recordsFolded[0].${path}`
  f.sqlite.prepare('UPDATE import_batch SET item_results=json_set(item_results,?,json(?)) WHERE id=?').run(jsonPath,JSON.stringify(value),s.batchId)
  const observer=observeDriver(f.sqlite),r=await f.http('/api/roster/import/receipts/items?projection=snapshot&'+s.selector);observer.restore()
  expect(r.status).toBe(status);expect(r.body).toMatchObject({error:{code}})
  const rows=observer.results.filter(r=>r.sql.includes('WITH source_row'));expect(rows).toHaveLength(1)
  if(label==='oversized field') expect(rows[0]!.result).toMatchObject({availability:'field_limit',projection:null})
})
for(const [label,path,value] of [['failed item','ok',false],['non merge','kind','announcement'],['invalid old enterprise','detail.lineage.fromEnterpriseId',0],['invalid target enterprise','detail.lineage.intoEnterpriseId','2']] as const) it('rejects exact selector for '+label,async()=>{
  const f=await fixture(),s=await f.seedMerge();f.sqlite.prepare('UPDATE import_batch SET item_results=json_set(item_results,?,json(?)) WHERE id=?').run(`$[${s.index}].${path}`,JSON.stringify(value),s.batchId)
  const r=await f.http('/api/roster/import/receipts/items?projection=snapshot&'+s.selector);expect(r.status).toBe(409);expect(r.body).toMatchObject({error:{code:'selector_mismatch'}})
})
it('distinguishes missing source wrong item wrong fold duplicate fold and unretained historical snapshot',async()=>{
  const f=await fixture(),s=await f.seedMerge(),url='/api/roster/import/receipts/items?projection=snapshot&'
  expect(await f.http(url+s.selector.replace('batchId='+s.batchId,'batchId=999999'))).toMatchObject({status:404,body:{error:{code:'missing'}}})
  expect(await f.http(url+s.selector.replace('itemIndex='+s.index,'itemIndex=999'))).toMatchObject({status:409,body:{error:{code:'selector_mismatch'}}})
  expect(await f.http(url+s.selector.replace('oldRecordId='+s.origin.recordId,'oldRecordId=999'))).toMatchObject({status:409,body:{error:{code:'selector_mismatch'}}})
  const path=`$[${s.index}].detail.lineage.recordsFolded`
  f.sqlite.prepare("UPDATE import_batch SET item_results=json_insert(item_results,?,json_extract(item_results,?)) WHERE id=?").run(path+'[#]',path+'[0]',s.batchId)
  expect(await f.http(url+s.selector)).toMatchObject({status:409,body:{error:{code:'ambiguity'}}})
  f.sqlite.prepare('UPDATE import_batch SET item_results=json_remove(item_results,?,?) WHERE id=?').run(path+'[1]',path+'[0].fromRecordSnapshot',s.batchId)
  expect(snapshotSchema.parse((await f.http(url+s.selector)).body)).toMatchObject({availability:'not_retained',storedRedacted:false})
  const events=await f.http('/api/roster/import/receipts/items?projection=eventIds&'+s.selector);expect(snapshotSchema.parse(events.body).availability).toBe('not_retained')
})
it.each(['[]','null','[1,0]','[1,"2"]','[1,9007199254740992]','{"0":1}'])('validates the complete retained event array shape %s without rebuilding live events',async value=>{
  const f=await fixture(),s=await f.seedMerge(),path=`$[${s.index}].detail.lineage.recordsFolded[0].eventIds`
  f.sqlite.prepare('UPDATE import_batch SET item_results=json_set(item_results,?,json(?)) WHERE id=?').run(path,value,s.batchId)
  const r=await f.http('/api/roster/import/receipts/items?projection=eventIds&pageSize=1&'+s.selector)
  if(value==='[]') {expect(r.status).toBe(200);expect(snapshotSchema.parse(r.body)).toMatchObject({eventIds:[],nextCursor:null})}
  else if(value==='null') {expect(r.status).toBe(200);expect(snapshotSchema.parse(r.body).availability).toBe('not_retained')}
  else {expect(r.status).toBe(409);expect(r.body).toMatchObject({error:{code:'selector_mismatch'}})}
})
it('checks UTF8 full snapshot envelope bytes in SQL and rejects over-budget values without truncation',async()=>{
  const f=await fixture(),s=await f.seedMerge(),url='/api/roster/import/receipts/items?projection=snapshot&'+s.selector
  const initial=observeDriver(f.sqlite),baseline=await f.http(url),required=Buffer.byteLength(JSON.stringify(baseline.body));initial.restore();writeFileSync(join(f.dir,'budget-observation.json'),JSON.stringify(initial.results,null,2));expect(baseline.status).toBe(200)
  expect((await f.http(url+'&maxBytes='+required)).body).toEqual(baseline.body)
  const observer=observeDriver(f.sqlite),small=await f.http(url+'&maxBytes='+(required-1));observer.restore()
  expect(small.status).toBe(413);expect(small.body).toMatchObject({error:{code:'response_limit',requiredBytes:required}})
  expect(observer.results.filter(r=>r.sql.includes('WITH source_row'))[0]!.result).toMatchObject({requiredBytes:required,projection:null})
  const prefix=`$[${s.index}].detail.lineage.recordsFolded[0].fromRecordSnapshot`
  // Explicit extreme retained historical data: legal individual fields, oversized aggregate.
  f.sqlite.prepare('UPDATE import_batch SET item_results=json_set(item_results,?,json(?)) WHERE id=?').run(prefix+'.qualityFlags',JSON.stringify(Array.from({length:6},()=> '中'.repeat(4000))),s.batchId)
  expect((await f.http(url+'&maxBytes=65536')).status).toBe(413)
  expect(JSON.stringify((await f.http(url+'&maxBytes=65536')).body)).not.toContain('中')
})
it('redacts captured raw actor basis and path in the new projection while preserving private storage',async()=>{
  const f=await fixture();await f.commit(f.announcement([f.record('Canonical',2021,{...f.row('Bearer synthetic-c-api'),actor:{type:'agent',id:'synthetic-c-mcp'},basis:'synthetic-c-api'})]),'redact')
  const id=f.evidenceIds()[0]!.id
  // Adversarial retained path value; reading does not consult or open this path.
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET path=? WHERE evidence_id=?').run('synthetic-c-api/private.txt',id)
  const stored=f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=?').get(id)
  const r=await f.http(`/api/roster/evidence/${id}?official=latest`);expect(r.status).toBe(200)
  const row=latestSchema.parse(r.body).official.row!
  expect(JSON.stringify(row)).not.toContain('synthetic-c-api');expect(JSON.stringify(row)).not.toContain('synthetic-c-mcp');expect(row.nameRaw).toContain('[REDACTED]')
  expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=?').get(id)).toEqual(stored)
})

it('preserves a declared captured attachment section page and file ID without reading current file bytes',async()=>{
  const f=await fixture(),pdf=minimalPdf({pages:3}),sha256=createHash('sha256').update(pdf).digest('hex')
  writeFileSync(join(f.dir,'files','notice.pdf'),pdf)
  f.sqlite.prepare("INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(3,'notice.pdf','notice.pdf','pdf',?,?,'synthetic')").run(pdf.length,sha256)
  f.sqlite.exec("INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (3, 'jxj', 'announcement', 'specialized_sme')")
  const published={...f.row(' 原名 '),storedFileId:3,path:'notice.pdf',sha256,bytes:pdf.length,attachment:'附件 二',sectionKey:'2021 认定名单',page:2,declaration:{kind:'independent' as const,sourceDocument:{source:'jxj' as const,title:'Declared publication',docNumber:null,issueDate:null,path:'notice.pdf'},basis:'Actual PDF publication'}}
  const record=f.record('Canonical',2021,published);record.events![0]!.evidence![0]={sourceFile:'notice.pdf',attachment:published.attachment,listNo:1,page:2,publishedRow:published}
  await f.commit(f.announcement([record]),'coordinates')
  const id=f.evidenceIds()[0]!.id,r=await f.http(`/api/roster/evidence/${id}?official=latest`)
  expect(latestSchema.parse(r.body).official.row).toMatchObject({nameRaw:' 原名 ',storedFileId:3,path:'notice.pdf',sha256,bytes:pdf.length,attachment:'附件 二',sectionKey:'2021 认定名单',page:2,listNo:1})
})
it('rejects event scope 301 even when the cursor skips all old evidence and accepts scope 300',async()=>{
  const f=await fixture();await f.commit(f.announcement([f.record('Canonical',2021,f.row('Known'))]),'seed')
  const eventId=f.evidenceIds()[0]!.record_event_id
  // Explicit oversized legacy source fixture, not an upstream public happy path.
  const insert=f.sqlite.prepare("INSERT INTO record_evidence(record_event_id,source_file,list_no) VALUES(?,'notice.txt',?)")
  for(let i=2;i<=300;i++) insert.run(eventId,10000+i)
  const at=await f.http(`/api/roster/events/${eventId}?official=latest&afterEvidenceId=999999`);expect(at.status).toBe(200);expect(eventSchema.parse(at.body).official.rows).toEqual([])
  insert.run(eventId,10301)
  const over=await f.http(`/api/roster/events/${eventId}?official=latest&afterEvidenceId=999999`);expect(over.status).toBe(413);expect(over.body).toMatchObject({error:{code:'source_limit'}})
})
it.each(['official=latest&pageSize=2','official=latest&beforeRevision=2','official=history&beforeRevision=0','official=history&pageSize=51','official=history&maxBytes=65537','official=latest&extra=x','official=latest&maxBytes=1&maxBytes=2','official=latest&maxBytes=true'])('rejects strict new evidence query %s',async query=>{
  const f=await fixture();await f.commit(f.announcement([f.record('Canonical',2021)]),'legacy')
  const r=await f.http('/api/roster/evidence/'+f.evidenceIds()[0]!.id+'?'+query);expect(r.status).toBe(400);expect(r.body).toMatchObject({error:{code:'invalid_query'}})
})
it('rejects over-budget official facts in SQL and preserves legacy fields instead of clipping them',async()=>{
  const f=await fixture();await f.commit(f.announcement([f.record('Canonical',2021,f.row('中'.repeat(4000)))]),'wide')
  const id=f.evidenceIds()[0]!.id,legacy=await f.http('/api/roster/evidence/'+id)
  const observer=observeDriver(f.sqlite),small=await f.http(`/api/roster/evidence/${id}?official=latest&maxBytes=1024`);observer.restore()
  expect(small.status).toBe(413);expect(small.body).toMatchObject({error:{code:'response_limit'}})
  const native=observer.results.filter(r=>r.sql.includes('WITH selected AS'))
  expect(native).toHaveLength(1);expect(native[0]!.result).toMatchObject({projection:null});expect(JSON.stringify(native[0]!.result)).not.toContain('中')
  const large=await f.http(`/api/roster/evidence/${id}?official=latest&maxBytes=65536`);expect(large.status).toBe(200);expect(latestSchema.parse(large.body).official.row?.nameRaw).toBe('中'.repeat(4000))
  const {official:_official,...oldFields}=z.record(z.string(),z.unknown()).parse(large.body);expect(oldFields).toEqual(legacy.body)
})
it('reads explicitly retained redacted receipt snapshots from that receipt without selecting another source',async()=>{
  const f=await fixture(),s=await f.seedMerge()
  // Historical receipt retained fields are a targeted legacy fixture. New B receipts omit them.
  f.sqlite.prepare('UPDATE import_receipt SET item_results=(SELECT item_results FROM import_batch WHERE id=?) WHERE id=?').run(s.batchId,s.receiptId)
  const receipt='/api/roster/import/receipts/items?projection=snapshot&source=redacted_receipt&receiptId='+s.receiptId+'&itemIndex='+s.index+'&oldRecordId='+s.origin.recordId
  const result=await f.http(receipt);expect(result.status).toBe(200);expect(snapshotSchema.parse(result.body)).toMatchObject({source:'redacted_receipt',storedRedacted:true,availability:'available',snapshot:{nameRaw:'2021旧名'}})
  f.sqlite.prepare("UPDATE import_batch SET item_results='[]' WHERE id=?").run(s.batchId)
  expect((await f.http(receipt)).body).toEqual(result.body)
  f.sqlite.prepare("UPDATE import_receipt SET status='failed' WHERE id=?").run(s.receiptId)
  expect(await f.http(receipt)).toMatchObject({status:409,body:{error:{code:'selector_mismatch'}}})
})
it('does not expose raw SQL or secret-bearing database errors through the new selector',async()=>{
  const f=await fixture(),s=await f.seedMerge()
  const spy=vi.spyOn(f.db,'get').mockImplementation(()=>{throw new Error('secret=synthetic-c-api SELECT huge_private_payload')})
  const r=await f.http('/api/roster/import/receipts/items?projection=snapshot&'+s.selector);spy.mockRestore()
  expect(r).toMatchObject({status:500,body:{error:{code:'internal_error',message:'Exact snapshot read failed'}}});expect(JSON.stringify(r.body)).not.toContain('synthetic-c-api');expect(JSON.stringify(r.body)).not.toContain('SELECT')
})

it('checks redaction expansion against the final full envelope budget',async()=>{
  const f=await fixture(),s=await f.seedMerge(),path=`$[${s.index}].detail.lineage.recordsFolded[0].fromRecordSnapshot.nameRaw`
  f.sqlite.prepare('UPDATE import_batch SET item_results=json_set(item_results,?,?) WHERE id=?').run(path,'x',s.batchId)
  const url='/api/roster/import/receipts/items?projection=snapshot&'+s.selector
  const baseline=await f.http(url),required=Buffer.byteLength(JSON.stringify(baseline.body))
  vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'x',mcpToken:'synthetic-c-mcp',filesDir:current.filesDir}))
  try {
    const observer=observeDriver(f.sqlite),r=await f.http(url+'&maxBytes='+required,undefined,'x');observer.restore()
    expect(observer.results.filter(r=>r.sql.includes('WITH source_row'))[0]!.result).toMatchObject({requiredBytes:required,availability:'available',projection:expect.any(String)})
    expect(r.status).toBe(413);expect(r.body).toMatchObject({error:{code:'response_limit',requiredBytes:required+9}})
  } finally {vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'synthetic-c-api',mcpToken:'synthetic-c-mcp',filesDir:current.filesDir}))}
})

it('validates raw MCP opt-in arguments before SDK stripping and retains old anonymous exact reads',async()=>{
  const {officialEvidenceRpcError}=await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  const body=(name:string,args:unknown)=>({jsonrpc:'2.0',id:351,method:'tools/call',params:{name,arguments:args}})
  const invalid=officialEvidenceRpcError(body('get_roster_evidence',{id:1,official:'latest',unknown:1}),true)
  expect(invalid?.status).toBe(400);expect(await invalid!.json()).toMatchObject({error:{code:-32602}})
  expect(officialEvidenceRpcError(body('get_roster_evidence',{id:1}),false)).toBeNull()
  expect(officialEvidenceRpcError(body('get_roster_evidence',{id:1,legacyIgnored:1}),false)).toBeNull()
  expect(officialEvidenceRpcError(body('get_official_event',{eventId:1}),false)).toBeNull()
  const denied=officialEvidenceRpcError(body('get_roster_evidence',{id:999999,official:'invalid'}),false);expect(denied?.status).toBe(401)
  expect(officialEvidenceRpcError([body('get_roster_evidence',{id:1}),body('get_official_event',{eventId:1,official:'latest'})],false)?.status).toBe(401)
  expect(officialEvidenceRpcError(body('list_roster_import_items',{projection:'eventIds',source:'private_batch',batchId:1,itemIndex:0,oldRecordId:1,cursor:'not-base64'}),true)).toBeNull()
  // Shape validation precedes SQL; the exact bound cursor is checked by the domain reader.
})
it('closes sensitive HTTP reads when the token is unconfigured without changing legacy public reads',async()=>{
  const f=await fixture();await f.commit(f.announcement([f.record('Canonical',2021)]),'legacy')
  vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'',mcpToken:'',filesDir:current.filesDir}))
  try {
    const observer=observeDriver(f.sqlite)
    const r=await f.http('/api/roster/evidence/1?official=latest');expect(r.status).toBe(401)
    observer.restore();expect(observer.results).toEqual([])
    expect((await f.http('/api/roster/evidence/1?legacyIgnored=1',undefined,null)).status).toBe(200)
  } finally {vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'synthetic-c-api',mcpToken:'synthetic-c-mcp',filesDir:current.filesDir}))}
})

it('returns not retained for a missing event array despite the live moved events remaining available',async()=>{
  const f=await fixture(),s=await f.seedMerge(),path=`$[${s.index}].detail.lineage.recordsFolded[0].eventIds`
  f.sqlite.prepare('UPDATE import_batch SET item_results=json_remove(item_results,?) WHERE id=?').run(path,s.batchId)
  expect(f.sqlite.prepare('SELECT id FROM record_event WHERE id=?').get(s.old.record_event_id)).toEqual({id:s.old.record_event_id})
  const r=await f.http('/api/roster/import/receipts/items?projection=eventIds&'+s.selector);expect(r.status).toBe(200);expect(snapshotSchema.parse(r.body).availability).toBe('not_retained');expect(r.body).not.toHaveProperty('eventIds')
})
it('projects only the fixed eight snapshot fields even when the selected historical fold contains a giant extra blob',async()=>{
  const f=await fixture(),s=await f.seedMerge(),path=`$[${s.index}].detail.lineage.recordsFolded[0].fromRecordSnapshot.privateExtra`
  f.sqlite.prepare('UPDATE import_batch SET item_results=json_set(item_results,?,?) WHERE id=?').run(path,'PRIVATE_EXTRA'.repeat(200000),s.batchId)
  const observer=observeDriver(f.sqlite),r=await f.http('/api/roster/import/receipts/items?projection=snapshot&'+s.selector);observer.restore()
  expect(r.status).toBe(200)
  const snapshot=z.object({snapshot:z.record(z.string(),z.unknown())}).parse(r.body).snapshot
  expect(Object.keys(snapshot).sort()).toEqual(['district','enterpriseId','id','nameRaw','qualityFlags','source','titleCode','usccRaw'])
  expect(JSON.stringify(observer.results.filter(r=>r.sql.includes('WITH source_row')))).not.toContain('PRIVATE_EXTRA')
  expect(Buffer.byteLength(JSON.stringify(r.body))).toBeLessThan(1024)
})

it('applies the official event redactor once and enforces its final UTF8 envelope budget',async()=>{
  const f=await fixture();await f.commit(f.announcement([f.record('Canonical',2021,f.row('REDACTED'))]),'redaction-once')
  const eventId=f.evidenceIds()[0]!.record_event_id,url=`/api/roster/events/${eventId}?official=latest`
  vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'REDACTED',mcpToken:'synthetic-c-mcp',filesDir:current.filesDir}))
  try {
    const first=await f.http(url,undefined,'REDACTED');expect(first.status).toBe(200)
    const official=z.object({official:z.unknown()}).parse(first.body).official,required=Buffer.byteLength(JSON.stringify(official))
    const small=await f.http(url+'&maxBytes='+(required-1),undefined,'REDACTED')
    expect(official).toMatchObject({rows:[{nameRaw:'[REDACTED]'}]});expect(small.status).toBe(413);expect(small.body).toMatchObject({error:{code:'response_limit'}})
  } finally {vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'synthetic-c-api',mcpToken:'synthetic-c-mcp',filesDir:current.filesDir}))}
})

// Compile the route's actual literal metadata with the installed SDK's Ajv 8 provider.
// It supports the nullable extension retained by Nitro's OpenAPI 3.1 metadata.
function itemsResponseValidator() {
  const meta = z.object({ openAPI: z.object({ responses: z.object({ '200': z.object({ content: z.object({ 'application/json': z.object({ schema: z.record(z.string(), z.unknown()) }) }) }) }) }) }).parse(itemsMetadata)
  return new AjvJsonSchemaValidator().getValidator(meta.openAPI.responses['200'].content['application/json'].schema)
}
it.each(['legacy list', 'private snapshot', 'receipt not retained', 'event IDs'] as const)('items response schema accepts real reader %s and rejects missing required fields', async kind => {
  const f = await fixture(), s = await f.seedMerge(), validate = itemsResponseValidator()
  const query = kind === 'legacy list' ? `batchId=${s.batchId}` : kind === 'receipt not retained'
    ? `projection=snapshot&source=redacted_receipt&receiptId=${s.receiptId}&itemIndex=${s.index}&oldRecordId=${s.origin.recordId}`
    : `projection=${kind === 'private snapshot' ? 'snapshot' : 'eventIds'}&${s.selector}`
  const result = await f.http('/api/roster/import/receipts/items?' + query)
  expect(result.status).toBe(200)
  const valid = validate(result.body)
  expect(valid.valid, valid.errorMessage).toBe(true)
  const body = z.record(z.string(), z.unknown()).parse(result.body)
  const required = kind === 'legacy list' ? 'rows' : kind === 'private snapshot' ? 'snapshot' : kind === 'receipt not retained' ? 'availability' : 'eventIds'
  const malformed = { ...body }; delete malformed[required]
  expect(validate(malformed).valid).toBe(false)
  expect(validate({}).valid).toBe(false)
  if (kind === 'private snapshot') {
    expect(body.receiptId).toBeNull() // Actual private-source null, not a hand-built schema example.
    expect(validate({ ...body, rows: [], page: 1, pageSize: 20, total: 0 }).valid).toBe(false)
    expect(validate({ ...body, snapshot: { id: s.origin.recordId } }).valid).toBe(false)
  }
  if (kind === 'receipt not retained') {
    expect(body.availability).toBe('not_retained')
    expect(validate({ ...body, snapshot: {} }).valid).toBe(false)
  }
  if (kind === 'event IDs') {
    expect(body.nextCursor).toBeNull()
    const noCursor = { ...body }; delete noCursor.nextCursor
    expect(validate(noCursor).valid).toBe(false)
  }
})

// #399 small lane: no fixture(), listener, SQLite instance or SDK transport.
// Literal partitions come from the approved five-key compatibility boundary.
function rpc399(args: unknown) {
  return { jsonrpc: '2.0', id: 399, method: 'tools/call', params: { name: 'list_roster_import_items', arguments: args } }
}
const invalidFields399: { case: string; args: Record<string, unknown> }[] = [
  { case: 'page-zero', args: { batchId: 1, page: 0 } },
  { case: 'page-over', args: { batchId: 1, page: 1000001 } },
  { case: 'size-zero', args: { batchId: 1, pageSize: 0 } },
  { case: 'size-over', args: { batchId: 1, pageSize: 51 } },
  { case: 'size-fraction', args: { batchId: 1, pageSize: 2.5 } },
  { case: 'page-null', args: { batchId: 1, page: null } },
  { case: 'size-null', args: { batchId: 1, pageSize: null } },
  { case: 'batch-null', args: { batchId: null } },
  { case: 'receipt-null', args: { receiptId: null } },
  { case: 'key-null', args: { idempotencyKey: null } },
  { case: 'batch-string', args: { batchId: '1' } },
  { case: 'receipt-boolean', args: { receiptId: true } },
  { case: 'key-number', args: { idempotencyKey: 1 } },
  { case: 'page-string', args: { batchId: 1, page: '1' } },
  { case: 'size-boolean', args: { batchId: 1, pageSize: true } },
  { case: 'batch-zero', args: { batchId: 0 } },
  { case: 'receipt-unsafe', args: { receiptId: Number.MAX_SAFE_INTEGER + 1 } },
  { case: 'key-empty', args: { idempotencyKey: '' } },
  { case: 'key-over', args: { idempotencyKey: 'x'.repeat(4097) } },
]
it.each([
  { case: 'normal-selector', args: { batchId: 1 } },
  { case: 'multiple-legacy-keys', args: { batchId: 1, receiptId: 2, idempotencyKey: 'key', page: 1, pageSize: 50 } },
  { case: 'SDK-owns-value-validation', args: { batchId: null, page: 'invalid', pageSize: false } },
  { case: 'undefined-own-key', args: { batchId: undefined } },
  { case: 'empty-object', args: {} },
])('raw legacy dispatch delegates values to SDK: $case', async ({ args }) => {
  const { officialEvidenceRpcError } = await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  // null proves raw dispatch only, never HTTP200 or an SDK tool-error envelope.
  expect(officialEvidenceRpcError(rpc399(args), true)).toBeNull()
})
it.each([
  { case: 'missing', body: { jsonrpc: '2.0', id: 399, method: 'tools/call', params: { name: 'list_roster_import_items' } } },
  ...[undefined, null, [], 1, 'x', true].map((args, i) => ({ case: ['undefined', 'null', 'array', 'number', 'string', 'boolean'][i], body: rpc399(args) })),
])("raw malformed root $case", async ({ body }) => {
  const { officialEvidenceRpcError } = await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  const result = officialEvidenceRpcError(body, true)
  expect(result?.status).toBe(400)
  expect(await result!.json()).toEqual({ jsonrpc: '2.0', id: 399, error: { code: -32602, message: 'Invalid exact official read arguments' } })
})
it.each(['projection', 'source', 'itemIndex', 'oldRecordId', 'cursor', 'maxBytes', 'extra'])("raw own key stays strict %s", async key => {
  const { officialEvidenceRpcError } = await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  for (const value of [undefined, null, 'invalid']) {
    // Invalid old paging distinguishes strict routing even for optional undefined.
    const result = officialEvidenceRpcError(rpc399({ batchId: 1, pageSize: 51, [key]: value }), true)
    expect(result?.status).toBe(400)
    expect(await result!.json()).toMatchObject({ error: { code: -32602 } })
  }
  const optional = officialEvidenceRpcError(rpc399({ batchId: 1, [key]: undefined }), true)
  if (key === 'extra') expect(optional?.status).toBe(400)
  else expect(optional).toBeNull() // helper-only: undefined is not JSON wire data.
})
const snapshot399 = { projection: 'snapshot', source: 'private_batch', batchId: 1, itemIndex: 0, oldRecordId: 1 }
const events399 = { projection: 'eventIds', source: 'redacted_receipt', receiptId: 2, itemIndex: 0, oldRecordId: 1 }
const strictInvalid399: { case: string; args: Record<string, unknown> }[] = [
  { case: 'projection-null', args: { batchId: 1, projection: null } },
  { case: 'source-null', args: { batchId: 1, source: null } },
  { case: 'projection-legacy', args: { batchId: 1, projection: 'legacy' } },
  { case: 'source-default', args: { batchId: 1, source: 'default' } },
  { case: 'source-only', args: { batchId: 1, source: 'private_batch' } },
  { case: 'index-only', args: { batchId: 1, itemIndex: 0 } },
  { case: 'old-id-only', args: { batchId: 1, oldRecordId: 1 } },
  { case: 'cursor-only', args: { batchId: 1, cursor: 'x' } },
  { case: 'budget-only', args: { batchId: 1, maxBytes: 16384 } },
  { case: 'unknown-defined', args: { batchId: 1, extra: 1 } },
  { case: 'unknown-undefined', args: { batchId: 1, extra: undefined } },
  { case: 'snapshot-page', args: { ...snapshot399, page: 1 } },
  { case: 'snapshot-size', args: { ...snapshot399, pageSize: 20 } },
  { case: 'snapshot-cursor', args: { ...snapshot399, cursor: 'x' } },
  { case: 'snapshot-two-selectors', args: { ...snapshot399, receiptId: 2 } },
  { case: 'snapshot-key', args: { ...snapshot399, idempotencyKey: 'x' } },
  { case: 'snapshot-wrong-source', args: { ...snapshot399, source: 'redacted_receipt' } },
  { case: 'receipt-wrong-source', args: { ...events399, source: 'private_batch' } },
  { case: 'snapshot-no-source', args: { ...snapshot399, source: undefined } },
  { case: 'snapshot-no-index', args: { ...snapshot399, itemIndex: undefined } },
  { case: 'snapshot-no-old-id', args: { ...snapshot399, oldRecordId: undefined } },
  { case: 'index-negative', args: { ...events399, itemIndex: -1 } },
  { case: 'index-over', args: { ...events399, itemIndex: Number.MAX_SAFE_INTEGER } },
  { case: 'old-id-zero', args: { ...events399, oldRecordId: 0 } },
  { case: 'events-page', args: { ...events399, page: 1 } },
  { case: 'events-size-zero', args: { ...events399, pageSize: 0 } },
  { case: 'events-size-over', args: { ...events399, pageSize: 51 } },
  { case: 'events-size-fraction', args: { ...events399, pageSize: 2.5 } },
  { case: 'budget-zero', args: { ...events399, maxBytes: 0 } },
  { case: 'budget-over', args: { ...events399, maxBytes: 65537 } },
  { case: 'cursor-empty', args: { ...events399, cursor: '' } },
  { case: 'cursor-over', args: { ...events399, cursor: 'x'.repeat(513) } },
]
it.each(strictInvalid399)("raw strict rejection $case", async ({ args }) => {
  const { officialEvidenceRpcError } = await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  const result = officialEvidenceRpcError(rpc399(args), true)
  expect(result?.status).toBe(400)
  const body = await result!.json()
  expect(body).toMatchObject({ jsonrpc: '2.0', id: 399, error: { code: -32602 } })
  expect(body).not.toHaveProperty('result')
})
it('raw valid opt-in boundaries and domain cursor dispatch', async () => {
  const { officialEvidenceRpcError } = await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  for (const args of [snapshot399, events399, { ...snapshot399, source: 'redacted_receipt', batchId: undefined, receiptId: 2 }, { ...events399, source: 'private_batch', receiptId: undefined, batchId: 1 }, { ...events399, pageSize: 1, maxBytes: 1 }, { ...events399, pageSize: 50, maxBytes: 65536, itemIndex: Number.MAX_SAFE_INTEGER - 1, oldRecordId: Number.MAX_SAFE_INTEGER, cursor: 'x'.repeat(512) }, { ...events399, cursor: 'not-base64' }, { ...events399, cursor: Buffer.from(JSON.stringify({ source: 'redacted_receipt', sourceId: 2, itemIndex: 0, oldRecordId: 1, afterIndex: 999999 })).toString('base64url') }]) {
    expect(officialEvidenceRpcError(rpc399(args), true)).toBeNull()
  }
})
it('raw auth precedes legacy strict malformed and batch dispatch', async () => {
  const { officialEvidenceRpcError } = await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  const { resolveMcpAuth } = await import('../../../layers/core/server/utils/mcp-auth')
  for (const auth of [{ given: null, configured: 'synthetic-399-mcp' }, { given: 'wrong', configured: 'synthetic-399-mcp' }, { given: 'synthetic-399-mcp', configured: '' }, { given: 'synthetic-399-api', configured: 'synthetic-399-mcp' }]) {
    expect(resolveMcpAuth(auth).writeAuthorized).toBe(false)
    for (const args of [{ batchId: 1 }, { batchId: 1, pageSize: 51 }, {}, null, { ...events399, pageSize: 51 }]) {
      const response = officialEvidenceRpcError(rpc399(args), resolveMcpAuth(auth).writeAuthorized)
      expect(response?.status).toBe(401)
      expect(await response!.json()).toEqual({ jsonrpc: '2.0', id: 399, error: { code: -32001, message: 'Configured MCP token required' } })
    }
  }
  const publicRead = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_roster_evidence', arguments: { id: 1, legacyIgnored: 1 } } }
  expect(officialEvidenceRpcError([publicRead, rpc399({ batchId: 1, pageSize: 51 })], false)?.status).toBe(401)
  const invalid = { ...publicRead, id: 2, params: { name: 'get_official_event', arguments: { eventId: 1, official: 'latest', pageSize: 51 } } }
  expect(await officialEvidenceRpcError([rpc399({}), invalid], true)!.json()).toMatchObject({ id: 2, error: { code: -32602 } })
  expect(await officialEvidenceRpcError([invalid, rpc399({})], true)!.json()).toMatchObject({ id: 2, error: { code: -32602 } })
})
it('raw other tools retain their original dispatch and strict opt-in', async () => {
  const { officialEvidenceRpcError } = await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  for (const [name, args] of [['get_roster_evidence', { id: 1, legacyIgnored: 1 }], ['get_official_event', { eventId: 1 }], ['list_roster_import_receipts', { batchId: 1, pageSize: 51 }], ['get_roster_import_request', { batchId: 1, maxBytes: 65537 }]] as const) {
    expect(officialEvidenceRpcError({ ...rpc399(args), params: { name, arguments: args } }, false)).toBeNull()
  }
  for (const [name, args] of [['get_roster_evidence', { id: 1, official: 'latest', extra: 1 }], ['get_official_event', { eventId: 1, official: 'latest', pageSize: 51 }]] as const) {
    expect(officialEvidenceRpcError({ ...rpc399(args), params: { name, arguments: args } }, true)?.status).toBe(400)
  }
})

async function handler399() {
  // Identity definition adapter only; production handler, schema, error class and
  // importReceiptMcpResult are real. This is not toolkit/SDK transport evidence.
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
  const tool = (await import('../../../server/mcp/tools/list_roster_import_items')).default
  const dbModule = await import('@db'), receipts = await import('../../../layers/sme-roster/server/utils/import-receipts')
  const db = {} as ReturnType<typeof dbModule.useDb>
  const acquire = vi.spyOn(dbModule, 'useDb').mockReturnValue(db)
  const read = vi.spyOn(receipts, 'readImportReceipt').mockReturnValue({ batchId: 1, receiptId: null, status: 'committed', page: 1, pageSize: 20, total: 0, rows: [] })
  return { tool, db, acquire, read, restore: () => { acquire.mockRestore(); read.mockRestore() } }
}
it.each([
  { case: 'empty', args: {}, message: 'Supply exactly one batchId, idempotencyKey or receiptId' },
  { case: 'undefined-selector', args: { batchId: undefined }, message: 'Supply exactly one batchId, idempotencyKey or receiptId' },
  { case: 'batch-receipt', args: { batchId: 1, receiptId: 2 }, message: 'Supply exactly one batchId, idempotencyKey or receiptId' },
  { case: 'batch-key', args: { batchId: 1, idempotencyKey: 'x' }, message: 'Supply exactly one batchId, idempotencyKey or receiptId' },
  { case: 'receipt-key', args: { receiptId: 2, idempotencyKey: 'x' }, message: 'Supply exactly one batchId, idempotencyKey or receiptId' },
  { case: 'whitespace', args: { idempotencyKey: '   ' }, message: 'Invalid idempotencyKey' },
  { case: 'unknown-undefined', args: { batchId: 1, extra: undefined }, message: 'Unsupported query field' },
])("handler original selector error before DB $case", async ({ args, message }) => {
  const f = await handler399()
  try {
    expect(await f.tool.handler(args as never, {} as never)).toEqual({ isError: true, structuredContent: { error: { code: 'invalid_query', message } } })
    expect(f.acquire).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  } finally { f.restore() }
})
it.each([...invalidFields399, ...strictInvalid399])("handler full schema rejects before DB $case", async ({ args }) => {
  const f = await handler399()
  try {
    expect(await f.tool.handler(args as never, {} as never)).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_query' } } })
    expect(f.acquire).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  } finally { f.restore() }
})
it('handler preserves accepted selectors undefined normalization and content bytes', async () => {
  const f = await handler399()
  try {
    for (const [args, expected] of [
      [{ batchId: 1 }, { batchId: 1 }], [{ receiptId: 2 }, { receiptId: 2 }], [{ idempotencyKey: ' x ' }, { idempotencyKey: ' x ' }],
      [{ batchId: 1, page: 1, pageSize: 20 }, { batchId: 1, page: 1, pageSize: 20 }],
      [{ batchId: 1, receiptId: undefined, idempotencyKey: undefined, page: undefined, pageSize: undefined, projection: undefined, source: undefined, itemIndex: undefined, oldRecordId: undefined, cursor: undefined, maxBytes: undefined }, { batchId: 1 }],
      [snapshot399, snapshot399], [events399, events399],
      [{ batchId: Number.MAX_SAFE_INTEGER, page: 1000000, pageSize: 50 }, { batchId: Number.MAX_SAFE_INTEGER, page: 1000000, pageSize: 50 }],
    ] as const) {
      f.acquire.mockClear(); f.read.mockClear()
      expect(await f.tool.handler(args as never, {} as never)).toEqual({ content: [{ type: 'text', text: '{"batchId":1,"receiptId":null,"status":"committed","page":1,"pageSize":20,"total":0,"rows":[]}' }] })
      expect(f.acquire).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledExactlyOnceWith(f.db, 'items', expected)
    }
    const { ImportReceiptError } = await import('../../../layers/sme-roster/server/utils/import-receipts')
    f.read.mockImplementationOnce(() => { throw new ImportReceiptError(404, 'not_found', 'Import batch or receipt not found') })
    expect(await f.tool.handler({ batchId: 1 } as never, {} as never)).toEqual({ isError: true, structuredContent: { error: { code: 'not_found', message: 'Import batch or receipt not found' } } })
  } finally { f.restore() }
})
it.each(invalidFields399)("SDK field schema rejects legacy $case", async ({ args }) => {
  const { importItemsReadShape } = await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  const { objectFromShape, safeParseAsync } = await import('@modelcontextprotocol/sdk/server/zod-compat.js')
  // Actual installed SDK schema adapter only. SDK server ordering is inspected
  // statically; HTTP/status/result.isError remains a separate UNRUN lane.
  expect((await safeParseAsync(objectFromShape(importItemsReadShape), args)).success).toBe(false)
})
it('SDK raw shape accepts selector combinations for handler validation', async () => {
  const { importItemsReadShape } = await import('../../../layers/sme-roster/server/utils/official-evidence-read')
  const { objectFromShape, safeParseAsync } = await import('@modelcontextprotocol/sdk/server/zod-compat.js')
  for (const args of [{}, { batchId: 1, receiptId: 2 }, { idempotencyKey: '   ' }]) expect((await safeParseAsync(objectFromShape(importItemsReadShape), args)).success).toBe(true)
})
