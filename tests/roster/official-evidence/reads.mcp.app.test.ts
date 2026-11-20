import { execFileSync } from 'node:child_process'
import { readLatestOfficialEvidence } from '../../../layers/sme-roster/server/utils/official-evidence'
import { nativeAppAdapter } from '../../support/native-app'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { reviewFixtureRows } from '../imports/fixtures/reviewed-announcement'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      NUXT_DB_READONLY: '1', NUXT_POSTGRES_ROSTER_READ: '1', NUXT_POSTGRES_DIRECTORY_URL: url,
      NUXT_POSTGRES_DIRECTORY_WRITE: '1', NUXT_FILES_DIR: filesDir },
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

    const firstOwner = sqlite.prepare('SELECT r.enterprise_id AS id FROM record_event e JOIN record r ON r.id=e.record_id WHERE e.id=?').get(event.id) as { id: number }
    const scope = { enterpriseId: firstOwner.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
    const legacyDecision = { ...scope, action: 'replace', expectedCurrentId: null, idempotencyKey: 'native-decision-read',
      actor: { type: 'agent', id: 'decision-fixture' }, basis: 'Synthetic source decision', ruleVersion: 'fixture', effectiveAt: '2026-10-18T00:00:00Z',
      decision: { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' } }
    const savedDecision = await http('/api/roster/decision-lifecycle/commands', legacyDecision)
    expect(savedDecision.status, JSON.stringify(savedDecision.body)).toBe(200)
    const decisionVersionId = z.object({ versionId: z.number() }).parse(savedDecision.body).versionId
    const withdrawal = await http('/api/roster/decision-lifecycle/commands', {
      ...scope, action: 'withdraw', expectedCurrentId: decisionVersionId, idempotencyKey: 'native-decision-withdraw',
      actor: legacyDecision.actor, basis: legacyDecision.basis, ruleVersion: legacyDecision.ruleVersion, effectiveAt: legacyDecision.effectiveAt,
    })
    expect(withdrawal.status, JSON.stringify(withdrawal.body)).toBe(200)

    const activeScope = { ...scope, direction: 'extra_in_miit' }
    const active = await http('/api/roster/decision-lifecycle/commands', { ...legacyDecision, ...activeScope, idempotencyKey: 'native-impact-decision' })
    expect(active.status, JSON.stringify(active.body)).toBe(200)
    const activeDecisionId = z.object({ versionId: z.number() }).parse(active.body).versionId

    const secondScope = { ...activeScope, titleCode: 'little_giant' }
    const second = await http('/api/roster/decision-lifecycle/commands', { ...legacyDecision, ...secondScope, idempotencyKey: 'native-second-impact' })
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    const secondDecisionId = z.object({ versionId: z.number() }).parse(second.body).versionId
    const archivedAt = '2026-10-09T01:08:28Z'
    const archived = await http('/api/roster/import/commit', {
      idempotencyKey: 'native-qualification-source', sourceKind: 'alias_evidence', sourceIdentity: '合成工信部来源',
      payload: { platformQueries: [{ interface: 'business_list', queryKey: event.uscc, titleCode: scope.titleCode, rdjb: '2',
        queriedAt: archivedAt, status: 'success', rawResponse: '{}', relations: [{ sequenceNo: 1, enterpriseId: firstOwner.id, usccRaw: event.uscc,
          nameRaw: '合成迁入核验', matchBasis: 'uscc', verificationStatus: 'confirmed' }] }] },
    })
    expect(archived.status, JSON.stringify(archived.body)).toBe(200)
    expect(archived.body).toMatchObject({ status: 'committed' })
    const archiveCoordinates = sqlite.prepare(`SELECT q.old_id AS queryId,r.old_id AS relationId FROM platform_legacy_query_alias q
      JOIN platform_collection c ON c.id=q.collection_id JOIN platform_business_observation o ON o.collection_id=c.id
      JOIN platform_legacy_relation_alias r ON r.observation_id=o.id WHERE c.query_key=? AND c.queried_at=?`)
      .get(event.uscc, archivedAt) as { queryId: number; relationId: number }
    expect(archiveCoordinates).toMatchObject({ queryId: expect.any(Number), relationId: expect.any(Number) })

    installLeadListSchema(sqlite)
    run('initdb', ['-A', 'trust', '-E', 'UTF8', '--locale=C', '-U', 'receipt_fixture', '-D', join(pgDir, 'pg')])
    run('pg_ctl', ['-w', '-D', join(pgDir, 'pg'), '-l', join(pgDir, 'pg.log'), '-o', "-c listen_addresses='' -k " + pgDir, 'start'])
    started = true
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', dbPath, 'staged'], { env, stdio: 'pipe' })
    for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
      run('psql', ['-X', '-w', '-q', '-v', 'staging=staged', '-f', 'upgrade/postgresql/materialize-' + name + '.sql'])
    }
    await app.start()
    const entries = new URLSearchParams(Object.entries(scope).map(([key, value]) => [key, String(value)]))
    const decisionReads = [
      ['/api/roster/decision-lifecycle/current?' + entries, 'get_current_difference_decision', scope],
      ['/api/roster/decision-lifecycle/' + decisionVersionId, 'get_difference_decision', { id: decisionVersionId }],
      ['/api/roster/decision-lifecycle/history?' + entries + '&pageSize=1&page=2', 'list_difference_decision_history', { ...scope, page: 2, pageSize: 1 }],
    ] as const
    const nativeTool = async (name: string, args: Record<string, unknown>) => {
      const response = await app.request('/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18', authorization: 'Bearer ' + mcpToken },
        body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name, arguments: args } }),
      })
      const raw = await response.text()
      const content = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
      return rpcValue({ status: response.status, body: content })
    }
    for (const [path, name, args] of decisionReads) {
      const source = await http(path), native = await app.request(path)
      expect(source.status, JSON.stringify(source.body)).toBe(200)
      expect(native.status, await native.clone().text()).toBe(200)
      expect(await native.json()).toEqual(source.body)
      expect(await nativeTool(name, args)).toEqual({ body: source.body, isError: false })
    }
    const listScope = { title: scope.titleCode, direction: scope.direction, pageSize: 1 }
    expect(await nativeTool('list_differences', listScope)).toEqual(rpcValue(await rpc('list_differences', listScope)))
    for (const query of ['pageSize=4', 'pageSize=1&page=2&q=source', 'pageSize=6&title=specialized_sme&direction=missing_in_miit']) {
      const path = '/api/roster/differences?' + query
      const legacy = await http(path)
      const response = await app.request(path)
      expect(legacy.status, JSON.stringify(legacy.body)).toBe(200)
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.json()).toEqual(legacy.body)
    }

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

    const { evidenceId } = sqlite.prepare('SELECT evidence_id AS evidenceId FROM official_evidence_row_revision WHERE source_binding_known=1 ORDER BY evidence_id LIMIT 1').get() as { evidenceId: number }
    const exactPath = '/api/roster/evidence/' + evidenceId
    const row = await (await app.request(exactPath)).json()
    expect(row).toEqual((await http(exactPath)).body)
    const { sourceDocumentId, revision, nameRaw, usccRaw, districtRaw, storedFileId, path, sha256: sourceHash, bytes, attachment, sectionKey, listNo, page, sourceBindingKnown } =
      readLatestOfficialEvidence(db, evidenceId).row!
    const actor = { type: 'agent', id: 'native-evidence-review' }, basis = '按原件更正原文'
    const change = { idempotencyKey: 'native-exact-evidence', actor, basis, operations: [{
      evidenceId, eventId: row.eventId, recordId: row.recordId, enterpriseId: row.enterpriseId,
      expectedVersion: row.version, expectedRowRevision: revision, coordinate: row.coordinate,
      publishedRow: { nameRaw: nameRaw + '（更正）', usccRaw, districtRaw, storedFileId, path, sha256: sourceHash, bytes, attachment,
        sectionKey, listNo, page, sourceBindingKnown, declaration: { kind: 'existing', sourceDocumentId, basis }, actor, basis },
    }] }
    const correction = (operation: string, body: unknown) => app.request('/api/roster/evidence/corrections/' + operation, {
      method: 'POST', body: JSON.stringify(body),
    })
    const before = await http('/api/roster/evidence/corrections/preflight', change)
    expect(before.status, JSON.stringify(before.body)).toBe(200)
    const nativeBefore = await correction('preflight', change)
    const nativeCorrectionPlan = await nativeBefore.json()
    expect(nativeBefore.status, JSON.stringify(nativeCorrectionPlan)).toBe(200)
    expect(nativeCorrectionPlan).toEqual(before.body)
    const command = { request: change, planHash: nativeCorrectionPlan.planHash }
    const responses = await Promise.all([correction('commit', command), correction('commit', command)])
    const receipts = await Promise.all(responses.map(response => response.json()))
    expect(responses.map(response => response.status), JSON.stringify(receipts)).toEqual([200, 200])
    expect(receipts[0]).toEqual(receipts[1])
    expect(receipts[0]).toMatchObject({ status: 'committed', evidenceIds: [evidenceId], impact: { updated: 1, audit: 1 } })
    expect(await (await app.request(exactPath)).json()).toMatchObject({ evidenceId, event: { revision: row.event.revision + 1 } })
    const audit = await (await app.request(exactPath + '/audit')).json()
    expect(audit.rows.at(-1)).toMatchObject({ before: { row: { revision, nameRaw } }, after: { rowRevision: revision + 1 } })
    expect(await (await app.request('/api/roster/evidence/corrections/batches/' + change.idempotencyKey)).json()).toEqual(receipts[0])
    expect((await http(exactPath)).body).toEqual(row)

    const intake = sqlite.prepare('SELECT id,digest FROM roster_announcement_intake WHERE removed_reason IS NULL AND receipt IS NOT NULL ORDER BY id LIMIT 1').get() as { id: number; digest: string }
    const intakePath = `/api/roster/import/intake/${intake.id}`
    const sourceIntake = await http(intakePath)
    expect(sourceIntake.status).toBe(200)
    const originalIntake = await app.request(intakePath)
    expect(originalIntake.status).toBe(200)
    expect(await originalIntake.json()).toEqual(sourceIntake.body)
    const remove = (sourceDigest: string, reason: string) => app.request(intakePath + '/remove', {
      method: 'POST', body: JSON.stringify({ sourceDigest, reason }),
    })
    expect((await remove('a'.repeat(64), '旧摘要')).status).toBe(409)
    const removals = await Promise.all([remove(intake.digest, '撤下一版'), remove(intake.digest, '撤下另一版')])
    expect(removals.map(response => response.status).sort()).toEqual([200, 409])
    const result = await removals.find(response => response.ok)!.json()
    expect(await (await remove(intake.digest, result.removedReason)).json()).toEqual(result)
    const original = z.looseObject({ status: z.literal('supplemented') }).parse(sourceIntake.body)
    expect(await (await app.request(intakePath)).json()).toEqual({ ...original, status: 'removed', removedReason: result.removedReason })
    expect((await http(intakePath)).body).toEqual(sourceIntake.body)

    const stagedRequest = { idempotencyKey: 'native-announcement-staged', sourceKind: 'announcement',
      sourceIdentity: 'isolated-new-notice.xlsx', sourceSha256: null,
      payload: { announcement: { sourceDocument: { source: 'jxj', title: '合成新名单' },
        records: [{ enterprise: { name: '合成新企业' }, titleCode: 'specialized_sme', events: [] }] } } }
    const stage = (request: unknown = stagedRequest) => app.request('/api/roster/import/commit', {
      method: 'POST', body: JSON.stringify(request),
    })
    const sqliteStage = await http('/api/roster/import/commit', stagedRequest)
    expect(sqliteStage.status, JSON.stringify(sqliteStage.body)).toBe(200)
    expect(sqliteStage.body).toMatchObject({ status: 'staged', rowCount: 1 })
    const stagedResponses = await Promise.all([stage(), stage()])
    expect(stagedResponses.map(response => response.status)).toEqual([200, 200])
    const staged = await Promise.all(stagedResponses.map(response => response.json()))
    expect(staged[0]).toEqual(sqliteStage.body)
    expect(staged[1]).toEqual(staged[0])
    const newIntakePath = '/api/roster/import/intake/' + staged[0].intakeId
    expect(await (await app.request(newIntakePath)).json()).toEqual((await http(newIntakePath)).body)
    expect((await stage({ ...stagedRequest, sourceIdentity: 'another-source.xlsx' })).status).toBe(409)
    expect((await stage({ ...snapshot, idempotencyKey: stagedRequest.idempotencyKey })).status).toBe(409)
    const sourceRecordCount = run('psql', ['-X', '-w', '-Atc', "SELECT count(*) FROM business.enterprise WHERE name='合成新企业'"]).toString().trim()
    expect(sourceRecordCount).toBe('0')

    const exportRequest = { ...snapshot, idempotencyKey: 'postgres-new-export', sourceIdentity: 'new-platform-export.xlsx',
      payload: { exportSnapshot: { ...snapshot.payload.exportSnapshot, year: 2027, sha256: 'c'.repeat(64) } } }
    const exportCommand = (action: string, request = exportRequest) => app.request(`/api/roster/import/${action}`, {
      method: 'POST', body: JSON.stringify(request),
    })
    const expectedPreview = await http('/api/roster/import/preflight', exportRequest)
    const nativePreview = await exportCommand('preflight')
    const nativePlan = await nativePreview.json()
    expect(nativePreview.status, JSON.stringify(nativePlan)).toBe(200)
    expect(nativePlan.preflight).toEqual(z.object({ preflight: z.unknown() }).parse(expectedPreview.body).preflight)
    expect(nativePlan.preflight.add).toBe(1)
    const attempts = await Promise.all([exportCommand('commit'), exportCommand('commit')])
    const committed = await Promise.all(attempts.map(response => response.json()))
    expect(attempts.map(response => response.status), JSON.stringify(committed)).toEqual([200, 200])
    expect(committed[0]).toEqual(committed[1])
    expect(committed[0]).toMatchObject({ status: 'committed', summary: { written: 2, skipped: 0, failed: 0 }, items: [{ detail: { rows: [expect.any(Number)] } }] })
    expect(JSON.parse(run('psql', ['-X', '-w', '-Atc', `SELECT json_build_object('count',(SELECT count(*) FROM business.platform_export_batch WHERE year=2027),
      'revision',(SELECT count(*) FROM business.evidence_revision_113 WHERE source_kind='selected_snapshot' AND metadata::json#>>'{after,year}'='2027'))`]).toString())).toEqual({ count: 1, revision: 1 })
    const receipt = await app.request(`/api/roster/import/receipts/history?batchId=${committed[0].batchId}`)
    expect(receipt.status).toBe(200)
    expect(await receipt.json()).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ status: 'committed' })]) })
    const replay = await app.request('/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18', authorization: 'Bearer ' + mcpToken },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'save_roster_batch', arguments: exportRequest } }),
    })
    const replayBody = await replay.text()
    const replayEvent = replayBody.startsWith('event:') ? replayBody.split('\n').find(line => line.startsWith('data: '))!.slice(6) : replayBody
    expect(JSON.parse(JSON.parse(replayEvent).result.content[0].text)).toEqual(committed[0])

    const eventPath = '/api/roster/events/' + event.id
    const legacyEvent = await http(eventPath)
    const eventBefore = z.object({ event: z.object({ revision: z.number(), batchSeq: z.number().nullable() }),
      record: z.object({ id: z.number(), enterpriseId: z.number() }) }).parse(legacyEvent.body)
    const priorNative = await (await app.request(eventPath)).json()
    const eventRequest = {
      idempotencyKey: 'native-event-correction', sourceIdentity: '合成原件', actor, basis,
      operations: [{ eventId: event.id, recordId: eventBefore.record.id, enterpriseId: eventBefore.record.enterpriseId,
        expectedRevision: eventBefore.event.revision, patch: { batchSeq: (eventBefore.event.batchSeq ?? 0) + 42 } }],
    }
    const eventRoot = '/api/roster/events/corrections/'
    const nativeEventCommand = (action: string, body: unknown) => app.request(eventRoot + action, {
      method: 'POST', body: JSON.stringify(body),
    })
    const proof = z.object({ stage: z.string(), status: z.literal('captured'), target: z.object({ enterpriseId: z.number() }),
      assessment: z.object({ assessmentVersion: z.literal('enterprise-qualification-407-v1'), ruleVersion: z.literal('current-roster-116-v8'),
        titles: z.array(z.unknown()).length(3) }) })
    const legacyEventPlan = await http(eventRoot + 'preflight', eventRequest)
    const nativeEventPlanResponse = await nativeEventCommand('preflight', eventRequest)
    const nativeEventPlan = await nativeEventPlanResponse.json()
    expect(legacyEventPlan.status, JSON.stringify(legacyEventPlan.body)).toBe(200)
    expect(nativeEventPlanResponse.status, JSON.stringify(nativeEventPlan)).toBe(200)
    expect(nativeEventPlan).toMatchObject({ targets: z.object({ targets: z.array(z.unknown()) }).parse(legacyEventPlan.body).targets })
    expect(nativeEventPlan.planHash).toEqual(z.object({ planHash: z.string() }).parse(legacyEventPlan.body).planHash)
    expect(proof.parse(nativeEventPlan.qualificationReadback)).toEqual(proof.parse(z.object({ qualificationReadback: z.unknown() }).parse(legacyEventPlan.body).qualificationReadback))
    expect(await nativeTool('preflight_event_corrections', eventRequest)).toEqual({ body: nativeEventPlan, isError: false })
    const eventCommand = { request: eventRequest, planHash: nativeEventPlan.planHash }
    const legacyEventCommit = await http(eventRoot + 'commit', eventCommand)
    const responsesToEvent = await Promise.all([nativeEventCommand('commit', eventCommand), nativeEventCommand('commit', eventCommand)])
    const eventReceipts = await Promise.all(responsesToEvent.map(response => response.json()))
    expect(legacyEventCommit.status, JSON.stringify(legacyEventCommit.body)).toBe(200)
    expect(responsesToEvent.map(response => response.status), JSON.stringify(eventReceipts)).toEqual([200, 200])
    expect(eventReceipts[0]).toEqual(eventReceipts[1])
    expect(proof.parse(eventReceipts[0].qualificationReadback)).toEqual(proof.parse(z.object({ qualificationReadback: z.unknown() }).parse(legacyEventCommit.body).qualificationReadback))
    expect(await nativeTool('commit_event_corrections', eventCommand)).toEqual({ body: eventReceipts[0], isError: false })
    const corrected = await (await app.request(eventPath)).json()
    expect(corrected.event).toMatchObject({ id: event.id, revision: eventBefore.event.revision + 1, batchSeq: eventRequest.operations[0]!.patch.batchSeq })
    expect(corrected.evidence).toEqual(priorNative.evidence)
    const eventAudit = await (await app.request(eventPath + '/audit')).json()
    expect(eventAudit.rows).toEqual([expect.objectContaining({ eventId: event.id, before: priorNative.event, after: corrected.event })])


    const workPath = '/api/roster/evidence-impacts/commands'
    const evidenceWork = (body: unknown) => app.request(workPath, { method: 'POST', body: JSON.stringify(body) })
    const rule = { action: 'release_rule', idempotencyKey: 'native-impact-release', actor, basis, ruleId: 'fixture-source-rule', version: '2',
      scopes: [activeScope, secondScope].map(target => ({ ...target, previousEvaluationDigest: 'a'.repeat(64), evaluationDigest: 'b'.repeat(64) })) }
    const releaseResponses = await Promise.all([evidenceWork(rule), evidenceWork(rule)])
    const releases = await Promise.all(releaseResponses.map(response => response.json()))
    expect(releaseResponses.map(response => response.status), JSON.stringify(releases)).toEqual([200, 200])
    expect(releases[0]).toEqual(releases[1])
    expect(releases[0]).toMatchObject({ unchanged: 0, revisionIds: [expect.any(Number), expect.any(Number)] })
    expect(await nativeTool('release_evidence_rule', rule)).toEqual({ body: releases[0], isError: false })
    expect((await evidenceWork({ ...rule, idempotencyKey: 'different-rule-request', scopes: [{ ...rule.scopes[0], evaluationDigest: 'c'.repeat(64) }] })).status).toBe(409)
    const processCommand = { action: 'process', idempotencyKey: 'native-impact-process', limit: 100, actor, basis }
    const applied = await evidenceWork(processCommand)
    const workReceipt = await applied.json()
    expect(applied.status, JSON.stringify(workReceipt)).toBe(200)
    expect(workReceipt).toMatchObject({ processed: expect.any(Number), unfinished: false })
    expect(workReceipt.processed).toBeGreaterThan(0)
    expect(workReceipt.watermark).toBeGreaterThanOrEqual(releases[0].revisionIds[0])
    expect(await nativeTool('process_evidence_impacts', processCommand)).toEqual({ body: workReceipt, isError: false })
    const link = run('psql', ['-X', '-w', '-Atc', `SELECT l.classification,i.decision_id FROM business.evidence_impact_link_113 l
      JOIN business.explanation_impact_113 i ON i.id=l.impact_id WHERE l.revision_id=${releases[0].revisionIds[0]}`]).toString().trim()
    expect(link).toEqual('evidence_changed|' + activeDecisionId)
    const pending = run('psql', ['-X', '-w', '-Atc', 'SELECT sum(pending_count) FROM business.evidence_scope_version_113']).toString().trim()
    expect(pending).toBe('0')


    const impactsPath = '/api/roster/evidence-impacts'
    const impacted = await app.request(impactsPath + '?limit=1&enterpriseId=' + firstOwner.id)
    const firstImpact = await impacted.json()
    expect(impacted.status, JSON.stringify(firstImpact)).toBe(200)
    expect(firstImpact).toMatchObject({ rows: [expect.objectContaining({ decisionId: activeDecisionId, pending: true })],
      nextCursor: expect.any(String), projectionReady: true })
    const impactId = firstImpact.rows[0].id
    const impactRead = await app.request(impactsPath + '/' + impactId)
    const impactDetail = await impactRead.json()
    expect(impactRead.status, JSON.stringify(impactDetail)).toBe(200)
    expect(impactDetail).toMatchObject({ decisionId: activeDecisionId, oldDecision: { id: activeDecisionId },
      evidenceToken: { latestRevisionId: releases[0].revisionIds[0], projectionReady: true } })
    expect(await nativeTool('get_evidence_impact', { id: impactId })).toEqual({ body: impactDetail, isError: false })
    const sources = await app.request(impactsPath + '/' + impactId + '/sources')
    expect(sources.status).toBe(200)
    expect(await sources.json()).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({
      revisionId: releases[0].revisionIds[0], sourceKind: 'rule_release', classification: 'evidence_changed',
    })]) })
    const impactPreview = await nativeTool('preview_evidence_impacts', { revisionId: releases[0].revisionIds[1] })
    expect(impactPreview).toMatchObject({ isError: false, body: { rows: [expect.objectContaining({ id: secondDecisionId, classification: 'evidence_changed' })] } })
    const eventRevision = Number(run('psql', ['-X', '-w', '-Atc',
      'SELECT max(id) FROM business.evidence_revision_113 WHERE event_id=' + event.id]).toString().trim())
    expect(await nativeTool('list_evidence_revision_events', { revisionId: eventRevision })).toMatchObject({
      isError: false, body: { rows: [expect.objectContaining({ eventId: event.id, enterpriseId: firstOwner.id })] },
    })

    const decisionRoot = '/api/roster/decision-lifecycle/'
    const decide = (action: string, body: unknown) => app.request(decisionRoot + action, { method: 'POST', body: JSON.stringify(body) })
    const maintain = { ...activeScope, action: 'maintain', expectedCurrentId: activeDecisionId,
      idempotencyKey: 'native-scope-review', basis, effectiveAt: '2026-10-18T00:00:00Z',
      reviewedEvidence: { latestRevisionId: releases[0].revisionIds[0], projectionReady: true } }
    const reviewPath = '/api/roster/evidence-review/browser-commands'
    const reviewResponse = await app.request(reviewPath, {
      method: 'POST', headers: { origin: new URL(app.url(reviewPath)).origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify(maintain),
    })
    const reviewed = await reviewResponse.json()
    expect(reviewResponse.status, JSON.stringify(reviewed)).toBe(200)
    expect(reviewed).toMatchObject({ action: 'maintain', versionId: activeDecisionId, reviewedRevisionId: releases[0].revisionIds[0] })
    const secondPage = await app.request(impactsPath + '?limit=1&enterpriseId=' + firstOwner.id + '&cursor=' + encodeURIComponent(firstImpact.nextCursor))
    expect(secondPage.status).toBe(200)
    expect(await secondPage.json()).toMatchObject({ asOf: firstImpact.asOf,
      rows: [expect.objectContaining({ decisionId: secondDecisionId, pending: true })] })
    const nowReviewed = await app.request(impactsPath + '/' + impactId)
    expect(await nowReviewed.json()).toMatchObject({ pending: false, reviewedBaseline: { actor: null, ruleVersion: null } })
    const migration = { ...legacyDecision, ...activeScope, expectedCurrentId: activeDecisionId, idempotencyKey: 'native-qualification-decision',
      decision: { status: 'confirmed_reason', reasonCode: 'moved_in', measureCode: 'record_moved_in', verificationStatus: 'confirmed',
        evidenceQueryId: archiveCoordinates.queryId, evidenceRelationId: archiveCoordinates.relationId, movedIn: { city: '南通' },
        currentQualification: { titleCode: scope.titleCode, validFrom: '2025-07-22T00:00:00Z', validUntil: '2028-07-22T00:00:00Z',
          basis: '合成独立资格', publicationCheck: { status: 'not_found', scope: '合成公布范围' } } } }
    const legacyPlan = await http(decisionRoot + 'qualification-preflight', migration)
    expect(legacyPlan.status, JSON.stringify(legacyPlan.body)).toBe(200)
    const pgPreview = await decide('qualification-preflight', migration)
    const pgPlan = await pgPreview.json()
    expect(pgPreview.status, JSON.stringify(pgPlan)).toBe(200)
    expect(pgPlan).toEqual(legacyPlan.body)
    const qualifiedCommand = { command: migration, planHash: pgPlan.planHash }
    expect((await decide('qualification-commit', { ...qualifiedCommand, planHash: '0'.repeat(64) })).status).toBe(409)
    const decided = await decide('qualification-commit', qualifiedCommand)
    const qualificationReceipt = await decided.json()
    const commitDiagnostic = decided.ok ? undefined : JSON.stringify(qualificationReceipt) + '\n' + readFileSync(join(pgDir, 'pg.log'), 'utf8').slice(-4000)
    expect(decided.status, commitDiagnostic).toBe(200)
    expect(await nativeTool('commit_qualification_decision', qualifiedCommand)).toEqual({ body: qualificationReceipt, isError: false })
    const decisionsPath = decisionRoot + 'current?' + new URLSearchParams(Object.entries(activeScope).map(([key,value]) => [key,String(value)]))
    const qualificationDecision = await (await app.request(decisionsPath)).json()
    expect(qualificationDecision).toMatchObject({ versionId: qualificationReceipt.versionId,
      current: { ...activeScope, evidenceQueryId: archiveCoordinates.queryId,
        evidenceRelationId: archiveCoordinates.relationId, currentQualification: migration.decision.currentQualification } })
    const withdrawalCommand = { ...activeScope, action: 'withdraw', expectedCurrentId: qualificationReceipt.versionId,
      idempotencyKey: 'native-qualification-withdraw', actor, basis, ruleVersion: legacyDecision.ruleVersion, effectiveAt: legacyDecision.effectiveAt }
    const cancelledDecision = await nativeTool('save_difference_decision', withdrawalCommand)
    expect(cancelledDecision).toMatchObject({ isError: false, body: { action: 'withdraw', previousId: qualificationReceipt.versionId, currentId: null } })
    expect(await (await app.request(decisionsPath)).json()).toMatchObject({ current: null })

  } finally {
    await app.close()
    if (started) run('pg_ctl', ['-w', '-D', join(pgDir, 'pg'), '-m', 'fast', 'stop'])
    rmSync(pgDir, { recursive: true, force: true })
  }
}, 90_000)
