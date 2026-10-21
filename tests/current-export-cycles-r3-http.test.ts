import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './helpers/current-export-118'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import type ExcelJS from 'exceljs'
import { currentExport118Fixture, rows, year as y, type Event } from './helpers/current-export-118'

const f = currentExport118Fixture()
beforeAll(f.start, 90000)
beforeEach(f.resetBusiness)
afterAll(f.close)
const award = (year: number|null, batchSeq: number|null = 1): Event => ({eventType:'award',year,batchSeq})
const review = (year: number|null, decidedYear: number|null, reviewOutcome: 'passed'|'failed'|null = 'passed', batchSeq: number|null = 1): Event => ({eventType:'review',year,decidedYear,reviewOutcome,batchSeq})
function exported(wb: ExcelJS.Workbook, id: number) {
  return wb.worksheets.slice(0,3).flatMap(sheet => rows(wb,sheet.name).filter(row => matchesBusinessIdentity(f.db, row, id)).map(row => ({sheet:sheet.name,row})))
}
it('不同原周期同结论年的失败不阻断当前周期正式延续', async () => {
  const c=f.candidate('旧失败当前延续同结论年',[award(y-8),award(y-5),review(y-8,y-1,'failed'),review(y-5,y-1)])
  const {wb}=await f.workbook('r3-cross-cycle-same-year')
  const actual=exported(wb,c.enterprise.id)
  expect(actual.map(r=>r.sheet)).toEqual(['有效企业'])
  expect(actual[0]!.row[6]).toBe(String(y-8))
  expect(actual[0]!.row[7]).toContain('复核未通过')
  expect(actual[0]!.row[7]).toContain('复核通过')
})
it('独立周期失败后的通过不能冒充重新认定恢复', async () => {
  const c=f.candidate('独立周期失败后仅通过',[award(y-16),review(y-8,y-4,'failed'),review(y-8,y-1)])
  const {wb}=await f.workbook('r3-failed-then-passed')
  const actual=exported(wb,c.enterprise.id)
  expect(actual.map(r=>r.sheet)).toEqual(['待确认'])
  expect(actual[0]!.row[6]).toBe(String(y-16))
  expect(actual[0]!.row[11]).toContain('恢复')
  expect(actual[0]!.row[7]).toContain('复核未通过')
})
it('同原年份全部批次在通过失败及未决组合中均保留裁定', async () => {
  const cases: Array<{name:string;extra:Event[]}>=[
    {name:'另一批明确失败',extra:[review(y-4,y,'failed',2)]},
    {name:'另一批无复核',extra:[]},
    {name:'另一批缺结果',extra:[review(y-4,y,null,2)]},
    {name:'另一批缺结论年',extra:[review(y-4,null,'passed',2)]},
  ]
  const entries=cases.map(c=>({...c,...f.candidate(c.name,[award(y-4,1),award(y-4,2),review(y-4,y-1),...c.extra])}))
  const {wb}=await f.workbook('r3-preserve-all-batches')
  for(const c of entries) {
    const actual=exported(wb,c.enterprise.id)
    expect.soft(actual.map(r=>r.sheet),c.name).toEqual(['待确认'])
    expect.soft(actual[0]!.row[7].split('\n').filter((line:string)=>line.endsWith('认定')),c.name).toHaveLength(2)
    expect.soft(actual[0]!.row[11],c.name).toContain('批次')
    expect.soft(actual[0]!.row[12].match(/synthetic-118\.xlsx/g),c.name).toHaveLength(3+c.extra.length)
  }
})

