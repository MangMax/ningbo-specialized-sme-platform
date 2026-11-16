import { readCurrentQualificationAssessment } from '../../../lib/roster/current-qualification'

import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'

import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './fixtures/specialized-export'



import ExcelJS from 'exceljs'
import { eq } from 'drizzle-orm'
import { schema as s } from '../../../db/client'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { expectCounts, rows, year as y, type Event } from './fixtures/specialized-export'
import { nativeWorkbookFixture } from './fixtures/native-workbook'
const f=nativeWorkbookFixture()
beforeEach(()=>f.resetBusiness())
afterAll(f.close)
it('本称号复核周期失败恢复及同年冲突准确分组', async () => {
  const fixtures = [
    ['新认定无需复核', [{eventType:'award',year:y-1,batchSeq:2}]],
    ['复核延续', [{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'passed'}]],
    ['失败后重新认定', [{eventType:'award',year:y-5,batchSeq:1},{eventType:'review',year:y-5,batchSeq:1,decidedYear:y-2,reviewOutcome:'failed'},{eventType:'award',year:y-1,batchSeq:2}]],
    ['旧周期晚失败', [{eventType:'award',year:y-5,batchSeq:1},{eventType:'award',year:y-1,batchSeq:2},{eventType:'review',year:y-5,batchSeq:1,decidedYear:y,reviewOutcome:'failed'}]],
    ['本周期失败', [{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'failed'}]],
    ['纯培育', [{eventType:'nurture',year:y}]],
    ['已到复核年结果未知', [{eventType:'award',year:y-3,batchSeq:1}]],
    ['复核结论年未知', [{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,reviewOutcome:'passed'}]],
    ['同年通过失败冲突', [{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'failed'},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'passed'}]],
    ['同年恢复顺序未知', [{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y,reviewOutcome:'failed'},{eventType:'award',year:y,batchSeq:2}]],
    ['复核周期未知', [{eventType:'award',year:y-1,batchSeq:1},{eventType:'review',year:null,decidedYear:y,reviewOutcome:'failed'}]],
  ] as Array<[string, Event[]]>
  const ids = Object.fromEntries(fixtures.map(([name,events]) => [name,String(f.candidate(name,events).enterprise.id)]))
  const {wb,result} = await f.workbook('118-cycles')
  for (const [sheet,names] of [
    ['有效企业',['新认定无需复核','复核延续','失败后重新认定']],
    ['未认定',['纯培育']],
    ['已到期',['旧周期晚失败','本周期失败','已到复核年结果未知','复核结论年未知','同年通过失败冲突','同年恢复顺序未知','复核周期未知']],
  ] as Array<[string,string[]]>) expect(rows(wb,sheet).map(row => businessIdentity(row))).toEqual(names.map(name => expectedBusinessIdentity(f.db,Number(ids[name]))))
  const restored = rows(wb,'有效企业').find(row => row[2] === '失败后重新认定')!
  expect(restored[6]).toBe(String(y-5))
  expect(restored[7]).toContain('复核未通过')
  expect(restored[7].split('\n')).toHaveLength(3)
  expect(rows(wb,'有效企业').find(row => row[2] === '复核延续')![7]).toContain((y-1) + '年复核通过')
  expect(rows(wb,'已到期').find(row => row[2] === '本周期失败')![15]).toContain('复核明确不通过')
  for (const name of ['同年通过失败冲突','同年恢复顺序未知']) expect(rows(wb,'已到期').find(row => row[2] === name)![15]).toContain('复核明确不通过')
  expectCounts(wb,{result},{eligible:3,pending:0,excluded:8}, {effective:3,expired:7,terminated:0,moved_out:0,unrecognized:1})
})
it('迁入更名双备注及主体事实和公布缺口保留依据', async () => {
  // Historical case name retained; #355/#379 keep migration notes and aliases,
  // while legacy evidence has no captured published name or inferred rename.
  const renamed = f.candidate('迁入更名现名')
  f.db.update(s.record).set({nameRaw:'专精特新公布旧名'}).where(eq(s.record.id,renamed.record.id)).run()
  f.db.insert(s.enterpriseAlias).values({enterpriseId:renamed.enterprise.id,name:'专精特新公布旧名',nameNorm:'专精特新公布旧名',sourceKind:'manual',verificationStatus:'confirmed'}).run()
  f.decision(renamed.enterprise.id,'moved_in',{movedInTitleCode:'specialized_sme'})
  const returned = f.candidate('迁出后迁回'), old = f.decision(returned.enterprise.id,'moved_out',{recordedAt:'2025-01-01T00:00:00Z'})
  f.decision(returned.enterprise.id,'moved_in',{previousId:old.id,effectiveAt:'2026-01-01T00:00:00Z',movedInTitleCode:'specialized_sme'})
  const out = f.candidate('已外迁'), outDecision = f.decision(out.enterprise.id,'moved_out')
  const gone = f.candidate('已注销'); f.decision(gone.enterprise.id,'deregistered')
  const stale = f.candidate('旧解释缺码前提变化'), staleDecision = f.decision(stale.enterprise.id,'moved_out',{lifecycleAction:null,basis:null,reasonNote:'缺码无法查询'})
  const unknown = f.candidate('公布身份未核实'); f.db.update(s.record).set({nameRaw:'未确认旧名'}).where(eq(s.record.id,unknown.record.id)).run()
  const migrant = f.candidate('迁入缺当前资格',[]); f.decision(migrant.enterprise.id,'moved_in',{movedInTitleCode:'specialized_sme',movedInYear:y})
  const pending = f.candidate('更新待审核'); f.decision(pending.enterprise.id,'pending_review',{measureCode:'follow_review'})
  const terminalGap = f.candidate('取消终止缺结构化周期'); f.decision(terminalGap.enterprise.id,'other',{reasonNote:'取消/撤销/终止，但对应资格周期未确认'})
  const otherPublication = f.candidate('只有他称号已公布',[]); f.addRecord(otherPublication.enterprise.id,'只有他称号已公布',undefined,'little_giant')
  const conflict = f.candidate('公布统代冲突'); f.db.update(s.record).set({usccRaw:'OTHER-LEGAL-ENTITY'}).where(eq(s.record.id,conflict.record.id)).run()
  const expectedDisplay = Object.freeze({
    8: `${y}年第1批认定，《synthetic-118.xlsx》：未逐出处核实`,
    9: '专精特新公布旧名',
    11: '逐出处公布名见公布名称列；现用名见企业名称列；已确认曾用名仅见该列',
    12: `${y}年第1批认定：宁波市经信局公布资料\n《synthetic-118.xlsx》，附件：专精特新中小企业名单，名单序号${renamed.enterprise.id}，未逐出处核实`,
  })
  const {wb,result} = await f.workbook('118-identity')
  const eligible = rows(wb,'有效企业'), waiting = rows(wb,'未认定')
  expect(eligible.map(row => businessIdentity(row))).toEqual([renamed,returned,out,gone,stale,unknown,pending,terminalGap,otherPublication,conflict].map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
  expect(rows(wb,'已迁出')).toEqual([]); expect(rows(wb,'已注销（吊销）')).toEqual([])
  expect(waiting.map(row => businessIdentity(row))).toEqual([migrant].map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
  const rename = eligible.find(row => matchesBusinessIdentity(f.db, row, renamed.enterprise.id))!
  expect({ 8: rename[8], 9: rename[9], 11: rename[11], 12: rename[12] }).toEqual(expectedDisplay); expect(rename[9]).toBe('专精特新公布旧名')
  expect(rename[10]).toBe('已见本称号宁波公布记录')
  // Ordinary workbook notes must not revive the retired manual qualification review.
  for (const sheet of ['有效企业', '未认定']) for (const row of rows(wb, sheet)) {
    expect(row[11] ?? '').not.toContain('迁入资格来源版本或归属需重新核实')
  }
  expect(rename[11]).not.toContain('已确认迁入宁波')
  expect(rename[11]).not.toContain('现已更名为')
  expect(rename[11]).not.toContain('未见宁波'); expect(rename[11]).not.toContain('原城市')
  expect(eligible.find(row => matchesBusinessIdentity(f.db, row, out.enterprise.id))![13]).toBe('有效企业')
  expect(eligible.find(row => matchesBusinessIdentity(f.db, row, stale.enterprise.id))![13]).toBe('有效企业')
  expect(f.db.$client.prepare('select enterprise_id,reason_code,verification_status from difference_reason where id=?').get(outDecision.id)).toEqual({enterprise_id:out.enterprise.id,reason_code:'moved_out',verification_status:'confirmed'})
  expect(f.db.$client.prepare('select enterprise_id,reason_code,basis from difference_reason where id=?').get(staleDecision.id)).toEqual({enterprise_id:stale.enterprise.id,reason_code:'moved_out',basis:null})
  expect(eligible.find(row => matchesBusinessIdentity(f.db, row, stale.enterprise.id))![11]).not.toContain('相关主体事实适用性未确认')
  expect(waiting.find(row => matchesBusinessIdentity(f.db, row, migrant.enterprise.id))![15]).toContain('缺少已确认认定及资格依据')
  for (const item of [migrant]) {
    const row = waiting.find(row => matchesBusinessIdentity(f.db, row, item.enterprise.id))!
    expect(row[10]).toBe('尚未完成公布匹配核实'); expect(row[11] ?? null).toBeNull()
  }
  expect(eligible.find(row => matchesBusinessIdentity(f.db, row, otherPublication.enterprise.id))![11]).toContain('按有效小巨人资格计入')
  expect(eligible.find(row => matchesBusinessIdentity(f.db, row, conflict.enterprise.id))![11]).toContain('身份冲突')
  expectCounts(wb,{result},{eligible:10,pending:0,excluded:1}, {effective:10,expired:0,terminated:0,moved_out:0,unrecognized:1})
})
it('超过最大列表页的全部主体和公式样式文本安全导出且业务只读', async () => {
  const candidates = Array.from({length:205},(_,index) => f.candidate('超页企业' + String(index).padStart(3,'0')))
  const formulas = ['=HYPERLINK("https://invalid.example","合成")','+SUM(1,2)','-1+2','@SUM(A1:A2)']
  const formulaCandidates = formulas.map(value => f.candidate(value))
  f.db.update(s.enterprise).set({usccNorm:'001234567890123456'}).where(eq(s.enterprise.id,formulaCandidates[0]!.enterprise.id)).run()
  f.db.update(s.recordEvidence).set({sourceFile:'=FORMULA_SOURCE()'}).where(eq(s.recordEvidence.listNo,formulaCandidates[0]!.enterprise.id)).run()
  const longName = '专精特新😀长名称'.repeat(15), long = f.candidate(longName)
  const digest = f.businessDigest(), {wb,result} = await f.workbook('118-full-text')
  const eligible = rows(wb,'有效企业')
  expect(eligible.map(row => businessIdentity(row))).toEqual([...candidates,...formulaCandidates,long].map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
  expect(eligible.slice(205,209).map(row => row[2])).toEqual(formulas)
  expect(eligible[205]![3]).toBe('001234567890123456')
  expect(eligible[205]![12]).toContain('=FORMULA_SOURCE()')
  expect(eligible[209]![2]).toBe(longName)
  const sheet = wb.getWorksheet('有效企业')!
  sheet.eachRow(row => row.eachCell(cell => { expect(typeof cell.value).toBe('string'); expect(cell.type).toBe(ExcelJS.ValueType.String) }))
  expect(f.businessDigest()).toBe(digest)
  expectCounts(wb,{result},{eligible:210,pending:0,excluded:0})
})
it('查询失败零行退回待审不作废且部分依据候选显式待确认', async () => {
  const eligible = []
  for (const status of ['failed','no_record'] as const) {
    const c = f.candidate('平台查询' + status); eligible.push(c)
    submitNativePlatformQuery(f.db,{interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:new Date().toISOString(),status,rawResponse:'Synthetic query status '+status})
  }
  for (const status of ['退回','待审核']) {
    const c = f.candidate('更新' + status); eligible.push(c)
    submitNativePlatformQuery(f.db,{interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:new Date().toISOString(),status:'success',rawResponse:JSON.stringify({status}),relations:[{sequenceNo:1,enterpriseId:c.enterprise.id,status,declareKind:'update',verificationStatus:'confirmed',matchBasis:'uscc'}]})
  }
  const partial = f.candidate('首次补充依据缺口',[{eventType:'award',year:y-5},{eventType:'award',year:y}]); eligible.push(partial)
  const oldEvent = f.db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,partial.record.id)).all()[0]!
  f.db.delete(s.recordEvidence).where(eq(s.recordEvidence.recordEventId,oldEvent.id)).run()
  const unconfirmed = f.candidate('未确认资格对应',[{eventType:'maintain',year:y}])
  f.db.update(s.record).set({source:'miit'}).where(eq(s.record.id,unconfirmed.record.id)).run()
  const event = f.db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,unconfirmed.record.id)).get()!
  const edge = f.db.insert(s.recordCorrespondence).values({edgeKey:'synthetic-118-candidate',type:'event_process',role:'award',eventId:event.id,enterpriseId:unconfirmed.enterprise.id,titleCode:'specialized_sme',status:'candidate',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:new Date().toISOString()}).returning().get()
  const platform = f.db.insert(s.enterprise).values({name:'仅平台识别候选',nameNorm:'仅平台识别候选',usccNorm:'SYNTHETIC-118-PLATFORM'}).returning().get()
  const native = submitSyntheticRecognizedCollection(f.db,{rdjb:'2',queriedAt:new Date().toISOString(),rows:[{enterpriseId:platform.id,raw:{id:'PLATFORM-118',qymc:platform.name,tyshxydm:platform.usccNorm,rdjb:'2'}}]})
  const relation = {id:native.relationIds[0]!}
  const digest = f.businessDigest(), {wb,result} = await f.workbook('118-evidence-gaps')
  expect(rows(wb,'有效企业').map(row => businessIdentity(row))).toEqual(eligible.map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
  const partialRow = rows(wb,'有效企业').find(row => matchesBusinessIdentity(f.db, row, partial.enterprise.id))!
  expect(partialRow[6] ?? null).toBeNull(); expect(partialRow[11]).toContain('首次认定补充依据不完整')
  const waiting = rows(wb,'未认定')
  expect(waiting.map(row => businessIdentity(row))).toEqual([expectedBusinessIdentity(f.db,unconfirmed.enterprise.id),expectedBusinessIdentity(f.db,platform.id)])
  expect(waiting[0]![13]).toBe('未认定'); expect(waiting[0]![15]).toContain('缺少已确认认定及资格依据')
  expect(waiting[1]![15]).toContain('缺少已确认认定及资格依据')
  expect(f.db.$client.prepare('select event_id,enterprise_id,status,role from record_correspondence where id=?').get(edge.id)).toEqual({event_id:event.id,enterprise_id:unconfirmed.enterprise.id,status:'candidate',role:'award'})
  expect(native.queryId).toBeGreaterThan(0)
  expect(native.relationIds).toEqual([relation.id])
  expect(waiting[1]![12]).toContain('工信部已认定企业名单')
  expect(f.businessDigest()).toBe(digest)
  expectCounts(wb,{result},{eligible:5,pending:0,excluded:2}, {effective:5,expired:0,terminated:0,moved_out:0,unrecognized:2})
})


