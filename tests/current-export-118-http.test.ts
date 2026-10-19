import { execFileSync } from 'node:child_process'

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import ExcelJS from 'exceljs'

import { eq } from 'drizzle-orm'
import { schema as s } from '../db/client'

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { currentExport118Fixture, expectCounts, rows, route, year as y, type Event } from './helpers/current-export-118'

const f = currentExport118Fixture()
beforeAll(f.start,90000)
beforeEach(f.resetBusiness)
afterAll(f.close)

it('专精特新入口提交202并下载四表新认定文件', async () => {
  const {enterprise} = f.candidate('专精特新新认定')
  const {wb,job} = await f.workbook('118-fresh')
  expect(rows(wb,'有效企业').map(row => [row[2],row[4]])).toEqual([[String(enterprise.id),'专精特新新认定']])
  expect(rows(wb,'有效企业')[0]![14]).toContain('evidence:')
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
    ['有效企业',['新认定无需复核','复核延续','失败后重新认定','旧周期晚失败']],
    ['排除明细',['本周期失败','纯培育']],
    ['待确认',['已到复核年结果未知','复核结论年未知','同年通过失败冲突','同年恢复顺序未知','复核周期未知']],
  ] as Array<[string,string[]]>) expect(rows(wb,sheet).map(row => row[2])).toEqual(names.map(name => ids[name]))
  const restored = rows(wb,'有效企业').find(row => row[4] === '失败后重新认定')!
  expect(restored[9]).toBe(String(y-5))
  expect(restored[11]).toContain('failed')
  expect(restored[10].match(/event:/g)).toHaveLength(3)
  expect(rows(wb,'有效企业').find(row => row[4] === '复核延续')![11]).toContain('结论年' + (y-1))
  expect(rows(wb,'排除明细').find(row => row[4] === '本周期失败')![13]).toContain('复核明确不通过')
  for (const name of ['同年通过失败冲突','同年恢复顺序未知']) expect(rows(wb,'待确认').find(row => row[4] === name)![13]).toContain('冲突')
  expectCounts(wb,job,{eligible:4,pending:5,excluded:2})
})

