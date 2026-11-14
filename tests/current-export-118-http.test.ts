import { submitNativePlatformQuery } from './helpers/native-platform-fixture'
import { submitSyntheticRecognizedCollection } from './helpers/qualification-native-source'
import { CURRENT_RULE_VERSION } from '../lib/roster/current-qualification'
import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './helpers/current-export-118'
import { execFileSync } from 'node:child_process'

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import ExcelJS from 'exceljs'

import { eq } from 'drizzle-orm'
import { schema as s } from '../db/client'

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { currentExport118Fixture, expectCounts, rows, route, year as y, type Event } from './helpers/current-export-118'

const f = currentExport118Fixture()
beforeAll(f.start,90000)
beforeEach(f.resetBusiness, 90000)
afterAll(f.close)

it('专精特新入口提交202并下载六表新认定文件', async () => {
  const {enterprise} = f.candidate('专精特新新认定')
  const {wb,job} = await f.workbook('118-fresh')
  expect(rows(wb,'有效企业').map(row => businessIdentity(row))).toEqual([expectedBusinessIdentity(f.db,enterprise.id)])
  expect(rows(wb,'有效企业')[0]![12]).toContain('synthetic-118.xlsx')
  expect(job.result.artifact.filename).toBe('current-specialized_sme.xlsx')
  expect(job.result.artifact.availability).toBe('available')
  expect(job.result.snapshotId).toBe(job.id)
  expect(job.result.executor.peakRssBytes).toBeGreaterThan(0)
  expectCounts(wb,job,{eligible:1,pending:0,excluded:0})
})

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
  const {wb,job} = await f.workbook('118-cycles')
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
  expectCounts(wb,job,{eligible:3,pending:0,excluded:8}, {effective:3,expired:7,terminated:0,moved_out:0,unrecognized:1})
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
  const {wb,job} = await f.workbook('118-identity')
  const eligible = rows(wb,'有效企业'), waiting = rows(wb,'未认定')
  expect(eligible.map(row => businessIdentity(row))).toEqual([renamed,returned,out,gone,stale,unknown,pending,terminalGap,conflict].map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
  expect(rows(wb,'已迁出')).toEqual([]); expect(rows(wb,'已注销（吊销）')).toEqual([])
  expect(waiting.map(row => businessIdentity(row))).toEqual([migrant,otherPublication].map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
  const rename = eligible.find(row => matchesBusinessIdentity(f.db, row, renamed.enterprise.id))!
  expect({ 8: rename[8], 9: rename[9], 11: rename[11], 12: rename[12] }).toEqual(expectedDisplay); expect(rename[9]).toBe('专精特新公布旧名')
  expect(rename[10]).toBe('已见本称号宁波公布记录')
  expect(rename[11]).not.toContain('已确认迁入宁波')
  expect(rename[11]).not.toContain('现已更名为')
  expect(rename[11]).not.toContain('未见宁波'); expect(rename[11]).not.toContain('原城市')
  expect(eligible.find(row => matchesBusinessIdentity(f.db, row, out.enterprise.id))![13]).toBe('有效企业')
  expect(eligible.find(row => matchesBusinessIdentity(f.db, row, stale.enterprise.id))![13]).toBe('有效企业')
  expect(f.db.$client.prepare('select enterprise_id,reason_code,verification_status from difference_reason where id=?').get(outDecision.id)).toEqual({enterprise_id:out.enterprise.id,reason_code:'moved_out',verification_status:'confirmed'})
  expect(f.db.$client.prepare('select enterprise_id,reason_code,basis from difference_reason where id=?').get(staleDecision.id)).toEqual({enterprise_id:stale.enterprise.id,reason_code:'moved_out',basis:null})
  expect(eligible.find(row => matchesBusinessIdentity(f.db, row, stale.enterprise.id))![11]).not.toContain('相关主体事实适用性未确认')
  expect(waiting.find(row => matchesBusinessIdentity(f.db, row, migrant.enterprise.id))![15]).toContain('缺少已确认认定及资格依据')
  for (const item of [migrant,otherPublication]) {
    const row = waiting.find(row => matchesBusinessIdentity(f.db, row, item.enterprise.id))!
    expect(row[10]).toBe('尚未完成公布匹配核实'); expect(row[11] ?? null).toBeNull()
  }
  expect(waiting.find(row => matchesBusinessIdentity(f.db, row, otherPublication.enterprise.id))![8] ?? null).toBeNull()
  expect(eligible.find(row => matchesBusinessIdentity(f.db, row, conflict.enterprise.id))![11]).toContain('身份冲突')
  expectCounts(wb,job,{eligible:9,pending:0,excluded:2}, {effective:9,expired:0,terminated:0,moved_out:0,unrecognized:2})
})

