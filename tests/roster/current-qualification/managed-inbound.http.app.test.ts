import ExcelJS from 'exceljs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema as s } from '../../../db/client'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'

// Process acceptance readiness: synthetic SQLite only; parent builds the exact candidate.
const f = qualificationExportFixture()
beforeAll(async () => {
 const discovery = await readDevelopmentDiscovery()
 expect(JSON.stringify(discovery)).toContain('/api/roster/decision-lifecycle/qualification-preflight')
 await f.start()
}, 90000)
afterAll(() => f.close())
it('public source-bound own qualification reaches query detail statistics filters and downloaded identities without formal history', async () => {
 const enterprise = f.db.insert(s.enterprise).values({ name:'合成迁入资格验收',nameNorm:'合成迁入资格验收',usccNorm:'91330211255994457P',city:'宁波市',district:'余姚市' }).returning().get()
 const source = submitNativePlatformQuery(f.db, { interface:'business_list',queryKey:enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-11-16T00:00:00Z',status:'success',rawResponse:'{}',relations:[{sequenceNo:1,enterpriseId:enterprise.id,usccRaw:enterprise.usccNorm!,nameRaw:enterprise.name,verificationStatus:'confirmed',matchBasis:'uscc'}] })
 const qualification = { titleCode:'specialized_sme',awardYear:2025,validFrom:'2025-07-22T00:00:00Z',validUntil:'2028-07-22T00:00:00Z',basis:'合成独立资格来源',publicationCheck:{status:'not_found',scope:'合成宁波公布核对范围'} }
 const command = { enterpriseId:enterprise.id,titleCode:'specialized_sme',direction:'extra_in_miit',action:'replace',expectedCurrentId:null,idempotencyKey:'synthetic-inbound',actor:{type:'agent',id:'synthetic'},basis:'合成核实',ruleVersion:'manual',effectiveAt:'2025-07-22T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:source.queryId,evidenceRelationId:source.relationIds[0],movedIn:{city:'南通'},currentQualification:qualification} }
 const post = async (path:string, body:unknown) => { const r = await fetch(f.url(path),{method:'POST',headers:f.headers,body:JSON.stringify(body)});expect(r.status,await r.clone().text()).toBe(200);return r.json() }
 const plan = await post('/api/roster/decision-lifecycle/qualification-preflight',command)
 const saved = await post('/api/roster/decision-lifecycle/qualification-commit',{command,planHash:plan.planHash})
 const readback = await fetch(f.url(`/api/roster/decision-lifecycle/current?enterpriseId=${enterprise.id}&titleCode=specialized_sme&direction=extra_in_miit`)).then(r=>r.json())
 expect(readback.current).toMatchObject({id:saved.versionId,currentQualification:qualification,movedInCity:'南通'})
 for (const suffix of ['', '&district=余姚市', '&recognitionFrom=2025-01-01&recognitionTo=2025-12-31']) {
  const r = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme'+suffix));expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.total).toBe(1)
  expect(body.rows.map((r:any)=>r.uscc)).toEqual(['91330211255994457P'])
  expect(body.rows[0].firstYear).toBeNull()
  const own = body.rows[0].qualificationAssessment.titles.find((t:any)=>t.titleCode==='specialized_sme')
  expect(own.effectiveQualification).toMatchObject({status:'effective',presentationBasis:['合成独立资格来源 [2025-07-22T00:00:00Z,2028-07-22T00:00:00Z)']})
  expect(own.evidence).toEqual([])
 }
 const detail = await fetch(f.url(`/api/roster/enterprises/${enterprise.id}`)).then(r=>r.json())
 expect(detail.qualificationAssessment.titles.find((t:any)=>t.titleCode==='specialized_sme').effectiveQualification.status).toBe('effective')
 const stats = await fetch(f.url('/api/statistics/districts?title=specialized_sme&district=余姚市')).then(r=>r.json())
 expect(stats.total).toBe(1)
 expect(stats.rows.map((r:any)=>r.enterpriseId)).toEqual([enterprise.id])
 const {bytes} = await f.workbook('synthetic-managed-inbound')
 const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as any)
 const sheet = workbook.getWorksheet('有效企业')!
 expect(sheet.rowCount).toBe(2)
 expect(sheet.getRow(2).getCell(2).value).toBe('合成迁入资格验收')
 const cells = sheet.getRow(2).values
 expect(JSON.stringify(cells)).toContain('91330211255994457P')
 expect(JSON.stringify(cells)).toContain('2025-07-22至2028-07-22')
 expect(JSON.stringify(cells)).toContain('合成独立资格来源')
 await post('/api/roster/decision-lifecycle/commands',{...command,action:'withdraw',decision:undefined,expectedCurrentId:saved.versionId,idempotencyKey:'synthetic-withdraw'})
 const after = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme')).then(r=>r.json())
 expect(after.rows).toEqual([])
},60000)
