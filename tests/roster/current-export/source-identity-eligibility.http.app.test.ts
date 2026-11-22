import { syntheticRecognizedQuery } from '../fixtures/recognized-source'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { readPostgresLegacyQualification } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { readPostgresQueryAssessments } from '../../../layers/sme-roster/lib/roster/query-assessment-postgres'
import { postgresIdentityExportFixture } from './fixtures/postgres-identity-export'
import { rows, year } from './fixtures/specialized-export'

const f = postgresIdentityExportFixture()
const { occurrences } = f
beforeAll(() => f.start(), 90000)
beforeEach(() => f.resetBusiness())
afterAll(() => f.close())
let serial = 0
const actor = { type:'agent', id:'synthetic-pr126' }
async function api(path: string, body: unknown) {
  const response = await fetch(f.url(path), { method:'POST', headers:f.headers, body:JSON.stringify(body) })
  return { status:response.status, body:await response.json() }
}
const scope = (id:number, titleCode = 'specialized_sme' as const) => ({ enterpriseId:id, titleCode, direction:'extra_in_miit' as const })
async function maintain(id:number, version:number) {
  const token = await f.reviewToken(scope(id),version)
  const r = await api('/api/roster/decision-lifecycle/commands',{...scope(id),action:'maintain',expectedCurrentId:version,idempotencyKey:'pr126-maintain-'+(++serial),actor,basis:'Explicitly reviewed all committed evidence',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:true}})
  expect(r.status,JSON.stringify(r.body)).toBe(200)
}
async function relation(id:number, rdjb='2', assigned=true) {
  const e=f.identity(id)
  const native=await seedPostgresPlatformQuery(f.db,syntheticRecognizedQuery({rdjb,queriedAt:new Date(Date.now()+(++serial)).toISOString(),rows:[{enterpriseId:assigned?id:null,raw:{id:`PR126-${serial}`,qymc:e.name,tyshxydm:e.usccNorm,rdjb:'2'}}]}))
  return {q:{id:native.queryId},r:{id:native.relationIds[0]!}, sourceKey:`PR126-${serial}`}
}
// Valid identity is independent of the shared fixture's intentionally invalid codes.
const sourceCodes = ['91310115MA1H7KUG93','91310114MA1GYDE2XE','91440300MA5G2DGE3R','91330110MA2GMDFH58'] as const
async function sourceCandidate(name: string, index: number, formal = false) {
  const code = sourceCodes[index]!
  const c = await f.candidate(name, formal ? [{eventType:'award',year,batchSeq:1}] : [], undefined, code)
  return { ...c, code }
}
function sourceFact(c: Awaited<ReturnType<typeof sourceCandidate>>, key: string, raw: Record<string,unknown> = {}, assigned = false) {
  return seedPostgresPlatformQuery(f.db,syntheticRecognizedQuery({rdjb:'2',queriedAt:new Date(Date.now()+(++serial)*1000).toISOString(),rows:[{
    enterpriseId:assigned?c.enterprise.id:null,
    raw:{id:key,qymc:'Platform former name',tyshxydm:c.code,rdjb:'2',rdtime:`${year-1}-01-01`,rddqrq:`${year+1}-12-31`,sfyx:'1',szsmc:'宁波市',...raw},
  }]}))
}
async function currentIdentity(id: number, status: 'effective'|'unrecognized') {
  const response = await fetch(f.url(`/api/roster/current-enterprises?titleCode=specialized_sme&status=${status}&pageSize=200`),{headers:f.headers})
  expect(response.status).toBe(200)
  const body = await response.json()
  return body.rows.filter((row:any)=>row.enterpriseId===id)
}
it('keeps explanation validity readable while legacy subject decisions do not alter formal eligibility', async () => {
  const c=await f.candidate('Changed departure evidence'), legacy=await f.candidate('Maintained legacy termination')
  const d=await f.decision(c.enterprise.id,'moved_out')
  await maintain(c.enterprise.id,d.id)
  const l=await f.decision(legacy.enterprise.id,'deregistered',{lifecycleAction:null,basis:null,effectiveAt:null})
  await maintain(legacy.enterprise.id,l.id)
  const release=await api('/api/roster/evidence-impacts/commands',{action:'release_rule',idempotencyKey:'pr126-rule-'+(++serial),actor,basis:'Synthetic rule change',ruleId:'synthetic-pr126',version:String(serial),scopes:[{...scope(c.enterprise.id),previousEvaluationDigest:'0'.repeat(64),evaluationDigest:'1'.repeat(64)}]})
  expect(release.status).toBe(200)
  for(let i=0;i<20;i++){const r=await api('/api/roster/evidence-impacts/commands',{action:'process',limit:100,idempotencyKey:'pr126-process-'+(++serial),actor,basis:'Process synthetic impacts'});expect(r.status).toBe(200);if(!r.body.unfinished)break}
  expect((await readPostgresQueryAssessments(f.db,[scope(c.enterprise.id)]))[0]!.explanationValidity.status).toBe('evidence_changed')
  expect((await readPostgresQueryAssessments(f.db,[scope(legacy.enterprise.id)]))[0]!.explanationValidity.status).toBe('valid')
  const {wb}=await f.workbook('pr126-validity')
  expect(occurrences(wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['有效企业'])
  expect(occurrences(wb,c.enterprise.id)[0]!.row[11]??'').not.toContain('解释依据：')
  expect(occurrences(wb,legacy.enterprise.id).map(x=>x.sheet)).toEqual(['有效企业'])
  expect(occurrences(wb,legacy.enterprise.id)[0]!.row[11]??'').not.toContain('解释依据：')
},60000)
it('assigns multi title recognized candidates by original source page segments', async () => {
  const c=await f.candidate('Only segmented specialized row',[])
  await f.query('delete from business.record where id=$1',[c.record.id])
  await relation(c.enterprise.id,'1,2,3')
  for(const title of ['specialized_sme','little_giant','innovative_sme'] as const){
    const {wb}=await f.workbook('source-page-'+title,title)
    expect(occurrences(wb,c.enterprise.id).map(x=>x.sheet)).toEqual(title==='little_giant'?[]:['未认定'])
  }
},60000)
it('retains historical inbound receipts while only a same-code source period grants current eligibility', async () => {
  const c=await sourceCandidate('Inbound renamed current enterprise',0)
  const {q,r}=await relation(c.enterprise.id)
  await f.query('insert into business.enterprise_alias(enterprise_id,name,name_norm,verification_status,source_kind,created_at) values ($1,$2,$2,$3,$4,$5)',[c.enterprise.id,'Confirmed old inbound name','confirmed','manual',new Date().toISOString()])
  const result=await api('/api/roster/decision-lifecycle/commands',{...scope(c.enterprise.id),action:'replace',expectedCurrentId:null,idempotencyKey:'pr126-qualified-inbound',actor,basis:'Synthetic independent qualification and publication search verification',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:q.id,evidenceRelationId:r.id,movedIn:{titleCode:'specialized_sme'},currentQualification:{titleCode:'specialized_sme',validFrom:`${year-1}-01-01T00:00:00Z`,validUntil:`${year+1}-01-01T00:00:00Z`,basis:'Verified external award document and current qualification',publicationCheck:{status:'not_found',scope:'All ingested Ningbo specialized announcements through 2026-10-20; current and confirmed former names'}}}})
  expect(result.status,JSON.stringify(result.body)).toBe(200)
  await maintain(c.enterprise.id,result.body.versionId)
  // This old relation has neither a recognition start nor a usable current period.
  const manual=await f.workbook('pr126-manual-inbound-is-not-current-grant')
  expect(occurrences(manual.wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['未认定'])
  expect(await currentIdentity(c.enterprise.id,'effective')).toEqual([])
  expect(await currentIdentity(c.enterprise.id,'unrecognized')).toMatchObject([{name:'Inbound renamed current enterprise',uscc:'91310115MA1H7KUG93'}])
  await sourceFact(c,'same-code-inbound') // pending assignment, changed platform name, no second human command
  const {wb}=await f.workbook('pr126-source-period-inbound-http')
  const actual=occurrences(wb,c.enterprise.id)
  expect(actual.map(x=>x.sheet)).toEqual(['有效企业'])
  expect(actual[0]!.row[6]??'').toBe('')
  expect(actual[0]!.row[9]).toBe('Confirmed old inbound name')
  expect(actual[0]!.row[14]).toContain(`有效期间：${year-1}-01-01 至 ${year+1}-12-31（含首尾）`)
  expect(actual[0]!.row[10]).toBe('平台资格；未见本称号公布记录')
  expect(actual[0]!.row.join(' ')).not.toContain('decision:'+result.body.versionId)
  const current=await currentIdentity(c.enterprise.id,'effective')
  expect(current).toMatchObject([{name:'Inbound renamed current enterprise',uscc:'91310115MA1H7KUG93',group:'eligible'}])
  expect(current[0].qualificationAssessment.titles.find((title:any)=>title.titleCode==='specialized_sme')).toMatchObject({
    group:'eligible',effectiveQualification:{status:'effective',source:{source:'recognized_list',period:{from:{raw:`${year-1}-01-01`},until:{raw:`${year+1}-12-31`}}}},
  })
  expect((await f.query('select count(*)::int n from business.record_event where record_id=$1',[c.record.id])).rows[0]).toEqual({n:0})
},60000)

it('preserves historical qualification command validation without granting current eligibility', async () => {
  const decision=(queryId:number,relationId:number,qualification:any)=>({status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:queryId,evidenceRelationId:relationId,currentQualification:qualification})
  const base={titleCode:'specialized_sme',validFrom:`${year-1}-01-01T00:00:00Z`,validUntil:`${year+1}-01-01T00:00:00Z`,basis:'Synthetic independently verified external qualification',publicationCheck:{status:'not_found',scope:'Ingested Ningbo announcements and all confirmed names'}}
  const pending:number[]=[]
  for(const [label,patch,review] of [
    ['expired',{validUntil:`${year}-01-01T00:00:00Z`},true],
    ['future',{validFrom:`${year+1}-01-01T00:00:00Z`,validUntil:`${year+2}-01-01T00:00:00Z`},true],
    ['confirmed without diagnostic review',{},false],
    ['unconfirmed',{},false],
    ['publication unchecked',{publicationCheck:{status:'not_checked',scope:'No publication search completed'}},true],
  ] as const){
    const c=await f.candidate('Inbound boundary '+label,[]),{q,r}=await relation(c.enterprise.id)
    const result=await api('/api/roster/decision-lifecycle/commands',{...scope(c.enterprise.id),action:'replace',expectedCurrentId:null,idempotencyKey:'pr126-boundary-'+label,actor,basis:'Synthetic explicit verification',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',decision:{...decision(q.id,r.id,{...base,...patch}),...(label==='unconfirmed'?{verificationStatus:'pending'}:{})}})
    if(label==='unconfirmed') { expect(result.status).toBe(400); pending.push(c.enterprise.id); continue }
    expect(result.status,JSON.stringify(result.body)).toBe(200)
    if(review)await maintain(c.enterprise.id,result.body.versionId)
    pending.push(c.enterprise.id)
  }
  const c=await f.candidate('Invalid qualification scope',[]),{q,r}=await relation(c.enterprise.id)
  for(const patch of [{titleCode:'little_giant'},{validUntil:base.validFrom},{basis:''}]){
    const result=await api('/api/roster/decision-lifecycle/commands',{...scope(c.enterprise.id),action:'replace',expectedCurrentId:null,idempotencyKey:'pr126-reject-'+(++serial),actor,basis:'Synthetic',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',decision:decision(q.id,r.id,{...base,...patch})})
    expect(result.status).toBe(400)
  }
  const {wb}=await f.workbook('pr126-inbound-boundaries')
  for(const id of pending)expect(occurrences(wb,id).map(x=>x.sheet),String(id)).toEqual(['未认定'])
},60000)

it('preserves historical source ownership commands and explicit prior-version interval boundaries', async () => {
  const c=await f.candidate('Exact inbound interval',[]),{q,r}=await relation(c.enterprise.id)
  const qualification={titleCode:'specialized_sme',validFrom:'2026-01-01T00:00:00Z',validUntil:'2027-01-01T00:00:00Z',basis:'Verified external award',publicationCheck:{status:'not_found',scope:'Ingested Ningbo announcements including confirmed former names'}}
  const command={...scope(c.enterprise.id),action:'replace',expectedCurrentId:null,actor,basis:'Synthetic independent qualification verification',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:q.id,evidenceRelationId:r.id,currentQualification:qualification}}
  const unassigned=await relation(c.enterprise.id,'2',false)
  const rejected=await api('/api/roster/decision-lifecycle/commands',{...command,idempotencyKey:'pr126-unconfirmed-source',decision:{...command.decision,evidenceQueryId:unassigned.q.id,evidenceRelationId:unassigned.r.id}})
  expect(rejected.status).toBe(422)
  const result=await api('/api/roster/decision-lifecycle/commands',{...command,idempotencyKey:'pr126-exact-interval'})
  expect(result.status,JSON.stringify(result.body)).toBe(200)
  const replay=await api('/api/roster/decision-lifecycle/commands',{...command,idempotencyKey:'pr126-exact-interval'})
  expect(replay.body).toEqual(result.body)
  await maintain(c.enterprise.id,result.body.versionId)
  const at = async (instant: string) => {
    const snapshot = await f.db.transaction(tx => readPostgresLegacyQualification(tx,c.enterprise.id,Date.parse(instant)),
      { isolationLevel: 'repeatable read', accessMode: 'read only' })
    return snapshot.titles.find(row => row.titleCode === 'specialized_sme')?.group
  }
  expect(await at('2025-12-31T23:59:59.999Z')).toBe('pending')
  expect(await at(qualification.validFrom)).toBe('eligible')
  expect(await at('2026-12-31T23:59:59.999Z')).toBe('eligible')
  expect(await at(qualification.validUntil)).toBe('pending')
  // Explicit old-version compatibility above retains [from,until). The current
  // version has no platform period here; the stored human interval grants nothing.
  for(const instant of ['2025-12-31T23:59:59.999Z',qualification.validFrom,'2026-12-31T23:59:59.999Z',qualification.validUntil]) {
    expect(await f.currentGroup(c.enterprise.id,'specialized_sme',Date.parse(instant)),instant).toBe('excluded')
  }
  expect((await f.query('select count(*)::int n from business.record_event where record_id=$1',[c.record.id])).rows[0]).toEqual({n:0})
  const current=await f.workbook('pr126-prior-interval-default-consumer')
  expect(occurrences(current.wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['未认定'])
  expect(await currentIdentity(c.enterprise.id,'effective')).toEqual([])
  const changed=await api('/api/roster/decision-lifecycle/commands',{...command,idempotencyKey:'pr126-exact-interval',decision:{...command.decision,currentQualification:{...qualification,basis:'Changed attestation'}}})
  expect(changed.status).toBe(409)
},60000)

// Identity comes from the source code. Pending ownership does not revoke a
// valid period; changed source content does. Formal qualification is independent.
it('recomputes current source facts without a confirmed assignment and preserves independent publication', async () => {
  const expected: Array<{id:number; name:string; code:string; sheet:string}> = []
  let index=0
  for (const change of ['ownership','content'] as const) for (const formal of [false, true]) {
    const name = (formal ? 'Formal survives source ' : 'Source-only ') + change
    const c = await sourceCandidate(name,index++,formal)
    const sourceKey='current-source-'+change+'-'+formal
    await sourceFact(c,sourceKey,{},true)
    const before=await f.workbook('source-before-'+change+'-'+formal)
    expect(occurrences(before.wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['有效企业'])
    expect(await currentIdentity(c.enterprise.id,'effective')).toMatchObject([{name,uscc:c.code,group:'eligible'}])
    if(change==='content') {
      await sourceFact(c,sourceKey,{sfyx:'0',sxsj:`${year}-01-01`,sxyy:'资格取消'})
    } else {
      await f.query(`insert into business.platform_observation_assignment (observation_id,revision,enterprise_id,uscc_raw,name_raw,match_basis,verification_status,alias_name_raw,actor,basis,command_receipt_id,recorded_at,origin)
        select observation_id,revision+1,enterprise_id,uscc_raw,name_raw,match_basis,'pending',alias_name_raw,actor,basis,command_receipt_id,recorded_at,origin
        from business.platform_observation_assignment where enterprise_id=$1 order by observation_id desc, revision desc limit 1`,[c.enterprise.id])
    }
    expected.push({id:c.enterprise.id,name,code:c.code,sheet:formal||change==='ownership'?'有效企业':'未认定'})
  }
  expect((await f.query('select * from business.difference_reason')).rows).toEqual([])
  const {wb}=await f.workbook('source-facts-after')
  for (const item of expected) {
    const actual=occurrences(wb,item.id)
    expect(actual.map(x=>x.sheet),item.name).toEqual([item.sheet])
    expect(actual[0]!.row[2]).toBe(item.name)
    expect(actual[0]!.row[3]).toBe(item.code)
    expect(actual[0]!.row[6]??'').toBe(item.name.startsWith('Formal')?String(year):'')
    const status=item.sheet==='有效企业'?'effective':'unrecognized'
    expect(await currentIdentity(item.id,status)).toMatchObject([{name:item.name,uscc:item.code}])
    expect(await currentIdentity(item.id,status==='effective'?'unrecognized':'effective')).toEqual([])
  }
},60000)

it('distinguishes usable source periods from expired future and missing starts through HTTP and XLSX', async () => {
  const active=await sourceCandidate('Directory active period',0)
  const expired=await sourceCandidate('Directory expired period',1)
  const future=await sourceCandidate('Directory future period',2)
  const missing=await sourceCandidate('Directory missing start',3)
  await sourceFact(active,'period-active')
  await sourceFact(expired,'period-expired',{rdtime:`${year-4}-01-01`,rddqrq:`${year-1}-12-31`})
  await sourceFact(future,'period-future',{rdtime:`${year+1}-01-01`,rddqrq:`${year+4}-12-31`})
  // End-only is not a period; collection time and sfyx=1 cannot fill its start.
  await sourceFact(missing,'period-missing',{rdtime:''})
  const expected={
    effective:[['Directory active period','91310115MA1H7KUG93']],
    unrecognized:[['Directory expired period','91310114MA1GYDE2XE'],['Directory future period','91440300MA5G2DGE3R'],['Directory missing start','91330110MA2GMDFH58']],
  }
  const {wb,result}=await f.workbook('source-period-literal-boundaries')
  expect(result.counts).toEqual({eligible:1,pending:0,excluded:3})
  for(const [status,sheet] of [['effective','有效企业'],['unrecognized','未认定']] as const) {
    const response=await fetch(f.url(`/api/roster/current-enterprises?titleCode=specialized_sme&status=${status}&sort=id_asc`),{headers:f.headers})
    expect(response.status).toBe(200)
    const body=await response.json()
    expect(body.total).toBe(expected[status].length)
    expect(body.rows.map((row:any)=>[row.name,row.uscc])).toEqual(expected[status])
    expect(rows(wb,sheet).map(row=>[row[2],row[3]])).toEqual(expected[status])
  }
  expect(rows(wb,'有效企业')[0]![14]).toContain(`有效期间：${year-1}-01-01 至 ${year+1}-12-31（含首尾）`)
  expect((await f.query('select * from business.difference_reason')).rows).toEqual([])
},60000)
