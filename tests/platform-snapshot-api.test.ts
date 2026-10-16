/**
 * RL-05 —— 平台导出快照**读接口**(契约 §7.7 与版本比较)。
 *
 * 缝(HTTP):
 *   - `GET /api/platform/snapshots?title=&year=` —— 快照批次与版本(§7.7 的响应行);
 *   - `GET /api/platform/snapshots/diff?from=&to=` —— 两个快照的新增/消失/字段变化(追溯源行号)。
 *
 * 分两层测:
 *   1. **HTTP 核心**(`server/utils/platform-snapshots-http.ts`,不 import h3)——
 *      状态码与响应体的全部判据;这也正是真实 HTTP 回放测试打的同一份实现;
 *   2. **Nitro 路由**——只是薄薄地转调核心,这里用 `vi.stubGlobal` 补 h3 的编译期宏与
 *      自动导入(裸 node 下没有),断言它转调到位、状态码写进响应。
 *
 * 库是临时库、夹具直接落库(测试夹具例外条款)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handlePlatformSnapshotRequest } from '../server/utils/platform-snapshots-http'

const dir = mkdtempSync(join(tmpdir(), 'spztx-snapshot-api-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const { schema, useDb } = await import('../db')
const db = useDb({ dbPath: join(dir, 'api.db') })

// --- 夹具:一个称号两版(第二版替换第一版)+ 另一个称号一版 ---------------------

const OLD = db
  .insert(schema.platformExportBatch)
  .values({
    titleCode: 'specialized_sme',
    year: 2026,
    collectedOn: '2026-10-14',
    originalFilename: '专精特新中小企业导出Excel-旧.xlsx',
    sha256: '1'.repeat(64),
    rowCount: 3,
    importStatus: 'imported',
  })
  .returning({ id: schema.platformExportBatch.id })
  .get().id

const NEW = db
  .insert(schema.platformExportBatch)
  .values({
    titleCode: 'specialized_sme',
    year: 2026,
    collectedOn: '2026-10-15',
    originalFilename: '专精特新中小企业导出Excel.xlsx',
    sha256: '2'.repeat(64),
    rowCount: 3,
    importStatus: 'imported',
    replacedBatchId: OLD,
  })
  .returning({ id: schema.platformExportBatch.id })
  .get().id

const OTHER = db
  .insert(schema.platformExportBatch)
  .values({
    titleCode: 'innovative_sme',
    year: 2026,
    collectedOn: '2026-10-15',
    originalFilename: '创新型中小企业导出Excel.xlsx',
    sha256: '3'.repeat(64),
    rowCount: 1,
    importStatus: 'imported',
  })
  .returning({ id: schema.platformExportBatch.id })
  .get().id

const rowsOf = (batchId: number, rows: Array<Record<string, unknown> & { sourceRowNo: number }>) => {
  for (const r of rows) {
    db.insert(schema.platformExportRow)
      .values({ batchId, usccRaw: null, nameRaw: null, province: '浙江省', city: '宁波市', ...r })
      .run()
  }
}
rowsOf(OLD, [
  { sourceRowNo: 3, usccRaw: 'CODE1', nameRaw: '甲公司', district: '鄞州区', regStatus: '待审核' },
  { sourceRowNo: 4, usccRaw: 'CODE2', nameRaw: '乙公司', district: '海曙区', regStatus: '待审核' },
  { sourceRowNo: 5, usccRaw: 'CODE3', nameRaw: '丙公司', district: '江北区', regStatus: '待审核' },
])
rowsOf(NEW, [
  { sourceRowNo: 3, usccRaw: 'CODE1', nameRaw: '甲公司', district: '鄞州区', regStatus: '待审核' },
  { sourceRowNo: 4, usccRaw: 'CODE2', nameRaw: '乙公司(改名)', district: '北仑区', regStatus: '终审通过' },
  { sourceRowNo: 6, usccRaw: 'CODE4', nameRaw: '丁公司', district: '镇海区', regStatus: '待审核' },
])
rowsOf(OTHER, [{ sourceRowNo: 3, usccRaw: 'CODE9', nameRaw: '戊公司', district: '象山县', regStatus: '待审核' }])

interface SnapshotBody {
  rows?: Array<Record<string, unknown>>
  count?: number
  diff?: {
    added: Array<{ usccRaw: string; sourceRowNo: number }>
    removed: Array<{ usccRaw: string; sourceRowNo: number }>
    changed: Array<{ usccRaw: string; fromSourceRowNo: number; toSourceRowNo: number; fields: unknown[] }>
    unchanged: number
  }
  from?: Record<string, unknown>
  to?: Record<string, unknown>
  message?: string
}

const list = (query: Record<string, unknown> = {}) =>
  handlePlatformSnapshotRequest('snapshots', { method: 'GET', query }, { db }) as { status: number; body: SnapshotBody }
const compare = (query: Record<string, unknown>) =>
  handlePlatformSnapshotRequest('diff', { method: 'GET', query }, { db }) as { status: number; body: SnapshotBody }

// ---------------------------------------------------------------------------

describe('GET /api/platform/snapshots —— 快照与版本(契约 §7.7)', () => {
  it('列出某称号某年度的两版,新版本标出它替换了谁;旧版本仍在', () => {
    const out = list({ title: 'specialized_sme', year: '2026' })
    expect(out.status).toBe(200)
    const ids = out.body.rows!.map((r) => (r.batch as { id: number }).id)
    expect(ids).toEqual([OLD, NEW])
    expect(out.body.count).toBe(2)
    const newer = out.body.rows!.find((r) => (r.batch as { id: number }).id === NEW)!
    expect(newer.replacedBatchId).toBe(OLD)
    expect((newer.batch as { originalFilename: string }).originalFilename).toBe('专精特新中小企业导出Excel.xlsx')
    // 采集时间、导入状态、记录数量都能看到(票面验收第 2 条)。
    expect(newer).toMatchObject({ rowCount: 3, importStatus: 'imported' })
    expect((newer.batch as { collectedOn: string }).collectedOn).toBe('2026-10-15')
  })

  it('多值参数(逗号分隔 / 重复传)与「不筛」', () => {
    expect(list().body.count).toBe(3)
    expect(list({ title: 'specialized_sme,innovative_sme' }).body.count).toBe(3)
    // 重复参数(数组)也认 —— 与 h3 的 getQuery 口径一致。
    expect(list({ title: ['specialized_sme', 'innovative_sme'] }).body.count).toBe(3)
    expect(list({ year: '2025' }).body.count).toBe(0)
  })

  it('年度参数不是数字 ⇒ 400,不静默当 0 年', () => {
    const out = list({ year: 'abc' })
    expect(out.status).toBe(400)
    expect(out.body.message).toContain('正整数')
  })

  it('非 GET ⇒ 405(读面只读)', () => {
    const out = handlePlatformSnapshotRequest('snapshots', { method: 'POST', query: {} }, { db }) as { status: number }
    expect(out.status).toBe(405)
  })
})

describe('GET /api/platform/snapshots/diff —— 两版差异可追到原始行', () => {
  it('新增 / 消失 / 字段变化,都带源行号;两版身份一并返回', () => {
    const out = compare({ from: String(OLD), to: String(NEW) })
    expect(out.status).toBe(200)
    expect((out.body.from as { id: number }).id).toBe(OLD)
    expect((out.body.to as { id: number }).id).toBe(NEW)

    const d = out.body.diff!
    expect(d.added).toEqual([expect.objectContaining({ usccRaw: 'CODE4', sourceRowNo: 6 })])
    expect(d.removed).toEqual([expect.objectContaining({ usccRaw: 'CODE3', sourceRowNo: 5 })])
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0]).toMatchObject({ usccRaw: 'CODE2', fromSourceRowNo: 4, toSourceRowNo: 4 })
    expect(d.changed[0]!.fields).toEqual([
      { field: 'name', from: '乙公司', to: '乙公司(改名)' },
      { field: 'district', from: '海曙区', to: '北仑区' },
      { field: 'regStatus', from: '待审核', to: '终审通过' },
    ])
    expect(d.unchanged).toBe(1)
  })

  it('缺 from / to ⇒ 400;批号不是数字 ⇒ 400', () => {
    for (const query of [{}, { from: String(OLD) }, { to: String(NEW) }, { from: 'x', to: String(NEW) }]) {
      expect(compare(query).status).toBe(400)
    }
  })

  it('批号不存在 ⇒ 404(不是空差异)', () => {
    const out = compare({ from: '999999', to: String(NEW) })
    expect(out.status).toBe(404)
    expect(out.body.message).toContain('不存在')
  })

  it('跨称号比较被挡下(拿中小表比创新型表只会全是增删,没有意义)⇒ 400', () => {
    const out = compare({ from: String(OLD), to: String(OTHER) })
    expect(out.status).toBe(400)
    expect(out.body.message).toContain('称号不同')
  })
})

describe('Nitro 路由只是薄薄地转调 HTTP 核心', () => {
  let status: number | undefined
  let snapshots: (event: unknown) => unknown
  let diff: (event: unknown) => unknown
  let query: Record<string, unknown> = {}

  beforeAll(async () => {
    vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
    vi.stubGlobal('getQuery', () => query)
    vi.stubGlobal('getMethod', () => 'GET')
    vi.stubGlobal('setResponseStatus', (_event: unknown, code: number) => {
      status = code
    })
    vi.stubGlobal('setHeader', () => undefined)
    vi.doMock('@db', () => ({ useDb: () => db }))
    snapshots = (await import('../server/api/platform/snapshots.get')).default as typeof snapshots
    diff = (await import('../server/api/platform/snapshots/diff.get')).default as typeof diff
  })

  beforeEach(() => {
    status = undefined
    query = {}
  })

  it('snapshots 路由:同样的查询得到同样的响应体,状态码写进响应', () => {
    query = { title: 'specialized_sme' }
    const body = snapshots({}) as SnapshotBody
    expect(body.count).toBe(2)
    expect(status).toBe(200)
  })

  it('diff 路由:缺参时状态码是 400', () => {
    query = {}
    diff({})
    expect(status).toBe(400)
  })

  it('两条路由都带顶层 defineRouteMeta(spec 的唯一输入)', async () => {
    const { readFile } = await import('node:fs/promises')
    const routes = ['../server/api/platform/snapshots.get.ts', '../server/api/platform/snapshots/diff.get.ts']
    for (const rel of routes) {
      const source = await readFile(new URL(rel, import.meta.url), 'utf8')
      expect(source, rel).toContain('defineRouteMeta({')
      // nitro 的 handlers-meta 只认顶层 ExpressionStatement。
      expect(/^defineRouteMeta\(/m.test(source), rel).toBe(true)
    }
  })
})