it('迁入更名双备注及主体事实和公布缺口保留依据', async () => {
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
  const {wb,job} = await f.workbook('118-identity')
  const eligible = rows(wb,'有效企业'), waiting = rows(wb,'待确认'), excluded = rows(wb,'排除明细')
  expect(eligible.map(row => row[2])).toEqual([renamed,returned,pending].map(item => String(item.enterprise.id)))
  expect(excluded.map(row => row[2])).toEqual([out,gone].map(item => String(item.enterprise.id)))
  expect(waiting.map(row => row[2])).toEqual([stale,unknown,migrant,terminalGap,otherPublication,conflict].map(item => String(item.enterprise.id)))
  const rename = eligible.find(row => row[2] === String(renamed.enterprise.id))!
  expect(rename[5]).toBe('专精特新公布旧名'); expect(rename[6]).toBe('专精特新公布旧名')
  expect(rename[12]).toBe('已见本称号宁波公布记录')
  expect(rename[13]).toContain('已确认迁入宁波')
  expect(rename[13]).toContain('已公布，公布名称为专精特新公布旧名；现已更名为迁入更名现名')
  expect(rename[13]).not.toContain('未见宁波'); expect(rename[13]).not.toContain('原城市')
  expect(excluded.find(row => row[2] === String(out.enterprise.id))![14]).toContain('decision:' + outDecision.id)
  expect(waiting.find(row => row[2] === String(stale.enterprise.id))![14]).toContain('decision:' + staleDecision.id)
  expect(waiting.find(row => row[2] === String(migrant.enterprise.id))![13]).toContain('#108')
  for (const item of [unknown,migrant,otherPublication]) {
    const row = waiting.find(row => row[2] === String(item.enterprise.id))!
    expect(row[12]).toBe('尚未完成公布匹配核实'); expect(row[13]).not.toContain('未见宁波')
  }
  expect(waiting.find(row => row[2] === String(otherPublication.enterprise.id))![5] ?? null).toBeNull()
  expect(waiting.find(row => row[2] === String(conflict.enterprise.id))![13]).toContain('身份冲突')
  expectCounts(wb,job,{eligible:3,pending:6,excluded:2})
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
  expect(rows(wb,'有效企业').map(row => row[2])).toEqual([multi,peerA,peerB,crossFailure].map(item => String(item.enterprise.id)))
  expect(rows(wb,'排除明细').map(row => row[2])).toEqual([String(reverse.enterprise.id)])
  expect(rows(wb,'有效企业').filter(row => row[4] === '同名企业').map(row => [row[2],row[3]])).toEqual([
    [String(peerA.enterprise.id),'SYNTHETIC-118-同名主体甲'],[String(peerB.enterprise.id),'SYNTHETIC-118-同名主体乙'],
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
    expect(rows(otherWb,'有效企业').map(row => row[2])).toEqual(eligible.map(item => String(item.enterprise.id)))
    expect(rows(otherWb,'排除明细').map(row => row[2])).toEqual(excluded.map(item => String(item.enterprise.id)))
    expect(rows(otherWb,'有效企业').every(row => row[8] === label)).toBe(true)
    expect(other.kind).toBe(job.kind)
  }
})

it('超过最大列表页的全部主体和公式样式文本安全导出且业务只读', async () => {
  const candidates = Array.from({length:205},(_,index) => f.candidate('超页企业' + String(index).padStart(3,'0')))
  const formulas = ['=HYPERLINK("https://invalid.example","合成")','+SUM(1,2)','-1+2','@SUM(A1:A2)']
  const formulaCandidates = formulas.map(value => f.candidate(value))
  f.db.update(s.enterprise).set({usccNorm:'001234567890123456'}).where(eq(s.enterprise.id,formulaCandidates[0]!.enterprise.id)).run()
  f.db.update(s.recordEvidence).set({sourceFile:'=FORMULA_SOURCE()'}).where(eq(s.recordEvidence.listNo,formulaCandidates[0]!.enterprise.id)).run()
  const longName = '专精特新😀长名称'.repeat(50), long = f.candidate(longName)
  const page = await f.json(await fetch(f.url('/api/roster/enterprises?pageSize=200')))
  expect(page.rows).toHaveLength(200)
  const digest = f.businessDigest(), {wb,job} = await f.workbook('118-full-text')
  const eligible = rows(wb,'有效企业')
  expect(eligible.map(row => row[2])).toEqual([...candidates,...formulaCandidates,long].map(item => String(item.enterprise.id)))
  expect(eligible.slice(205,209).map(row => row[4])).toEqual(formulas)
  expect(eligible[205]![3]).toBe('001234567890123456')
  expect(eligible[205]![14]).toContain('=FORMULA_SOURCE()')
  expect(eligible[209]![4]).toBe(longName)
  const sheet = wb.getWorksheet('有效企业')!
  sheet.eachRow(row => row.eachCell(cell => { expect(typeof cell.value).toBe('string'); expect(cell.type).toBe(ExcelJS.ValueType.String) }))
  expect(f.businessDigest()).toBe(digest)
  expectCounts(wb,job,{eligible:210,pending:0,excluded:0})
})

it('查询失败零行退回待审不作废且部分依据候选显式待确认', async () => {
  const eligible = []
  for (const status of ['failed','no_record'] as const) {
    const c = f.candidate('平台查询' + status); eligible.push(c)
    f.db.insert(s.platformQuery).values({interface:'recognized_list',queryKey:c.enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:new Date().toISOString(),status}).run()
  }
  for (const status of ['退回','待审核']) {
    const c = f.candidate('更新' + status); eligible.push(c)
    const q = f.db.insert(s.platformQuery).values({interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:new Date().toISOString(),status:'success'}).returning().get()
    f.db.insert(s.platformRelation).values({queryId:q.id,sequenceNo:1,enterpriseId:c.enterprise.id,status,declareKind:'update',verificationStatus:'confirmed',matchBasis:'uscc'}).run()
  }
  const partial = f.candidate('首次补充依据缺口',[{eventType:'award',year:y-5},{eventType:'award',year:y}]); eligible.push(partial)
  const oldEvent = f.db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,partial.record.id)).all()[0]!
  f.db.delete(s.recordEvidence).where(eq(s.recordEvidence.recordEventId,oldEvent.id)).run()
  const unconfirmed = f.candidate('未确认资格对应',[{eventType:'maintain',year:y}])
  f.db.update(s.record).set({source:'miit'}).where(eq(s.record.id,unconfirmed.record.id)).run()
  const event = f.db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,unconfirmed.record.id)).get()!
  const edge = f.db.insert(s.recordCorrespondence).values({edgeKey:'synthetic-118-candidate',type:'event_process',role:'award',eventId:event.id,enterpriseId:unconfirmed.enterprise.id,titleCode:'specialized_sme',status:'candidate',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:new Date().toISOString()}).returning().get()
  const platform = f.db.insert(s.enterprise).values({name:'仅平台识别候选',nameNorm:'仅平台识别候选',usccNorm:'SYNTHETIC-118-PLATFORM'}).returning().get()
  const q = f.db.insert(s.platformQuery).values({interface:'recognized_list',queryKey:platform.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:new Date().toISOString(),status:'success'}).returning().get()
  const relation = f.db.insert(s.platformRelation).values({queryId:q.id,sequenceNo:1,enterpriseId:platform.id,status:'认定通过',verificationStatus:'confirmed',matchBasis:'uscc'}).returning().get()
  const digest = f.businessDigest(), {wb,job} = await f.workbook('118-evidence-gaps')
  expect(rows(wb,'有效企业').map(row => row[2])).toEqual(eligible.map(item => String(item.enterprise.id)))
  const partialRow = rows(wb,'有效企业').find(row => row[2] === String(partial.enterprise.id))!
  expect(partialRow[9] ?? null).toBeNull(); expect(partialRow[13]).toContain('首次认定补充依据不完整')
  const waiting = rows(wb,'待确认')
  expect(waiting.map(row => row[2])).toEqual([String(unconfirmed.enterprise.id),String(platform.id)])
  expect(waiting[0]![14]).toContain('correspondence:' + edge.id)
  expect(waiting[1]![14]).toContain('platform-relation:' + relation.id)
  expect(waiting[1]![13]).toContain('缺少已确认认定及资格依据')
  expect(f.businessDigest()).toBe(digest)
  expectCounts(wb,job,{eligible:5,pending:2,excluded:0})
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