// Expectations are literal #116 decisions, independent of the production reducer.
// Every variant is asserted through the downloaded workbook, including preserved
// history and evidence. Reversing inserts changes event IDs and SQL row order.
type Case = {id:string;events:Event[];sheet:'有效企业'|'待确认'|'排除明细';first:number|null;note?:string}
const continuity: Case[] = [
  {id:'fresh-award',events:[award(y-1)],sheet:'有效企业',first:y-1},
  {id:'award-at-due-year',events:[award(y-3)],sheet:'待确认',first:y-3},
  {id:'review-only',events:[review(y-4,y-1)],sheet:'有效企业',first:null},
  {id:'review-at-due-year',events:[review(y-6,y-3)],sheet:'待确认',first:null},
  {id:'same-cycle-three-passes',events:[award(y-10),review(y-10,y-7),review(y-10,y-4),review(y-10,y-1)],sheet:'有效企业',first:y-10},
  {id:'cross-cycle-pass-chain',events:[award(y-10),review(y-7,y-4),review(y-4,y-1)],sheet:'有效企业',first:y-10},
  {id:'cross-cycle-pass-chain-no-award',events:[review(y-10,y-7),review(y-7,y-4),review(y-4,y-1)],sheet:'有效企业',first:null},
  {id:'old-award-independent-pass',events:[award(y-8),review(y-4,y-1)],sheet:'有效企业',first:y-8},
  {id:'older-late-pass-newer-failed',events:[award(y-8),review(y-8,y),award(y-4,2),review(y-4,y-1,'failed',2)],sheet:'排除明细',first:y-8},
  {id:'old-failure-current-pass-same-year',events:[award(y-8),award(y-5),review(y-8,y-1,'failed'),review(y-5,y-1)],sheet:'有效企业',first:y-8},
  {id:'old-failure-later-than-current-pass',events:[award(y-8),award(y-5),review(y-8,y,'failed'),review(y-5,y-1)],sheet:'有效企业',first:y-8},
  {id:'old-gap-does-not-override-new-cycle',events:[award(y-8),review(y-8,null,null),award(y-1,2)],sheet:'有效企业',first:y-8},
]
const termination: Case[] = [
  {id:'failed-only',events:[review(y-4,y-1,'failed')],sheet:'排除明细',first:null},
  {id:'award-cycle-failed',events:[award(y-4),review(y-4,y-1,'failed')],sheet:'排除明细',first:y-4},
  {id:'independent-failed-then-passed',events:[award(y-16),review(y-8,y-4,'failed'),review(y-8,y-1)],sheet:'待确认',first:y-16,note:'恢复'},
  {id:'same-cycle-failed-then-passed',events:[award(y-8),review(y-8,y-4,'failed'),review(y-8,y-1)],sheet:'待确认',first:y-8,note:'恢复'},
  {id:'no-award-failed-then-passed',events:[review(y-8,y-4,'failed'),review(y-8,y-1)],sheet:'待确认',first:null,note:'恢复'},
  {id:'passed-then-failed',events:[review(y-8,y-4),review(y-8,y-1,'failed')],sheet:'排除明细',first:null},
  {id:'same-year-pass-fail',events:[award(y-8),review(y-8,y-1),review(y-8,y-1,'failed')],sheet:'待确认',first:y-8,note:'冲突'},
  {id:'old-conflict-not-erased-by-pass',events:[review(y-8,y-4),review(y-8,y-4,'failed'),review(y-8,y-1)],sheet:'待确认',first:null,note:'恢复'},
  {id:'new-cycle-award-restores',events:[award(y-16),review(y-8,y-4,'failed'),review(y-8,y-1),award(y-2,2)],sheet:'有效企业',first:y-16},
  {id:'same-cycle-later-award-restores',events:[award(y-8),review(y-8,y-4,'failed'),{...award(y-8),decidedYear:y-2}],sheet:'有效企业',first:y-8},
  {id:'new-award-same-year-as-failure',events:[award(y-8),review(y-8,y-1,'failed'),award(y-1,2)],sheet:'待确认',first:y-8,note:'冲突'},
  {id:'old-cycle-late-failure-new-award',events:[award(y-8),award(y-1,2),review(y-8,y,'failed')],sheet:'有效企业',first:y-8},
]
const gaps: Case[] = [
  {id:'undated-award',events:[award(null),review(y-4,y-1)],sheet:'待确认',first:null,note:'日期'},
  {id:'future-award',events:[award(y+1)],sheet:'待确认',first:y+1},
  {id:'future-review',events:[award(y-4),review(y-4,y+1)],sheet:'待确认',first:y-4},
  {id:'future-origin',events:[review(y+1,y+2)],sheet:'待确认',first:null},
  {id:'review-before-origin',events:[review(y-4,y-5)],sheet:'待确认',first:null},
  {id:'review-without-conclusion-year',events:[review(y-4,null)],sheet:'待确认',first:null},
  {id:'review-without-outcome',events:[award(y-4),review(y-4,y-1,null)],sheet:'待确认',first:y-4},
  {id:'review-without-batch',events:[award(y-4),review(y-4,y-1,'passed',null)],sheet:'待确认',first:y-4,note:'批次'},
  {id:'review-only-without-batch',events:[review(y-4,y-1,'passed',null)],sheet:'待确认',first:null,note:'批次'},
  {id:'award-unknown-batch-with-review',events:[award(y-4,null),review(y-4,y-1)],sheet:'待确认',first:y-4,note:'批次'},
  {id:'fresh-award-no-review-batch-gap',events:[award(y-1,null)],sheet:'有效企业',first:y-1},
  {id:'unknown-origin-pass',events:[review(null,y-1)],sheet:'待确认',first:null,note:'周期未知'},
  {id:'unknown-origin-failure-not-restored-by-pass',events:[award(y-8),review(null,y-2,'failed'),review(y-4,y-1)],sheet:'待确认',first:y-8,note:'周期未知'},
  {id:'unknown-origin-before-new-award',events:[review(null,y-2,'failed'),award(y-1)],sheet:'有效企业',first:y-1,note:'周期未知'},
  {id:'unknown-origin-same-year-new-award',events:[review(null,y-1,'failed'),award(y-1)],sheet:'待确认',first:y-1,note:'周期未知'},
  {id:'unknown-origin-future-failure',events:[review(null,y+1,'failed'),award(y-1)],sheet:'待确认',first:y-1,note:'周期未知'},
  {id:'unknown-origin-undated-failure',events:[review(null,null,'failed'),award(y-1)],sheet:'待确认',first:y-1,note:'周期未知'},
  {id:'same-year-both-batches-passed',events:[award(y-4),award(y-4,2),review(y-4,y-1),review(y-4,y-1,'passed',2)],sheet:'有效企业',first:y-4},
  {id:'same-year-review-only-other-batch-failed',events:[award(y-4),review(y-4,y-1),review(y-4,y,'failed',2)],sheet:'待确认',first:y-4,note:'批次'},
]
async function assertMatrix(cases: Case[], key: string, transform: (events: Event[]) => Event[] = events=>events) {
  const entries=cases.map(c=>({...c,...f.candidate(key+'-'+c.id,transform(c.events))}))
  const before=f.businessDigest()
  const {wb}=await f.workbook(key)
  expect(f.businessDigest()).toBe(before)
  for(const c of entries) {
    const actual=exported(wb,c.enterprise.id)
    expect.soft(actual.map(r=>r.sheet),c.id).toEqual([c.sheet])
    const row=actual[0]!.row
    expect.soft(row[6]??null,c.id).toBe(c.first==null?null:String(c.first))
    expect.soft(row[7].split('\n'),c.id).toHaveLength(c.events.length)
    expect.soft(row[12].match(/synthetic-118\.xlsx/g),c.id).toHaveLength(c.events.length)
    if(c.note) expect.soft(row[11]??'',c.id).toContain(c.note)
  }
  console.log(JSON.stringify({matrix:key,cases:entries.map(c=>({case:c.id,expected:c.sheet,actual:exported(wb,c.enterprise.id).map(r=>r.sheet),first:c.first}))}))
}
it('认定与连续延续矩阵保持当前资格及真实首次历史',()=>assertMatrix(continuity,'r3-continuity'),60000)
it('失败终止与重新认定矩阵不允许通过伪造恢复',()=>assertMatrix(termination,'r3-termination'),60000)
it('周期日期批次及未知结论矩阵保留缺口而不猜测',()=>assertMatrix(gaps,'r3-gaps'),60000)
it('周期矩阵在反向插入后保持相同字面期望',()=>assertMatrix([...continuity,...termination,...gaps],'r3-reversed',events=>[...events].reverse()),60000)
it('周期矩阵在反向插入及任意事件出处ID重排后保持相同字面期望',async()=>{
  const cases=[...continuity,...termination,...gaps]
  const entries=cases.map(c=>({...c,...f.candidate('id-permuted-'+c.id,[...c.events].reverse())}))
  // Synthetic identity transformation only: move all event/evidence IDs into a
  // permuted positive range. Actual HTTP reads the same facts and associations.
  const db=f.db.$client
  db.pragma('foreign_keys = OFF')
  try {
    db.exec('update record_event set id = -id; update record_evidence set record_event_id = -record_event_id; update record_evidence set id = -id')
    db.exec('update record_event set id = 1000000 + (-id * 37 % 1009); update record_evidence set record_event_id = 1000000 + (-record_event_id * 37 % 1009); update record_evidence set id = 2000000 + (-id * 37 % 1009)')
  } finally { db.pragma('foreign_keys = ON') }
  expect(db.pragma('foreign_key_check')).toEqual([])
  const before=f.businessDigest()
  const {wb}=await f.workbook('r3-id-permuted')
  expect(f.businessDigest()).toBe(before)
  for(const c of entries) {
    const actual=exported(wb,c.enterprise.id)
    expect.soft(actual.map(r=>r.sheet),c.id).toEqual([c.sheet])
    expect.soft(actual[0]!.row[6]??null,c.id).toBe(c.first==null?null:String(c.first))
    expect.soft(actual[0]!.row[7].split('\n'),c.id).toHaveLength(c.events.length)
    expect.soft(actual[0]!.row[12].match(/synthetic-118\.xlsx/g),c.id).toHaveLength(c.events.length)
  }
},60000)
it('正式更正失败事实后重新导出恢复资格并保留首次及出处审计',async()=>{
  const c=f.candidate('正式更正恢复',[award(y-8),review(y-8,y-1,'failed')])
  const failed=f.db.$client.prepare("select id,revision from record_event where record_id=? and review_outcome='failed'").get(c.record.id) as {id:number;revision:number}
  const before=await f.workbook('r3-before-official-correction')
  expect(exported(before.wb,c.enterprise.id).map(r=>r.sheet)).toEqual(['排除明细'])
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
it('当前出处缺口待确认而旧首次出处缺口仅留空不丢当前资格',async()=>{
  const cases: Array<{id:string;events:Event[];removeIndex:number;sheet:string;first:number|null}>=[
    {id:'missing-current-review-evidence',events:[award(y-4),review(y-4,y-1)],removeIndex:1,sheet:'待确认',first:y-4},
    {id:'missing-current-award-evidence',events:[award(y-4),review(y-4,y-1)],removeIndex:0,sheet:'待确认',first:null},
    {id:'missing-old-first-evidence',events:[award(y-8),review(y-4,y-1)],removeIndex:0,sheet:'有效企业',first:null},
  ]
  const entries=cases.map(c=>({...c,...f.candidate(c.id,c.events)}))
  for(const c of entries) {
    const events=f.db.$client.prepare('select id from record_event where record_id=? order by id').all(c.record.id) as {id:number}[]
    f.db.$client.prepare('delete from record_evidence where record_event_id=?').run(events[c.removeIndex]!.id)
  }
  const {wb}=await f.workbook('r3-missing-current-evidence')
  for(const c of entries) {
    const actual=exported(wb,c.enterprise.id)
    expect(actual.map(r=>r.sheet),c.id).toEqual([c.sheet])
    expect(actual[0]!.row[6]??null,c.id).toBe(c.first==null?null:String(c.first))
    expect(actual[0]!.row[12]).toContain('正式出处待核')
  }
},60000)
