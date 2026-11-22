


import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'

import { businessIdentity, expectedBusinessIdentity } from './fixtures/specialized-export'
import { reviewCurrentExportDecision } from '../fixtures/qualification-decisions'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ExcelJS from 'exceljs'

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'

import { writeCurrentWorkbook } from '../../../layers/sme-roster/lib/roster/current-workbook'
const dir=mkdtempSync(join(tmpdir(),'little-giant-native-'))
let generation=0
let db=initializeDb({create:true,dbPath:join(dir,'initial.db')})
const titleCode='little_giant'
const year=new Date().getFullYear()
type Event = Pick<typeof s.recordEvent.$inferInsert, 'eventType' | 'year' | 'decidedYear' | 'reviewOutcome' | 'batchSeq'>
const award: Event={eventType:'award',year,batchSeq:1}
beforeEach(()=>{db.$client.close();db=initializeDb({create:true,dbPath:join(dir,String(++generation)+'.db')})})
afterAll(()=>{db.$client.close();rmSync(dir,{recursive:true,force:true})})
async function workbook(key:string){const filename=join(dir,key+'.xlsx');const result=await writeCurrentWorkbook(db.$client,titleCode,filename,()=>{});const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(filename);return {wb,result}}
function candidate(name: string, events: Array<{ eventType: 'award'|'review'|'nurture'|'maintain'; year: number|null; decidedYear?: number|null; reviewOutcome?: 'passed'|'failed'|null; batchSeq?: number|null }> = [{ eventType: 'award', year: new Date().getFullYear(), batchSeq: 1 }], titleCode = 'little_giant') {
  const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: 'TEST-' + name, district: '鄞州区', city: '宁波市' }).returning().get()
  const record = db.insert(s.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode, nameRaw: name }).returning().get()
  for (const e of events) {
    const event = db.insert(s.recordEvent).values({ recordId: record.id, ...e }).returning().get()
    db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'jxj/announcement/synthetic.xlsx', attachment: '名单', listNo: enterprise.id }).run()
  }
  return { enterprise, record }
}
function rows(wb: ExcelJS.Workbook, sheet: string) {
  return wb.getWorksheet(sheet)!.getRows(2, Math.max(0,wb.getWorksheet(sheet)!.rowCount-1))?.map(row => row.values as any[]) ?? []
}
function decision(enterpriseId: number, reasonCode: 'moved_out'|'moved_in'|'deregistered'|'renamed'|'pending_review'|'other', extra: Record<string,unknown> = {}) {
  const decision = db.insert(s.differenceReason).values({enterpriseId,titleCode:'little_giant',direction:'extra_in_miit',status:'confirmed_reason',reasonCode,verificationStatus:'confirmed',lifecycleAction:'replace',basis:'人工确认合成主体事实',effectiveAt:'2025-01-01T00:00:00Z',recordedAt:new Date().toISOString(),...extra} as any).returning().get()
  reviewCurrentExportDecision(db,decision)
  return decision
}
function businessDigest() {
  const hash=createHash('sha256')
  for(const table of ['enterprise','record','record_event','record_evidence','enterprise_alias','platform_collection','platform_business_observation','difference_reason','record_correspondence','enterprise_fact_revision']) for(const row of db.$client.prepare('select * from '+table+' order by id').iterate()) hash.update(JSON.stringify(row))
  for (const { name } of db.$client.prepare("select name from sqlite_master where type='table' and name like 'platform_%' order by name").all() as Array<{ name: string }>) {
    hash.update(name)
    for (const row of db.$client.prepare(`select * from "${name}" order by rowid`).iterate()) hash.update(JSON.stringify(row))
  }
  for(const row of db.$client.prepare('select * from enterprise_fact_receipt order by idempotency_key').iterate()) hash.update(JSON.stringify(row))
  return hash.digest('hex')
}
it('对应周期、复核年份与同年冲突', async () => {
  candidate('新认定')
  const y = new Date().getFullYear()
  candidate('复核延续',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'passed'}])
  candidate('失败恢复',[{eventType:'award',year:y-5,batchSeq:1},{eventType:'review',year:y-5,batchSeq:1,decidedYear:y-2,reviewOutcome:'failed'},{eventType:'award',year:y-1,batchSeq:2}])
  candidate('旧周期晚失败',[{eventType:'award',year:y-5,batchSeq:1},{eventType:'award',year:y-1,batchSeq:2},{eventType:'review',year:y-5,batchSeq:1,decidedYear:y,reviewOutcome:'failed'}])
  candidate('本周期失败',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'failed'}])
  candidate('已到复核年',[{eventType:'award',year:y-3,batchSeq:1}])
  candidate('复核结论缺年',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,reviewOutcome:'passed'}])
  candidate('同年冲突',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'failed'},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'passed'}])
  candidate('培育非资格',[{eventType:'nurture',year:y}])
  // Explicit source dates expire even though award age alone does not.
  const dated = candidate('正式期间已到期',[{eventType:'award',year:y-3,batchSeq:1}])
  const datedEvent = db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,dated.record.id)).get()!
  const datedEvidence = db.select().from(s.recordEvidence).where(eq(s.recordEvidence.recordEventId,datedEvent.id)).get()!
  const sha = 'a'.repeat(64)
  db.insert(s.storedFile).values({relPath:datedEvidence.sourceFile,filename:'synthetic.xlsx',ext:'xlsx',bytes:1,sha256:sha}).run()
  db.update(s.recordEvent).set({formalValidity:{evidenceId:datedEvidence.id,sourceSha256:sha,statementPages:[1],interval:{validFrom:`${y-3}-01-01`,validThrough:`${y-1}-12-31`}}}).where(eq(s.recordEvent.id,datedEvent.id)).run()
  const before = businessDigest()
  const {wb} = await workbook('cycles')
  expect(businessDigest()).toBe(before)
  const names = (sheet: string) => rows(wb,sheet).map(r => r[2])
  expect(names('有效企业')).toEqual(['新认定','复核延续','失败恢复','旧周期晚失败','已到复核年','复核结论缺年'])
  expect(names('未认定')).toEqual(['培育非资格'])
  expect(names('已到期')).toEqual(['本周期失败','同年冲突','正式期间已到期'])
  expect(rows(wb,'已到期').find(r => r[2] === '正式期间已到期')![14]).toBe(`公布名单所载有效期：${y-3}-01-01 至 ${y-1}-12-31（含首尾）；正式来源：jxj/announcement/synthetic.xlsx；第 1 页`)
  expect(rows(wb,'有效企业').find(r => r[2] === '失败恢复')![6]).toBe(String(y-5))
  expect(rows(wb,'已到期').find(r => r[2] === '同年冲突')![15]).toContain('本称号原认定周期已有生效的已确认处置；复核通过不构成新认定')
})
it('迁入、更名与旧解释缺口', async () => {
  candidate('培育非资格',[{eventType:'nurture',year:new Date().getFullYear()}])
  // Historical case name retained. #379 follows the approved #355 display contract;
  // record.nameRaw and confirmed aliases do not constitute a per-evidence capture.
  const renamed = candidate('迁入更名现名')
  db.update(s.record).set({nameRaw:'迁入更名旧名'}).where(eq(s.record.id,renamed.record.id)).run()
  db.insert(s.enterpriseAlias).values({enterpriseId:renamed.enterprise.id,name:'迁入更名旧名',nameNorm:'迁入更名旧名',sourceKind:'manual',verificationStatus:'confirmed'}).run()
  decision(renamed.enterprise.id,'moved_in',{movedInTitleCode:'little_giant'})
  const out = candidate('已确认外迁'); decision(out.enterprise.id,'moved_out')
  const deregistered = candidate('已确认注销'); decision(deregistered.enterprise.id,'deregistered')
  const returned = candidate('迁出后迁回'); const old = decision(returned.enterprise.id,'moved_out',{recordedAt:'2025-01-01T00:00:00Z'})
  decision(returned.enterprise.id,'moved_in',{previousId:old.id,effectiveAt:'2026-01-01T00:00:00Z',movedInTitleCode:'little_giant'})
  const legacy = candidate('旧缺码前提变化'); decision(legacy.enterprise.id,'moved_out',{lifecycleAction:null,basis:null,reasonNote:'缺码无法查询'})
  const unknown = candidate('未确认旧名链'); db.update(s.record).set({nameRaw:'未经核实原名'}).where(eq(s.record.id,unknown.record.id)).run()
  const migrant = candidate('迁入无资格依据',[]); decision(migrant.enterprise.id,'moved_in',{movedInTitleCode:'little_giant',movedInYear:new Date().getFullYear()})
  const review = candidate('更新待审核'); decision(review.enterprise.id,'pending_review',{measureCode:'follow_review'})
  const other = candidate('其他称号不冒充',[]); candidate('其他称号独立',[{eventType:'award',year:new Date().getFullYear()}],'specialized_sme')
  db.insert(s.record).values({enterpriseId:other.enterprise.id,source:'jxj',titleCode:'innovative_sme',nameRaw:'其他称号不冒充'}).run()
  // Freeze from the independent seed before submitting: only year/list locator vary.
  const expectedDisplay = Object.freeze({
    8: `${new Date().getFullYear()}年第1批认定，《synthetic.xlsx》：未逐出处核实`,
    9: '迁入更名旧名',
    11: '逐出处公布名见公布名称列；现用名见企业名称列；已确认曾用名仅见该列',
    12: `${new Date().getFullYear()}年第1批认定：宁波经信来源资料\n《synthetic.xlsx》，附件：名单，名单序号${renamed.enterprise.id}，未逐出处核实`,
  })
  const {wb} = await workbook('identity')
  const eligible = rows(wb,'有效企业'), pending = rows(wb,'未认定')
  const rename = eligible.find(r => r[2] === '迁入更名现名')!
  expect({ 8: rename[8], 9: rename[9], 11: rename[11], 12: rename[12] }).toEqual(expectedDisplay); expect(rename[9]).toBe('迁入更名旧名')
  // Ordinary workbook notes must not revive the retired manual qualification review.
  for (const sheet of ['有效企业', '未认定']) for (const row of rows(wb, sheet)) {
    expect(row[11] ?? '').not.toContain('迁入资格来源版本或归属需重新核实')
  }
  expect(rename[11]).not.toContain('已确认迁入宁波'); expect(rename[11]).not.toContain('现已更名'); expect(rename[11]).not.toContain('未见宁波')
  expect(eligible.map(r => r[2])).toEqual(expect.arrayContaining(['迁出后迁回','更新待审核']))
  expect(eligible.filter(r => ['已确认外迁','已确认注销','旧缺码前提变化','未确认旧名链'].includes(r[2])).map(r => r[2])).toEqual(['已确认外迁','已确认注销','旧缺码前提变化','未确认旧名链'])
  expect(rows(wb,'已迁出')).toEqual([]); expect(rows(wb,'已注销（吊销）')).toEqual([])
  expect(pending.map(r => r[2])).toEqual(['培育非资格','迁入无资格依据','其他称号不冒充'])
  expect(pending.find(r => r[2] === '迁入无资格依据')![15]).toContain('缺少已确认认定及资格依据')
  expect(eligible.find(r => r[2] === '未确认旧名链')![10]).toBe('尚未完成公布匹配核实')
  expect([...eligible,...pending].some(r => r[2] === '其他称号独立')).toBe(false)
})
it('文本、身份、缺项与业务只读', async () => {
  const formula=candidate('=HYPERLINK("https://invalid.example","合成")')
  db.update(s.enterprise).set({usccNorm:'001234567890123456'}).where(eq(s.enterprise.id,formula.enterprise.id)).run()
  const long='超长😀名称'.repeat(30);candidate(long)
  const a=candidate('同名甲'),b=candidate('同名乙')
  for(const c of [a,b]) {db.update(s.enterprise).set({name:'同名企业',nameNorm:'同名企业'}).where(eq(s.enterprise.id,c.enterprise.id)).run();db.update(s.record).set({nameRaw:'同名企业'}).where(eq(s.record.id,c.record.id)).run()}
  const partial=candidate('首次补充缺口',[{eventType:'award',year:new Date().getFullYear()-5},{eventType:'award',year:new Date().getFullYear()}])
  const oldEvent=db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,partial.record.id)).all()[0]!
  db.delete(s.recordEvidence).where(eq(s.recordEvidence.recordEventId,oldEvent.id)).run()
  for(const status of ['failed','no_record'] as const) {
    const c=candidate('查询'+status)
    submitNativePlatformQuery(db,{interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:'3',titleCode:'little_giant',queriedAt:new Date().toISOString(),status,rawResponse:'=FORMULA()'})
  }
  const sourceBefore=businessDigest()
  const {wb}=await workbook('safe-full')
  const eligible=rows(wb,'有效企业')
  const text=eligible.find(r=>r[2]===formula.enterprise.name)!
  expect(text[3]).toBe('001234567890123456');expect(text[2]).toBe('=HYPERLINK("https://invalid.example","合成")')
  expect(eligible.find(r=>r[2]===long)![2]).toBe(long)
  expect(eligible.filter(r=>r[2]==='同名企业').map(r => businessIdentity(r))).toEqual([expectedBusinessIdentity(db,a.enterprise.id),expectedBusinessIdentity(db,b.enterprise.id)])
  expect(eligible.find(r=>r[2]==='首次补充缺口')![6] ?? null).toBeNull()
  expect(eligible.map(r => r[2])).toEqual(expect.arrayContaining(['查询failed','查询no_record']))
  expect(businessDigest()).toBe(sourceBefore)
},30000)
it('平台单独候选不遗漏且不冒充已确认资格', async () => {
  const c=db.insert(s.enterprise).values({name:'仅平台识别候选',nameNorm:'仅平台识别候选',usccNorm:'PLATFORM-CANDIDATE-117'}).returning().get()
  const queriedAt = new Date().toISOString()
  const rawFields = { id: 'PLATFORM-ONLY-117', qymc: c.name, tyshxydm: c.usccNorm!, rdjb: '3' }
  const collectionEvidence = { source: 'queryBusList' as const, status: 'success' as const, effectiveConditions: { combination: 'and' as const }, titleScope: { mode: 'selected' as const, rdjb: ['3'] }, queriedAt, completedAt: queriedAt, rows: [rawFields], pages: [{ source: 'queryBusList' as const, rdjb: '3', page: 1, maxPage: 1, status: 'success' as const, fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete' as const, fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } }
  const native = submitNativePlatformQuery(db,{interface:'recognized_list',queryKey:c.usccNorm!,rdjb:'3',titleCode:'little_giant',queriedAt,status:'success',collectionEvidence,relations:[{sequenceNo:1,relationKey:rawFields.id,rawFields,nameRaw:c.name,usccRaw:c.usccNorm,enterpriseId:c.id,verificationStatus:'confirmed',matchBasis:'uscc'}]})
  const r = { id: native.relationIds[0]! }
  const {wb}=await workbook('platform-only')
  const pending=rows(wb,'未认定').find(row=>row[2]==='仅平台识别候选')!
  expect(businessIdentity(pending)).toEqual(expectedBusinessIdentity(db,c.id));expect(pending[12]).toContain('工信部已认定企业名单')
  expect(r.id).toBeGreaterThan(0)
  expect(rows(wb,'有效企业').some(row=>row[2]==='仅平台识别候选')).toBe(false)
},30000)

it('决定撤回、前提失效与候选引用', async () => {
  const withdrawn=candidate('撤回旧外迁'),previous=decision(withdrawn.enterprise.id,'moved_out',{recordedAt:'2025-01-01T00:00:00Z'})
  decision(withdrawn.enterprise.id,'moved_out',{lifecycleAction:'withdraw',previousId:previous.id})
  const replaced=candidate('替代旧外迁'),head=decision(replaced.enterprise.id,'moved_out',{recordedAt:'2025-01-01T00:00:00Z'})
  decision(replaced.enterprise.id,'pending_review',{previousId:head.id,measureCode:'follow_review'})
  const premise=candidate('现有代码旧按名查询')
  const query=submitNativePlatformQuery(db,{interface:'business_list',queryKey:'name:'+premise.enterprise.nameNorm,rdjb:'3',titleCode:'little_giant',queriedAt:new Date().toISOString(),status:'failed',rawResponse:'Synthetic failed name query'})
  const stale=decision(premise.enterprise.id,'moved_out',{evidenceQueryId:query.queryId})
  const terminalGap=candidate('终止能力待确认');decision(terminalGap.enterprise.id,'other',{reasonNote:'正式取消/终止资格，但现有模型无对应周期终止事件'})
  const identity=candidate('统代冲突');db.update(s.record).set({usccRaw:'DIFFERENT-ID'}).where(eq(s.record.id,identity.record.id)).run()
  for(const status of ['退回','待审核']) {
    const c=candidate('申请状态'+status)
    submitNativePlatformQuery(db,{interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:'3',titleCode:'little_giant',queriedAt:new Date().toISOString(),status:'success',rawResponse:JSON.stringify({status}),relations:[{sequenceNo:1,enterpriseId:c.enterprise.id,status,declareKind:'update',verificationStatus:'confirmed',matchBasis:'uscc'}]})
  }
  const unconfirmed=candidate('未确认对应边',[{eventType:'maintain',year:new Date().getFullYear()}])
  db.update(s.record).set({source:'miit'}).where(eq(s.record.id,unconfirmed.record.id)).run()
  const edge=db.insert(s.recordCorrespondence).values({edgeKey:'synthetic-candidate',type:'event_process',role:'award',eventId:db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,unconfirmed.record.id)).get()!.id,enterpriseId:unconfirmed.enterprise.id,titleCode:'little_giant',status:'candidate',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:new Date().toISOString()}).returning().get()
  const {wb}=await workbook('decision-scope')
  expect(rows(wb,'有效企业').map(r => r[2])).toEqual(expect.arrayContaining(['撤回旧外迁','替代旧外迁','申请状态退回','申请状态待审核']))
  const pending=rows(wb,'未认定')
  expect(rows(wb,'有效企业').filter(r => ['现有代码旧按名查询','终止能力待确认','统代冲突'].includes(r[2])).map(r=>r[2])).toEqual(['现有代码旧按名查询','终止能力待确认','统代冲突'])
  expect(pending.filter(r=>r[2]==='未确认对应边').map(r=>r[2])).toEqual(['未确认对应边'])
  expect(rows(wb,'有效企业').find(r=>r[2]==='现有代码旧按名查询')![13]).toBe('有效企业')
  expect(pending.find(r=>r[2]==='未确认对应边')![13]).toBe('未认定'); expect(pending.find(r=>r[2]==='未确认对应边')![15]).toContain('缺少已确认认定及资格依据')
  expect(stale.id).toBeGreaterThan(0); expect(edge.id).toBeGreaterThan(0)
},30000)