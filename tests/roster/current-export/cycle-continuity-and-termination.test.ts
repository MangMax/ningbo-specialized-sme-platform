import { afterAll, beforeEach, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { join } from 'node:path'
import { writeCurrentWorkbook } from '../../../layers/sme-roster/lib/roster/current-workbook'
import { specializedExportFixture, rows, year as y, type Event, businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './fixtures/specialized-export'
// Full literal matrix and order/identity transformations run without HTTP or a worker.
// The owning HTTP suite retains correction, provenance gaps and two cycle representatives.
const base = specializedExportFixture()
const f = { get db() { return base.db }, candidate: base.candidate, businessDigest: base.businessDigest,
 async workbook(key: string) {
  const filename = join(base.dir, key + '.xlsx')
  await writeCurrentWorkbook(base.db.$client, 'specialized_sme', filename, () => {})
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(filename); return { wb }
 }
}
beforeEach(() => base.resetBusiness())
afterAll(base.close)
function exported(wb: ExcelJS.Workbook, id: number) {
  return wb.worksheets.slice(0,5).flatMap(sheet => rows(wb,sheet.name).filter(row => matchesBusinessIdentity(f.db, row, id)).map(row => ({sheet:sheet.name,row})))
}
const award = (year: number|null, batchSeq: number|null = 1): Event => ({eventType:'award',year,batchSeq})
const review = (year: number|null, decidedYear: number|null, reviewOutcome: 'passed'|'failed'|null = 'passed', batchSeq: number|null = 1): Event => ({eventType:'review',year,decidedYear,reviewOutcome,batchSeq})
type Case = {id:string;events:Event[];sheet:'有效企业'|'已到期'|'未认定';first:number|null}
const continuity: Case[] = [
  {id:'fresh-award',events:[award(y-1)],sheet:'有效企业',first:y-1},
  {id:'award-at-due-year',events:[award(y-3)],sheet:'已到期',first:y-3},
  {id:'review-only',events:[review(y-4,y-1)],sheet:'有效企业',first:null},
  {id:'review-at-due-year',events:[review(y-6,y-3)],sheet:'未认定',first:null},
  {id:'same-cycle-three-passes',events:[award(y-10),review(y-10,y-7),review(y-10,y-4),review(y-10,y-1)],sheet:'有效企业',first:y-10},
  {id:'cross-cycle-pass-chain',events:[award(y-10),review(y-7,y-4),review(y-4,y-1)],sheet:'有效企业',first:y-10},
  {id:'cross-cycle-pass-chain-no-award',events:[review(y-10,y-7),review(y-7,y-4),review(y-4,y-1)],sheet:'有效企业',first:null},
  {id:'old-award-independent-pass',events:[award(y-8),review(y-4,y-1)],sheet:'有效企业',first:y-8},
  {id:'older-late-pass-newer-failed',events:[award(y-8),review(y-8,y),award(y-4,2),review(y-4,y-1,'failed',2)],sheet:'有效企业',first:y-8},
  {id:'old-failure-current-pass-same-year',events:[award(y-8),award(y-5),review(y-8,y-1,'failed'),review(y-5,y-1)],sheet:'已到期',first:y-8},
  {id:'old-failure-later-than-current-pass',events:[award(y-8),award(y-5),review(y-8,y,'failed'),review(y-5,y-1)],sheet:'已到期',first:y-8},
  {id:'old-gap-does-not-override-new-cycle',events:[award(y-8),review(y-8,null,null),award(y-1,2)],sheet:'有效企业',first:y-8},
]
const termination: Case[] = [
  {id:'failed-only',events:[review(y-4,y-1,'failed')],sheet:'未认定',first:null},
  {id:'award-cycle-failed',events:[award(y-4),review(y-4,y-1,'failed')],sheet:'已到期',first:y-4},
  {id:'independent-failed-then-passed',events:[award(y-16),review(y-8,y-4,'failed'),review(y-8,y-1)],sheet:'有效企业',first:y-16},
  {id:'same-cycle-failed-then-passed',events:[award(y-8),review(y-8,y-4,'failed'),review(y-8,y-1)],sheet:'有效企业',first:y-8},
  {id:'no-award-failed-then-passed',events:[review(y-8,y-4,'failed'),review(y-8,y-1)],sheet:'有效企业',first:null},
  {id:'passed-then-failed',events:[review(y-8,y-4),review(y-8,y-1,'failed')],sheet:'未认定',first:null},
  {id:'same-year-pass-fail',events:[award(y-8),review(y-8,y-1),review(y-8,y-1,'failed')],sheet:'已到期',first:y-8},
  {id:'old-conflict-not-erased-by-pass',events:[review(y-8,y-4),review(y-8,y-4,'failed'),review(y-8,y-1)],sheet:'有效企业',first:null},
  {id:'new-cycle-award-restores',events:[award(y-16),review(y-8,y-4,'failed'),review(y-8,y-1),award(y-2,2)],sheet:'有效企业',first:y-16},
  {id:'same-cycle-later-award-restores',events:[award(y-8),review(y-8,y-4,'failed'),{...award(y-8),decidedYear:y-2}],sheet:'有效企业',first:y-8},
  {id:'new-award-same-year-as-failure',events:[award(y-8),review(y-8,y-1,'failed'),award(y-1,2)],sheet:'已到期',first:y-8},
  {id:'old-cycle-late-failure-new-award',events:[award(y-8),award(y-1,2),review(y-8,y,'failed')],sheet:'已到期',first:y-8},
]
const gaps: Case[] = [
  {id:'undated-award',events:[award(null),review(y-4,y-1)],sheet:'有效企业',first:null},
  {id:'future-award',events:[award(y+1)],sheet:'已到期',first:y+1},
  {id:'future-review',events:[award(y-4),review(y-4,y+1)],sheet:'已到期',first:y-4},
  {id:'future-origin',events:[review(y+1,y+2)],sheet:'未认定',first:null},
  {id:'review-before-origin',events:[review(y-4,y-5)],sheet:'未认定',first:null},
  {id:'review-without-conclusion-year',events:[review(y-4,null)],sheet:'未认定',first:null},
  {id:'review-without-outcome',events:[award(y-4),review(y-4,y-1,null)],sheet:'已到期',first:y-4},
  {id:'review-without-batch',events:[award(y-4),review(y-4,y-1,'passed',null)],sheet:'有效企业',first:y-4},
  {id:'review-only-without-batch',events:[review(y-4,y-1,'passed',null)],sheet:'有效企业',first:null},
  {id:'award-unknown-batch-with-review',events:[award(y-4,null),review(y-4,y-1)],sheet:'有效企业',first:y-4},
  {id:'fresh-award-no-review-batch-gap',events:[award(y-1,null)],sheet:'有效企业',first:y-1},
  {id:'unknown-origin-pass',events:[review(null,y-1)],sheet:'有效企业',first:null},
  {id:'unknown-origin-failure-not-restored-by-pass',events:[award(y-8),review(null,y-2,'failed'),review(y-4,y-1)],sheet:'有效企业',first:y-8},
  {id:'unknown-origin-before-new-award',events:[review(null,y-2,'failed'),award(y-1)],sheet:'有效企业',first:y-1},
  {id:'unknown-origin-same-year-new-award',events:[review(null,y-1,'failed'),award(y-1)],sheet:'已到期',first:y-1},
  {id:'unknown-origin-future-failure',events:[review(null,y+1,'failed'),award(y-1)],sheet:'有效企业',first:y-1},
  {id:'unknown-origin-undated-failure',events:[review(null,null,'failed'),award(y-1)],sheet:'有效企业',first:y-1},
  {id:'same-year-both-batches-passed',events:[award(y-4),award(y-4,2),review(y-4,y-1),review(y-4,y-1,'passed',2)],sheet:'有效企业',first:y-4},
  {id:'same-year-review-only-other-batch-failed',events:[award(y-4),review(y-4,y-1),review(y-4,y,'failed',2)],sheet:'已到期',first:y-4},
]
async function assertMatrix(cases: Case[], key: string, transform: (events: Event[]) => Event[] = events=>events) {
  const entries=cases.map(c=>({...c,...f.candidate(key+'-'+c.id,transform(c.events))}))
  const before=f.businessDigest()
  const {wb}=await f.workbook(key)
  expect(f.businessDigest()).toBe(before)
  for (const sheet of ['有效企业','已到期','已注销（吊销）','已迁出','未认定']) {
    expect(rows(wb,sheet).map(row=>businessIdentity(row)),sheet).toEqual(entries.filter(c=>c.sheet===sheet).map(c=>expectedBusinessIdentity(f.db,c.enterprise.id)))
  }
  for(const c of entries) {
    const actual=exported(wb,c.enterprise.id)
    expect.soft(actual.map(r=>r.sheet),c.id).toEqual([c.sheet])
    const row=actual[0]!.row
    expect.soft(row[6]??null,c.id).toBe(c.first==null?null:String(c.first))
    expect.soft(row[7].split('\n'),c.id).toHaveLength(c.events.length)
    expect.soft(row[7].match(/原认定年份待核/g)?.length??0,c.id).toBe(c.events.filter(e=>e.year==null).length)
    expect.soft(row[7].match(/结论年份待核/g)?.length??0,c.id).toBe(c.events.filter(e=>e.eventType==='review'&&e.decidedYear==null).length)
    expect.soft(row[7].match(/复核结论待核/g)?.length??0,c.id).toBe(c.events.filter(e=>e.eventType==='review'&&e.reviewOutcome==null).length)
    expect.soft(row[12].match(/synthetic-118\.xlsx/g),c.id).toHaveLength(c.events.length)
  }
  console.log(JSON.stringify({matrix:key,cases:entries.map(c=>({case:c.id,expected:c.sheet,actual:exported(wb,c.enterprise.id).map(r=>r.sheet),first:c.first}))}))
}
it('认定与连续延续矩阵保持当前资格及真实首次历史',()=>assertMatrix(continuity,'r3-continuity'),60000)
it('失败优先同年边界与较晚正式恢复矩阵保留历史',()=>assertMatrix(termination,'r3-termination'),60000)
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
  for (const sheet of ['有效企业','已到期','已注销（吊销）','已迁出','未认定']) {
    expect(rows(wb,sheet).map(row=>businessIdentity(row)),sheet).toEqual(entries.filter(c=>c.sheet===sheet).map(c=>expectedBusinessIdentity(f.db,c.enterprise.id)))
  }
  for(const c of entries) {
    const actual=exported(wb,c.enterprise.id)
    expect.soft(actual.map(r=>r.sheet),c.id).toEqual([c.sheet])
    expect.soft(actual[0]!.row[6]??null,c.id).toBe(c.first==null?null:String(c.first))
    expect.soft(actual[0]!.row[7].split('\n'),c.id).toHaveLength(c.events.length)
    expect.soft(actual[0]!.row[12].match(/synthetic-118\.xlsx/g),c.id).toHaveLength(c.events.length)
  }
},60000)
