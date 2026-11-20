import { execFileSync } from 'node:child_process'
import { nativeAppAdapter } from '../../support/native-app'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { reviewFixtureRows } from '../imports/fixtures/reviewed-announcement'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { z } from 'zod'
import * as schema from '../../../db/schema'
import type { OfficialPublishedRow, RosterImportPayload, RosterImportRecord } from '../../../layers/sme-roster/lib/roster-import-client'
import { usccFormatVerdict } from '../../../layers/sme-roster/lib/roster/uscc-research'
import { spawnOwnedChild, spawnCompiledApp, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

// Actual Nuxt routes/toolkit/middleware/JSON-RPC and real import process. Execute only
// with the parent's heavy slot; this suite never uses the SDK's in-memory bridge.
const dir=mkdtempSync('/tmp/issue351-transport-'),filesDir=join(dir,'files'),dbPath=join(dir,'synthetic.sqlite')
for(const name of ['files','incoming','logs','tmp']) mkdirSync(join(dir,name))
writeFileSync(join(dir,'emptydotenv'),'')
const text='synthetic transport official source\n',sha256=createHash('sha256').update(text).digest('hex')
writeFileSync(join(filesDir,'notice.txt'),text)
const sqlite=new Database(dbPath);sqlite.pragma('foreign_keys=ON')
const db=drizzle(sqlite,{schema});createRuntimeSchema(sqlite)
// Infrastructure catalog only; all business fixtures are formed through public commands.
sqlite.prepare("INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(1,'notice.txt','notice.txt','txt',?,?,'synthetic')").run(Buffer.byteLength(text),sha256)
sqlite.exec("INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (1, 'jxj', 'announcement', 'specialized_sme')")
const apiToken='synthetic-c-api',mcpToken='synthetic-c-mcp',trace:unknown[]=[]
let discovery: unknown
let base='',child:ReturnType<typeof spawnOwnedChild>|undefined,sequence=0,seedSequence=0
// Synthetic identities with independently precomputed valid check digits, not registered entities.
const seedUsccs=['913302110000001015','913302110000001028','91330211000000103B','91330211000000104E','91330211000000105H','91330211000000106L'] as const
const usedSeedUsccs=new Set<string>()
beforeAll(async()=>{
  discovery = await readDevelopmentDiscovery()
  const cwd=resolve(import.meta.dirname,'../../..'),port=await reserveLoopbackPort()
  const env:Record<string,string>={}
  for(const key of ['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL']) if(process.env[key]!==undefined) env[key]=process.env[key]!
  Object.assign(env,{TMPDIR:join(dir,'tmp'),NUXT_DB_PATH:dbPath,NUXT_FILES_DIR:filesDir,NUXT_INCOMING_DIR:join(dir,'incoming'),NUXT_LOG_DIR:join(dir,'logs'),NUXT_CURATED_PATH:join(dir,'curated.json'),NUXT_RECONCILE_PATH:join(dir,'reconcile.json'),NUXT_API_TOKEN:apiToken,NUXT_MCP_TOKEN:mcpToken,CI:'1'})
  child=spawnCompiledApp(port,{cwd,stdio:['ignore','pipe','pipe'],env})
  let output='';for(const stream of [child.stdout,child.stderr]) stream?.on('data',data=>{output+=String(data);writeFileSync(join(dir,'nuxt.log'),output)})
  base=`http://127.0.0.1:${port}`
  writeFileSync(join(dir,'owned-launch.json'),JSON.stringify({pid:child.pid,port,envKeys:Object.keys(env),cwd,args:child.spawnargs,defaultBuildDir:join(cwd,'.nuxt')},null,2))
  await waitForHttp(base+'/api/health',{timeoutMs:60000,child})
},90000)
afterAll(async()=>{
  // Awaited commits leave no queued jobs. Stop the owned service before closing SQLite.
  try {expect(sqlite.prepare("SELECT count(*) n FROM job WHERE state IN ('queued','running')").get()).toEqual({n:0})}
  finally {if(child) await stopOwnedChild(child);writeFileSync(join(dir,'public-commands.json'),JSON.stringify(trace,null,2));sqlite.close()}
})
async function http(path:string,body?:unknown,token:string|null=apiToken) {
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
  const output:unknown=await r.json();trace.push({transport:'http',path,body,status:r.status,output})
  return {status:r.status,body:output}
}
const rpcResult=z.object({result:z.object({isError:z.boolean().optional(),content:z.array(z.object({type:z.string(),text:z.string().optional()}))})})
async function rpc(name:string,args:Record<string,unknown>,token:string|null=mcpToken,method='tools/call') {
  const r=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params:method==='tools/list'?{}:{name,arguments:args}})})
  const raw=await r.text(),data=raw.startsWith('event:')?raw.split('\n').find(line=>line.startsWith('data: '))?.slice(6):raw
  const body:unknown=JSON.parse(data??'null');trace.push({transport:'rpc',name,args,status:r.status,body});return {status:r.status,body}
}
function rpcValue(value:Awaited<ReturnType<typeof rpc>>) {
  const result=rpcResult.parse(value.body).result,text=result.content.find(c=>c.type==='text')?.text
  if(text===undefined) throw new Error('Actual MCP text content absent')
  const body:unknown=JSON.parse(text);return {body,isError:result.isError??false}
}
const committedSchema=z.object({status:z.literal('committed'),batchId:z.number(),items:z.array(z.object({kind:z.string(),detail:z.unknown()}).passthrough())}).passthrough()
async function commit(payload:RosterImportPayload,key:string,transport:'http'|'mcp'='http') {
  const request={idempotencyKey:key,sourceKind:'announcement' as const,sourceIdentity:'synthetic-c',payload}
  const plan=transport==='http'?(await http('/api/roster/import/preflight',request)).body:rpcValue(await rpc('preflight_roster_batch',request)).body
  const parsed=z.object({preflight:z.object({conflicts:z.array(z.unknown()),officialEvidencePlanHash:z.string().optional()})}).parse(plan);expect(parsed.preflight.conflicts).toEqual([])
  const bound=parsed.preflight.officialEvidencePlanHash?{...request,payload:{...payload,officialEvidencePlanHash:parsed.preflight.officialEvidencePlanHash}}:request
  const saved=transport==='http'?(await http('/api/roster/import/commit',bound)).body:rpcValue(await rpc('save_roster_batch',bound)).body
  const staged = z.object({ status: z.literal('staged'), intakeId: z.number(), sourceDigest: z.string(), officialEvidencePreflightRequired: z.literal(true).optional() }).safeParse(saved)
  if (staged.success) {
    const path = `/api/roster/import/intake/${staged.data.intakeId}/supplement`
    const review = reviewFixtureRows({ $client: sqlite }, staged.data.sourceDigest, bound)
    const preview = staged.data.officialEvidencePreflightRequired ? await http(path, { ...review, preflight: true }) : undefined
    let officialEvidencePlanHash: string | undefined
    if (preview) {
      expect(preview.status, JSON.stringify(preview.body)).toBe(200)
      const parsed = z.object({ status: z.literal('preflighted'), conflicts: z.array(z.unknown()), officialEvidencePlanHash: z.string() }).parse(preview.body)
      expect(parsed.conflicts).toEqual([])
      officialEvidencePlanHash = parsed.officialEvidencePlanHash
    }
    const result = await http(path, { ...review, officialEvidencePlanHash })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    return { saved: committedSchema.extend({ status: z.literal('supplemented') }).parse(result.body), bound }
  }
  return {saved:committedSchema.parse(saved),bound}
}
const exact=z.object({evidenceId:z.number(),eventId:z.number(),recordId:z.number(),enterpriseId:z.number()})
async function seed(merge=false,transport:'http'|'mcp'='http') {
  const ordinal=++seedSequence,targetUscc=seedUsccs[ordinal-1]
  if(!targetUscc) throw new Error('Synthetic seed identity exhausted')
  expect(usccFormatVerdict(targetUscc)).toBe('ok');expect(usedSeedUsccs.has(targetUscc)).toBe(false);usedSeedUsccs.add(targetUscc)
  const marker='source-'+ordinal,row=(nameRaw:string,listNo:number):OfficialPublishedRow=>({nameRaw,usccRaw:null,districtRaw:'原属地',declaration:{kind:'independent',sourceDocument:{source:'jxj',title:marker,docNumber:null,issueDate:null,path:'notice.txt'},basis:'Explicit separate publication verified'},storedFileId:1,path:'notice.txt',sha256,bytes:Buffer.byteLength(text),attachment:null,sectionKey:'名单',listNo,page:null,sourceBindingKnown:true,actor:{type:'agent',id:'synthetic-c'},basis:'Verified exact source row'})
  const records:RosterImportRecord[]=[{enterprise:{name:marker+'旧名'},titleCode:'specialized_sme',events:[{eventType:'award',year:2021,evidence:[{sourceFile:'notice.txt',attachment:null,listNo:1,page:null,publishedRow:row('2021旧名',1)}]}]},{enterprise:{name:marker+'现名',uscc:targetUscc},titleCode:'specialized_sme',events:[{eventType:'award',year:2024,evidence:[{sourceFile:'notice.txt',attachment:null,listNo:2,page:null,publishedRow:row('2024新名',2)}]}]}]
  const initial=await commit({announcement:{sourceDocument:{source:'jxj',title:marker},records}},marker,transport)
  const captures=z.array(z.object({evidence_id:z.number(),event_id:z.number(),captured_record_id:z.number(),captured_enterprise_id:z.number()})).parse(sqlite.prepare("SELECT evidence_id,event_id,captured_record_id,captured_enterprise_id FROM official_evidence_row_revision WHERE import_batch_id=? AND command_kind='import' AND name_raw=? AND list_no=? AND revision=1 LIMIT 2").all(initial.saved.batchId,'2021旧名',1))
  expect(captures).toHaveLength(1)
  const captured=captures[0]!
  const old=exact.parse((await http('/api/roster/evidence/'+captured.evidence_id)).body)
  expect(old).toEqual({evidenceId:captured.evidence_id,eventId:captured.event_id,recordId:captured.captured_record_id,enterpriseId:captured.captured_enterprise_id})
  if(!merge) return {old,oldName:marker+'旧名'}
  const saved=await commit({merges:[{fromEnterpriseId:old.enterpriseId,intoUscc:targetUscc,note:'Verified same legal enterprise'}]},marker+'-merge',transport)
  const itemIndex=saved.saved.items.findIndex(item=>item.kind==='merge'),batchId=saved.saved.batchId
  const receipt=z.object({id:z.number()}).parse(sqlite.prepare('SELECT id FROM import_receipt WHERE batch_id=? ORDER BY id DESC LIMIT 1').get(batchId))
  return {old,oldName:marker+'旧名',merged:{...saved,batchId,itemIndex,receiptId:receipt.id,oldRecordId:old.recordId}}
}
function query(args:Record<string,string|number>) {return new URLSearchParams(Object.entries(args).map(([k,v])=>[k,String(v)])).toString()}

