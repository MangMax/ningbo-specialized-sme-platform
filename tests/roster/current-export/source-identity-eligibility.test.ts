import { nativeWorkbookFixture } from './fixtures/native-workbook'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './fixtures/specialized-export'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { schema as s } from '../../../db/client'
import { specializedExportFixture, rows, year } from './fixtures/specialized-export'
import { readEvidenceToken113 } from '../../../layers/sme-roster/server/utils/evidence-impact-113'
import { readQueryAssessment } from '../../../layers/sme-roster/lib/roster/query-assessment'
const f=nativeWorkbookFixture()
beforeEach(()=>f.resetBusiness())
afterAll(f.close)
let serial=0
const scope = (id:number,titleCode='specialized_sme')=>({enterpriseId:id,titleCode,direction:'extra_in_miit' as const})
const occurrences = (wb:any,id:number): Array<{sheet:string;row:any[]}> => wb.worksheets.slice(0,5).flatMap((sheet:any) => rows(wb,sheet.name).filter(r => matchesBusinessIdentity(f.db, r, id)).map(row => ({sheet:sheet.name,row})))
function relation(id:number, rdjb='2', assigned=true) {
  const e=f.db.select().from(s.enterprise).all().find(e=>e.id===id)!
  const native=submitSyntheticRecognizedCollection(f.db,{rdjb,queriedAt:new Date(Date.now()+(++serial)).toISOString(),rows:[{enterpriseId:assigned?id:null,raw:{id:`PR126-${serial}`,qymc:e.name,tyshxydm:e.usccNorm,rdjb:'2'}}]})
  return {q:{id:native.queryId},r:{id:native.relationIds[0]!}}
}
it('keeps sourced stable enterprises eligible without inventing missing published names', async () => {
  const c=f.candidate('Legacy unnamed official row'), unknown=f.candidate('Unknown identity unnamed row'), conflict=f.candidate('Conflicting official identity')
  f.db.$client.prepare('update record set name_raw=null,uscc_raw=null where id in (?,?)').run(c.record.id,unknown.record.id)
  f.db.$client.prepare('update enterprise set uscc_norm=null where id=?').run(unknown.enterprise.id)
  f.db.$client.prepare('update record set name_raw=null,uscc_raw=? where id=?').run('OTHER-LEGAL-ENTITY',conflict.record.id)
  // Deliberately null legacy fixture stays null: no capture and no current-name fallback.
  const expectedDisplay = Object.freeze({
    8: `${year}年第1批认定，《synthetic-118.xlsx》：未逐出处核实`,
    9: null,
    11: '历史诊断（不参与有效判定）：公布名未留档；未将现名补作公布名；逐出处公布名见公布名称列；现用名见企业名称列；已确认曾用名仅见该列',
    12: `${year}年第1批认定：宁波市经信局公布资料\n《synthetic-118.xlsx》，附件：专精特新中小企业名单，名单序号${c.enterprise.id}，未逐出处核实`,
  })
  const {wb}=await f.workbook('pr126-null-name')
  expect(occurrences(wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['有效企业'])
  const row=occurrences(wb,c.enterprise.id)[0]!.row
  expect({ 8: row[8], 9: row[9] ?? null, 11: row[11], 12: row[12] }).toEqual(expectedDisplay)
  expect(row[8]).not.toContain('Legacy unnamed official row')
  expect(row[11]).not.toContain('现已更名为')
  expect(row[10]).toContain('已见本称号宁波公布')
  expect(row[11]).toContain('公布名未留档')
  expect(row[12]).toContain('synthetic-118.xlsx')
  expect(occurrences(wb,unknown.enterprise.id).map(x=>x.sheet)).toEqual(['有效企业'])
  expect(occurrences(wb,conflict.enterprise.id).map(x=>x.sheet)).toEqual(['有效企业'])
  for(const id of [unknown.enterprise.id,conflict.enterprise.id]) expect(occurrences(wb,id)[0]!.row[15]).toContain('主体身份对应尚未核实')
},60000)
it('excludes query attempts from candidates while keeping positive unassigned platform rows', async () => {
  const empty=f.candidate('Only no record query',[]), failed=f.candidate('Only failed query',[]), positive=f.candidate('Positive unassigned current row',[])
  for(const c of [empty,failed,positive]) f.db.$client.prepare('delete from record where id=?').run(c.record.id)
  for(const [c,status] of [[empty,'no_record'],[failed,'failed']] as const) submitNativePlatformQuery(f.db,{interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-10-20',status,rawResponse:'Synthetic status '+status})
  relation(positive.enterprise.id,'2',false)
  const {wb}=await f.workbook('pr126-positive-candidate')
  expect(occurrences(wb,empty.enterprise.id)).toEqual([])
  expect(occurrences(wb,failed.enterprise.id)).toEqual([])
  expect(occurrences(wb,positive.enterprise.id).map(x=>x.sheet)).toEqual(['未认定'])
},60000)
it('preserves premise invalid and unknown decisions without treating failed coverage as no record', async () => {
  const invalid=f.candidate('Premise invalid departure'), unknown=f.candidate('Unknown baseline departure')
  const d=f.decision(invalid.enterprise.id,'moved_out',{lifecycleAction:null,status:'not_queried'})
  submitNativePlatformQuery(f.db,{interface:'business_list',queryKey:invalid.enterprise.usccNorm!,titleCode:'specialized_sme',rdjb:'2',queriedAt:'2026-10-20',status:'failed',rawResponse:'Synthetic failed source'})
  f.decision(unknown.enterprise.id,'moved_out',{lifecycleAction:null})
  const a=readQueryAssessment(f.db,scope(invalid.enterprise.id))
  expect(a.explanationValidity.status).toBe('premise_invalid')
  expect(a.queryCoverage.status).toBe('failed')
  expect(a.queryCoverage.sources.every(s=>s.outcome==='unknown')).toBe(true)
  const {wb}=await f.workbook('pr126-invalid-unknown')
  for(const id of [invalid.enterprise.id,unknown.enterprise.id])expect(occurrences(wb,id).map(x=>x.sheet)).toEqual(['有效企业'])
  expect(occurrences(wb,invalid.enterprise.id)[0]!.row[11]??'').not.toContain('解释依据：')
  expect(occurrences(wb,invalid.enterprise.id)[0]!.row.join(' ')).not.toContain('decision:'+d.id)
},60000)