it('称号隔离同名不同主体及多称号独立重复纳入', async () => {
  const multi = f.candidate('多称号同一企业')
  f.addRecord(multi.enterprise.id,multi.enterprise.name,undefined,'little_giant')
  f.addRecord(multi.enterprise.id,multi.enterprise.name,undefined,'innovative_sme')
  const peerA = f.candidate('同名主体甲'), peerB = f.candidate('同名主体乙')
  for (const item of [peerA,peerB]) {
    f.db.update(s.enterprise).set({name:'同名企业',nameNorm:'同名企业'}).where(eq(s.enterprise.id,item.enterprise.id)).run()
    f.db.update(s.record).set({nameRaw:'同名企业'}).where(eq(s.record.id,item.record.id)).run()
  }
  const onlyLittle = f.candidate('仅小巨人',undefined,'little_giant')
  const onlyInnovative = f.candidate('仅创新型',undefined,'innovative_sme')
  const crossFailure = f.candidate('他称号失败不影响本称号')
  f.addRecord(crossFailure.enterprise.id,crossFailure.enterprise.name,[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'failed'}],'little_giant')
  // Qualification failure is title-scoped; cross-title subject termination is
  // covered separately by current-export-review-fixes-http.
  const reverse = f.candidate('本称号失败不借他称号恢复',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'failed'}])
  f.addRecord(reverse.enterprise.id,reverse.enterprise.name,undefined,'innovative_sme')
  const {wb,job} = await f.workbook('118-isolation')
  expect(rows(wb,'有效企业').map(row => businessIdentity(row))).toEqual([multi,peerA,peerB,crossFailure].map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
  expect(rows(wb,'已到期').map(row => businessIdentity(row))).toEqual([expectedBusinessIdentity(f.db,reverse.enterprise.id)])
  expect(rows(wb,'有效企业').filter(row => row[2] === '同名企业').map(row => [row[2],row[3]])).toEqual([
    ['同名企业','SYNTHETIC-118-同名主体甲'],['同名企业','SYNTHETIC-118-同名主体乙'],
  ])
  expectCounts(wb,job,{eligible:4,pending:0,excluded:1})
  // Other titles use the very same public kind. Their independent sets must also retain multi.
  for (const [title,label,eligible,excluded] of [
    ['little_giant','专精特新“小巨人”',[multi,onlyLittle],[crossFailure]],
    ['innovative_sme','创新型中小企业',[multi,onlyInnovative,reverse],[]],
  ] as const) {
    const response = await fetch(f.url('/api/jobs'),{method:'POST',headers:f.headers,body:JSON.stringify({kind:'current-roster-export',params:{titleCode:title,clientRequestId:'118-multi-' + title}})})
    expect(response.status).toBe(202)
    const other = await f.terminal((await f.json(response)).jobId); expect(other.state).toBe('done')
    const {wb:otherWb} = await f.download(other)
    expect(rows(otherWb,'有效企业').map(row => businessIdentity(row))).toEqual(eligible.map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
    expect(rows(otherWb,'已到期').map(row => businessIdentity(row))).toEqual(excluded.map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
    expect(rows(otherWb,'有效企业').every(row => row[5] === label)).toBe(true)
    expect(other.kind).toBe(job.kind)
  }
})

it('超过最大列表页的全部主体和公式样式文本安全导出且业务只读', async () => {
  const candidates = Array.from({length:205},(_,index) => f.candidate('超页企业' + String(index).padStart(3,'0')))
  const formulas = ['=HYPERLINK("https://invalid.example","合成")','+SUM(1,2)','-1+2','@SUM(A1:A2)']
  const formulaCandidates = formulas.map(value => f.candidate(value))
  f.db.update(s.enterprise).set({usccNorm:'001234567890123456'}).where(eq(s.enterprise.id,formulaCandidates[0]!.enterprise.id)).run()
  f.db.update(s.recordEvidence).set({sourceFile:'=FORMULA_SOURCE()'}).where(eq(s.recordEvidence.listNo,formulaCandidates[0]!.enterprise.id)).run()
  const longName = '专精特新😀长名称'.repeat(15), long = f.candidate(longName)
  const page = await f.json(await fetch(f.url('/api/roster/enterprises?pageSize=200')))
  expect(page.rows).toHaveLength(200)
  const digest = f.businessDigest(), {wb,job} = await f.workbook('118-full-text')
  const eligible = rows(wb,'有效企业')
  expect(eligible.map(row => businessIdentity(row))).toEqual([...candidates,...formulaCandidates,long].map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
  expect(eligible.slice(205,209).map(row => row[2])).toEqual(formulas)
  expect(eligible[205]![3]).toBe('001234567890123456')
  expect(eligible[205]![12]).toContain('=FORMULA_SOURCE()')
  expect(eligible[209]![2]).toBe(longName)
  const sheet = wb.getWorksheet('有效企业')!
  sheet.eachRow(row => row.eachCell(cell => { expect(typeof cell.value).toBe('string'); expect(cell.type).toBe(ExcelJS.ValueType.String) }))
  expect(f.businessDigest()).toBe(digest)
  expectCounts(wb,job,{eligible:210,pending:0,excluded:0})
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
  const digest = f.businessDigest(), {wb,job} = await f.workbook('118-evidence-gaps')
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
  expectCounts(wb,job,{eligible:5,pending:0,excluded:2}, {effective:5,expired:0,terminated:0,moved_out:0,unrecognized:2})
})

it('专用入口鉴权去重重生成参数拒绝及OpenAPI共用kind', async () => {
  f.candidate('任务契约企业')
  const first = await f.workbook('118-dedup')
  const duplicate = await f.submit('118-dedup'); expect(duplicate.status).toBe(202)
  expect((await f.json(duplicate)).jobId).toBe(first.job.id)
  const generic = await fetch(f.url('/api/jobs'),{method:'POST',headers:f.headers,body:JSON.stringify({kind:'current-roster-export',params:{titleCode:'specialized_sme',clientRequestId:'118-dedup'}})})
  expect(generic.status).toBe(202); expect((await f.json(generic)).jobId).toBe(first.job.id)
  const list = await f.json(await fetch(f.url('/api/jobs?kind=current-roster-export')))
  expect(list.rows.filter((job:any) => job.params.clientRequestId === '118-dedup')).toHaveLength(1)
  const kinds = await f.json(await fetch(f.url('/api/jobs/kinds')))
  expect(kinds.kinds.filter((kind:any) => kind.kind === 'current-roster-export')).toHaveLength(1)
  expect(kinds.kinds.find((kind:any) => kind.kind === 'current-roster-export').paramsHint).toContain('specialized_sme')
  const regenerated = await f.workbook('118-regenerated',{regenerateOf:first.job.id})
  expect(regenerated.job.id).not.toBe(first.job.id); expect(regenerated.job.params.regenerateOf).toBe(first.job.id)
  expect((await f.submit('118-regenerated',{regenerateOf:regenerated.job.id})).status).toBe(409)
  expect((await fetch(f.url('/api/roster/exports/current/little-giant'),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'118-dedup'})})).status).toBe(409)
  const wrongTitle = await fetch(f.url('/api/jobs'),{method:'POST',headers:f.headers,body:JSON.stringify({kind:'current-roster-export',params:{titleCode:'innovative_sme',clientRequestId:'118-wrong-regenerate',regenerateOf:first.job.id}})})
  expect(wrongTitle.status).toBe(409)
  for (const body of [{},{clientRequestId:''},{clientRequestId:' '},{clientRequestId:'a'.repeat(129)},{clientRequestId:'118-bad',asOf:'2025-01-01'},{clientRequestId:'118-bad',titleCode:'innovative_sme'},{clientRequestId:'118-bad',unknown:true},[],null]) {
    expect((await fetch(f.url(route),{method:'POST',headers:f.headers,body:JSON.stringify(body)})).status).toBe(400)
  }
  expect((await fetch(f.url(route + '?asOf=2025-01-01'),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'118-query-date'})})).status).toBe(400)
  expect((await fetch(f.url(route),{method:'POST',headers:f.headers,body:'{'})).status).toBe(400)
  for (const auth of [{},{authorization:'Bearer wrong'}] as Record<string,string>[]) {
    expect((await fetch(f.url(route),{method:'POST',headers:{'content-type':'application/json',...auth},body:'{}'})).status).toBe(401)
    expect((await fetch(f.url(first.job.result.artifact.downloadUrl),{headers:auth as Record<string,string>})).status).toBe(401)
  }
  const xToken = await fetch(f.url(route),{method:'POST',headers:{'content-type':'application/json','x-api-token':f.token},body:JSON.stringify({clientRequestId:'118-dedup'})})
  expect(xToken.status).toBe(202); expect((await f.json(xToken)).jobId).toBe(first.job.id)
  const repeated = await f.download(first.job); expect(repeated.bytes.equals(first.bytes)).toBe(true)
  expect(repeated.response.headers.get('etag')).toBe('"' + first.job.result.artifact.sha256 + '"')
  expect(JSON.stringify(first.job)).not.toContain(f.dir)
  expect((await fetch(f.url('/api/job-artifacts/not-a-path'),{headers:f.headers})).status).toBe(400)
  const spec = await f.json(await fetch(f.url('/_openapi.json'))), endpoint = spec.paths[route].post
  expect(endpoint.summary).toBe('提交专精特新中小企业当前有效名录后台导出')
  expect(endpoint.security).toEqual([{bearerAuth:[]}]); expect(endpoint.responses['202']).toBeDefined()
  expect(endpoint.requestBody.content['application/json'].schema.additionalProperties).toBe(false)
  expect(Object.keys(endpoint.requestBody.content['application/json'].schema.properties)).toEqual(['clientRequestId','regenerateOf'])
  expect(spec.paths['/api/job-artifacts/{id}'].get.security).toEqual([{bearerAuth:[]}])
})

