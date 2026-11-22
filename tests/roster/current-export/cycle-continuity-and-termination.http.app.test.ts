import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './fixtures/specialized-export'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import type ExcelJS from 'exceljs'
import { specializedExportFixture, rows, year as y, type Event } from './fixtures/specialized-export'

const f = specializedExportFixture()
vi.setConfig({ testTimeout: 60_000 })
beforeEach(f.resetBusiness, 90_000)
afterAll(f.close)
const award = (year: number|null, batchSeq: number|null = 1): Event => ({eventType:'award',year,batchSeq})
const review = (year: number|null, decidedYear: number|null, reviewOutcome: 'passed'|'failed'|null = 'passed', batchSeq: number|null = 1): Event => ({eventType:'review',year,decidedYear,reviewOutcome,batchSeq})
function exported(wb: ExcelJS.Workbook, id: number) {
  return wb.worksheets.slice(0,5).flatMap(sheet => rows(wb,sheet.name).filter(row => matchesBusinessIdentity(f.db, row, id)).map(row => ({sheet:sheet.name,row})))
}
it('不同原周期同结论年失败优先于正式延续', async () => {
  const c=f.candidate('旧失败当前延续同结论年',[award(y-8),award(y-5),review(y-8,y-1,'failed'),review(y-5,y-1)])
  const {wb}=await f.workbook('r3-cross-cycle-same-year')
  const actual=exported(wb,c.enterprise.id)
  expect(actual.map(r=>r.sheet)).toEqual(['已到期'])
  expect(actual[0]!.row[6]).toBe(String(y-8))
  expect(actual[0]!.row[7]).toContain('复核未通过')
  expect(actual[0]!.row[7]).toContain('复核通过')
})
it('独立周期失败后的较晚正式通过重启资格期间', async () => {
  const c=f.candidate('独立周期失败后仅通过',[award(y-16),review(y-8,y-4,'failed'),review(y-8,y-1)])
  const {wb}=await f.workbook('r3-failed-then-passed')
  const actual=exported(wb,c.enterprise.id)
  expect(actual.map(r=>r.sheet)).toEqual(['有效企业'])
  expect(actual[0]!.row[6]).toBe(String(y-16))
  expect(actual[0]!.row[7]).toContain('复核未通过')
})
it('同原年份各批次失败优先且未决资料不覆盖正式延续期间', async () => {
  const cases: Array<{name:string;extra:Event[];sheet:string}>=[
    {name:'另一批明确失败',sheet:'已到期',extra:[review(y-4,y,'failed',2)]},
    {name:'另一批无复核',sheet:'有效企业',extra:[]},
    {name:'另一批缺结果',sheet:'有效企业',extra:[review(y-4,y,null,2)]},
    {name:'另一批缺结论年',sheet:'有效企业',extra:[review(y-4,null,'passed',2)]},
  ]
  const entries=cases.map(c=>({...c,...f.candidate(c.name,[award(y-4,1),award(y-4,2),review(y-4,y-1),...c.extra])}))
  const {wb}=await f.workbook('r3-preserve-all-batches')
  for (const sheet of ['有效企业','已到期','已注销（吊销）','已迁出','未认定']) {
    expect(rows(wb,sheet).map(row=>businessIdentity(row)),sheet).toEqual(entries.filter(c=>c.sheet===sheet).map(c=>expectedBusinessIdentity(f.db,c.enterprise.id)))
  }
  for(const c of entries) {
    const actual=exported(wb,c.enterprise.id)
    expect.soft(actual.map(r=>r.sheet),c.name).toEqual([c.sheet])
    expect.soft(actual[0]!.row[7].split('\n').filter((line:string)=>line.endsWith('认定')),c.name).toHaveLength(2)
    expect.soft(actual[0]!.row[7],c.name).toContain('第2批')
    expect.soft(actual[0]!.row[12].match(/synthetic-118\.xlsx/g),c.name).toHaveLength(3+c.extra.length)
  }
})
it('正式更正失败事实后重新导出恢复资格并保留首次及出处审计',async()=>{
  const c=f.candidate('正式更正恢复',[award(y-8),review(y-8,y-1,'failed')])
  const failed=f.db.$client.prepare("select id,revision from record_event where record_id=? and review_outcome='failed'").get(c.record.id) as {id:number;revision:number}
  const before=await f.workbook('r3-before-official-correction')
  expect(exported(before.wb,c.enterprise.id).map(r=>r.sheet)).toEqual(['已到期'])
  const eventUrl='/api/roster/events/'+failed.id
  const readBefore=await (await fetch(f.url(eventUrl))).json()
  const request={idempotencyKey:'r3-correct-failed-fact',sourceIdentity:'synthetic-r3-official-correction',actor:{type:'agent',id:'r3-test'},basis:'正式附件核实原失败标注错误，原结论为通过',operations:[{eventId:failed.id,recordId:c.record.id,enterpriseId:c.enterprise.id,expectedRevision:failed.revision,patch:{reviewOutcome:'passed'}}]}
  const post=(action:string,body:unknown)=>fetch(f.url('/api/roster/events/corrections/'+action),{method:'POST',headers:f.headers,body:JSON.stringify(body)})
  const preflight=await post('preflight',request)
  const plan=await preflight.json()
  expect(preflight.status,JSON.stringify(plan)).toBe(200)
  const committed=await post('commit',{request,planHash:plan.planHash})
  expect(committed.status).toBe(200)
  const readAfter=await (await fetch(f.url(eventUrl))).json()
  expect(readAfter.event).toMatchObject({id:failed.id,revision:2,reviewOutcome:'passed'})
  expect(readAfter.evidence).toEqual(readBefore.evidence)
  const audit=await (await fetch(f.url(eventUrl+'/audit'))).json()
  expect(audit).toMatchObject({total:1,rows:[{before:{reviewOutcome:'failed'},after:{reviewOutcome:'passed'},basis:request.basis}]})
  const {wb}=await f.workbook('r3-after-official-correction')
  const actual=exported(wb,c.enterprise.id)
  expect(actual.map(r=>r.sheet)).toEqual(['有效企业'])
  expect(actual[0]!.row[6]).toBe(String(y-8))
  expect(actual[0]!.row[7]).toContain('复核通过')
  expect(actual[0]!.row[12].match(/synthetic-118\.xlsx/g)).toHaveLength(2)
},60000)
it('当前及历史出处缺口仅备注并保留当前资格与真实首次历史',async()=>{
  const cases: Array<{id:string;events:Event[];removeIndex:number;sheet:string;first:number|null}>=[
    {id:'missing-current-review-evidence',events:[award(y-4),review(y-4,y-1)],removeIndex:1,sheet:'有效企业',first:y-4},
    {id:'missing-current-award-evidence',events:[award(y-4),review(y-4,y-1)],removeIndex:0,sheet:'有效企业',first:null},
    {id:'missing-old-first-evidence',events:[award(y-8),review(y-4,y-1)],removeIndex:0,sheet:'有效企业',first:null},
  ]
  const entries=cases.map(c=>({...c,...f.candidate(c.id,c.events)}))
  for(const c of entries) {
    const events=f.db.$client.prepare('select id from record_event where record_id=? order by id').all(c.record.id) as {id:number}[]
    f.db.$client.prepare('delete from record_evidence where record_event_id=?').run(events[c.removeIndex]!.id)
  }
  const {wb}=await f.workbook('r3-missing-current-evidence')
  for (const sheet of ['有效企业','已到期','已注销（吊销）','已迁出','未认定']) {
    expect(rows(wb,sheet).map(row=>businessIdentity(row)),sheet).toEqual(entries.filter(c=>c.sheet===sheet).map(c=>expectedBusinessIdentity(f.db,c.enterprise.id)))
  }
  for(const c of entries) {
    const actual=exported(wb,c.enterprise.id)
    expect(actual.map(r=>r.sheet),c.id).toEqual([c.sheet])
    expect(actual[0]!.row[6]??null,c.id).toBe(c.first==null?null:String(c.first))
    expect(actual[0]!.row[12]).toContain('正式出处待核')
  }
},60000)