it('discovers bounded opt-in fields on actual OpenAPI and MCP schemas while keeping old exact tools public',async()=>{
  const tools=z.object({result:z.object({tools:z.array(z.object({name:z.string(),inputSchema:z.record(z.string(),z.unknown())}))})}).parse((await rpc('',{},null,'tools/list')).body).result.tools
  expect(tools.map(t=>t.name)).toContain('get_roster_evidence');expect(tools.map(t=>t.name)).toContain('get_official_event');expect(tools.map(t=>t.name)).not.toContain('list_roster_import_items')
  const evidence=tools.find(t=>t.name==='get_roster_evidence')!;expect(evidence.inputSchema).toMatchObject({properties:{official:{enum:['latest','history']},pageSize:{maximum:50},maxBytes:{maximum:65536}}})
  const auth=z.object({result:z.object({tools:z.array(z.object({name:z.string(),inputSchema:z.record(z.string(),z.unknown())}))})}).parse((await rpc('',{},mcpToken,'tools/list')).body).result.tools
  expect(auth.find(t=>t.name==='list_roster_import_items')?.inputSchema).toMatchObject({properties:{projection:{enum:['snapshot','eventIds','qualification']},source:{enum:['private_batch','redacted_receipt']},itemIndex:{minimum:0}}})
  const serialized=JSON.stringify(discovery);for(const field of ['beforeRevision','afterEvidenceId','oldRecordId','storedRedacted','requiredBytes','officialEvidencePlanHash','/api/roster/import/intake/{id}/supplement']) expect(serialized).toContain(field)
})
it('reads exact fact evidence and event with HTTP and actual MCP JSON-RPC parity after public worker writes',async()=>{
  const s=await seed(false,'mcp')
  for(const [path,name,args] of [[`/api/roster/evidence/${s.old.evidenceId}?official=latest`,'get_roster_evidence',{id:s.old.evidenceId,official:'latest'}],[`/api/roster/events/${s.old.eventId}?official=latest`,'get_official_event',{eventId:s.old.eventId,official:'latest'}]] as const) {
    const rest=await http(path);expect(rest.status).toBe(200);expect(rest.body).toMatchObject(name==='get_roster_evidence'?{official:{row:{nameRaw:'2021旧名',path:'notice.txt',sha256,bytes:Buffer.byteLength(text)}}}:{official:{rows:[{nameRaw:'2021旧名'}]}});const mcp=rpcValue(await rpc(name,args));expect(mcp.isError).toBe(false);expect(mcp.body).toEqual(rest.body)
  }
  expect((await http(`/api/roster/evidence/${s.old.evidenceId}`,undefined,null)).status).toBe(200)
  expect(rpcValue(await rpc('get_roster_evidence',{id:s.old.evidenceId},null)).body).toEqual((await http(`/api/roster/evidence/${s.old.evidenceId}`,undefined,null)).body)
})
it('preflights and captures a no-USCC official row for the manually selected same-name enterprise', async () => {
  const name = '同名公布证据企业'
  const first = await http('/api/core/enterprises', { name })
  const second = await http('/api/core/enterprises', { name, uscc: '91330226MA2CL6FP2U' })
  expect([first.status, second.status]).toEqual([200, 200])
  const owner = z.object({ id: z.number(), revision: z.number() }).parse(second.body)
  const row = {
    nameRaw: '  同名公布证据企业  ', usccRaw: null, districtRaw: '原属地',
    declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: '人工核对公布', docNumber: null, issueDate: null, path: 'notice.txt' }, basis: '已核对公布文档' },
    storedFileId: 1, path: 'notice.txt', sha256, bytes: Buffer.byteLength(text), attachment: null,
    sectionKey: '人工核对名单', listNo: 11, page: null, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic' }, basis: '已核对原行',
  } satisfies OfficialPublishedRow
  const request = { idempotencyKey: 'reviewed-source-row', sourceKind: 'announcement', sourceIdentity: 'notice.txt',
    payload: { announcement: { sourceDocument: { source: 'jxj', title: '人工核对公布' }, records: [
      { enterprise: { name }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2022, evidence: [{ sourceFile: 'notice.txt', attachment: null, listNo: 11, page: null, publishedRow: row }] }] },
    ] } } }
  const original = await http('/api/roster/import/preflight', request)
  expect(original.body).toMatchObject({ preflight: { conflicts: [{ error: { code: 'enterprise_ambiguous' } }] } })
  const staged = z.object({ status: z.literal('staged'), intakeId: z.number(), sourceDigest: z.string(), officialEvidencePreflightRequired: z.literal(true) })
    .parse(rpcValue(await rpc('save_roster_batch', request)).body)
  const path = `/api/roster/import/intake/${staged.intakeId}`
  const review = { sourceDigest: staged.sourceDigest, basis: '核对两家同名企业后选定第二家', rows: [{ action: 'attach', enterpriseId: owner.id, expectedRevision: owner.revision }] }
  expect((await http(path + '/supplement', { ...review, preflight: true }, null)).status).toBe(401)
  const preflight = await http(path + '/supplement', { ...review, preflight: true })
  expect(preflight.status).toBe(200)
  expect(preflight.body).toEqual({ status: 'preflighted', conflicts: [], officialEvidencePlanHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  const officialEvidencePlanHash = z.object({ officialEvidencePlanHash: z.string() }).parse(preflight.body).officialEvidencePlanHash
  expect((await http(path)).body).toMatchObject({ status: 'staged', receipt: null, review: null, officialEvidencePreflightRequired: true })
  const receipt = await http(path + '/supplement', { ...review, officialEvidencePlanHash })
  expect(receipt.status).toBe(200)
  expect(receipt.body).toMatchObject({ status: 'supplemented', owners: [owner.id] })
  const captured = z.object({ evidence_id: z.number(), captured_enterprise_id: z.number(), name_raw: z.string(), uscc_raw: z.null() })
    .parse(sqlite.prepare('SELECT evidence_id,captured_enterprise_id,name_raw,uscc_raw FROM official_evidence_row_revision WHERE section_key=?').get(row.sectionKey))
  expect(captured).toMatchObject({ captured_enterprise_id: owner.id, name_raw: row.nameRaw, uscc_raw: null })
  const published = await http(`/api/roster/evidence/${captured.evidence_id}?official=latest`)
  expect(published.body).toMatchObject({ enterpriseId: owner.id, official: { row: { nameRaw: row.nameRaw, usccRaw: null } } })
  expect(await http(path + '/supplement', { ...review, officialEvidencePlanHash })).toEqual(receipt)
})