it('空集六表计数及产物过期缺失与成功历史分别可查', async () => {
  f.candidate('只有其他称号',undefined,'little_giant')
  const empty = await f.workbook('118-empty')
  expectCounts(empty.wb,empty.job,{eligible:0,pending:0,excluded:0})
  for (const sheet of ['有效企业','已到期','已注销（吊销）','已迁出','未认定']) expect(empty.wb.getWorksheet(sheet)!.getRow(1).values).toEqual([undefined,'序号','企业名称','统一社会信用代码','区县','称号','首次认定年份','认定及复核情况','公布名称','已确认曾用名','公布对应情况','情况说明','来源及页码','有效状态','有效期及排除依据','资料缺口与来源备注'])
  expect(empty.job.progress).toEqual({done:0,total:0}); expect(empty.job.percent).toBe(100)
  f.db.update(s.job).set({result:{...empty.job.result,artifact:{...empty.job.result.artifact,expiresAt:'2000-01-01T00:00:00Z'}}}).where(eq(s.job.id,empty.job.id)).run()
  const expired = await f.json(await fetch(f.url('/api/jobs/' + empty.job.id)))
  expect(expired.state).toBe('done'); expect(expired.result.artifact.availability).toBe('expired')
  expect((await fetch(f.url(empty.job.result.artifact.downloadUrl),{headers:f.headers})).status).toBe(410)
  expect(existsSync(join(f.dbPath + '.exports',empty.job.id + '.xlsx'))).toBe(false)
  const missing = await f.workbook('118-missing')
  rmSync(join(f.dbPath + '.exports',missing.job.id + '.xlsx'))
  const read = await f.json(await fetch(f.url('/api/jobs/' + missing.job.id)))
  expect(read.state).toBe('done'); expect(read.result.artifact.availability).toBe('missing')
  expect((await fetch(f.url(missing.job.result.artifact.downloadUrl),{headers:f.headers})).status).toBe(404)
  const restored = await f.workbook('118-empty-regenerate',{regenerateOf:empty.job.id})
  expect(restored.job.id).not.toBe(empty.job.id)
  expect(restored.job.result.artifact.availability).toBe('available')
  expectCounts(restored.wb,restored.job,{eligible:0,pending:0,excluded:0})
})

