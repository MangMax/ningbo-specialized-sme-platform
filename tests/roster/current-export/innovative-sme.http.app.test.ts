import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { CURRENT_RULE_VERSION } from '../../../layers/sme-roster/lib/roster/current-qualification-model'
import { readDevelopmentDiscovery, businessIdentity, expectedBusinessIdentity } from './fixtures/specialized-export'
import { confirmCurrentExportExclusion } from '../fixtures/qualification-decisions'
import { createHash } from 'node:crypto'

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as s from '../fixtures/postgres-tables'
import { nativeAppAdapter } from '../../support/native-app'

// Only synthetic fixtures are written here. Assertions use real HTTP and XLSX bytes.
const dir = mkdtempSync(join(tmpdir(), 'export-119-'))
vi.setConfig({ testTimeout: 60_000 })
const titleCode = 'innovative_sme'
const endpoint = '/api/roster/exports/current/innovative-sme'
const token = 'synthetic-export-119-token'
const app = nativeAppAdapter({ dir, token })
let db: typeof app.db
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
const year = new Date().getFullYear()
let starting: Promise<void> | undefined
const url = app.url
const json = (response: Response): Promise<any> => response.json()
const submit = async (clientRequestId: string, extra = {}) => {
  await startService()
  return fetch(url(endpoint), { method: 'POST', headers, body: JSON.stringify({ clientRequestId, ...extra }) })
}