it('authenticates sensitive opt-in independently on actual HTTP and MCP before malformed or missing selectors',async()=>{
  for(const token of [null,mcpToken]) expect((await http('/api/roster/evidence/999999?official=latest',undefined,token)).status).toBe(401)
  for(const token of [null,apiToken]) expect((await rpc('get_roster_evidence',{id:999999,official:'latest'},token)).status).toBe(401)
  expect((await rpc('get_official_event',{eventId:999999,official:'latest'},null)).status).toBe(401)
  expect((await rpc('list_roster_import_items',{projection:'snapshot',source:'private_batch',batchId:1,itemIndex:0,oldRecordId:1},null)).status).toBe(401)
})
it('rejects unknown fields wrong combinations and invalid bounds through original actual JSON-RPC bodies',async()=>{
  for(const [name,args] of [['get_roster_evidence',{id:1,official:'latest',extra:1}],['get_roster_evidence',{id:1,official:'latest',beforeRevision:1}],['get_official_event',{eventId:1,official:'latest',pageSize:51}],['list_roster_import_items',{projection:'snapshot',source:'private_batch',batchId:1,receiptId:1,itemIndex:0,oldRecordId:1}],['list_roster_import_items',{projection:'eventIds',source:'private_batch',batchId:1,itemIndex:0,oldRecordId:1,maxBytes:65537}]] as const) {
    const r=await rpc(name,args);expect(r.status).toBe(400);expect(r.body).toMatchObject({error:{code:-32602}})
  }
})
it('selects private merge origin and paged event IDs with transport parity and no first-retry-outcome leakage',async()=>{
  const s=await seed(true,'mcp');expect(s.merged).toBeDefined();const m=s.merged!,selector={source:'private_batch',batchId:m.batchId,itemIndex:m.itemIndex,oldRecordId:m.oldRecordId}
  const before=sqlite.prepare('SELECT item_results FROM import_batch WHERE id=?').get(m.batchId)
  for(const projection of ['snapshot','eventIds']) {
    const args={...selector,projection},rest=await http('/api/roster/import/receipts/items?'+query(args));expect(rest.status).toBe(200)
    expect(rpcValue(await rpc('list_roster_import_items',args)).body).toEqual(rest.body)
    if(projection==='snapshot') expect(rest.body).toMatchObject({source:'private_batch',storedRedacted:false,responseRedacted:true,availability:'available',snapshot:{id:s.old.recordId,enterpriseId:s.old.enterpriseId,nameRaw:s.oldName}})
    else {expect(rest.body).toMatchObject({eventIds:[s.old.eventId],nextCursor:null});expect(rest.body).not.toHaveProperty('snapshot')}
  }
  const first=JSON.stringify(m.saved),retry=JSON.stringify(rpcValue(await rpc('save_roster_batch',m.bound)).body)
  for(const output of [first,retry]){expect(output).not.toContain('fromRecordSnapshot');expect(output).not.toContain('eventIds');expect(output).toContain('snapshotRef')}
  expect(sqlite.prepare('SELECT item_results FROM import_batch WHERE id=?').get(m.batchId)).toEqual(before)
})
it('reports explicitly unretained receipt snapshots without batch fallback on both real transports',async()=>{
  const s=await seed(true),m=s.merged!,args={projection:'snapshot',source:'redacted_receipt',receiptId:m.receiptId,itemIndex:m.itemIndex,oldRecordId:m.oldRecordId}
  const rest=await http('/api/roster/import/receipts/items?'+query(args));expect(rest.status).toBe(200);expect(rest.body).toMatchObject({availability:'not_retained',source:'redacted_receipt',storedRedacted:true,responseRedacted:true});expect(rest.body).not.toHaveProperty('snapshot')
  expect(rpcValue(await rpc('list_roster_import_items',args)).body).toEqual(rest.body)
})
it('preserves structured budget errors and history pages across actual transports',async()=>{
  const s=await seed(),path=`/api/roster/evidence/${s.old.evidenceId}`,rest=await http(path+'?official=latest&maxBytes=1')
  expect(rest.status).toBe(413);expect(rest.body).toMatchObject({error:{code:'response_limit'}})
  const denied=rpcValue(await rpc('get_roster_evidence',{id:s.old.evidenceId,official:'latest',maxBytes:1}));expect(denied.isError).toBe(true);expect(denied.body).toEqual(rest.body)
  const history=await http(path+'?official=history&pageSize=1');expect(history.status).toBe(200);expect(rpcValue(await rpc('get_roster_evidence',{id:s.old.evidenceId,official:'history',pageSize:1})).body).toEqual(history.body)
})

