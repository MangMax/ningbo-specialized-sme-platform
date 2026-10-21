import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './helpers/current-export-118'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema as s } from '../db/client'
import { currentExport118Fixture, rows, year } from './helpers/current-export-118'
import { readEvidenceToken113 } from '../server/utils/evidence-impact-113'
import { readQueryAssessment } from '../lib/roster/query-assessment'
const f = currentExport118Fixture()
beforeAll(() => f.start(), 90000)
afterAll(() => f.close())
let serial = 0
const actor = { type:'agent', id:'synthetic-pr126' }
async function api(path: string, body: unknown) {
  const response = await fetch(f.url(path), { method:'POST', headers:f.headers, body:JSON.stringify(body) })
  return { status:response.status, body:await response.json() }
}
const scope = (id:number, titleCode = 'specialized_sme') => ({ enterpriseId:id, titleCode, direction:'extra_in_miit' as const })
async function maintain(id:number, version:number) {
  const token = readEvidenceToken113(f.db,scope(id))
  const r = await api('/api/roster/decision-lifecycle/commands',{...scope(id),action:'maintain',expectedCurrentId:version,idempotencyKey:'pr126-maintain-'+(++serial),actor,basis:'Explicitly reviewed all committed evidence',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:true}})
  expect(r.status,JSON.stringify(r.body)).toBe(200)
}
const occurrences = (wb:any,id:number): Array<{sheet:string;row:any[]}> => wb.worksheets.slice(0,3).flatMap((sheet:any) => rows(wb,sheet.name).filter(r => matchesBusinessIdentity(f.db, r, id)).map(row => ({sheet:sheet.name,row})))
function relation(id:number, rdjb='2', evidence?:any, sequenceNo=1, assigned=true) {
  const e = f.db.select().from(s.enterprise).all().find(e=>e.id===id)!
  const q = f.db.insert(s.platformQuery).values({interface:'recognized_list',queryKey:e.usccNorm!,rdjb,titleCode:rdjb==='2'?'specialized_sme':null,queriedAt:new Date(Date.now()+(++serial)).toISOString(),status:'success',collectionEvidence:evidence}).returning().get()
  const r = f.db.insert(s.platformRelation).values({queryId:q.id,sequenceNo,enterpriseId:assigned?id:null,usccRaw:e.usccNorm,nameRaw:e.name,verificationStatus:'confirmed',matchBasis:'uscc',status:'有效'}).returning().get()
  return {q,r}
}
it('keeps sourced stable enterprises eligible without inventing missing published names', async () => {
  const c=f.candidate('Legacy unnamed official row'), unknown=f.candidate('Unknown identity unnamed row'), conflict=f.candidate('Conflicting official identity')
  f.db.$client.prepare('update record set name_raw=null,uscc_raw=null where id in (?,?)').run(c.record.id,unknown.record.id)
  f.db.$client.prepare('update enterprise set uscc_norm=null where id=?').run(unknown.enterprise.id)
  f.db.$client.prepare('update record set name_raw=null,uscc_raw=? where id=?').run('OTHER-LEGAL-ENTITY',conflict.record.id)
  const {wb}=await f.workbook('pr126-null-name')
  expect(occurrences(wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['有效企业'])
  const row=occurrences(wb,c.enterprise.id)[0]!.row
  expect(row[8]??'').toBe('')
  expect(row[10]).toContain('已见本称号宁波公布')
  expect(row[11]).toContain('公布名未留档')
  expect(row[12]).toContain('synthetic-118.xlsx')
  expect(occurrences(wb,unknown.enterprise.id).map(x=>x.sheet)).toEqual(['待确认'])
  expect(occurrences(wb,conflict.enterprise.id).map(x=>x.sheet)).toEqual(['待确认'])
},60000)
it('uses explanation validity and accepts explicitly maintained legacy subject decisions', async () => {
  const c=f.candidate('Changed departure evidence'), legacy=f.candidate('Maintained legacy termination')
  const d=f.decision(c.enterprise.id,'moved_out')
  await maintain(c.enterprise.id,d.id)
  const l=f.decision(legacy.enterprise.id,'deregistered',{lifecycleAction:null,basis:null,effectiveAt:null})
  await maintain(legacy.enterprise.id,l.id)
  const release=await api('/api/roster/evidence-impacts/commands',{action:'release_rule',idempotencyKey:'pr126-rule-'+(++serial),actor,basis:'Synthetic rule change',ruleId:'synthetic-pr126',version:String(serial),scopes:[{...scope(c.enterprise.id),previousEvaluationDigest:'0'.repeat(64),evaluationDigest:'1'.repeat(64)}]})
  expect(release.status).toBe(200)
  for(let i=0;i<20;i++){const r=await api('/api/roster/evidence-impacts/commands',{action:'process',limit:100,idempotencyKey:'pr126-process-'+(++serial),actor,basis:'Process synthetic impacts'});expect(r.status).toBe(200);if(!r.body.unfinished)break}
  expect(readQueryAssessment(f.db,scope(c.enterprise.id)).explanationValidity.status).toBe('evidence_changed')
  expect(readQueryAssessment(f.db,scope(legacy.enterprise.id)).explanationValidity.status).toBe('valid')
  const {wb}=await f.workbook('pr126-validity')
  expect(occurrences(wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['待确认'])
  expect(occurrences(wb,c.enterprise.id)[0]!.row[11]).toContain('解释依据：证据已变化；查询覆盖：尚未查询')
  expect(occurrences(wb,legacy.enterprise.id).map(x=>x.sheet)).toEqual(['排除明细'])
  expect(occurrences(wb,legacy.enterprise.id)[0]!.row[11]).toContain('解释依据：适用；查询覆盖：尚未查询')
},60000)
it('excludes query attempts from candidates while keeping positive unassigned platform rows', async () => {
  const empty=f.candidate('Only no record query',[]), failed=f.candidate('Only failed query',[]), positive=f.candidate('Positive unassigned current row',[])
  for(const c of [empty,failed,positive]) f.db.$client.prepare('delete from record where id=?').run(c.record.id)
  for(const [c,status] of [[empty,'no_record'],[failed,'failed']] as const) f.db.insert(s.platformQuery).values({interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-10-20',status}).run()
  relation(positive.enterprise.id,'2',undefined,1,false)
  const {wb}=await f.workbook('pr126-positive-candidate')
  expect(occurrences(wb,empty.enterprise.id)).toEqual([])
  expect(occurrences(wb,failed.enterprise.id)).toEqual([])
  expect(occurrences(wb,positive.enterprise.id).map(x=>x.sheet)).toEqual(['待确认'])
},60000)
it('assigns multi title recognized candidates by original page segments without reading raw bodies', async () => {
  const c=f.candidate('Only segmented specialized row',[])
  f.db.$client.prepare('delete from record where id=?').run(c.record.id)
  relation(c.enterprise.id,'1,2,3',{pages:[{rdjb:'1',page:1,status:'success',fetchedCount:0},{rdjb:'2',page:1,status:'success',fetchedCount:1},{rdjb:'3',page:1,status:'success',fetchedCount:0}],rows:[{archive:'RAW_SENTINEL'}]},1)
  for(const [title,path] of [['specialized_sme','specialized-sme'],['little_giant','little-giant'],['innovative_sme','innovative-sme']] as const){
    const response=await fetch(f.url('/api/roster/exports/current/'+path),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'pr126-segment-'+title})})
    expect(response.status).toBe(202)
    const accepted=await response.json(), job=await f.terminal(accepted.jobId)
    expect(job.state,JSON.stringify(job)).toBe('done')
    const {wb}=await f.download(job)
    expect(occurrences(wb,c.enterprise.id).map(x=>x.sheet)).toEqual(title==='specialized_sme'?['待确认']:[])
  }
},60000)
it('includes reviewed inbound qualification without local publication and retains rename and scope notes', async () => {
  const c=f.candidate('Inbound renamed current enterprise',[])
  const {q,r}=relation(c.enterprise.id)
  f.db.insert(s.enterpriseAlias).values({enterpriseId:c.enterprise.id,name:'Confirmed old inbound name',nameNorm:'Confirmed old inbound name',verificationStatus:'confirmed',sourceKind:'manual'} as any).run()
  const result=await api('/api/roster/decision-lifecycle/commands',{...scope(c.enterprise.id),action:'replace',expectedCurrentId:null,idempotencyKey:'pr126-qualified-inbound',actor,basis:'Synthetic independent qualification and publication search verification',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:q.id,evidenceRelationId:r.id,movedIn:{titleCode:'specialized_sme'},currentQualification:{titleCode:'specialized_sme',validFrom:`${year-1}-01-01T00:00:00Z`,validUntil:`${year+1}-01-01T00:00:00Z`,basis:'Verified external award document and current qualification',publicationCheck:{status:'not_found',scope:'All ingested Ningbo specialized announcements through 2026-10-20; current and confirmed former names'}}}})
  expect(result.status,JSON.stringify(result.body)).toBe(200)
  await maintain(c.enterprise.id,result.body.versionId)
  const {wb}=await f.workbook('pr126-qualified-inbound-http')
  const actual=occurrences(wb,c.enterprise.id)
  expect(actual.map(x=>x.sheet)).toEqual(['有效企业'])
  expect(actual[0]!.row[6]??'').toBe('')
  expect(actual[0]!.row[10]).toContain('未见宁波该称号公布记录')
  expect(actual[0]!.row[11]).toContain('迁入')
  expect(actual[0]!.row[11]).toContain('Confirmed old inbound name')
  expect(actual[0]!.row[11]).toContain('All ingested Ningbo')
  expect(actual[0]!.row[11]).not.toContain('缺少已确认认定及资格依据')
  expect(actual[0]!.row[11]).not.toContain('需核实具体资格与公布匹配范围')
  expect(actual[0]!.row[12]).toContain('工信部已认定企业名单')
  expect(actual[0]!.row.join(' ')).not.toContain('decision:'+result.body.versionId)
},60000)

