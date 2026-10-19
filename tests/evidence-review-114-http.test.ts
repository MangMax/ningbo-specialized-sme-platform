import { createHash } from 'node:crypto'
import { minimalPdf } from './helpers/minimal-pdf'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { useDb, schema } from '../db/client'
import { createRosterImportClient } from '../lib/roster-import-client'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'
const dir = mkdtempSync(join(tmpdir(), 'review-114-')), dbPath = join(dir, 'synthetic.db'), db = useDb({ dbPath })
let base: string, stop: () => Promise<void>, client: ReturnType<typeof createRosterImportClient>
const actor = { type: 'user', id: 'synthetic-reviewer' }, basis = '指定证据人工核验'
const coord = (enterpriseId: number, direction = 'missing_in_miit', titleCode = 'specialized_sme') => ({ enterpriseId, titleCode, direction })
const query = (v: Record<string, unknown>) => new URLSearchParams(Object.entries(v).map(([k,v]) => [k,String(v)])).toString()
async function get(path: string, params: Record<string,unknown> = {}) { const r = await fetch(base + path + '?' + query(params)); expect(r.headers.get('cache-control')).toBe('no-store'); return { status: r.status, body: await r.json() as any } }
async function post(path: string, input: unknown, token = 'synthetic-api') { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(input) }); expect(r.headers.get('cache-control')).toBe('no-store'); return { status: r.status, body: await r.json() as any } }
async function rpc(name: string, args: Record<string,unknown>, token = '') {
  const r = await fetch(base + '/mcp', { method:'POST', headers: { 'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18', ...(token ? { authorization:'Bearer ' + token } : {}) }, body:JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call', params:{name,arguments:args} }) })
  expect(r.headers.get('cache-control')).toBe('no-store')
  const raw = await r.text(), b = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(l=>l.startsWith('data: '))!.slice(6) : raw)
  return { status:r.status, body:b, value:b.result?.content?.[0]?.text ? JSON.parse(b.result.content[0].text) : null }
}
const cmd = (key:string) => ({ idempotencyKey:key, actor, basis })
const workPath = '/api/roster/evidence-impacts/commands', listPath = '/api/roster/evidence-impacts', decisionPath = '/api/roster/decision-lifecycle/commands'
function seed(name: string, usccNorm: string | null = null) { return db.insert(schema.enterprise).values({ name,nameNorm:name,usccNorm }).returning().get() }
async function decide(scope: ReturnType<typeof coord>, key: string, expectedCurrentId: number | null = null) {
  const r = await post(decisionPath, { ...scope, ...cmd(key), action:'replace', expectedCurrentId, ruleVersion:'manual-1',effectiveAt:'2026-10-19T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'other',reasonNote:'保留用户原始原因',measureCode:'keep_history',measureNote:'保留原措施',verificationStatus:'confirmed'} }); expect(r.status).toBe(200); return r.body
}
async function archive(e: ReturnType<typeof seed>, key: string, status = '新事实') {
  const r = await client.commit({ idempotencyKey:key, sourceKind:'alias_evidence',sourceIdentity:'synthetic/' + key,payload:{platformQueries:[{interface:'business_list',queryKey:e.usccNorm ?? 'name:' + e.nameNorm,rdjb:'2',titleCode:'specialized_sme',queriedAt:new Date().toISOString(),status:'success',relations:[{sequenceNo:1,enterpriseId:e.id,nameRaw:e.name,status}]}]} }); expect(r.status,JSON.stringify(r)).toBe('committed')
}
async function drain(key: string, limit = 100) { for(let i=0;i<30;i++){ const r = await post(workPath,{...cmd(key+'-'+i),action:'process',limit}); expect(r.status,JSON.stringify(r.body)).toBe(200); if(!r.body.unfinished)return r.body }; throw new Error('drain incomplete') }
beforeAll(async()=>{
  const cwd = resolve(import.meta.dirname,'..'), port=await reserveLoopbackPort()
  const child=spawn(process.execPath,[join(cwd,'node_modules/nuxt/bin/nuxt.mjs'),'dev','--host','127.0.0.1','--port',String(port)],{cwd,stdio:['ignore','pipe','pipe'],env:{...process.env,NUXT_BUILD_DIR:join(dir,'build'),NUXT_DB_PATH:dbPath,NUXT_API_TOKEN:'synthetic-api',NUXT_MCP_TOKEN:'synthetic-mcp',NUXT_FILES_DIR:join(dir,'files'),NUXT_INCOMING_DIR:join(dir,'incoming')}})
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{output=(output+d).slice(-8000)})
  base=`http://127.0.0.1:${port}`;stop=()=>stopOwnedChild(child)
  try{await waitForHttp(base+'/api/roster/differences',{timeoutMs:60000,child})}catch(e){await stop();throw new Error(String(e)+output)}
  client=createRosterImportClient({baseUrl:base,token:'synthetic-api'})
},90000)
afterAll(async()=>{if(stop)await stop();rmSync(dir,{recursive:true,force:true})})
describe('ticket 114 public evidence review',()=>{
  it('exposes bounded no-token HTTP and MCP lists without implicitly processing committed evidence',async()=>{
    const e=seed('有界复核主体','REVIEW-114-A'), scope=coord(e.id), d=await decide(scope,'list-decision')
    await archive(e,'list-archive')
    const before=await get(listPath,{enterpriseId:e.id})
    expect(before.status).toBe(200);expect(before.body.rows).toEqual([]);expect(before.body.projectionReady).toBe(false)
    await drain('list-drain',1)
    const after=await get(listPath,{enterpriseId:e.id,limit:1})
    expect(after.status).toBe(200);expect(after.body.rows).toHaveLength(1)
    expect(after.body.rows[0]).toMatchObject({...scope,decisionId:d.versionId,classification:'evidence_changed',pending:true,lineage:'current',oldDecision:{reasonNote:'保留用户原始原因',measureNote:'保留原措施'}})
    const m=await rpc('list_evidence_impacts',{enterpriseId:e.id,limit:1})
    expect(m.status).toBe(200);expect(m.value.rows).toEqual(after.body.rows)
    expect((await get(listPath,{enterpriseId:999999})).body.rows).toEqual([])
    expect((await get(listPath,{limit:101})).status).toBe(400)
    expect((await post(workPath,{...cmd('unauth'),action:'process',limit:1},'')).status).toBe(401)
    expect((await rpc('process_evidence_impacts',{...cmd('unauth-mcp'),action:'process',limit:1})).status).toBe(401)
  })
  it('maintains the original decision atomically with a reviewed baseline and replays the original receipt across transports without settling later evidence',async()=>{
    const e=seed('明确维持主体','REVIEW-114-M'),scope=coord(e.id),d=await decide(scope,'maintain-decision')
    await archive(e,'maintain-archive');await drain('maintain-drain')
    const item=(await get(listPath,{enterpriseId:e.id})).body.rows[0]
    const detailResponse=await get(listPath+'/'+item.id);expect(detailResponse.status,JSON.stringify(detailResponse.body)).toBe(200);const detail=detailResponse.body
    expect(detail.evidenceToken,JSON.stringify(detail)).toMatchObject({decisionId:d.versionId,projectionReady:true})
    const input={...scope,...cmd('maintain-success'),action:'maintain',expectedCurrentId:d.versionId,reviewedEvidence:{latestRevisionId:detail.evidenceToken.latestRevisionId,projectionReady:true},ruleVersion:'manual-1',effectiveAt:'2026-10-19T00:00:00Z'}
    const first=await post(decisionPath,input)
    expect(first.status,JSON.stringify(first.body)).toBe(200)
    expect(first.body).toMatchObject({versionId:d.versionId,currentId:d.versionId,action:'maintain',reviewedRevisionId:detail.evidenceToken.latestRevisionId})
    expect((await get('/api/roster/decision-lifecycle/current',scope)).body.current).toMatchObject({id:d.versionId,reasonNote:'保留用户原始原因',measureNote:'保留原措施'})
    expect((await get('/api/roster/decision-lifecycle/history',scope)).body.total).toBe(1)
    expect((await get(listPath,{enterpriseId:e.id})).body.rows).toEqual([])
    const assessment=(await get('/api/roster/enterprises/'+e.id)).body.titleAssessments.find((a:any)=>a.titleCode===scope.titleCode&&a.direction===scope.direction)
    expect(assessment.explanationValidity).toMatchObject({status:'valid',reasons:[],explanationId:d.versionId})
    const replay=await rpc('save_difference_decision',input,'synthetic-mcp')
    expect(replay.value).toEqual(first.body)
    await archive(e,'maintain-new-evidence','维持之后的变化')
    const stale=await post(decisionPath,{...input,...cmd('maintain-stale')})
    expect(stale.status).toBe(409);expect(stale.body.error.code).toBe('stale_evidence')
    await drain('maintain-new-drain')
    expect((await rpc('save_difference_decision',input,'synthetic-mcp')).value).toEqual(first.body)
    expect((await get(listPath,{enterpriseId:e.id})).body.rows).toEqual([expect.objectContaining({id:item.id,pending:true})])
    expect((await get('/api/roster/enterprises/'+e.id)).body.titleAssessments.find((a:any)=>a.titleCode===scope.titleCode&&a.direction===scope.direction).explanationValidity.status).toBe('evidence_changed')
    const conflict=await post(decisionPath,{...input,basis:'相同键不同请求'})
    expect(conflict.status).toBe(409);expect(conflict.body.error.code).toBe('idempotency_conflict')
  })

  it('freezes filter-bound list pages across completion replacement and later evidence and rejects forged cursors',async()=>{
    const e=seed('稳定分页主体','REVIEW-114-P'),s1=coord(e.id),s2=coord(e.id,'extra_in_miit'),d1=await decide(s1,'page-d1'),d2=await decide(s2,'page-d2')
    await archive(e,'page-q1');await drain('page-drain')
    const all=(await get(listPath,{enterpriseId:e.id,limit:1})).body
    expect(all.rows).toHaveLength(1);expect(all.nextCursor).toEqual(expect.any(String))
    const expected=(await get(listPath,{enterpriseId:e.id,limit:100})).body.rows
    await decide(s2,'page-user-replace',d2.versionId)
    await archive(e,'page-q2','后续新事实');await drain('page-next-drain')
    const second=(await rpc('list_evidence_impacts',{enterpriseId:e.id,limit:1,cursor:all.nextCursor})).value
    expect(second.asOf).toEqual(all.asOf)
    expect([...all.rows,...second.rows]).toEqual(expected)
    expect(second.nextCursor).toBeNull()
    expect((await get(listPath,{enterpriseId:e.id,limit:1,cursor:all.nextCursor+'x'})).status).toBe(400)
    expect((await get(listPath,{enterpriseId:e.id,direction:'extra_in_miit',limit:1,cursor:all.nextCursor})).status).toBe(400)
    const current=(await get(listPath,{enterpriseId:e.id})).body.rows
    expect(current.map((r:any)=>r.decisionId)).toEqual(expect.arrayContaining([d1.versionId]))
    expect(current.some((r:any)=>r.decisionId===d2.versionId)).toBe(false)
    const history=(await get(listPath,{enterpriseId:e.id,view:'historical'})).body.rows
    expect(history).toEqual([expect.objectContaining({decisionId:d2.versionId,lineage:'historical'})])
    const stale=await post(decisionPath,{...s2,...cmd('page-stale-head'),action:'maintain',expectedCurrentId:d2.versionId,reviewedEvidence:{latestRevisionId:history[0].latestRevisionId,projectionReady:true},ruleVersion:'1',effectiveAt:'2026-10-19T00:00:00Z'})
    expect(stale.status).toBe(409);expect(stale.body.error.code).toBe('stale_version')
  })

  it('rolls back actual replacement and review baseline together and retries response-loss receipts without hiding concurrent committed evidence',async()=>{
    const e=seed('更正事务主体','REVIEW-114-T'),scope=coord(e.id),d=await decide(scope,'tx-d')
    await archive(e,'tx-q');await drain('tx-drain')
    const item=(await get(listPath,{enterpriseId:e.id})).body.rows[0], detail=(await get(listPath+'/'+item.id)).body
    const input={...scope,...cmd('tx-replace'),action:'replace',expectedCurrentId:d.versionId,reviewedEvidence:{latestRevisionId:detail.evidenceToken.latestRevisionId,projectionReady:true},ruleVersion:'manual-2',effectiveAt:'2026-10-19T00:00:00Z',decision:{status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed'}}
    db.run(sql`create trigger fail_review114 before insert on evidence_review_receipt_114 when new.idempotency_key='tx-replace' begin select raise(abort,'synthetic receipt failure'); end`)
    const failed=await post(decisionPath,input);expect(failed.status).toBe(500)
    expect((await get('/api/roster/decision-lifecycle/current',scope)).body.versionId).toBe(d.versionId)
    expect((await get(listPath,{enterpriseId:e.id})).body.rows).toEqual([expect.objectContaining({id:item.id,pending:true,reviewedRevisionId:null})])
    db.run(sql`drop trigger fail_review114`)
    const completed=await rpc('save_difference_decision',input,'synthetic-mcp')
    expect(completed.value).toMatchObject({action:'replace',previousId:d.versionId,reviewedRevisionId:detail.evidenceToken.latestRevisionId})
    expect(completed.value.versionId).not.toBe(d.versionId)
    expect((await get('/api/roster/decision-lifecycle/current',scope)).body.current).toMatchObject({status:'confirmed_no_diff',measureCode:'none',previousId:d.versionId})
    const old=(await get(listPath+'/'+item.id)).body
    expect(old).toMatchObject({pending:false,lineage:'historical',reviewedRevisionId:detail.evidenceToken.latestRevisionId,oldDecision:{reasonNote:'保留用户原始原因'}})
    expect((await get('/api/roster/enterprises/'+e.id)).body.titleAssessments.find((a:any)=>a.titleCode===scope.titleCode&&a.direction===scope.direction).explanationValidity.status).toBe('valid')
    // Discarded response/transport retry must return the original receipt after a later commit.
    await archive(e,'tx-new','更正完成后的并发事实')
    const replay=await post(decisionPath,input);expect(replay.body).toEqual(completed.value)
    const nextToken=(await get(listPath+'/'+item.id)).body.evidenceToken
    expect(nextToken.projectionReady).toBe(false)
    const notReady=await post(decisionPath,{...scope,...cmd('tx-not-ready'),action:'maintain',expectedCurrentId:completed.value.versionId,reviewedEvidence:{latestRevisionId:nextToken.latestRevisionId,projectionReady:true},ruleVersion:'manual-2',effectiveAt:'2026-10-19T00:00:00Z'})
    expect(notReady.status).toBe(409);expect(notReady.body.error.code).toBe('stale_evidence')
    await drain('tx-next-drain')
    expect((await get(listPath,{enterpriseId:e.id})).body.rows).toEqual([expect.objectContaining({decisionId:completed.value.versionId,pending:true})])
  })

  it('publishes only explicit bounded rule scopes including unchanged releases and rejects reused versions with different evaluated material',async()=>{
    const e=seed('规则显式范围','REVIEW-114-R'), other=seed('规则无关范围','REVIEW-114-R-OTHER'),scope=coord(e.id)
    const d=await decide(scope,'rule-d');await decide(coord(e.id,'extra_in_miit'),'rule-other-direction');await decide(coord(e.id,'missing_in_miit','innovative_sme'),'rule-other-title');await decide(coord(other.id),'rule-other-enterprise')
    const zero='0'.repeat(64),one='1'.repeat(64),two='2'.repeat(64)
    const release={...cmd('rule-unchanged'),action:'release_rule',ruleId:'human-evaluation',version:'same-1',scopes:[{...scope,previousEvaluationDigest:zero,evaluationDigest:zero}]}
    const same=await post(workPath,release);expect(same.status).toBe(200);expect(same.body).toMatchObject({revisionIds:[null],unchanged:1})
    await drain('rule-same-drain');expect((await get(listPath,{enterpriseId:e.id})).body.rows).toEqual([])
    const reused=await rpc('release_evidence_rule',{...release,...cmd('rule-same-version-different'),scopes:[{...scope,previousEvaluationDigest:zero,evaluationDigest:one}]},'synthetic-mcp')
    expect(reused.value.error.code).toBe('rule_version_conflict')
    const changed={...release,...cmd('rule-changed'),version:'changed-1',scopes:[{...scope,previousEvaluationDigest:zero,evaluationDigest:one}]}
    const result=await rpc('release_evidence_rule',changed,'synthetic-mcp');expect(result.value.revisionIds[0]).toEqual(expect.any(Number))
    expect((await post(workPath,changed)).body).toEqual(result.value)
    await drain('rule-changed-drain')
    expect((await get(listPath,{enterpriseId:e.id})).body.rows).toEqual([expect.objectContaining({decisionId:d.versionId,...scope,classification:'evidence_changed'})])
    expect((await get(listPath,{enterpriseId:other.id})).body.rows).toEqual([])
    const bad=await post(workPath,{...changed,...cmd('rule-duplicate'),scopes:[changed.scopes[0],changed.scopes[0]]});expect(bad.status).toBe(400)
    expect((await post(workPath,{...changed,...cmd('rule-unbounded'),scopes:Array.from({length:51},(_,i)=>({...changed.scopes[0],enterpriseId:i+1}))})).status).toBe(400)
    expect((await post(workPath,{...changed,...cmd('rule-raw'),rawSource:{token:'must-not-pass'}})).status).toBe(400)
    expect((await post(workPath,{...changed,...cmd('rule-changed-digest'),scopes:[{...scope,previousEvaluationDigest:one,evaluationDigest:two}]})).body.error.code).toBe('rule_version_conflict')
    const processRequest={...cmd('process-replay'),action:'process',limit:1}, first=await post(workPath,processRequest)
    expect((await rpc('process_evidence_impacts',processRequest,'synthetic-mcp')).value).toEqual(first.body)
    expect((await post(workPath,{...processRequest,limit:2})).body.error.code).toBe('idempotency_conflict')
  })

  it('pages exact event and source references with committed preview classifications and preserves unknown subject gaps and withdrawn history',async()=>{
    const e=seed('事件范围复核主体','REVIEW-114-E'),scope=coord(e.id),a=await decide(scope,'event-da'),b=await decide(coord(e.id,'extra_in_miit'),'event-db')
    await decide(coord(e.id,'missing_in_miit','innovative_sme'),'event-other-title')
    const rec=db.insert(schema.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj'}).returning().get()
    const events=[2022,2023,2024].map(year=>db.insert(schema.recordEvent).values({recordId:rec.id,eventType:'award',year}).returning().get())
    const bytes=minimalPdf({pages:3});mkdirSync(join(dir,'files'),{recursive:true});writeFileSync(join(dir,'files/event114.pdf'),bytes)
    db.insert(schema.storedFile).values({relPath:'event114.pdf',filename:'event114.pdf',ext:'pdf',source:'jxj',kind:'announcement',titleCode:'specialized_sme',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}).run()
    db.insert(schema.recordEvidence).values({recordEventId:events[0]!.id,sourceFile:'event114.pdf',page:1,listNo:1}).run()
    const request={idempotencyKey:'event-correction114',sourceIdentity:'synthetic-event',actor,basis,operations:[{enterpriseId:e.id,recordId:rec.id,eventId:events[0]!.id,expectedRevision:1,patch:{year:2021}}]}
    const plan=(await rpc('preflight_event_corrections',request,'synthetic-mcp')).value
    const commit=await rpc('commit_event_corrections',{request,planHash:plan.planHash},'synthetic-mcp');expect(commit.body.result?.isError,JSON.stringify(commit)).not.toBe(true)
    await drain('event-drain')
    const rows=(await get(listPath,{enterpriseId:e.id,eventId:events[0]!.id})).body.rows
    expect(rows.map((r:any)=>r.decisionId)).toEqual([a.versionId,b.versionId])
    expect((await get(listPath,{enterpriseId:e.id,eventId:events[1]!.id})).body.rows).toEqual([])
    expect((await get(listPath,{enterpriseId:e.id,titleCode:'innovative_sme',eventId:events[0]!.id})).body.rows).toEqual([])
    const preview=(await rpc('preview_evidence_impacts',{revisionId:rows[0].latestRevisionId,enterpriseId:e.id,limit:1})).value
    expect(preview.rows).toEqual([expect.objectContaining({id:a.versionId,classification:'evidence_changed'})]);expect(preview.nextCursor).toEqual(expect.any(String))
    expect((await get(listPath+'/preview',{revisionId:rows[0].latestRevisionId,enterpriseId:e.id,limit:1,cursor:preview.nextCursor})).body.rows).toEqual([expect.objectContaining({id:b.versionId})])
    expect((await get(listPath+'/preview',{revisionId:999999})).status).toBe(404)
    const alias=await client.commit({idempotencyKey:'event-alias114',sourceKind:'alias_evidence',sourceIdentity:'synthetic-alias',payload:{aliases:[{enterpriseName:e.name,name:'事件主体已确认旧名',sourceKind:'manual',sourceRefId:0,verificationStatus:'confirmed'}]}});expect(alias.status).toBe('committed');await drain('event-alias-drain')
    const sources=(await get(listPath+'/'+rows[0].id+'/sources',{limit:1})).body
    expect(sources.rows).toEqual([expect.objectContaining({eventId:events[0]!.id,sourceKind:'official_event'})]);expect(sources.nextCursor).toEqual(expect.any(String))
    const next=(await rpc('list_evidence_impact_sources',{id:rows[0].id,limit:1,cursor:sources.nextCursor})).value
    expect(next.rows).toEqual([expect.objectContaining({sourceKind:'identity'})]);expect(next.nextCursor).toBeNull()
    expect(JSON.stringify(next.rows)).not.toMatch(/metadata|rawResponse|raw_fields|evaluationDigest/)
    const firstEvents=(await get(listPath+'/revisions/'+next.rows[0].revisionId+'/events',{enterpriseId:e.id,limit:1})).body
    expect(firstEvents.rows.map((x:any)=>x.eventId)).toEqual([events[0]!.id])
    const rest=await rpc('list_evidence_revision_events',{revisionId:next.rows[0].revisionId,enterpriseId:e.id,limit:1,cursor:firstEvents.nextCursor})
    expect(rest.value.rows.map((x:any)=>x.eventId)).toEqual([events[1]!.id])
    expect((await get(listPath+'/revisions/'+next.rows[0].revisionId+'/events',{enterpriseId:999999})).body.rows).toEqual([])
    const detail=(await rpc('get_evidence_impact',{id:rows[0].id})).value
    expect(detail.evidenceToken.projectionReady).toBe(true);expect(detail.gaps.coverageStatus).toBe('not_queried')
    const withdrawn=await post(decisionPath,{...scope,...cmd('event-withdraw'),action:'withdraw',expectedCurrentId:a.versionId,ruleVersion:'manual-1',effectiveAt:'2026-10-19T00:00:00Z'});expect(withdrawn.status).toBe(200)
    const historical=(await get(listPath+'/'+rows[0].id)).body
    expect(historical).toMatchObject({lineage:'withdrawn',currentDecision:{versionId:withdrawn.body.versionId,current:null},oldDecision:{id:a.versionId}})
    expect((await get(listPath,{enterpriseId:e.id,titleCode:'specialized_sme',direction:'missing_in_miit'})).body.rows).toEqual([])
    const unknown=seed('未知查询主体')
    await decide(coord(unknown.id),'unknown-decision')
    const result=await client.commit({idempotencyKey:'unknown-archive114',sourceKind:'alias_evidence',sourceIdentity:'synthetic-unknown',payload:{platformQueries:[{interface:'business_list',queryKey:'name:'+unknown.name,rdjb:'2',queriedAt:'2026-10-19T05:00:00Z',status:'no_record',relations:[]}]}});expect(result.status).toBe('committed');await drain('unknown-drain')
    expect((await get(listPath,{enterpriseId:unknown.id})).body.rows).toEqual([])
    const unknownAssessment=(await get('/api/roster/enterprises/'+unknown.id)).body.titleAssessments.find((x:any)=>x.titleCode==='specialized_sme'&&x.direction==='missing_in_miit')
    expect(unknownAssessment).toMatchObject({queryCoverage:{status:'unknown',sources:[{subjectMatch:'name_only',outcome:'unknown'}]},explanationValidity:{status:'unknown',reasons:['no_evidence_baseline']}})
  })

})