it('空集四表计数及产物过期缺失与成功历史分别可查', async () => {
  f.candidate('只有其他称号',undefined,'little_giant')
  const empty = await f.workbook('118-empty')
  expectCounts(empty.wb,empty.job,{eligible:0,pending:0,excluded:0})
  for (const sheet of ['有效企业','待确认','排除明细']) expect(empty.wb.getWorksheet(sheet)!.getRow(1).values).toEqual([undefined,'序号','稳定企业标识','统一社会信用代码','现名','公布名','已确认曾用名','宁波区县','称号','首次认定','最近授予/延续资格依据','复核情况','公布对应情况','备注','可核对依据'])
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
  f.candidate('超'.repeat(33000))
  const response = await f.submit('118-failed'); expect(response.status).toBe(202)
  const accepted = await f.json(response), failed = await f.terminal(accepted.jobId)
  expect(failed.state).toBe('failed'); expect(failed.error).toContain('Excel')
  expect(failed.params.titleCode).toBe('specialized_sme')
  expect(failed.result.ruleVersion).toBe('current-roster-116-v3')
  expect(failed.result.artifact).toBeUndefined()
  expect(JSON.stringify(failed)).not.toContain(f.dir)
  expect((await fetch(f.url('/api/job-artifacts/' + failed.id),{headers:f.headers})).status).toBe(404)
  for (const suffix of ['.part','.xlsx']) expect(existsSync(join(f.dbPath + '.exports',failed.id + suffix))).toBe(false)
  expect((await f.json(await f.submit('118-failed'))).jobId).toBe(failed.id)
  f.resetBusiness(); const recovered = f.candidate('修正合成超限后重新导出')
  const next = await f.workbook('118-retry-failed',{regenerateOf:failed.id})
  expect(next.job.id).not.toBe(failed.id); expect(next.job.params.regenerateOf).toBe(failed.id)
  expect(rows(next.wb,'有效企业').map(row => row[2])).toEqual([String(recovered.enterprise.id)])
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
    writeFileSync('/tmp/spec118-controlled-timing.json',JSON.stringify({node:process.version,fixtureRows:210,submitWhileStoppedMs:submitMs,kind:active.kind,title:active.params.titleCode},null,2))
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
