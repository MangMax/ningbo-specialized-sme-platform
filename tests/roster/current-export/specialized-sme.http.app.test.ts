import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import { CURRENT_RULE_VERSION } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './fixtures/specialized-export'
import { execFileSync } from 'node:child_process'

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import ExcelJS from 'exceljs'

import { eq } from 'drizzle-orm'
import { schema as s } from '../../../db/client'

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { readDevelopmentDiscovery, specializedExportFixture, expectCounts, rows, route, year as y, type Event } from './fixtures/specialized-export'

let developmentSpec: any
beforeAll(async () => { developmentSpec = await readDevelopmentDiscovery() }, 60000)
const f = specializedExportFixture()
beforeEach(async () => { await f.resetBusiness(); await f.start() }, 90000)
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
  expect(rows(wb,'有效企业').map(row => businessIdentity(row))).toEqual([multi,peerA,peerB,onlyLittle,crossFailure].map(item => expectedBusinessIdentity(f.db,item.enterprise.id)))
  expect(rows(wb,'已到期').map(row => businessIdentity(row))).toEqual([expectedBusinessIdentity(f.db,reverse.enterprise.id)])
  expect(rows(wb,'有效企业').filter(row => row[2] === '同名企业').map(row => [row[2],row[3]])).toEqual([
    ['同名企业','SYNTHETIC-118-同名主体甲'],['同名企业','SYNTHETIC-118-同名主体乙'],
  ])
  expectCounts(wb,job,{eligible:5,pending:0,excluded:1})
  // Other titles use the very same public kind. Their independent sets must also retain multi.
  for (const [title,label,eligible,excluded] of [
    ['little_giant','专精特新“小巨人”',[multi,onlyLittle],[crossFailure]],
    ['innovative_sme','创新型中小企业',[multi,peerA,peerB,onlyLittle,onlyInnovative,crossFailure,reverse],[]],
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
  const spec = developmentSpec, endpoint = spec.paths[route].post
  expect(endpoint.summary).toBe('提交专精特新中小企业当前有效名录后台导出')
  expect(endpoint.security).toEqual([{bearerAuth:[]}]); expect(endpoint.responses['202']).toBeDefined()
  expect(endpoint.requestBody.content['application/json'].schema.additionalProperties).toBe(false)
  expect(Object.keys(endpoint.requestBody.content['application/json'].schema.properties)).toEqual(['clientRequestId','regenerateOf'])
  expect(spec.paths['/api/job-artifacts/{id}'].get.security).toEqual([{bearerAuth:[]}])
})

it('空集六表计数及产物过期缺失与成功历史分别可查', async () => {
  // No valid own or upper candidate: the original giant-only seed is now effective.
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
    const line = execFileSync('ps',['-Ao','pid=,ppid=,args='],{encoding:'utf8'}).split('\n').find(line => Number(line.trim().split(/\s+/)[1]) === f.processId && line.includes('/current-export-worker.mjs'))
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