it('rejects out of range and mismatched event cursors with real transport error parity',async()=>{
  const s=await seed(true),m=s.merged!,selector={projection:'eventIds',source:'private_batch',batchId:m.batchId,itemIndex:m.itemIndex,oldRecordId:m.oldRecordId}
  const cursor=Buffer.from(JSON.stringify({source:'private_batch',sourceId:m.batchId,itemIndex:m.itemIndex,oldRecordId:m.oldRecordId,afterIndex:999999})).toString('base64url')
  for(const value of ['invalid-cursor',cursor]) {
    const args={...selector,cursor:value},rest=await http('/api/roster/import/receipts/items?'+query(args));expect(rest.status).toBe(400);expect(rest.body).toMatchObject({error:{code:'invalid_query'}})
    const mcp=rpcValue(await rpc('list_roster_import_items',args));expect(mcp.isError).toBe(true);expect(mcp.body).toEqual(rest.body)
  }
})
it('enforces the 300 and 301 event source boundary over real HTTP and MCP without cursor bypass',async()=>{
  const s=await seed(),insert=sqlite.prepare("INSERT INTO record_evidence(record_event_id,source_file,list_no) VALUES(?,'notice.txt',?)")
  // Explicit oversized historical fixture, after genuine public command setup.
  for(let i=2;i<=300;i++) insert.run(s.old.eventId,10000+i)
  const args={eventId:s.old.eventId,official:'latest',afterEvidenceId:999999},path=`/api/roster/events/${s.old.eventId}?official=latest&afterEvidenceId=999999`
  const at=await http(path);expect(at.status).toBe(200);expect(at.body).toMatchObject({official:{rows:[]}});expect(rpcValue(await rpc('get_official_event',args)).body).toEqual(at.body)
  insert.run(s.old.eventId,10301)
  const over=await http(path);expect(over.status).toBe(413);expect(over.body).toMatchObject({error:{code:'source_limit'}})
  const mcp=rpcValue(await rpc('get_official_event',args));expect(mcp.isError).toBe(true);expect(mcp.body).toEqual(over.body)
})

