import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { assertEnterpriseDetailSnapshotEqual } from '../assertions/enterprise-detail-snapshot'
import { createHash } from 'node:crypto'
import { minimalPdf } from '../../support/minimal-pdf'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { initializeDb, schema } from '../../../db/client'
import { recognizedResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'
import { createRosterImportClient } from '../../../lib/roster-import-client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
const dir = mkdtempSync(join(tmpdir(), 'review-114-')), dbPath = join(dir, 'synthetic.db'), db = initializeDb({ create: true,  dbPath })
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
  const r = await client.commit({ idempotencyKey:key, sourceKind:'alias_evidence',sourceIdentity:'synthetic/' + key,payload:{platformQueries:[{interface:'business_list',queryKey:e.usccNorm ?? 'name:' + e.nameNorm,rdjb:'2',titleCode:'specialized_sme',queriedAt:new Date().toISOString(),status:'success',rawResponse:JSON.stringify([{name:e.name,status}]),relations:[{sequenceNo:1,enterpriseId:e.id,nameRaw:e.name,status}]}]} }); expect(r.status,JSON.stringify(r)).toBe('committed')
}
async function drain(key: string, limit = 100) { for(let i=0;i<30;i++){ const r = await post(workPath,{...cmd(key+'-'+i),action:'process',limit}); expect(r.status,JSON.stringify(r.body)).toBe(200); if(!r.body.unfinished)return r.body }; throw new Error('drain incomplete') }
beforeAll(async()=>{
  const cwd = resolve(import.meta.dirname,'../../..'), port=await reserveLoopbackPort()
  const child=spawnCompiledApp(port, {cwd,stdio:['ignore','pipe','pipe'],env:{...process.env,NUXT_BUILD_DIR:join(dir,'build'),NUXT_DB_PATH:dbPath,NUXT_API_TOKEN:'synthetic-api',NUXT_CURATED_PATH:join(dir,'curated.json'),NUXT_MCP_TOKEN:'synthetic-mcp',NUXT_FILES_DIR:join(dir,'files'),NUXT_INCOMING_DIR:join(dir,'incoming')}})
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
    expect((await get(listPath+'/'+item.id)).body.reviewedBaseline).toMatchObject({ reviewedRevisionId: detail.evidenceToken.latestRevisionId, actor, basis, ruleVersion: 'manual-1', effectiveAt: '2026-10-19T00:00:00Z' })
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

  it.each(['failed', 'partial', 'disjoint-condition', 'disjoint-page'] as const)('keeps reviewed validity after ready no_review %s without advancing audit and preserves unprocessed and substantive work', async kind => {
    const e=seed('语义有效性-'+kind,'9133000000000000'+(['failed','partial','disjoint-condition','disjoint-page'].indexOf(kind)+10)),scope=coord(e.id)
    let time=0
    const saveArchive=async(key:string, status:'success'|'failed'|'partial', year='2024', page=1, fact='原事实')=>{
      const rows=status!=='failed'?[{id:status==='partial'?'核验事实':fact,tyshxydm:e.usccNorm!,qymc:e.name,whpcyear:year}]:[]
      const at=new Date(Date.UTC(2026,9,19,10,++time)).toISOString()
      const result:PlatformLiveQueryResult={source:'queryBusList',status,effectiveConditions:{uscc:e.usccNorm!,combination:'and',whpcyear:year},titleScope:{mode:'selected',rdjb:['2']},queriedAt:at,completedAt:at,rows,
        pages:[{source:'queryBusList',rdjb:'2',page,status:status==='failed'?'failed':'success',fetchedCount:rows.length,declaredTotal:status==='success'?(page-1)*50+1:null,error:null}],fetchedCount:rows.length,declaredTotal:status==='success'?(page-1)*50+1:null,
        completeness:status==='success'?'complete':'partial',fullRange:false,unfinished:status==='success'?[]:[{source:'queryBusList',rdjb:'2',page:status==='failed'?page:page+1}],error:null,limits:{pageSize:50,maxRequests:100,maxRows:5000,maxDurationMs:60000}}
      const r=await client.commit({idempotencyKey:key,sourceKind:'alias_evidence',sourceIdentity:'synthetic/'+key,payload:{platformQueries:[recognizedResultToImport(result)]}})
      expect(r.status,JSON.stringify(r)).toBe('committed')
      return Number(r.items.find(i=>i.kind==='platform_query')!.ref.split(':')[1])
    }
    const prefix='semantic-'+kind,queryId=await saveArchive(prefix+'-original','success')
    await drain(prefix+'-initial-drain')
    const d=await post(decisionPath,{...scope,...cmd(prefix+'-d'),action:'replace',expectedCurrentId:null,ruleVersion:'original-rule',effectiveAt:'2026-10-19T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'other',reasonNote:'不可改写的原原因',measureCode:'keep_history',verificationStatus:'confirmed',...(kind==='failed'?{}:{evidenceQueryId:queryId})}})
    expect(d.status).toBe(200)
    await saveArchive(prefix+'-relevant','success','2024',1,'核验事实');await drain(prefix+'-relevant-drain')
    const item=(await get(listPath,{enterpriseId:e.id})).body.rows[0],initial=(await get(listPath+'/'+item.id)).body
    const maintain={...scope,...cmd(prefix+'-maintain'),action:'maintain',expectedCurrentId:d.body.versionId,reviewedEvidence:{latestRevisionId:initial.evidenceToken.latestRevisionId,projectionReady:true},ruleVersion:'review-rule',effectiveAt:'2026-10-19T00:00:00Z'}
    const receipt=await post(decisionPath,maintain);expect(receipt.status).toBe(200)
    const baseline=(await get(listPath+'/'+item.id)).body.reviewedBaseline
    const original=(await get('/api/roster/decision-lifecycle/'+d.body.versionId)).body
    const assess=(b:any)=>b.titleAssessments.find((a:any)=>a.titleCode===scope.titleCode&&a.direction===scope.direction)
    expect(assess((await get('/api/roster/enterprises/'+e.id)).body).explanationValidity.status).toBe('valid')
    const changedQuery=await saveArchive(prefix+'-no-review',kind==='failed'?'failed':kind==='partial'?'partial':'success',kind==='disjoint-condition'?'2025':'2024',kind==='disjoint-page'?2:1,'无关分区事实')
    const unprocessed=(await get(listPath+'/'+item.id)).body
    expect(unprocessed.evidenceToken).toMatchObject({projectionReady:false})
    expect((await rpc('get_evidence_impact',{id:item.id})).value).toEqual(unprocessed)
    expect((await get(listPath,{enterpriseId:e.id})).body).toMatchObject({rows:[],projectionReady:false})
    expect((await rpc('list_evidence_impacts',{enterpriseId:e.id})).value).toMatchObject({rows:[],projectionReady:false})
    expect(unprocessed.evidenceToken.latestRevisionId).toBeGreaterThan(baseline.reviewedRevisionId)
    expect(assess((await get('/api/roster/enterprises/'+e.id)).body).explanationValidity.status).toBe('evidence_changed')
    const stale=await post(decisionPath,{...maintain,...cmd(prefix+'-stale')});expect(stale.status).toBe(409);expect(stale.body.error.code).toBe('stale_evidence')
    await drain(prefix+'-no-review-drain')
    const detail=(await get(listPath+'/'+item.id)).body
    expect(detail).toMatchObject({pending:false,evidenceToken:{projectionReady:true},reviewedBaseline:baseline,oldDecision:{id:d.body.versionId,reasonNote:'不可改写的原原因'}})
    expect(detail.latestRevisionId).toBe(baseline.reviewedRevisionId)
    expect((await rpc('get_evidence_impact',{id:item.id})).value).toEqual(detail)
    const list=(await get(listPath,{enterpriseId:e.id})).body
    expect(list).toMatchObject({rows:[],projectionReady:true});expect((await rpc('list_evidence_impacts',{enterpriseId:e.id})).value.rows).toEqual([])
    const params={enterpriseId:e.id,revisionId:detail.evidenceToken.latestRevisionId}
    const preview=(await get(listPath+'/preview',params)).body
    expect(preview.rows).toEqual([expect.objectContaining({id:d.body.versionId,classification:'no_review'})])
    expect((await rpc('preview_evidence_impacts',params)).value.rows).toEqual(preview.rows)
    const enterprise=(await get('/api/roster/enterprises/'+e.id)).body
    expect(assess(enterprise)).toMatchObject({assessment:'decided',explanationValidity:{status:'valid',reasons:[],explanationId:d.body.versionId}})
    if(kind==='failed'||kind==='partial') expect(assess(enterprise).queryCoverage.sources).toContainEqual(expect.objectContaining({queryId:changedQuery,status:kind,outcome:'unknown'}))
    assertEnterpriseDetailSnapshotEqual((await rpc('get_enterprise_detail',{enterpriseId:e.id})).value, enterprise)
    expect((await get('/api/roster/decision-lifecycle/'+d.body.versionId)).body).toEqual(original)
    expect((await get('/api/roster/decision-lifecycle/history',scope)).body.total).toBe(1)
    expect((await rpc('save_difference_decision',maintain,'synthetic-mcp')).value).toEqual(receipt.body)
    // A no-review evaluation must not clear earlier substantive work or manufacture a new baseline.
    await saveArchive(prefix+'-substantive','success','2024',1,'真实新事实');await drain(prefix+'-substantive-drain')
    const substantive=(await get(listPath+'/'+item.id)).body
    const substantiveParams={enterpriseId:e.id,revisionId:substantive.latestRevisionId}
    const substantivePreview=(await get(listPath+'/preview',substantiveParams)).body
    expect(substantivePreview.rows).toEqual([expect.objectContaining({id:d.body.versionId,classification:'evidence_changed'})])
    expect((await rpc('preview_evidence_impacts',substantiveParams)).value.rows).toEqual(substantivePreview.rows)
    await saveArchive(prefix+'-later-coverage','failed');await drain(prefix+'-later-drain')
    const pending=(await get(listPath+'/'+item.id)).body
    expect(pending).toMatchObject({pending:true,classification:'evidence_changed',reviewedBaseline:baseline,evidenceToken:{projectionReady:true}})
    expect((await rpc('get_evidence_impact',{id:item.id})).value).toEqual(pending)
    expect((await get(listPath,{enterpriseId:e.id})).body.rows).toEqual([expect.objectContaining({id:item.id,pending:true})])
    expect(assess((await get('/api/roster/enterprises/'+e.id)).body).explanationValidity.status).toBe('evidence_changed')
    expect((await rpc('save_difference_decision',maintain,'synthetic-mcp')).value).toEqual(receipt.body)
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
    expect(failed.body).toMatchObject({ error: { code: 'transaction_failed' } })
    const failedMcp = await rpc('save_difference_decision', input, 'synthetic-mcp')
    expect(failedMcp.body.result.isError).toBe(true)
    expect(failedMcp.value).toMatchObject({ error: { code: 'transaction_failed' } })
    expect((await get('/api/roster/decision-lifecycle/current',scope)).body.versionId).toBe(d.versionId)
    expect((await get('/api/roster/decision-lifecycle/history',scope)).body.total).toBe(1)
    expect((await get(listPath+'/'+item.id)).body.reviewedBaseline).toBeNull()
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

  it('keeps withdrawal heads in live evidence tokens and preserves historical review state across HTTP and MCP', async () => {
    const e = seed('撤回复核边界主体', 'ISOLATION-196-W'), scope = coord(e.id)
    const decision = await decide(scope, 'isolation196-decision')
    await archive(e, 'isolation196-evidence'); await drain('isolation196-drain')
    const item = (await get(listPath, { enterpriseId: e.id })).body.rows[0]
    const before = (await get(listPath + '/' + item.id)).body
    const withdraw = { ...scope, ...cmd('isolation196-withdraw'), action: 'withdraw', expectedCurrentId: decision.versionId, ruleVersion: 'manual-1', effectiveAt: '2026-10-19T00:00:00Z' }
    const withdrawn = await rpc('save_difference_decision', withdraw, 'synthetic-mcp')
    expect(withdrawn.status).toBe(200)
    expect(withdrawn.body.result.isError).not.toBe(true)
    expect(withdrawn.value).toMatchObject({ currentId: null, previousId: decision.versionId, action: 'withdraw' })
    const detail = (await get(listPath + '/' + item.id)).body
    expect(detail).toMatchObject({
      lineage: 'withdrawn', pending: true, reviewedBaseline: null,
      currentDecision: { versionId: withdrawn.value.versionId, current: null },
      evidenceToken: { decisionId: withdrawn.value.versionId, latestRevisionId: before.evidenceToken.latestRevisionId, projectionReady: true },
      oldDecision: { id: decision.versionId, reasonNote: '保留用户原始原因' },
    })
    expect((await rpc('get_evidence_impact', { id: item.id })).value).toEqual(detail)
    const maintain = { ...scope, ...cmd('isolation196-maintain'), action: 'maintain', expectedCurrentId: decision.versionId, reviewedEvidence: { latestRevisionId: detail.evidenceToken.latestRevisionId, projectionReady: true }, ruleVersion: 'manual-1', effectiveAt: '2026-10-19T00:00:00Z' }
    const stale = await post(decisionPath, maintain)
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'stale_version' } } })
    const noCurrent = { ...maintain, expectedCurrentId: withdrawn.value.versionId }
    expect(await post(decisionPath, noCurrent)).toMatchObject({ status: 409, body: { error: { code: 'no_current_decision' } } })
    const rejected = await rpc('save_difference_decision', noCurrent, 'synthetic-mcp')
    expect(rejected.body.result.isError).toBe(true)
    expect(rejected.value).toMatchObject({ error: { code: 'no_current_decision' } })
    await archive(e, 'isolation196-later-evidence', '撤回之后的新事实'); await drain('isolation196-later-drain')
    const later = (await get(listPath + '/' + item.id)).body
    expect(later).toMatchObject({ lineage: 'withdrawn', reviewedBaseline: null, oldDecision: detail.oldDecision, evidenceToken: { decisionId: withdrawn.value.versionId, projectionReady: true } })
    expect(later.evidenceToken.latestRevisionId).toBeGreaterThan(detail.evidenceToken.latestRevisionId)
    expect((await get(listPath, { enterpriseId: e.id })).body.rows).toEqual([])
    expect((await post(decisionPath, withdraw)).body).toEqual(withdrawn.value)
    expect((await get('/api/roster/decision-lifecycle/history', scope)).body.total).toBe(2)
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
    const result=await client.commit({idempotencyKey:'unknown-archive114',sourceKind:'alias_evidence',sourceIdentity:'synthetic-unknown',payload:{platformQueries:[{interface:'business_list',queryKey:'name:'+unknown.name,rdjb:'2',queriedAt:'2026-10-19T05:00:00Z',status:'no_record',rawResponse:'SYNTHETIC_EMPTY_RESPONSE',relations:[]}]}});expect(result.status).toBe('committed');await drain('unknown-drain')
    expect((await get(listPath,{enterpriseId:unknown.id})).body.rows).toEqual([])
    const unknownAssessment=(await get('/api/roster/enterprises/'+unknown.id)).body.titleAssessments.find((x:any)=>x.titleCode==='specialized_sme'&&x.direction==='missing_in_miit')
    expect(unknownAssessment).toMatchObject({queryCoverage:{status:'unknown',sources:[{subjectMatch:'name_only',outcome:'unknown'}]},explanationValidity:{status:'unknown',reasons:['no_evidence_baseline']}})
  })

  it('keeps a maintained legacy decision under the existing lifecycle ownership guards for import curation and merge',async()=>{
    const e=seed('维持旧导入决定','REVIEW-114-LEGACY'),scope=coord(e.id), target=seed('归并规范主体','REVIEW-114-LEGACY-TARGET')
    const old=db.insert(schema.differenceReason).values({...scope,direction:'missing_in_miit',status:'confirmed_reason',reasonCode:'other',reasonNote:'不可重写的原始理由',measureCode:'keep_history',verificationStatus:'confirmed',recordedAt:'2026-10-01T00:00:00Z'}).returning().get()
    await archive(e,'legacy-q');await drain('legacy-drain')
    const item=(await get(listPath,{enterpriseId:e.id})).body.rows[0], detail=(await get(listPath+'/'+item.id)).body
    const maintained=await post(decisionPath,{...scope,...cmd('legacy-maintain'),action:'maintain',expectedCurrentId:old.id,reviewedEvidence:{latestRevisionId:detail.evidenceToken.latestRevisionId,projectionReady:true},ruleVersion:'manual-1',effectiveAt:'2026-10-19T00:00:00Z'})
    expect(maintained.status).toBe(200)
    const imported=await client.commit({idempotencyKey:'legacy-after-maintain-import',sourceKind:'alias_evidence',sourceIdentity:'synthetic-legacy',payload:{differences:[{uscc:e.usccNorm!,titleCode:'specialized_sme',direction:'missing_in_miit',status:'not_queried',recordedAt:'2026-10-19T10:00:00Z'}]}})
    expect(imported.status).toBe('failed');expect(imported.items.some(i=>i.error?.code==='decision_lifecycle_required')).toBe(true)
    const patch=await fetch(base+'/api/comparison/curated',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({uscc:e.usccNorm,titleCode:'specialized_sme',direction:'missing_in_miit',curated:true,note:'旧路径不应覆盖'})})
    expect(patch.status).toBe(409);expect((await patch.json() as any).error.code).toBe('decision_lifecycle_required')
    const merged=await client.commit({idempotencyKey:'legacy-after-maintain-merge',sourceKind:'alias_evidence',sourceIdentity:'synthetic-merge',payload:{merges:[{fromEnterpriseId:e.id,intoUscc:target.usccNorm!,sourceKind:'manual'}]}})
    expect(merged.status).toBe('failed');expect(merged.items.some(i=>i.error?.code==='merge_difference_lifecycle_conflict')).toBe(true)
    expect((await get('/api/roster/decision-lifecycle/current',scope)).body.current).toMatchObject({id:old.id,enterpriseId:e.id,reasonNote:'不可重写的原始理由'})
    expect((await get('/api/roster/decision-lifecycle/history',scope)).body.total).toBe(1)
  })

  it('distinguishes provable invalid premises coverage-only no-review and reviewed baselines without inventing a replacement',async()=>{
    const e=seed('未查询前提核验','REVIEW-114-PREMISE'),scope=coord(e.id)
    const old=db.insert(schema.differenceReason).values({...scope,direction:'missing_in_miit',status:'not_queried',measureCode:'manual_review',verificationStatus:'pending',recordedAt:'2026-10-01T00:00:00Z'}).returning().get()
    const confirmed=await decide(coord(e.id,'extra_in_miit'),'premise-confirmed')
    const archiveResult=await client.commit({idempotencyKey:'premise-q',sourceKind:'alias_evidence',sourceIdentity:'synthetic-premise',payload:{platformQueries:[{interface:'business_list',queryKey:e.usccNorm!,titleCode:'specialized_sme',rdjb:'2',queriedAt:'2026-10-19T01:00:00Z',status:'no_record',rawResponse:'SYNTHETIC_EMPTY_RESPONSE',relations:[]}]}});expect(archiveResult.status).toBe('committed');await drain('premise-drain')
    const item=(await get(listPath,{enterpriseId:e.id})).body.rows[0]
    expect(item).toMatchObject({decisionId:old.id,classification:'premise_invalid'})
    const preview=(await get(listPath+'/preview',{revisionId:item.latestRevisionId,enterpriseId:e.id})).body.rows
    expect(preview).toEqual([expect.objectContaining({id:old.id,classification:'premise_invalid'}),expect.objectContaining({id:confirmed.versionId,classification:'no_review'})])
    const assessment=(await get('/api/roster/enterprises/'+e.id)).body.titleAssessments
    expect(assessment.find((a:any)=>a.direction==='missing_in_miit'&&a.titleCode==='specialized_sme').explanationValidity).toMatchObject({status:'premise_invalid',reasons:['query_executed']})
    expect(assessment.find((a:any)=>a.direction==='extra_in_miit'&&a.titleCode==='specialized_sme').explanationValidity).toMatchObject({status:'unknown',reasons:['no_evidence_baseline']})
    const detail=(await get(listPath+'/'+item.id)).body
    const maintained=await post(decisionPath,{...scope,...cmd('premise-acknowledge'),action:'maintain',expectedCurrentId:old.id,reviewedEvidence:{latestRevisionId:detail.evidenceToken.latestRevisionId,projectionReady:true},ruleVersion:'manual-acknowledge',effectiveAt:'2026-10-19T00:00:00Z'})
    expect(maintained.status).toBe(200)
    const current=(await get('/api/roster/decision-lifecycle/current',scope)).body.current
    expect(current).toMatchObject({id:old.id,status:'not_queried',measureCode:'manual_review',reasonCode:null})
    const after=(await get('/api/roster/enterprises/'+e.id)).body.titleAssessments.find((a:any)=>a.direction==='missing_in_miit'&&a.titleCode==='specialized_sme')
    expect(after.explanationValidity).toMatchObject({status:'valid',reasons:[]})
    const repeated=await client.commit({idempotencyKey:'premise-repeat',sourceKind:'alias_evidence',sourceIdentity:'synthetic-premise-repeat',payload:{platformQueries:[{interface:'business_list',queryKey:e.usccNorm!,titleCode:'specialized_sme',rdjb:'2',queriedAt:'2026-10-19T02:00:00Z',status:'no_record',rawResponse:'SYNTHETIC_EMPTY_RESPONSE',relations:[]}]}});expect(repeated.status).toBe('committed');await drain('premise-repeat-drain')
    expect((await get(listPath,{enterpriseId:e.id})).body.rows).toEqual([])
  })
  it('retains merged legacy impact provenance and refuses completion on the merged owner while preserving the survivor scope',async()=>{
    const from=seed('归并旧主体'),into=seed('归并现主体','REVIEW-114-MERGE'),scope=coord(from.id)
    const d=db.insert(schema.differenceReason).values({...scope,direction:'missing_in_miit',status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed',recordedAt:'2026-10-01T00:00:00Z'}).returning().get()
    db.insert(schema.differenceReason).values({...scope,direction:'extra_in_miit',status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed',recordedAt:'2026-10-01T00:00:00Z'}).run()
    await archive(from,'merge-q');await drain('merge-before-drain')
    const pageBefore=(await get(listPath,{enterpriseId:from.id,limit:1})).body
    const expectedBefore=(await get(listPath,{enterpriseId:from.id,limit:100})).body.rows
    const item=(await get(listPath,{enterpriseId:from.id})).body.rows[0]
    const result=await client.commit({idempotencyKey:'merge-legacy114',sourceKind:'alias_evidence',sourceIdentity:'synthetic-merge-legacy',payload:{merges:[{fromEnterpriseId:from.id,intoUscc:into.usccNorm!,sourceKind:'manual'}]}})
    expect(result.status,JSON.stringify(result)).toBe('committed');await drain('merge-after-drain')
    const pageAfter=(await rpc('list_evidence_impacts',{enterpriseId:from.id,limit:1,cursor:pageBefore.nextCursor})).value
    expect([...pageBefore.rows,...pageAfter.rows]).toEqual(expectedBefore)
    const detail=(await get(listPath+'/'+item.id)).body
    expect(detail).toMatchObject({enterpriseId:from.id,lineage:'merged',currentDecision:null,oldDecision:{id:d.id,enterpriseId:into.id},gaps:{coverageStatus:'unknown',subjectUnknown:true}})
    expect((await get(listPath,{enterpriseId:from.id})).body.rows).toEqual([])
    expect((await get(listPath,{enterpriseId:from.id,view:'historical'})).body.rows).toEqual([expect.objectContaining({id:item.id,lineage:'merged'}),expect.objectContaining({lineage:'merged',direction:'extra_in_miit'})])
    const complete=await post(decisionPath,{...scope,...cmd('merge-stale-owner'),action:'maintain',expectedCurrentId:d.id,reviewedEvidence:{latestRevisionId:detail.evidenceToken.latestRevisionId,projectionReady:true},ruleVersion:'manual',effectiveAt:'2026-10-19T00:00:00Z'})
    // Native merges retain the historical identity row while moving the current
    // decision coordinate, so the retained owner rejects its stale version.
    expect(complete).toMatchObject({status:409,body:{error:{code:'stale_version'}}})
    expect((await get('/api/roster/decision-lifecycle/current',coord(into.id))).body.current).toMatchObject({id:d.id,status:'confirmed_no_diff'})
  })

  it('rejects raw and unbounded public inputs and rolls back an entire multi-scope rule publication before a corrected retry',async()=>{
    const e=seed('公开输入核验','REVIEW-114-VALIDATION'),scope=coord(e.id),d=await decide(scope,'validation-d')
    await archive(e,'validation-q');await drain('validation-drain')
    const item=(await get(listPath,{enterpriseId:e.id})).body.rows[0],before=(await get(listPath+'/'+item.id)).body
    for(const params of [{limit:0},{limit:101},{limit:1.5},{enterpriseId:0},{cursor:'forged'},{rawSource:'caller source'}])expect((await get(listPath,params)).status).toBe(400)
    const unknownRpc=await rpc('list_evidence_impacts',{enterpriseId:e.id,rawSource:{id:1}});expect(unknownRpc.status).toBe(400);expect(unknownRpc.body.error.data.code).toBe('invalid_request')
    const falseReady=await post(decisionPath,{...scope,...cmd('false-ready'),action:'maintain',expectedCurrentId:d.versionId,reviewedEvidence:{latestRevisionId:before.evidenceToken.latestRevisionId,projectionReady:false},ruleVersion:'manual',effectiveAt:'2026-10-19T00:00:00Z'});expect(falseReady.status).toBe(400)
    expect((await post(workPath,{...cmd('validation-process-limit'),action:'process',limit:101})).status).toBe(400)
    expect((await rpc('release_evidence_rule',{...cmd('validation-rule-unauth'),action:'release_rule',ruleId:'validation',version:'1',scopes:[{...scope,previousEvaluationDigest:'0'.repeat(64),evaluationDigest:'1'.repeat(64)}]})).status).toBe(401)
    const rule={...cmd('atomic-rule114'),action:'release_rule',ruleId:'validation',version:'atomic-1',scopes:[{...scope,previousEvaluationDigest:'0'.repeat(64),evaluationDigest:'1'.repeat(64)},{...scope,enterpriseId:999999,previousEvaluationDigest:'0'.repeat(64),evaluationDigest:'2'.repeat(64)}]}
    const failed=await post(workPath,rule);expect(failed.status).toBe(404)
    const after=(await get(listPath+'/'+item.id)).body
    expect(after.evidenceToken).toEqual(before.evidenceToken)
    const retry=await post(workPath,{...rule,scopes:[rule.scopes[0]]});expect(retry.status).toBe(200);expect(retry.body.revisionIds).toEqual([expect.any(Number)])
    expect((await get(listPath+'/'+item.id)).body.evidenceToken.projectionReady).toBe(false)
    const forbidden=await post(decisionPath,{...scope,...cmd('no-decision-on-maintain'),action:'maintain',expectedCurrentId:d.versionId,reviewedEvidence:{latestRevisionId:before.evidenceToken.latestRevisionId,projectionReady:true},ruleVersion:'manual',effectiveAt:'2026-10-19T00:00:00Z',decision:{status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed'}})
    expect(forbidden.status).toBe(400)
    const missing=await get(listPath+'/999999');expect(missing.status).toBe(404)
  })

  it('retains merged impact IDs with an explicit decision gap when legacy duplicate consolidation removed the underlying version',async()=>{
    const from=seed('归并同内容旧主体'),into=seed('归并同内容现主体','REVIEW-114-MERGE-DUP')
    const material={titleCode:'specialized_sme',direction:'missing_in_miit' as const,status:'confirmed_no_diff' as const,measureCode:'none' as const,verificationStatus:'confirmed' as const,recordedAt:'2026-10-01T00:00:00Z'}
    const old=db.insert(schema.differenceReason).values({...material,enterpriseId:from.id}).returning().get(),survivor=db.insert(schema.differenceReason).values({...material,enterpriseId:into.id}).returning().get()
    await archive(from,'merge-duplicate-q');await drain('merge-duplicate-before')
    const item=(await get(listPath,{enterpriseId:from.id})).body.rows[0]
    const merged=await client.commit({idempotencyKey:'merge-duplicate114',sourceKind:'alias_evidence',sourceIdentity:'synthetic-merge-duplicate',payload:{merges:[{fromEnterpriseId:from.id,intoUscc:into.usccNorm!,sourceKind:'manual'}]}});expect(merged.status).toBe('committed');await drain('merge-duplicate-after')
    const detail=await get(listPath+'/'+item.id);expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({id:item.id,decisionId:old.id,lineage:'merged',oldDecision:null,currentDecision:null,gaps:{decisionUnavailable:true}})
    expect((await get(listPath,{enterpriseId:from.id,view:'historical'})).body.rows).toEqual([expect.objectContaining({id:item.id,decisionId:old.id,oldDecision:null})])
    expect((await get('/api/roster/decision-lifecycle/current',coord(into.id))).body.versionId).toBe(survivor.id)
  })

  it('caps held readers at 64 and evicts the oldest opaque cursor while preserving later HTTP and MCP pages',async()=>{
    const e=seed('读快照容量主体','REVIEW-114-CAP')
    await decide(coord(e.id),'cap-first');await decide(coord(e.id,'extra_in_miit'),'cap-second')
    await archive(e,'cap-q');await drain('cap-drain')
    const input={enterpriseId:e.id,limit:1},first=(await get(listPath,input)).body
    await archive(e,'cap-later','旧读者之后的 WAL 帧')
    const held=db.$client.pragma('wal_checkpoint(PASSIVE)') as Array<{busy:number;log:number;checkpointed:number}>
    expect(held[0]!.checkpointed).toBeLessThan(held[0]!.log)
    let latest=first
    for(let i=0;i<64;i++)latest=(await get(listPath,input)).body
    expect((await get(listPath,{...input,cursor:first.nextCursor})).body.error.code).toBe('invalid_cursor')
    const advanced=db.$client.pragma('wal_checkpoint(PASSIVE)') as Array<{busy:number;log:number;checkpointed:number}>
    expect(advanced[0]!.busy).toBe(0);expect(advanced[0]!.checkpointed).toBe(advanced[0]!.log)
    const last=await rpc('list_evidence_impacts',{...input,cursor:latest.nextCursor})
    expect(last.status).toBe(200);expect(last.value.rows).toEqual([expect.objectContaining({direction:'extra_in_miit'})])
  })
  it('expires 120-second readonly snapshots releases WAL retention and rejects the expired cursor across transports',async()=>{
    const e=seed('读快照到期主体','REVIEW-114-TTL')
    await decide(coord(e.id),'ttl-first');await decide(coord(e.id,'extra_in_miit'),'ttl-second')
    await archive(e,'ttl-q');await drain('ttl-drain')
    const input={enterpriseId:e.id,limit:1},page=(await get(listPath,input)).body
    await archive(e,'ttl-later','快照打开后的已提交事实')
    const held=db.$client.pragma('wal_checkpoint(TRUNCATE)') as Array<{busy:number;log:number;checkpointed:number}>
    expect(held[0]!.busy).toBe(1)
    // Real public server clock: no fake timer, shortened production TTL or private seam.
    await new Promise(resolve=>setTimeout(resolve,121000))
    const expired=await get(listPath,{...input,cursor:page.nextCursor});expect(expired.status).toBe(400);expect(expired.body.error.code).toBe('invalid_cursor')
    const m=await rpc('list_evidence_impacts',{...input,cursor:page.nextCursor});expect(m.status).toBe(200);expect(m.body.result.isError).toBe(true);expect(m.value.error.code).toBe('invalid_cursor')
    const released=db.$client.pragma('wal_checkpoint(TRUNCATE)') as Array<{busy:number;log:number;checkpointed:number}>
    expect(released[0]).toMatchObject({busy:0,log:0,checkpointed:0})
  },140000)

  it('rolls back and releases a readonly snapshot immediately when public list hydration fails',async()=>{
    const e=seed('读快照异常主体','REVIEW-114-READ-FAIL'),first=await decide(coord(e.id),'read-fail-first')
    await decide(coord(e.id,'extra_in_miit'),'read-fail-second');await archive(e,'read-fail-q');await drain('read-fail-drain')
    // Isolated fault only: error after anchor+impact reads have pinned the WAL snapshot.
    db.run(sql`update difference_reason set actor='invalid-json' where id=${first.versionId}`)
    const failed=await get(listPath,{enterpriseId:e.id,limit:1})
    expect(failed.status).toBe(500);expect(failed.body.error.code).toBe('transaction_failed')
    expect(JSON.stringify(failed.body)).not.toMatch(/invalid-json|SELECT|sqlite/i)
    db.run(sql`update difference_reason set actor=${JSON.stringify(actor)} where id=${first.versionId}`)
    const released=db.$client.pragma('wal_checkpoint(TRUNCATE)') as Array<{busy:number;log:number;checkpointed:number}>
    expect(released[0]).toMatchObject({busy:0,log:0,checkpointed:0})
    expect((await get(listPath,{enterpriseId:e.id})).body.rows).toHaveLength(2)
  })
  it('closes active readonly snapshots on the existing server shutdown lifecycle without waiting for idle expiry',async()=>{
    const e=seed('读快照关闭主体','REVIEW-114-CLOSE')
    await decide(coord(e.id),'close-first');await decide(coord(e.id,'extra_in_miit'),'close-second')
    await archive(e,'close-q');await drain('close-drain')
    const page=(await get(listPath,{enterpriseId:e.id,limit:1})).body
    expect(page.nextCursor).toEqual(expect.any(String))
    await archive(e,'close-later','关闭前写入')
    const started=Date.now();await stop();expect(Date.now()-started).toBeLessThan(5000)
    const released=db.$client.pragma('wal_checkpoint(TRUNCATE)') as Array<{busy:number;log:number;checkpointed:number}>
    expect(released[0]).toMatchObject({busy:0,log:0,checkpointed:0})
  },15000)

})