it('本称号生成失败无半成品且可显式重新生成', async () => {
  const invalid=f.candidate('超'.repeat(33000))
  const response = await f.submit('118-failed'); expect(response.status).toBe(202)
  const accepted = await f.json(response), failed = await f.terminal(accepted.jobId)
  expect(failed.state).toBe('failed'); expect(failed.error).toContain('Excel')
  expect(failed.params.titleCode).toBe('specialized_sme')
  expect(failed.result.ruleVersion).toBe(CURRENT_RULE_VERSION)
  expect(failed.result.artifact).toBeUndefined()
  expect(JSON.stringify(failed)).not.toContain(f.dir)
  expect((await fetch(f.url('/api/job-artifacts/' + failed.id),{headers:f.headers})).status).toBe(404)
  for (const suffix of ['.part','.xlsx']) expect(existsSync(join(f.dbPath + '.exports',failed.id + suffix))).toBe(false)
  expect((await f.json(await f.submit('118-failed'))).jobId).toBe(failed.id)
  f.db.delete(s.record).where(eq(s.record.id,invalid.record.id)).run()
  f.db.delete(s.enterprise).where(eq(s.enterprise.id,invalid.enterprise.id)).run()
  const recovered = f.candidate('修正合成超限后重新导出')
  const next = await f.workbook('118-retry-failed',{regenerateOf:failed.id})
  expect(next.job.id).not.toBe(failed.id); expect(next.job.params.regenerateOf).toBe(failed.id)
  expect(rows(next.wb,'有效企业').map(row => businessIdentity(row))).toEqual([expectedBusinessIdentity(f.db,recovered.enterprise.id)])
  expectCounts(next.wb,next.job,{eligible:1,pending:0,excluded:0})
})