type Event = Pick<typeof s.recordEvent.$inferInsert, 'eventType' | 'year' | 'decidedYear' | 'reviewOutcome' | 'batchSeq'>
const award: Event = { eventType: 'award', year, batchSeq: 1 }
async function record(enterpriseId: number, name: string, events: Event[] = [award], title = titleCode) {
  const row = (await db.insert(s.record).values({ enterpriseId, titleCode: title, source: 'jxj', nameRaw: name }).returning())[0]!
  const eventRows = []
  for (const event of events) {
    const rowEvent = (await db.insert(s.recordEvent).values({ recordId: row.id, ...event }).returning())[0]!
    await db.insert(s.recordEvidence).values({ recordEventId: rowEvent.id, sourceFile: `jxj/announcement/${title}-synthetic.xlsx`, attachment: '合成名单', listNo: rowEvent.id })
    eventRows.push(rowEvent)
  }
  return { record: row, events: eventRows }
}
async function candidate(name: string, events: Event[] = [award], title = titleCode) {
  const enterprise = (await db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: `TEST-119-${name}`, district: '鄞州区', city: '宁波市' }).returning())[0]!
  return { enterprise, ...await record(enterprise.id, name, events, title) }
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
  expect(wb.worksheets.map(sheet => sheet.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
  const explanation = Object.fromEntries(rows(wb, '口径说明').map(row => [row[1], row[2]]))
  for (const [sheet, key] of [['有效企业', 'effective'], ['已到期', 'expired'], ['已注销（吊销）', 'terminated'], ['已迁出', 'moved_out'], ['未认定', 'unrecognized']] as const) {
    expect(rows(wb, sheet)).toHaveLength(job.result.statusCounts[key])
    expect(explanation[sheet]).toBe(String(job.result.statusCounts[key]))
  }
  expect(explanation['规则版本']).toBeUndefined()
  expect(explanation['数据版本']).toBeUndefined()
  expect(job.result.ruleVersion).toBe(CURRENT_RULE_VERSION)
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
function startService() { return starting ??= app.start() }
let discovery: any
beforeAll(async () => { discovery = await readDevelopmentDiscovery() }, 90000)
beforeEach(async () => {
  await starting?.catch(() => {})
  await app.resetBusiness()
  await app.prepare()
  db = app.db
  starting = undefined
}, 90_000)


afterAll(async () => {
  try { await starting?.catch(() => {}); await app.close() }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('创新型专用入口交付六表与共享任务产物', async () => {
  const fresh = await candidate('创新型新认定')
  const { wb, job } = await workbook('119-fresh')
  expect(job.result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  expect(rows(wb, '有效企业').map(row => [...businessIdentity(row),row[5]])).toEqual([[...await expectedBusinessIdentity(db,fresh.enterprise.id), '创新型中小企业']])
  expect(rows(wb, '有效企业')[0]![12]).toContain('innovative_sme-synthetic.xlsx')
  expect(job.result.dataVersion).toMatch(/^sha256:[a-f0-9]{64}$/)
})

async function decision(enterpriseId: number, reasonCode: 'moved_out' | 'moved_in' | 'deregistered' | 'pending_review' | 'other', extra = {}) {
  const decision = (await db.insert(s.differenceReason).values({ enterpriseId, titleCode, direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode, verificationStatus: 'confirmed', lifecycleAction: 'replace', basis: '合成已确认主体事实', effectiveAt: '2025-01-01T00:00:00Z', recordedAt: new Date().toISOString(), createdAt: new Date().toISOString(), retiredEvidenceValidity: 'valid', retiredEvidenceReviewed: true, ...extra }).returning())[0]!
  return decision
}

it('创新型按稳定主体去重且多称号分别保留', async () => {
  const twins = [await candidate('同名主体甲'), await candidate('同名主体乙')]
  for (const twin of twins) {
    await db.update(s.enterprise).set({ name: '同名企业', nameNorm: '同名企业' }).where(eq(s.enterprise.id, twin.enterprise.id))
    await db.update(s.record).set({ nameRaw: '同名企业' }).where(eq(s.record.id, twin.record.id))
  }
  const multiple = await candidate('多称号企业', [{ eventType: 'award', year: year - 5 }, award])
  await record(multiple.enterprise.id, '多称号企业', [award], 'little_giant')
  await record(multiple.enterprise.id, '多称号企业', [award], 'specialized_sme')
  const giant = await candidate('只有小巨人', [award], 'little_giant')
  const province = await candidate('只有专精特新', [award], 'specialized_sme')
  const noOwnAward = await candidate('不得借用其他称号公布', [])
  await record(noOwnAward.enterprise.id, '不得借用其他称号公布', [award], 'little_giant')
  const { wb, job } = await workbook('119-isolation')
  // Original facts: three own awards, two upper-only identities and one empty-own + giant.
  // #738 removes the lower-history gate; overlapping titles still count once.
  expect(rows(wb, '有效企业').map(businessIdentity)).toEqual([
    ['同名企业', 'TEST-119-同名主体甲'], ['同名企业', 'TEST-119-同名主体乙'],
    ['多称号企业', 'TEST-119-多称号企业'], ['只有小巨人', 'TEST-119-只有小巨人'],
    ['只有专精特新', 'TEST-119-只有专精特新'], ['不得借用其他称号公布', 'TEST-119-不得借用其他称号公布'],
  ])
  expect(job.result.counts).toEqual({ eligible: 6, pending: 0, excluded: 0 })
  for (const sheet of ['已到期', '已注销（吊销）', '已迁出', '未认定']) expect(rows(wb, sheet)).toEqual([])
  expect(rows(wb, '有效企业').filter(row => row[2] === '同名企业')).toHaveLength(2)
  expect(rows(wb, '有效企业').filter(row => row[2] === multiple.enterprise.name && row[3] === multiple.enterprise.usccNorm)).toHaveLength(1)
  for (const [name, source] of [['多称号企业', 'innovative_sme'], ['只有小巨人', 'little_giant'], ['只有专精特新', 'specialized_sme'], ['不得借用其他称号公布', 'little_giant']]) {
    const row = rows(wb, '有效企业').find(row => row[2] === name)!
    expect(row[5]).toBe('创新型中小企业')
    expect(source === 'innovative_sme' ? row[12] : row[15]).toContain(source + '-synthetic.xlsx')
    if (source !== 'innovative_sme') expect(row[12] ?? null).toBeNull()
    if (source !== 'innovative_sme') expect(row[6] ?? null).toBeNull()
  }
  const generic = (title: string, key: string) => fetch(url('/api/jobs'), { method: 'POST', headers, body: JSON.stringify({ kind: 'current-roster-export', params: { titleCode: title, clientRequestId: key } }) })
  const replay = await generic(titleCode, '119-isolation')
  expect(replay.status).toBe(202)
  expect((await json(replay)).jobId).toBe(job.id)
  expect((await generic('little_giant', '119-isolation')).status).toBe(409)
  for (const [title, path, expectedIds] of [
    ['little_giant', '/api/roster/exports/current/little-giant', [multiple.enterprise.id, giant.enterprise.id, noOwnAward.enterprise.id]],
    ['specialized_sme', '/api/jobs', [multiple.enterprise.id, giant.enterprise.id, province.enterprise.id, noOwnAward.enterprise.id]],
  ] as const) {
    const response = path === '/api/jobs' ? await generic(title, '119-cross-' + title) : await fetch(url(path), { method: 'POST', headers, body: JSON.stringify({ clientRequestId: '119-cross-' + title }) })
    expect(response.status).toBe(202)
    const crossJob = await terminal((await json(response)).jobId)
    expect(crossJob.state).toBe('done'); expect(crossJob.kind).toBe(job.kind)
    const cross = await download(crossJob)
    for (const id of expectedIds) expect(rows(cross.wb, '有效企业').map(businessIdentity)).toContainEqual(await expectedBusinessIdentity(db, id))
    expect(rows(cross.wb, '有效企业').filter(row => row[2] === multiple.enterprise.name && row[3] === multiple.enterprise.usccNorm)).toHaveLength(1)
  }
})

// Native source facts live in this case's independent database generation.
async function query(enterprise: typeof s.enterprise.$inferSelect, status: 'success' | 'failed' | 'no_record', key = enterprise.usccNorm!, rowStatus?: string) {
  const native = await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: key, rdjb: '1', titleCode, queriedAt: new Date().toISOString(), status, rawResponse: JSON.stringify({ status, rowStatus: rowStatus ?? null }), relations: rowStatus == null ? [] : [{ sequenceNo: 1, enterpriseId: enterprise.id, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, status: rowStatus, declareKind: 'update', verificationStatus: 'confirmed', matchBasis: 'uscc' }] })
  return { id: native.queryId, relationIds: native.relationIds }
}

it('创新型空集保留六表表头与真实零计数', async () => {
  // A true empty database: a valid province would inherit and is covered above.
  const { wb, job } = await workbook('119-empty')
  expect(job.result.counts).toEqual({ eligible: 0, pending: 0, excluded: 0 })
  expect(job.result.total).toBe(0)
  expect(job.progress).toEqual({ done: 0, total: 0 })
  expect(job.percent).toBe(100)
  for (const name of ['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定']) {
    const ws = wb.getWorksheet(name)!
    expect(ws.rowCount).toBe(1)
    expect(ws.getRow(1).values).toEqual([undefined, '序号', '企业名称', '统一社会信用代码', '区县', '称号', '首次认定年份', '认定及复核情况', '公布名称', '已确认曾用名', '公布对应情况', '情况说明', '来源及页码', '有效状态', '有效期及排除依据', '资料缺口与来源备注'])
  }
})

it('创新型入口鉴权参数边界与OpenAPI可发现', async () => {
  await startService()
  const spec = discovery
  const operation = spec.paths[endpoint].post
  expect(operation.security).toEqual([{ bearerAuth: [] }])
  expect(operation.requestBody.content['application/json'].schema.additionalProperties).toBe(false)
  expect(operation.responses['202']).toBeDefined()
  expect(spec.paths['/api/jobs/kinds'].get.responses['200']).toBeDefined()
  const kinds = await fetch(url('/api/jobs/kinds'))
  expect(kinds.status).toBe(200)
  expect((await kinds.json()).kinds).toContainEqual(expect.objectContaining({ kind: 'current-roster-export', status: 'ready' }))
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

it('上级继承仍受主体与事实时点边界约束并优先自身期间', async () => {
  const own = await candidate('自身期间优先', [{ eventType: 'award', year: year - 1, batchSeq: 1 }])
  await record(own.enterprise.id, own.enterprise.name, [award], 'little_giant')
  await candidate('未来上级不提前有效', [{ eventType: 'award', year: year + 1, batchSeq: 1 }], 'little_giant')
  await candidate('旧上级不按年龄到期', [{ eventType: 'award', year: year - 5, batchSeq: 1 }], 'little_giant')
  const expired = await candidate('正式期间到期上级不带入', [{ eventType: 'award', year: year - 5, batchSeq: 1 }], 'little_giant')
  // Same award age, different source fact: only the explicit formal interval expires.
  // Bind the period to this event's evidence and source version, without a review fiction.
  const evidence = (await db.select().from(s.recordEvidence).where(eq(s.recordEvidence.recordEventId, expired.events[0]!.id)))[0]!
  const sourceBytes = Buffer.from(`合成小巨人正式有效期：${year - 5}-01-01 至 ${year - 2}-12-31（含首尾）`)
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
  await db.insert(s.storedFile).values({ relPath: evidence.sourceFile, filename: 'little_giant-synthetic.xlsx', createdAt: '2026-01-01T00:00:00Z', ext: 'xlsx', bytes: BigInt(sourceBytes.length), sha256: sourceSha256 })
  await db.update(s.recordEvent).set({ formalValidity: JSON.stringify({
    evidenceId: evidence.id, sourceSha256, statementPages: [1],
    interval: { validFrom: `${year - 5}-01-01`, validThrough: `${year - 2}-12-31` },
  }) }).where(eq(s.recordEvent.id, expired.events[0]!.id))
  for (const [name, kind] of [['注销上级不带入', 'cancelled'], ['迁出上级不带入', 'moved_out']] as const) {
    const c = await candidate(name, [award], 'little_giant')
    await db.insert(s.enterpriseFactRevision).values({ enterpriseId: c.enterprise.id, factId: 1, revision: 1, status: 'confirmed', fact: JSON.stringify({ kind, source: { reference: 'synthetic-official', statement: 'verified' }, effective: { precision: 'day', value: '2025-01-01' }, observed: { precision: 'day', value: '2025-01-01' }, city: null }), action: 'assert', actor: JSON.stringify({ type: 'agent', id: 'synthetic' }), basis: 'verified', createdAt: '2025-01-01T00:00:00Z' })
  }
  const expected: Record<string, string[]> = {
    effective: ['自身期间优先', '旧上级不按年龄到期'], expired: [], terminated: ['注销上级不带入'],
    moved_out: ['迁出上级不带入'], unrecognized: ['未来上级不提前有效', '正式期间到期上级不带入'],
  }
  const { wb, job } = await workbook('119-boundaries')
  // Six identities: own + retained giant; future + formal-expired + cancelled + moved-out.
  // An expired upper title does not create an innovative award or its expired history.
  expect(job.result.counts).toEqual({ eligible: 2, pending: 0, excluded: 4 })
  expect(job.result.total).toBe(6)
  for (const [state, sheet] of [['effective','有效企业'], ['expired','已到期'], ['terminated','已注销（吊销）'], ['moved_out','已迁出'], ['unrecognized','未认定']]) {
    const response = await fetch(url(`/api/roster/current-enterprises?titleCode=innovative_sme&status=${state}`))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.total).toBe(expected[state!]!.length)
    expect(body.rows.map((r: any) => [r.name, r.uscc]).sort()).toEqual(expected[state!]!.map(name => [name, 'TEST-119-' + name]).sort())
    expect(rows(wb, sheet!).map(businessIdentity).sort()).toEqual(expected[state!]!.map(name => [name, 'TEST-119-' + name]).sort())
  }
  const row = rows(wb, '有效企业').find(row => row[2] === '自身期间优先')!
  expect(row[6]).toBe(String(year - 1))
  expect(row[12]).toContain('innovative_sme-synthetic.xlsx')
  expect(row[14]).toContain(`${year - 1} 年 + 3 = ${year + 2} 年`)
  const inherited = rows(wb, '有效企业').find(row => row[2] === '旧上级不按年龄到期')!
  expect(inherited[5]).toBe('创新型中小企业')
  expect(inherited[6] ?? null).toBeNull()
  expect(inherited[12] ?? null).toBeNull()
  expect(inherited[15]).toContain('little_giant-synthetic.xlsx')
})