// #399: Nuxt dev + fetch regressions. Added for the parent's heavy lane;
// these are not compiled-server/SDK-client evidence and are UNRUN in this change.
it('transport legacy SDK field errors retain HTTP200 tool results', async () => {
  for (const args of [{ batchId: 1, page: 0 }, { batchId: 1, page: 1000001 }, { batchId: 1, pageSize: 0 }, { batchId: 1, pageSize: 51 }, { batchId: 1, pageSize: 2.5 }, { batchId: null }, { batchId: '1' }, { batchId: 1, pageSize: null }, { batchId: 1, pageSize: true }]) {
    const result = await rpc('list_roster_import_items', args)
    expect(result.status).toBe(200)
    expect(result.body).not.toHaveProperty('error')
    const tool = rpcResult.parse(result.body).result
    expect(tool.isError).toBe(true)
    expect(tool.content).toEqual([{ type: 'text', text: expect.stringContaining('Input validation error: Invalid arguments for tool list_roster_import_items:') }])
  }
})
it('transport legacy selectors retain original domain error results', async () => {
  for (const [args, message] of [[{}, 'Supply exactly one batchId, idempotencyKey or receiptId'], [{ batchId: 1, receiptId: 2 }, 'Supply exactly one batchId, idempotencyKey or receiptId'], [{ idempotencyKey: '   ' }, 'Invalid idempotencyKey']] as const) {
    const result = await rpc('list_roster_import_items', args)
    expect(result.status).toBe(200); expect(result.body).not.toHaveProperty('error')
    expect(rpcValue(result)).toEqual({ isError: true, body: { error: { code: 'invalid_query', message } } })
  }
})
it('transport auth and opt-in errors keep top-level envelopes', async () => {
  for (const token of [null, 'wrong-399-token', apiToken]) {
    for (const args of [{ batchId: 1, pageSize: 51 }, {}, { projection: 'snapshot', source: 'private_batch', batchId: 1 }]) {
      const result = await rpc('list_roster_import_items', args, token)
      expect(result.status).toBe(401); expect(result.body).toMatchObject({ error: { code: -32001 } }); expect(result.body).not.toHaveProperty('result')
    }
  }
  for (const args of [{ batchId: 1, extra: 1 }, { batchId: 1, projection: null }, { batchId: 1, source: 'default' }, { batchId: 1, itemIndex: 0 }, { projection: 'snapshot', source: 'private_batch', batchId: 1, itemIndex: 0, oldRecordId: 1, pageSize: 20 }, { projection: 'eventIds', source: 'redacted_receipt', receiptId: 1, itemIndex: 0, oldRecordId: 1, pageSize: 51 }]) {
    const result = await rpc('list_roster_import_items', args)
    expect(result.status).toBe(400); expect(result.body).toMatchObject({ error: { code: -32602 } }); expect(result.body).not.toHaveProperty('result')
  }
})
it('transport three legacy selectors and explicit defaults preserve content bytes', async () => {
  // Reuse the existing public command/lifecycle without consuming the six
  // historical official-capture seed identities or changing their oracle.
  const key = '399-legacy-normal'
  const saved = await commit({ announcement: { sourceDocument: { source: 'jxj', title: key }, records: [{ enterprise: { name: key }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021, evidence: [{ sourceFile: 'notice.txt', listNo: 399 }] }] }] } }, key)
  const batchId = saved.saved.batchId
  const receiptId = z.object({ id: z.number() }).parse(sqlite.prepare('SELECT id FROM import_receipt WHERE batch_id=? ORDER BY id DESC LIMIT 1').get(batchId)).id
  const rest = await http('/api/roster/import/receipts/items?batchId=' + batchId)
  expect(rest.status).toBe(200); expect(rest.body).toMatchObject({ batchId, receiptId, page: 1, pageSize: 20 })
  const expectedText = JSON.stringify(rest.body)
  for (const args of [{ batchId }, { receiptId }, { idempotencyKey: key }, { batchId, page: 1, pageSize: 20 }]) {
    const result = await rpc('list_roster_import_items', args)
    expect(result.status).toBe(200)
    expect(rpcResult.parse(result.body).result.content).toEqual([{ type: 'text', text: expectedText }])
    expect(rpcValue(result)).toEqual({ isError: false, body: rest.body })
  }
})
it('transport other legacy receipt tools retain SDK field errors', async () => {
  for (const args of [{ batchId: 1, page: 0 }, { batchId: 1, page: 1000001 }, { batchId: 1, pageSize: 0 }, { batchId: 1, pageSize: 51 }, { batchId: 1, pageSize: 2.5 }]) {
    const result = await rpc('list_roster_import_receipts', args)
    expect(result.status).toBe(200); expect(result.body).not.toHaveProperty('error'); expect(rpcResult.parse(result.body).result.isError).toBe(true)
  }
  const result = await rpc('get_roster_import_request', { batchId: 1, maxBytes: 65537 })
  expect(result.status).toBe(200); expect(result.body).not.toHaveProperty('error'); expect(rpcResult.parse(result.body).result.isError).toBe(true)
})