it('keeps expired future unreviewed and unchecked inbound attestations pending and rejects wrong scope', async () => {
  const decision=(queryId:number,relationId:number,qualification:any)=>({status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:queryId,evidenceRelationId:relationId,currentQualification:qualification})
  const base={titleCode:'specialized_sme',validFrom:`${year-1}-01-01T00:00:00Z`,validUntil:`${year+1}-01-01T00:00:00Z`,basis:'Synthetic independently verified external qualification',publicationCheck:{status:'not_found',scope:'Ingested Ningbo announcements and all confirmed names'}}
  const pending:number[]=[]
  for(const [label,patch,review] of [
    ['expired',{validUntil:`${year}-01-01T00:00:00Z`},true],
    ['future',{validFrom:`${year+1}-01-01T00:00:00Z`,validUntil:`${year+2}-01-01T00:00:00Z`},true],
    ['unreviewed',{},false],
    ['publication unchecked',{publicationCheck:{status:'not_checked',scope:'No publication search completed'}},true],
  ] as const){
    const c=f.candidate('Inbound boundary '+label,[]),{q,r}=relation(c.enterprise.id)
    const result=await api('/api/roster/decision-lifecycle/commands',{...scope(c.enterprise.id),action:'replace',expectedCurrentId:null,idempotencyKey:'pr126-boundary-'+label,actor,basis:'Synthetic explicit verification',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',decision:decision(q.id,r.id,{...base,...patch})})
    expect(result.status,JSON.stringify(result.body)).toBe(200)
    if(review)await maintain(c.enterprise.id,result.body.versionId)
    pending.push(c.enterprise.id)
  }
  const c=f.candidate('Invalid qualification scope',[]),{q,r}=relation(c.enterprise.id)
  for(const patch of [{titleCode:'little_giant'},{validUntil:base.validFrom},{basis:''}]){
    const result=await api('/api/roster/decision-lifecycle/commands',{...scope(c.enterprise.id),action:'replace',expectedCurrentId:null,idempotencyKey:'pr126-reject-'+(++serial),actor,basis:'Synthetic',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',decision:decision(q.id,r.id,{...base,...patch})})
    expect(result.status).toBe(400)
  }
  const {wb}=await f.workbook('pr126-inbound-boundaries')
  for(const id of pending)expect(occurrences(wb,id).map(x=>x.sheet),String(id)).toEqual(['待确认'])
},60000)

it('preserves premise invalid and unknown decisions without treating failed coverage as no record', async () => {
  const invalid=f.candidate('Premise invalid departure'), unknown=f.candidate('Unknown baseline departure')
  const d=f.decision(invalid.enterprise.id,'moved_out',{lifecycleAction:null,status:'not_queried'})
  f.db.insert(s.platformQuery).values({interface:'business_list',queryKey:invalid.enterprise.usccNorm!,titleCode:'specialized_sme',rdjb:'2',queriedAt:'2026-10-20',status:'failed'}).run()
  f.decision(unknown.enterprise.id,'moved_out',{lifecycleAction:null})
  const a=readQueryAssessment(f.db,scope(invalid.enterprise.id))
  expect(a.explanationValidity.status).toBe('premise_invalid')
  expect(a.queryCoverage.status).toBe('failed')
  expect(a.queryCoverage.sources.every(s=>s.outcome==='unknown')).toBe(true)
  const {wb}=await f.workbook('pr126-invalid-unknown')
  for(const id of [invalid.enterprise.id,unknown.enterprise.id])expect(occurrences(wb,id).map(x=>x.sheet)).toEqual(['待确认'])
  expect(occurrences(wb,invalid.enterprise.id)[0]!.row[11]).toContain('尚未确认')
  expect(occurrences(wb,invalid.enterprise.id)[0]!.row.join(' ')).not.toContain('decision:'+d.id)
},60000)

it('keeps unknown multi title positions visible and projects no archived raw bodies', async () => {
  const {readCurrentCandidate,prepareCurrentReader}=await import('../lib/roster/current-qualification')
  const c=f.candidate('Unknown segmented row',[]),{q,r}=relation(c.enterprise.id,'1,2,3')
  f.db.$client.prepare('delete from record where id=?').run(c.record.id)
  f.db.$client.prepare('update platform_query set raw_response=? where id=?').run('RAW_PR126_'+ 'x'.repeat(1024*1024),q.id)
  f.db.$client.prepare('update platform_relation set source_text=? where id=?').run('RAW_PR126_'+ 'x'.repeat(1024*1024),r.id)
  f.decision(c.enterprise.id,'moved_out',{evidenceQueryId:q.id,evidenceRelationId:r.id})
  prepareCurrentReader(f.db.$client)
  const prepare=f.db.$client.prepare.bind(f.db.$client)
  let rawBytes=0
  f.db.$client.prepare=((sql:string)=>{
    const st=prepare(sql)
    const check=(x:any):void=>{if(typeof x==='string'&&x.includes('RAW_PR126_'))rawBytes+=Buffer.byteLength(x);else if(x&&typeof x==='object')Object.values(x).forEach(check)}
    for(const method of ['all','get'] as const){const run=st[method].bind(st);Object.assign(st,{[method]:(...args:any[])=>{const result=run(...args);check(result);return result}})}
    return st
  }) as any
  try {
    const row=readCurrentCandidate(f.db.$client,c.enterprise.id,'specialized_sme',year)
    expect(row.group).toBe('pending');expect(row.references).toContain('platform-relation:'+r.id+' query:'+q.id)
    expect(rawBytes).toBe(0)
  } finally {f.db.$client.prepare=prepare}
  const {wb}=await f.workbook('pr126-unknown-segment')
  expect(occurrences(wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['待确认'])
},60000)

it('requires confirmed source ownership and honors exact qualification interval boundaries', async () => {
  const {readCurrentCandidate}=await import('../lib/roster/current-qualification')
  const c=f.candidate('Exact inbound interval',[]),{q,r}=relation(c.enterprise.id)
  const qualification={titleCode:'specialized_sme',validFrom:'2026-01-01T00:00:00Z',validUntil:'2027-01-01T00:00:00Z',basis:'Verified external award',publicationCheck:{status:'not_found',scope:'Ingested Ningbo announcements including confirmed former names'}}
  const command={...scope(c.enterprise.id),action:'replace',expectedCurrentId:null,actor,basis:'Synthetic independent qualification verification',ruleVersion:'synthetic-pr126',effectiveAt:'2025-01-01T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:q.id,evidenceRelationId:r.id,currentQualification:qualification}}
  f.db.$client.prepare("update platform_relation set verification_status='pending' where id=?").run(r.id)
  const rejected=await api('/api/roster/decision-lifecycle/commands',{...command,idempotencyKey:'pr126-unconfirmed-source'})
  expect(rejected.status).toBe(422)
  f.db.$client.prepare("update platform_relation set verification_status='confirmed' where id=?").run(r.id)
  const result=await api('/api/roster/decision-lifecycle/commands',{...command,idempotencyKey:'pr126-exact-interval'})
  expect(result.status,JSON.stringify(result.body)).toBe(200)
  const replay=await api('/api/roster/decision-lifecycle/commands',{...command,idempotencyKey:'pr126-exact-interval'})
  expect(replay.body).toEqual(result.body)
  await maintain(c.enterprise.id,result.body.versionId)
  const at=(instant:string)=>readCurrentCandidate(f.db.$client,c.enterprise.id,'specialized_sme',year,Date.parse(instant))
  expect(at('2025-12-31T23:59:59.999Z').group).toBe('pending')
  expect(at(qualification.validFrom).group).toBe('eligible')
  expect(at('2026-12-31T23:59:59.999Z').group).toBe('eligible')
  expect(at(qualification.validUntil).group).toBe('pending')
  const changed=await api('/api/roster/decision-lifecycle/commands',{...command,idempotencyKey:'pr126-exact-interval',decision:{...command.decision,currentQualification:{...qualification,basis:'Changed attestation'}}})
  expect(changed.status).toBe(409)
},60000)
