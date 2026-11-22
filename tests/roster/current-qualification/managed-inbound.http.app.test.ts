import { createCurrentQualificationAssessmentReader } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { syntheticRecognizedQuery } from '../fixtures/recognized-source'
import { createRosterImportClient } from '../../../layers/sme-roster/lib/roster-import-client'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema as s } from '../../../db/client'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'

const f = qualificationExportFixture()
beforeAll(async () => {
 const discovery = await readDevelopmentDiscovery()
 expect(JSON.stringify(discovery)).toContain('/api/roster/decision-lifecycle/qualification-preflight')
}, 90000)
afterAll(() => f.close())
it('public source-bound own qualification reaches query detail filters and downloaded identities without formal history', async () => {
 const enterprise = f.db.insert(s.enterprise).values({ name:'合成迁入资格验收',nameNorm:'合成迁入资格验收',usccNorm:'91330211255994457P',city:'宁波市',district:'余姚市' }).returning().get()
 const source = submitNativePlatformQuery(f.db, { interface:'business_list',queryKey:enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-11-16T00:00:00Z',status:'success',rawResponse:'{}',relations:[{sequenceNo:1,enterpriseId:enterprise.id,usccRaw:enterprise.usccNorm!,nameRaw:enterprise.name,verificationStatus:'confirmed',matchBasis:'uscc'}] })
 let observation = 0
 const query = (raw: Record<string, unknown> = {}) => syntheticRecognizedQuery({ rdjb:'2',queriedAt:new Date(Date.now() + (++observation)*1000).toISOString(),rows:[{enterpriseId:null,raw:{id:'managed-source',qymc:'平台曾用名',tyshxydm:enterprise.usccNorm,rdjb:'2',rdtime:'2025-07-22',rddqrq:'2028-07-22',sfyx:'1',szsmc:'宁波市',...raw}}] })
 submitNativePlatformQuery(f.db, query())
 await f.start()
 const client = createRosterImportClient({ baseUrl: f.url(''), token: f.token })
 async function facts(raw: Record<string, unknown> = {}) {
   const input = query(raw)
   const request = {
     idempotencyKey: 'managed-inbound-source-' + observation, sourceKind: 'alias_evidence' as const, sourceIdentity: 'managed-inbound',
     payload: { platformQueries: [input] },
   }
   const receipt = await client.commit(request)
   expect(receipt).toMatchObject({ status: 'committed', summary: { failed: 0 } })
   if (receipt.status !== 'committed') throw new Error('The recognized collection was not committed')
   const item = receipt.items.find(item => item.kind === 'platform_query')!
   const id = item.ref.split(':')[1]
   const [relationId] = item.detail?.relations as number[]
   const path = '/api/platform/queries/' + id + '/evidence?field=relation&relationId=' + relationId
   const evidence = await fetch(f.url(path))
   expect(evidence.status, await evidence.clone().text()).toBe(200)
   const encoded = await evidence.json()
   expect(JSON.parse(Buffer.from(encoded.data, 'base64').toString('utf8'))).toMatchObject({
     enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending',
   })
 }
 const current = async () => {
  const response = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme'))
  expect(response.status, await response.clone().text()).toBe(200)
  return response.json()
 }
 expect((await current()).rows.map((r:any)=>r.uscc)).toEqual(['91330211255994457P'])
 const read = createCurrentQualificationAssessmentReader(f.db.$client)
 for (const [at, expected] of [
  ['2025-07-21T15:59:59Z','unrecognized'],
  ['2025-07-21T16:00:00Z','effective'],
  ['2028-07-22T15:59:59Z','effective'],
  ['2028-07-22T16:00:00Z','unrecognized'],
 ] as const) {
  expect(read.read(enterprise.id,Date.parse(at)).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.effectiveQualification?.status,at).toBe(expected)
 }
 const qualification = { titleCode:'specialized_sme',awardYear:2025,validFrom:'2025-07-22T00:00:00Z',validUntil:'2028-07-22T00:00:00Z',basis:'合成独立资格来源',publicationCheck:{status:'not_found',scope:'合成宁波公布核对范围'} }
 const command = { enterpriseId:enterprise.id,titleCode:'specialized_sme',direction:'extra_in_miit',action:'replace',expectedCurrentId:null,idempotencyKey:'synthetic-inbound',actor:{type:'agent',id:'synthetic'},basis:'合成核实',ruleVersion:'manual',effectiveAt:'2025-07-22T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:source.queryId,evidenceRelationId:source.relationIds[0],movedIn:{city:'南通'},currentQualification:qualification} }
 const post = async (path:string, body:unknown) => { const r = await fetch(f.url(path),{method:'POST',headers:f.headers,body:JSON.stringify(body)});expect(r.status,await r.clone().text()).toBe(200);return r.json() }
 const plan = await post('/api/roster/decision-lifecycle/qualification-preflight',command)
 const saved = await post('/api/roster/decision-lifecycle/qualification-commit',{command,planHash:plan.planHash})
 expect(await post('/api/roster/decision-lifecycle/qualification-commit',{command,planHash:plan.planHash})).toEqual(saved)
 const readback = await fetch(f.url(`/api/roster/decision-lifecycle/current?enterpriseId=${enterprise.id}&titleCode=specialized_sme&direction=extra_in_miit`)).then(r=>r.json())
 expect(readback.current).toMatchObject({id:saved.versionId,currentQualification:qualification,movedInCity:'南通'})
 for (const suffix of ['', '&district=余姚市']) {
  const r = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme'+suffix));expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.total).toBe(1)
  expect(body.rows.map((r:any)=>r.uscc)).toEqual(['91330211255994457P'])
  expect(body.rows[0].firstYear).toBeNull()
  const own = body.rows[0].qualificationAssessment.titles.find((t:any)=>t.titleCode==='specialized_sme')
  expect(own.effectiveQualification).toMatchObject({status:'effective',source:{source:'recognized_list',uscc:'91330211255994457P',period:{from:{value:'2025-07-22'},until:{value:'2028-07-22'}}}})
  expect(own.evidence).toEqual([])
 }
 const detail = await fetch(f.url(`/api/roster/enterprises/${enterprise.id}`)).then(r=>r.json())
 expect(detail.qualificationAssessment.titles.find((t:any)=>t.titleCode==='specialized_sme').effectiveQualification.status).toBe('effective')
 const {bytes} = await f.workbook('synthetic-managed-inbound')
 const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as any)
 const sheet = workbook.getWorksheet('有效企业')!
 expect(sheet.rowCount).toBe(2)
 expect(sheet.getRow(2).getCell(2).value).toBe('合成迁入资格验收')
 const cells = sheet.getRow(2).values
 expect(JSON.stringify(cells)).toContain('91330211255994457P')
 expect(JSON.stringify(cells)).toContain('2025-07-22至2028-07-22')
 expect(JSON.stringify(cells)).not.toContain('合成独立资格来源')
 await post('/api/roster/decision-lifecycle/commands',{...command,action:'withdraw',decision:undefined,expectedCurrentId:saved.versionId,idempotencyKey:'synthetic-withdraw'})
 const after = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme')).then(r=>r.json())
 expect(after.rows.map((r:any)=>r.uscc)).toEqual(['91330211255994457P'])
 const dated = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&recognitionFrom=2025-01-01&recognitionTo=2025-12-31')).then(r=>r.json())
 // The public filter exposes recognition YEAR, not a fabricated publication.
 expect(dated).toMatchObject({total:1,uncertainTotal:0,rows:[{enterpriseId:enterprise.id,firstYear:null,recognition:{precision:'year',year:2025},qualificationWitnesses:[{awardEventId:null}]}]})
 const partial = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&recognitionFrom=2025-07-22&recognitionTo=2025-07-22')).then(r=>r.json())
 expect(partial).toMatchObject({total:0,uncertainTotal:1,rows:[]})
 // Current content versions and source locality control qualification, not the withdrawn receipt.
 await facts({szsmc:'南通市'})
 expect((await current()).rows).toEqual([])
 await facts({sfyx:'0'})
 expect((await current()).rows).toEqual([])
 await facts()
 expect((await current()).rows.map((r:any)=>r.uscc)).toEqual(['91330211255994457P'])
},60000)