const pgBin = process.env.TEST_IMPORT_RECEIPTS_PG_BIN
it.runIf(!!pgBin)('reads migrated import receipts and exact immutable projections with HTTP and MCP parity', async () => {
  const pgDir = mkdtempSync('/tmp/receipt-pg-')
  const url = 'postgresql://receipt_fixture@localhost/postgres?host=' + encodeURIComponent(pgDir)
  const app = nativeAppAdapter({ dir: pgDir, token: apiToken, launch: ({ cwd, port }) => ({
    args: [join(cwd, '.output/server/index.mjs')],
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NUXT_MCP_TOKEN: mcpToken,
      NUXT_DB_READONLY: '1', NUXT_POSTGRES_ROSTER_READ: '1', NUXT_POSTGRES_DIRECTORY_URL: url },
  }) })
  const env = {
    PATH: process.env.PATH, LANG: 'C', PGHOST: pgDir, PGPORT: '5432', PGDATABASE: 'postgres',
    PGUSER: 'receipt_fixture', PGSQL_BIN: join(pgBin!, 'psql'),
  }
  const run = (command: string, args: string[]) => execFileSync(join(pgBin!, command), args, { env, stdio: 'pipe' })
  let started = false
  try {
    const event = sqlite.prepare(`
      SELECT ev.id, e.uscc_norm AS uscc FROM record_event ev
      JOIN record r ON r.id=ev.record_id JOIN enterprise e ON e.id=r.enterprise_id
      WHERE r.source='jxj' AND r.title_code='specialized_sme' AND e.uscc_norm IS NOT NULL ORDER BY ev.id LIMIT 1
    `).get() as { id: number; uscc: string }
    const snapshot = {
      idempotencyKey: 'correspondence-source', sourceKind: 'platform_export', sourceIdentity: 'history-test.xlsx',
      payload: { exportSnapshot: {
        titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-11-20', originalFilename: 'history-test.xlsx', sha256: 'b'.repeat(64),
        rows: [{ sourceRowNo: 2, nameRaw: '测试来源企业', usccRaw: event.uscc, rawFields: { password: 'synthetic-private-history-value', preserved: '原始信息' } }],
      } },
    }
    const imported = await http('/api/roster/import/commit', snapshot)
    expect(imported.body).toMatchObject({ status: 'committed' })
    const { id: exportRowId } = sqlite.prepare("SELECT id FROM platform_export_row ORDER BY id DESC LIMIT 1").get() as { id: number }
    const decision = {
      idempotencyKey: 'correspondence-history', sourceIdentity: 'history-test.xlsx',
      actor: { type: 'agent', id: 'tester' }, basis: '测试审计依据', ruleId: 'manual-review', ruleVersion: '1',
      operations: [{ action: 'create', status: 'candidate', edge: {
        type: 'event_export_context', eventId: event.id, exportRowId, role: 'current_snapshot_context',
      } }],
    }
    const preview = await http('/api/roster/correspondences/preflight', decision)
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    const { planHash } = z.object({ planHash: z.string() }).parse(preview.body)
    const saved = await http('/api/roster/correspondences/commit', { request: decision, planHash })
    expect(saved.status).toBe(200)
    const { correspondenceIds: [correspondenceId] } = z.object({ correspondenceIds: z.array(z.number()).length(1) }).parse(saved.body)

    installLeadListSchema(sqlite)
    run('initdb', ['-A', 'trust', '-E', 'UTF8', '--locale=C', '-U', 'receipt_fixture', '-D', join(pgDir, 'pg')])
    run('pg_ctl', ['-w', '-D', join(pgDir, 'pg'), '-l', join(pgDir, 'pg.log'), '-o', "-c listen_addresses='' -k " + pgDir, 'start'])
    started = true
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', dbPath, 'staged'], { env, stdio: 'pipe' })
    for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
      run('psql', ['-X', '-w', '-q', '-v', 'staging=staged', '-f', 'upgrade/postgresql/materialize-' + name + '.sql'])
    }
    await app.start()
    const batch = sqlite.prepare("SELECT id,item_results FROM import_batch WHERE idempotency_key LIKE '%-merge' AND status='committed' ORDER BY id LIMIT 1").get() as { id: number; item_results: string }
    const items = JSON.parse(batch.item_results)
    const itemIndex = items.findIndex((item: { kind: string }) => item.kind === 'merge')
    const { fromRecordId: oldRecordId } = items[itemIndex].detail.lineage.recordsFolded[0]
    const { id: receiptId } = sqlite.prepare("SELECT id FROM import_receipt WHERE batch_id=? ORDER BY id DESC LIMIT 1").get(batch.id) as { id: number }
    const { id: grantBatchId, item_results: grantItems } = sqlite.prepare("SELECT id,item_results FROM import_batch WHERE status='committed' AND idempotency_key NOT LIKE '%-merge' ORDER BY id LIMIT 1").get() as { id: number; item_results: string }
    const grantIndex = JSON.parse(grantItems).findIndex((item: { kind: string }) => item.kind === 'record_event')
    const selector = { batchId: batch.id, source: 'private_batch', itemIndex, oldRecordId }
    const calls = [
      ['', 'get_roster_import_receipt', { receiptId }],
      ['/history', 'list_roster_import_receipts', { batchId: batch.id, pageSize: 1 }],
      ['/request', 'get_roster_import_request', { receiptId, offset: 3, maxBytes: 17 }],
      ['/items', 'list_roster_import_items', { batchId: batch.id, pageSize: 1 }],
      ['/items', 'list_roster_import_items', { ...selector, projection: 'snapshot' }],
      ['/items', 'list_roster_import_items', { ...selector, projection: 'eventIds', pageSize: 1 }],
      ['/items', 'list_roster_import_items', { projection: 'snapshot', receiptId, source: 'redacted_receipt', itemIndex, oldRecordId }],
      ['/items', 'list_roster_import_items', { projection: 'qualification', batchId: grantBatchId, source: 'private_batch', itemIndex: grantIndex }],
    ] as const
    const historyCalls = [
      [`/api/roster/correspondences/${correspondenceId}/audit?pageSize=1`, 'get_record_correspondence_audit', { id: correspondenceId!, pageSize: 1 }],
      ['/api/roster/correspondences/batches/' + decision.idempotencyKey, 'get_record_correspondence_batch', { idempotencyKey: decision.idempotencyKey }],
    ] as const
    for (const [path, name, args] of [...calls.map(([suffix, name, args]) =>
      ['/api/roster/import/receipts' + suffix + '?' + query(args), name, args] as const), ...historyCalls]) {
      const expected = await http(path)
      expect(expected.status, path).toBe(200)
      const response = await app.request(path)
      const body = await response.json()
      expect(response.status, JSON.stringify({ path, body })).toBe(200)
      expect(body, path).toEqual(expected.body)
      if (name === 'get_record_correspondence_audit') {
        expect(body).toMatchObject({ rows: [{ toStatus: 'candidate', actorId: 'tester', evidence: expect.any(Object) }], total: 1, page: 1, pageSize: 1 })
        expect(JSON.stringify(body)).not.toContain('synthetic-private-history-value')
      }
      if (name === 'get_record_correspondence_batch') expect(body).toEqual(saved.body)
      const remote = await app.request('/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18', authorization: 'Bearer ' + mcpToken },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      })
      const raw = await remote.text()
      const text = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw
      expect(JSON.parse(JSON.parse(text).result.content[0].text), name).toEqual(expected.body)
    }
    const batchPath = '/api/roster/correspondences/batches/' + decision.idempotencyKey
    const unauthorized = await app.request(batchPath, { headers: {} })
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual((await http(batchPath, undefined, null)).body)
    const missing = await app.request('/api/roster/correspondences/batches/' + snapshot.idempotencyKey)
    expect(missing.status).toBe(404)
    const invalidAudit = await app.request(`/api/roster/correspondences/${correspondenceId}/audit?pageSize=201`)
    expect(invalidAudit.status).toBe(400)

    const bounded = '/api/roster/import/receipts/items?' + query({ ...selector, projection: 'snapshot', maxBytes: 1 })
    const expected = await http(bounded)
    const response = await app.request(bounded)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual(expected.body)

    const exportPath = '/api/export?title=specialized_sme&q=source-1'
    const workbookRows = async (response: Response) => {
      expect(response.status).toBe(200)
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(await response.arrayBuffer())
      return workbook.getWorksheet('台账')!.getSheetValues()
    }
    const [legacyRows, nativeRows] = await Promise.all([
      workbookRows(await fetch(base + exportPath)), workbookRows(await app.request(exportPath)),
    ])
    expect(nativeRows).toEqual(legacyRows)
    expect(JSON.stringify(nativeRows)).toContain('2021旧名')
  } finally {
    await app.close()
    if (started) run('pg_ctl', ['-w', '-D', join(pgDir, 'pg'), '-m', 'fast', 'stop'])
    rmSync(pgDir, { recursive: true, force: true })
  }
}, 90_000)
