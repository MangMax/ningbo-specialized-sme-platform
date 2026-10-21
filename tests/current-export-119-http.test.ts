import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './helpers/current-export-118'
import { reviewCurrentExportDecision } from './helpers/current-export-decisions'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { useDb, schema as s } from '../db/client'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

// Only synthetic fixtures are written here. Assertions use real HTTP and XLSX bytes.
const dir = mkdtempSync(join(tmpdir(), 'export-119-'))
const dbPath = join(dir, 'synthetic.db')
const db = useDb({ dbPath })
const titleCode = 'innovative_sme'
const endpoint = '/api/roster/exports/current/innovative-sme'
const token = 'synthetic-export-119-token'
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
const year = new Date().getFullYear()
let service: { baseUrl: string; stop: () => Promise<void> } | undefined
const url = (path: string) => service!.baseUrl + path
const json = (response: Response): Promise<any> => response.json()
const submit = (clientRequestId: string, extra = {}) => fetch(url(endpoint), {
  method: 'POST', headers, body: JSON.stringify({ clientRequestId, ...extra }),
})

type Event = Pick<typeof s.recordEvent.$inferInsert, 'eventType' | 'year' | 'decidedYear' | 'reviewOutcome' | 'batchSeq'>
const award: Event = { eventType: 'award', year, batchSeq: 1 }
function record(enterpriseId: number, name: string, events: Event[] = [award], title = titleCode) {
  const row = db.insert(s.record).values({ enterpriseId, titleCode: title, source: 'jxj', nameRaw: name }).returning().get()
  const eventRows = events.map(event => {
    const rowEvent = db.insert(s.recordEvent).values({ recordId: row.id, ...event }).returning().get()
    db.insert(s.recordEvidence).values({ recordEventId: rowEvent.id, sourceFile: `jxj/announcement/${title}-synthetic.xlsx`, attachment: '合成名单', listNo: rowEvent.id }).run()
    return rowEvent
  })
  return { record: row, events: eventRows }
}
function candidate(name: string, events: Event[] = [award], title = titleCode) {
  const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: `TEST-119-${name}`, district: '鄞州区', city: '宁波市' }).returning().get()
  return { enterprise, ...record(enterprise.id, name, events, title) }
}
async function terminal(id: string) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const response = await fetch(url('/api/jobs/' + id))
    expect(response.status).toBe(200)
    const job = await json(response)
    if (['done', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('export did not finish: ' + id)
}
function rows(wb: ExcelJS.Workbook, sheet: string) {
  const ws = wb.getWorksheet(sheet)!
  return ws.getRows(2, Math.max(0, ws.rowCount - 1))?.map(row => row.values as any[]) ?? []
}
async function download(job: any) {
  const response = await fetch(url(job.result.artifact.downloadUrl), { headers })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="current-${job.params.titleCode}.xlsx"`)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const bytes = Buffer.from(await response.arrayBuffer())
  expect(bytes.length).toBe(job.result.artifact.size)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.result.artifact.sha256)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as any)
  expect(wb.worksheets.map(sheet => sheet.name)).toEqual(['有效企业', '待确认', '排除明细', '口径说明'])
  const explanation = Object.fromEntries(rows(wb, '口径说明').map(row => [row[1], row[2]]))
  for (const [sheet, key] of [['有效企业', 'eligible'], ['待确认', 'pending'], ['排除明细', 'excluded']] as const) {
    expect(rows(wb, sheet)).toHaveLength(job.result.counts[key])
    expect(explanation[sheet]).toBe(String(job.result.counts[key]))
  }
  expect(explanation['规则版本']).toBeUndefined()
  expect(explanation['数据版本']).toBeUndefined()
  expect(job.result.ruleVersion).toBe('current-roster-116-v8')
  expect(explanation['范围']).toContain('未实时采集，不证明全市完整')
  return { wb, bytes }
}
async function workbook(key: string, extra = {}) {
  const response = await submit(key, extra)
  expect(response.status).toBe(202)
  const accepted = await json(response)
  expect(response.headers.get('location')).toBe('/api/jobs/' + accepted.jobId)
  expect(Object.keys(accepted).sort()).toEqual(['jobId', 'kind', 'state'])
  expect(['queued', 'running']).toContain(accepted.state)
  expect(accepted.kind).toBe('current-roster-export')
  const job = await terminal(accepted.jobId)
  expect(job.state, JSON.stringify(job)).toBe('done')
  expect(job.params.titleCode).toBe(titleCode)
  expect(job.result.snapshotId).toBe(job.id)
  expect(job.result.executor.peakRssBytes).toBeGreaterThan(0)
  expect(job.result.artifact.availability).toBe('available')
  return { job, ...await download(job) }
}
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..')
  const port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: token, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') },
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(url('/api/jobs/kinds'), { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(String(error) + output) }
}, 90000)
beforeEach(() => {
  // Retain job history; reset only synthetic business fixtures between terminal jobs.
  db.transaction(() => {
    for (const table of ['record_correspondence', 'difference_reason', 'platform_relation', 'platform_query', 'record', 'enterprise_alias', 'enterprise']) db.$client.exec(`delete from ${table}`)
  })
})
afterAll(async () => {
  await service?.stop()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

it('创新型专用入口交付四表与共享任务产物', async () => {
  const fresh = candidate('创新型新认定')
  const { wb, job } = await workbook('119-fresh')
  expect(job.result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  expect(rows(wb, '有效企业').map(row => [...businessIdentity(row),row[5]])).toEqual([[...expectedBusinessIdentity(db,fresh.enterprise.id), '创新型中小企业']])
  expect(rows(wb, '有效企业')[0]![12]).toContain('innovative_sme-synthetic.xlsx')
  expect(job.result.dataVersion).toMatch(/^sha256:[a-f0-9]{64}$/)
})

it('创新型按自身认定周期复核并保留恢复与同年冲突', async () => {
  candidate('新认定')
  candidate('复核通过', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'passed' }])
  const restored = candidate('失败后恢复', [{ eventType: 'award', year: year - 5, batchSeq: 1 }, { eventType: 'review', year: year - 5, batchSeq: 1, decidedYear: year - 2, reviewOutcome: 'failed' }, { eventType: 'award', year: year - 1, batchSeq: 2 }])
  candidate('旧周期晚失败', [{ eventType: 'award', year: year - 5, batchSeq: 1 }, { eventType: 'award', year: year - 1, batchSeq: 2 }, { eventType: 'review', year: year - 5, batchSeq: 1, decidedYear: year, reviewOutcome: 'failed' }])
  const failed = candidate('本周期失败', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'failed' }])
  // A different title's passing review cannot rescue this title's failed cycle.
  record(failed.enterprise.id, '本周期失败', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'passed' }], 'specialized_sme')
  candidate('到期结果未知', [{ eventType: 'award', year: year - 3, batchSeq: 1 }])
  candidate('复核缺结论年', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, reviewOutcome: 'passed' }])
  candidate('同年复核冲突', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'failed' }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'passed' }])
  candidate('同年恢复顺序未知', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year, reviewOutcome: 'failed' }, { eventType: 'award', year, batchSeq: 2 }])
  candidate('复核原周期未知', [{ eventType: 'award', year: year - 1 }, { eventType: 'review', year: null, decidedYear: year, reviewOutcome: 'failed' }])
  candidate('纯培育', [{ eventType: 'nurture', year }])
  const { wb, job } = await workbook('119-cycles')
  expect(rows(wb, '有效企业').map(row => row[2])).toEqual(['新认定', '复核通过', '失败后恢复', '旧周期晚失败'])
  expect(rows(wb, '排除明细').map(row => row[2])).toEqual(['本周期失败', '纯培育'])
  expect(rows(wb, '待确认').map(row => row[2])).toEqual(['到期结果未知', '复核缺结论年', '同年复核冲突', '同年恢复顺序未知', '复核原周期未知'])
  expect(job.result.counts).toEqual({ eligible: 4, pending: 5, excluded: 2 })
  const restoreRow = rows(wb, '有效企业').find(row => matchesBusinessIdentity(db, row, restored.enterprise.id))!
  expect(restoreRow[6]).toBe(String(year - 5))
  expect(restoreRow[7].split('\n')).toHaveLength(restored.events.length)
  expect(restoreRow[7]).toContain('复核未通过')
  expect(rows(wb, '有效企业')[1]![7]).toContain(`${year - 1}年复核通过`)
  for (const name of ['同年复核冲突', '同年恢复顺序未知']) expect(rows(wb, '待确认').find(row => row[2] === name)![11]).toContain('冲突')
})

function decision(enterpriseId: number, reasonCode: 'moved_out' | 'moved_in' | 'deregistered' | 'pending_review' | 'other', extra = {}) {
  const decision = db.insert(s.differenceReason).values({ enterpriseId, titleCode, direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode, verificationStatus: 'confirmed', lifecycleAction: 'replace', basis: '合成已确认主体事实', effectiveAt: '2025-01-01T00:00:00Z', recordedAt: new Date().toISOString(), ...extra }).returning().get()
  reviewCurrentExportDecision(db,decision)
  return decision
}
it('创新型迁入更名双备注与主体排除不越过证据边界', async () => {
  const renamed = candidate('迁入现名')
  db.update(s.record).set({ nameRaw: '公布旧名' }).where(eq(s.record.id, renamed.record.id)).run()
  const alias = db.insert(s.enterpriseAlias).values({ enterpriseId: renamed.enterprise.id, name: '公布旧名', nameNorm: '公布旧名', sourceKind: 'manual', verificationStatus: 'confirmed' }).returning().get()
  decision(renamed.enterprise.id, 'moved_in', { movedInTitleCode: titleCode })
  const out = candidate('外迁排除'); const outDecision = decision(out.enterprise.id, 'moved_out')
  const deregistered = candidate('注销排除'); decision(deregistered.enterprise.id, 'deregistered')
  const returned = candidate('迁出后迁回')
  const prior = decision(returned.enterprise.id, 'moved_out', { recordedAt: '2025-01-01T00:00:00Z' })
  decision(returned.enterprise.id, 'moved_in', { previousId: prior.id, effectiveAt: '2026-01-01T00:00:00Z', movedInTitleCode: titleCode })
  const migrant = candidate('迁入缺本称号资格', [])
  decision(migrant.enterprise.id, 'moved_in', { movedInTitleCode: titleCode, movedInYear: year })
  record(migrant.enterprise.id, '迁入缺本称号资格', [award], 'little_giant')
  const unknown = candidate('未确认旧名')
  db.update(s.record).set({ nameRaw: '待确认公布名' }).where(eq(s.record.id, unknown.record.id)).run()
  const partial = candidate('缺正式出处')
  db.delete(s.recordEvidence).where(eq(s.recordEvidence.recordEventId, partial.events[0]!.id)).run()
  const conflict = candidate('统代冲突')
  db.update(s.record).set({ usccRaw: 'OTHER-IDENTITY' }).where(eq(s.record.id, conflict.record.id)).run()
  const stale = candidate('旧解释前提未知')
  const staleDecision = decision(stale.enterprise.id, 'moved_out', { lifecycleAction: null, basis: null, reasonNote: '历史缺码无法查询' })
  const terminated = candidate('终止周期未结构化')
  decision(terminated.enterprise.id, 'other', { reasonNote: '正式取消/终止，但缺对应周期结构化依据' })
  const { wb, job } = await workbook('119-identity')
  expect(rows(wb, '有效企业').map(row => row[2])).toEqual(['迁入现名', '迁出后迁回'])
  expect(rows(wb, '排除明细').map(row => row[2])).toEqual(['外迁排除', '注销排除'])
  expect(rows(wb, '待确认').map(row => row[2])).toEqual(['迁入缺本称号资格', '未确认旧名', '缺正式出处', '统代冲突', '旧解释前提未知', '终止周期未结构化'])
  expect(job.result.counts).toEqual({ eligible: 2, pending: 6, excluded: 2 })
  const renameRow = rows(wb, '有效企业')[0]!
  expect(renameRow[8]).toBe('公布旧名'); expect(renameRow[9]).toBe('公布旧名')
  expect(renameRow[11]).toContain('已确认迁入宁波')
  expect(renameRow[11]).toContain('已公布，公布名称为公布旧名；现已更名为迁入现名')
  expect(renameRow[11]).not.toContain('未见宁波')
  expect(renameRow[11]).not.toContain('原城市：')
  expect(renameRow[9]).toBe(alias.name)
  expect(rows(wb, '排除明细')[0]![11]).toContain('已确认外迁')
  expect(outDecision.id).toBeGreaterThan(0)
  for (const name of ['迁入缺本称号资格', '未确认旧名']) {
    const pending = rows(wb, '待确认').find(row => row[2] === name)!
    expect(pending[10]).toBe('尚未完成公布匹配核实')
    expect(pending[11]).not.toContain('未见宁波')
  }
  expect(rows(wb, '待确认').find(row => row[2] === '迁入缺本称号资格')![11]).toContain('迁入事实不能代替资格依据')
  expect(rows(wb, '待确认').find(row => row[2] === '旧解释前提未知')![11]).toContain('重新核实')
  expect(staleDecision.id).toBeGreaterThan(0)
  expect(rows(wb, '待确认').find(row => row[2] === '统代冲突')![11]).toContain('身份冲突')
})

it('创新型按稳定主体去重且多称号分别保留', async () => {
  const twins = [candidate('同名主体甲'), candidate('同名主体乙')]
  for (const twin of twins) {
    db.update(s.enterprise).set({ name: '同名企业', nameNorm: '同名企业' }).where(eq(s.enterprise.id, twin.enterprise.id)).run()
    db.update(s.record).set({ nameRaw: '同名企业' }).where(eq(s.record.id, twin.record.id)).run()
  }
  const multiple = candidate('多称号企业', [{ eventType: 'award', year: year - 5 }, award])
  record(multiple.enterprise.id, '多称号企业', [award], 'little_giant')
  record(multiple.enterprise.id, '多称号企业', [award], 'specialized_sme')
  const giant = candidate('只有小巨人', [award], 'little_giant')
  candidate('只有专精特新', [award], 'specialized_sme')
  const noOwnAward = candidate('不得借用其他称号公布', [])
  record(noOwnAward.enterprise.id, '不得借用其他称号公布', [award], 'little_giant')
  const { wb, job } = await workbook('119-isolation')
  expect(rows(wb, '有效企业').map(row => businessIdentity(row))).toEqual([...twins.map(twin => expectedBusinessIdentity(db,twin.enterprise.id)), expectedBusinessIdentity(db,multiple.enterprise.id)])
  expect(rows(wb, '有效企业').filter(row => row[2] === '同名企业')).toHaveLength(2)
  expect(rows(wb, '有效企业').filter(row => matchesBusinessIdentity(db, row, multiple.enterprise.id))).toHaveLength(1)
  expect(rows(wb, '待确认').map(row => businessIdentity(row))).toEqual([expectedBusinessIdentity(db,noOwnAward.enterprise.id)])
  expect(rows(wb, '待确认')[0]![8] ?? null).toBeNull()
  expect(rows(wb, '待确认')[0]![10]).toBe('尚未完成公布匹配核实')
  for (const row of [...rows(wb, '有效企业'), ...rows(wb, '待确认')]) {
    expect(row[5]).toBe('创新型中小企业')
    expect(row[12] ?? '').not.toContain('little_giant-synthetic.xlsx')
    expect(row[12] ?? '').not.toContain('specialized_sme-synthetic.xlsx')
  }
  const generic = (title: string, key: string) => fetch(url('/api/jobs'), { method: 'POST', headers, body: JSON.stringify({ kind: 'current-roster-export', params: { titleCode: title, clientRequestId: key } }) })
  const replay = await generic(titleCode, '119-isolation')
  expect(replay.status).toBe(202)
  expect((await json(replay)).jobId).toBe(job.id)
  expect((await generic('little_giant', '119-isolation')).status).toBe(409)
  for (const [title, path, expectedIds] of [
    ['little_giant', '/api/roster/exports/current/little-giant', [multiple.enterprise.id, giant.enterprise.id, noOwnAward.enterprise.id]],
    ['specialized_sme', '/api/jobs', [multiple.enterprise.id]],
  ] as const) {
    const response = path === '/api/jobs' ? await generic(title, '119-cross-' + title) : await fetch(url(path), { method: 'POST', headers, body: JSON.stringify({ clientRequestId: '119-cross-' + title }) })
    expect(response.status).toBe(202)
    const crossJob = await terminal((await json(response)).jobId)
    expect(crossJob.state).toBe('done'); expect(crossJob.kind).toBe(job.kind)
    const cross = await download(crossJob)
    for (const id of expectedIds) expect(rows(cross.wb, '有效企业').some(row => matchesBusinessIdentity(db,row,id))).toBe(true)
    expect(rows(cross.wb, '有效企业').filter(row => matchesBusinessIdentity(db, row, multiple.enterprise.id))).toHaveLength(1)
  }
})

function query(enterprise: typeof s.enterprise.$inferSelect, status: 'success' | 'failed' | 'no_record', key = enterprise.usccNorm!) {
  return db.insert(s.platformQuery).values({ interface: 'recognized_list', queryKey: key, rdjb: '1', titleCode, queriedAt: new Date().toISOString(), status }).returning().get()
}
it('创新型查询失败退回待审与旧决定不冒充资格失效', async () => {
  for (const status of ['failed', 'no_record'] as const) query(candidate('查询' + status).enterprise, status)
  for (const status of ['退回', '待审核']) {
    const c = candidate('更新' + status)
    const q = query(c.enterprise, 'success')
    db.insert(s.platformRelation).values({ queryId: q.id, sequenceNo: 1, enterpriseId: c.enterprise.id, status, declareKind: 'update', verificationStatus: 'confirmed', matchBasis: 'uscc' }).run()
  }
  const pending = candidate('更新待审决定'); decision(pending.enterprise.id, 'pending_review', { measureCode: 'follow_review' })
  const withdrawn = candidate('撤回旧外迁')
  const old = decision(withdrawn.enterprise.id, 'moved_out', { recordedAt: '2025-01-01T00:00:00Z' })
  decision(withdrawn.enterprise.id, 'moved_out', { lifecycleAction: 'withdraw', previousId: old.id })
  const stale = candidate('补码后旧按名证据')
  const staleQuery = query(stale.enterprise, 'failed', 'name:' + stale.enterprise.nameNorm)
  const staleDecision = decision(stale.enterprise.id, 'moved_out', { evidenceQueryId: staleQuery.id })
  const onlyPlatform = db.insert(s.enterprise).values({ name: '仅平台通过', nameNorm: '仅平台通过', usccNorm: 'ONLY-PLATFORM-119' }).returning().get()
  const q = query(onlyPlatform, 'success')
  const relation = db.insert(s.platformRelation).values({ queryId: q.id, sequenceNo: 1, enterpriseId: onlyPlatform.id, status: '认定通过', verificationStatus: 'confirmed', matchBasis: 'uscc' }).returning().get()
  const unconfirmed = candidate('候选对应非资格', [{ eventType: 'maintain', year }])
  db.update(s.record).set({ source: 'miit' }).where(eq(s.record.id, unconfirmed.record.id)).run()
  const edge = db.insert(s.recordCorrespondence).values({ edgeKey: 'candidate-119', type: 'event_process', role: 'award', eventId: unconfirmed.events[0]!.id, enterpriseId: unconfirmed.enterprise.id, titleCode, status: 'candidate', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'synthetic-119', ruleId: 'manual', ruleVersion: '1', createdAt: new Date().toISOString() }).returning().get()
  const { wb, job } = await workbook('119-platform-boundary')
  expect(rows(wb, '有效企业').map(row => row[2])).toEqual(['查询failed', '查询no_record', '更新退回', '更新待审核', '更新待审决定', '撤回旧外迁'])
  expect(rows(wb, '待确认').map(row => row[2])).toEqual(['补码后旧按名证据', '仅平台通过', '候选对应非资格'])
  expect(job.result.counts).toEqual({ eligible: 6, pending: 3, excluded: 0 })
  expect(rows(wb, '待确认')[0]![11]).toContain('重新核实')
  expect(rows(wb, '待确认')[1]![11]).toContain('缺少已确认认定及资格依据')
  expect(rows(wb, '待确认')[2]![11]).toContain('对应边不是已确认当前资格')
  expect(staleDecision.id).toBeGreaterThan(0); expect(relation.id).toBeGreaterThan(0); expect(edge.id).toBeGreaterThan(0)
})

it('创新型超页全量文本安全与业务只读', async () => {
  const fixtures = db.transaction(() => Array.from({ length: 251 }, (_, index) => candidate('超页合成' + index)))
  const textNames = ['=HYPERLINK("https://invalid.example","合成")', '+SUM(1,2)', '-1+2', '@SUM(1,2)', '长名称😀' + '宁波'.repeat(80)]
  for (const [index, name] of textNames.entries()) {
    const c = candidate(name)
    db.update(s.enterprise).set({ usccNorm: `00123456789012345${index}` }).where(eq(s.enterprise.id, c.enterprise.id)).run()
  }
  const sourceDigest = () => {
    const hash = createHash('sha256')
    for (const table of ['enterprise', 'record', 'record_event', 'record_evidence', 'enterprise_alias', 'platform_query', 'platform_relation', 'difference_reason', 'record_correspondence']) {
      for (const row of db.$client.prepare(`select * from ${table} order by id`).iterate()) hash.update(JSON.stringify(row))
    }
    return hash.digest('hex')
  }
  const before = sourceDigest()
  const { wb, job } = await workbook('119-pages-text')
  expect(job.result.counts).toEqual({ eligible: 256, pending: 0, excluded: 0 })
  expect(job.result.total).toBe(256)
  expect(rows(wb, '有效企业').slice(0, 251).map(row => businessIdentity(row))).toEqual(fixtures.map(c => expectedBusinessIdentity(db,c.enterprise.id)))
  const ws = wb.getWorksheet('有效企业')!
  for (const [index, name] of textNames.entries()) {
    const row = ws.getRow(253 + index)
    expect(row.getCell(2).value).toBe(name)
    expect(row.getCell(2).type).toBe(ExcelJS.ValueType.String)
    expect(row.getCell(3).value).toBe(`00123456789012345${index}`)
    expect(row.getCell(3).type).toBe(ExcelJS.ValueType.String)
  }
  expect(sourceDigest()).toBe(before)
})

it('创新型空集保留四表表头与真实零计数', async () => {
  candidate('其他称号不污染空集', [award], 'specialized_sme')
  const { wb, job } = await workbook('119-empty')
  expect(job.result.counts).toEqual({ eligible: 0, pending: 0, excluded: 0 })
  expect(job.result.total).toBe(0)
  expect(job.progress).toEqual({ done: 0, total: 0 })
  expect(job.percent).toBe(100)
  for (const name of ['有效企业', '待确认', '排除明细']) {
    const ws = wb.getWorksheet(name)!
    expect(ws.rowCount).toBe(1)
    expect(ws.getRow(1).values).toEqual([undefined, '序号', '企业名称', '统一社会信用代码', '区县', '称号', '首次认定年份', '认定及复核情况', '公布名称', '已确认曾用名', '公布对应情况', '情况说明', '来源及页码'])
  }
})

it('创新型入口鉴权参数边界与OpenAPI可发现', async () => {
  const specResponse = await fetch(url('/_openapi.json'))
  expect(specResponse.status).toBe(200)
  const spec = await json(specResponse)
  const operation = spec.paths[endpoint].post
  expect(operation.security).toEqual([{ bearerAuth: [] }])
  expect(operation.requestBody.content['application/json'].schema.additionalProperties).toBe(false)
  expect(operation.responses['202']).toBeDefined()
  expect(spec.paths['/api/jobs'].post.requestBody.content['application/json'].schema.properties.kind.enum).toContain('current-roster-export')
  expect(spec.paths['/api/job-artifacts/{id}'].get.security).toEqual([{ bearerAuth: [] }])
  for (const body of [{}, [], null, { clientRequestId: '' }, { clientRequestId: ' ' }, { clientRequestId: 'x'.repeat(129) }, { clientRequestId: '119-invalid', titleCode }, { clientRequestId: '119-invalid', asOf: '2020-01-01' }, { clientRequestId: '119-invalid', unknown: true }]) {
    expect((await fetch(url(endpoint), { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400)
  }
  for (const queryString of ['?asOf=2020-01-01', '?titleCode=little_giant', '?unknown=1']) expect((await fetch(url(endpoint + queryString), { method: 'POST', headers, body: JSON.stringify({ clientRequestId: '119-invalid-query' }) })).status).toBe(400)
  expect((await fetch(url(endpoint), { method: 'POST', headers, body: '{broken' })).status).toBe(400)
  for (const authorization of ['', 'Bearer wrong']) expect((await fetch(url(endpoint), { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify({ clientRequestId: '119-no-auth' }) })).status).toBe(401)
  const { job, bytes } = await workbook('b'.repeat(128))
  for (const authorization of ['', 'Bearer wrong']) expect((await fetch(url(job.result.artifact.downloadUrl), { headers: { authorization } })).status).toBe(401)
  const alternate = await fetch(url(job.result.artifact.downloadUrl), { headers: { 'x-api-token': token } })
  expect(alternate.status).toBe(200)
  expect(Buffer.from(await alternate.arrayBuffer())).toEqual(bytes)
  expect((await fetch(url('/api/job-artifacts/not-a-disk-path'), { headers })).status).toBe(400)
  expect((await fetch(url('/api/job-artifacts/%2Ftmp%2Fsynthetic.xlsx'), { headers })).status).toBe(400)
  expect(JSON.stringify(job)).not.toContain(dir)
})

it('创新型持久去重与显式重生成读取新决定', async () => {
  const c = candidate('重生成新决定')
  const first = await workbook('119-dedup')
  const responses = await Promise.all([submit('119-dedup'), submit('119-dedup')])
  for (const response of responses) {
    expect(response.status).toBe(202)
    expect((await json(response)).jobId).toBe(first.job.id)
  }
  const listed = await json(await fetch(url('/api/jobs?kind=current-roster-export')))
  expect(listed.rows.filter((job: any) => job.params.clientRequestId === '119-dedup')).toHaveLength(1)
  const changed = await fetch(url('/api/roster/decision-lifecycle/commands'), {
    method: 'POST', headers, body: JSON.stringify({ enterpriseId: c.enterprise.id, titleCode, direction: 'extra_in_miit', action: 'replace', expectedCurrentId: null, idempotencyKey: '119-change-current', actor: { type: 'agent', id: 'test' }, basis: '隔离SQLite合成外迁事实', ruleVersion: 'manual-v1', effectiveAt: '2026-01-01T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'moved_out', verificationStatus: 'confirmed', measureCode: 'mark_moved_out' } }),
  })
  expect(changed.status).toBe(200)
  const version=await changed.json()
  reviewCurrentExportDecision(db,db.select().from(s.differenceReason).where(eq(s.differenceReason.id,version.versionId)).get()!)
  const regenerated = await workbook('119-regenerated', { regenerateOf: first.job.id })
  expect(regenerated.job.id).not.toBe(first.job.id)
  expect(regenerated.job.params.regenerateOf).toBe(first.job.id)
  expect(regenerated.job.result.counts).toEqual({ eligible: 0, pending: 0, excluded: 1 })
  expect(businessIdentity(rows(regenerated.wb, '排除明细')[0]!)).toEqual(expectedBusinessIdentity(db,c.enterprise.id))
  expect(regenerated.job.result.dataVersion).not.toBe(first.job.result.dataVersion)
  expect((await download(first.job)).bytes).toEqual(first.bytes)
  expect((await submit('119-regenerated', { regenerateOf: regenerated.job.id })).status).toBe(409)
  const other = await fetch(url('/api/roster/exports/current/little-giant'), { method: 'POST', headers, body: JSON.stringify({ clientRequestId: '119-foreign-parent' }) })
  expect(other.status).toBe(202)
  const foreign = await terminal((await json(other)).jobId)
  expect((await submit('119-invalid-parent', { regenerateOf: foreign.id })).status).toBe(409)
})

it('创新型产物过期缺失保留成功历史并可重生成', async () => {
  candidate('产物状态合成企业')
  const expired = await workbook('119-expired')
  db.update(s.job).set({ result: { ...expired.job.result, artifact: { ...expired.job.result.artifact, expiresAt: '2000-01-01T00:00:00Z' } } }).where(eq(s.job.id, expired.job.id)).run()
  const expiredRead = await json(await fetch(url('/api/jobs/' + expired.job.id)))
  expect(expiredRead.state).toBe('done')
  expect(expiredRead.result.artifact.availability).toBe('expired')
  expect((await fetch(url(expired.job.result.artifact.downloadUrl), { headers })).status).toBe(410)
  expect(existsSync(join(dbPath + '.exports', expired.job.id + '.xlsx'))).toBe(false)
  const missing = await workbook('119-missing')
  rmSync(join(dbPath + '.exports', missing.job.id + '.xlsx'))
  const missingRead = await json(await fetch(url('/api/jobs/' + missing.job.id)))
  expect(missingRead.state).toBe('done')
  expect(missingRead.result.artifact.availability).toBe('missing')
  expect((await fetch(url(missing.job.result.artifact.downloadUrl), { headers })).status).toBe(404)
  const regenerated = await workbook('119-missing-regenerated', { regenerateOf: missing.job.id })
  expect(regenerated.job.id).not.toBe(missing.job.id)
  expect(regenerated.job.params.regenerateOf).toBe(missing.job.id)
  expect(regenerated.job.result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
})

it('创新型失败无半成品并支持修正后重生成', async () => {
  const c = candidate('超长单元格')
  db.update(s.enterprise).set({ name: '超'.repeat(33000) }).where(eq(s.enterprise.id, c.enterprise.id)).run()
  const response = await submit('119-failure')
  expect(response.status).toBe(202)
  const job = await terminal((await json(response)).jobId)
  expect(job.state).toBe('failed')
  expect(job.error).toContain('Excel')
  expect(job.result.ruleVersion).toBe('current-roster-116-v8')
  expect(job.result.artifact).toBeUndefined()
  expect((await fetch(url('/api/job-artifacts/' + job.id), { headers })).status).toBe(404)
  for (const extension of ['.part', '.xlsx']) expect(existsSync(join(dbPath + '.exports', job.id + extension))).toBe(false)
  db.update(s.enterprise).set({ name: '超长单元格' }).where(eq(s.enterprise.id, c.enterprise.id)).run()
  const retry = await workbook('119-failure-regenerated', { regenerateOf: job.id })
  expect(retry.job.params.regenerateOf).toBe(job.id)
  expect(retry.job.result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  expect((await download(retry.job)).bytes).toEqual(retry.bytes)
})