it('阻塞真实执行进程仍先返回202并共用队列取消', async () => {
  for (let index=0; index<210; index++) f.candidate('受控阻塞企业' + index)
  const response = await f.submit('118-blocked'); expect(response.status).toBe(202)
  const activeId = (await f.json(response)).jobId, ids = [activeId]
  let pid: number|undefined
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const line = execFileSync('ps',['-Ao','pid=,args='],{encoding:'utf8'}).split('\n').find(line => line.includes(f.dir) && line.includes('/current-export-worker.mjs'))
    if (line) { pid = Number(line.trim().split(/\s+/)[0]); break }
    await new Promise(resolve => setTimeout(resolve,10))
  }
  expect(pid).toBeGreaterThan(0)
  process.kill(pid!,'SIGSTOP')
  try {
    const active = await f.json(await fetch(f.url('/api/jobs/' + activeId)))
    expect(active.state).toBe('running'); expect(active.params.titleCode).toBe('specialized_sme')
    expect((await fetch(f.url('/api/job-artifacts/' + activeId),{headers:f.headers})).status).toBe(404)
    const started = performance.now(), queuedResponse = await f.submit('118-queued')
    const submitMs = performance.now() - started
    expect(queuedResponse.status).toBe(202); expect(submitMs).toBeLessThan(1000)
    const queuedId = (await f.json(queuedResponse)).jobId; ids.push(queuedId)
    const queued = await f.json(await fetch(f.url('/api/jobs/' + queuedId)))
    expect(queued.state).toBe('queued'); expect(queued.percent).toBeNull()
    const genericResponse = await fetch(f.url('/api/jobs'),{method:'POST',headers:f.headers,body:JSON.stringify({kind:'current-roster-export',params:{titleCode:'innovative_sme',clientRequestId:'118-shared-queue'}})})
    expect(genericResponse.status).toBe(202)
    const genericId = (await f.json(genericResponse)).jobId; ids.push(genericId)
    const generic = await f.json(await fetch(f.url('/api/jobs/' + genericId)))
    expect(generic.state).toBe('queued'); expect(generic.kind).toBe(active.kind)
    const duplicate = await f.submit('118-blocked'); expect(duplicate.status).toBe(202)
    expect((await f.json(duplicate)).jobId).toBe(activeId)
    expect((await f.submit('118-regenerate-running',{regenerateOf:activeId})).status).toBe(409)
    for (const id of [queuedId,genericId]) expect((await fetch(f.url('/api/jobs/' + id),{method:'DELETE',headers:f.headers})).status).toBe(200)
    expect((await fetch(f.url('/api/jobs/' + activeId),{method:'DELETE',headers:f.headers})).status).toBe(202)
  } finally {
    for (const id of ids) await fetch(f.url('/api/jobs/' + id),{method:'DELETE',headers:f.headers})
    try { process.kill(pid!,'SIGCONT') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    for (const id of ids) {
      const job = await f.terminal(id); expect(job.state).toBe('cancelled')
      expect((await fetch(f.url('/api/job-artifacts/' + id),{headers:f.headers})).status).toBe(404)
      for (const suffix of ['.part','.xlsx']) expect(existsSync(join(f.dbPath + '.exports',id + suffix))).toBe(false)
    }
  }
},30000)