it('own effective period wins while upper-only identities inherit real source without fabricated history', () => {
  const own = f.candidate('自身期间优先', [{eventType:'award',year:y-1,batchSeq:2}])
  f.addRecord(own.enterprise.id, own.enterprise.name, [{eventType:'award',year:y,batchSeq:1}], 'little_giant')
  const upper = f.candidate('仅上级无低梯度历史', [{eventType:'award',year:y,batchSeq:1}], 'little_giant')
  const before = f.businessDigest()
  const at = Date.parse(`${y}-06-01T00:00:00Z`)
  const ownTitles = readCurrentQualificationAssessment(f.db.$client,own.enterprise.id,at).titles
  const upperTitles = readCurrentQualificationAssessment(f.db.$client,upper.enterprise.id,at).titles
  for (const title of ['specialized_sme','innovative_sme']) {
    const inherited = upperTitles.find(t=>t.titleCode===title)!
    expect(inherited).toMatchObject({group:'eligible',evidence:[],sourceVersions:[],cycles:[]})
    expect(inherited.effectiveQualification!.localRuleBasis!.join(' ')).toContain('按有效小巨人资格计入')
    expect(inherited.effectiveQualification!.localRuleBasis!.join(' ')).toContain('jxj/announcement/synthetic-118.xlsx')
    expect(inherited.effectiveQualification!.presentationBasis!.join(' ')).toBe('小巨人原认定或复核通过资格保留；不按认定年龄自动到期，适用正式期间、同周期失败及已确认处置另行裁定')
  }
  const ownSpecialized = ownTitles.find(t=>t.titleCode==='specialized_sme')!
  expect(ownSpecialized.effectiveQualification!.localRuleBasis).toEqual([])
  expect(ownSpecialized.effectiveQualification!.presentationBasis!.join(' ')).toContain(`${y-1} 年 + 3 = ${y+2} 年`)
  expect(ownSpecialized.evidence).toContainEqual(expect.objectContaining({eventType:'award',year:y-1,batchSeq:2}))
  expect(f.businessDigest()).toBe(before)
})
