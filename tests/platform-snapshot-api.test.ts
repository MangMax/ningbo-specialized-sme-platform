/**
 * RL-05 —— 平台导出快照的**读接口**(契约 §7.7 与版本比较)。
 *
 * 缝(HTTP):
 *   - `GET /api/platform/snapshots?title=&year=` —— 快照批次与版本(§7.7 的响应行);
 *   - `GET /api/platform/snapshots/diff?from=&to=` —— 两个快照的新增/消失/字段变化(追溯源行号)。
 *
 * 测试缝 = 路由 handler 本身(h3 的编译期宏/自动导入在裸 node 下用 `vi.stubGlobal` 补),
 * 与 `tests/curation.test.ts` 同一套做法。库是临时库、夹具直接落库(测试夹具例外条款)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

// --- handler 加载(h3 宏 / 自动导入垫片) ---------------------------------------

let query: Record<string, unknown> = {}
let snapshots: (event: unknown) => unknown
let diff: (event: unknown) => unknown

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('createError', (opts: Record<string, unknown>) =>
    Object.assign(new Error(String(opts.message ?? opts.statusMessage ?? 'error')), opts),
  )
  vi.doMock('@db', () => ({ useDb: () => db }))
  snapshots = (await import('../server/api/platform/snapshots.get')).default as typeof snapshots
  diff = (await import('../server/api/platform/snapshots/diff.get')).default as typeof diff
})

beforeEach(() => {
  query = {}
})

const call = (handler: (event: unknown) => unknown, q: Record<string, unknown>) => {
  query = q
  return handler({}) as {
    rows?: Array<Record<string, unknown>>
    count?: number
    diff?: Record<string, unknown>
    from?: Record<string, unknown>
    to?: Record<string, unknown>
  }
}

// ---------------------------------------------------------------------------

describe('GET /api/platform/snapshots —— 快照与版本(契约 §7.7)', () => {
  it('列出某称号某年度的两版,新版本标出它替换了谁;旧版本仍在', () => {
    const body = call(snapshots, { title: 'specialized_sme', year: '2026' })
    const ids = body.rows!.map((r) => (r.batch as { id: number }).id)
    expect(ids).toEqual([OLD, NEW])
    expect(body.count).toBe(2)
    const newer = body.rows!.find((r) => (r.batch as { id: number }).id === NEW)!
    expect(newer.replacedBatchId).toBe(OLD)
    expect((newer.batch as { originalFilename: string }).originalFilename).toBe('专精特新中小企业导出Excel.xlsx')
    // 采集时间、导入状态、记录数量都能看到(票面验收第 2 条)。
    expect(newer).toMatchObject({ rowCount: 3, importStatus: 'imported' })
    expect((newer.batch as { collectedOn: string }).collectedOn).toBe('2026-10-15')
  })

  it('多值参数(逗号分隔 / 重复传)与「不筛」', () => {
    expect(call(snapshots, {}).count).toBe(3)
    expect(call(snapshots, { title: 'specialized_sme,innovative_sme' }).count).toBe(3)
    expect(call(snapshots, { year: '2025' }).count).toBe(0)
  })

  it('年度参数不是数字 ⇒ 400,不静默当 0 年', () => {
    expect(() => call(snapshots, { year: 'abc' })).toThrow()
    try {
      call(snapshots, { year: 'abc' })
    } catch (error) {
      expect((error as { statusCode: number }).statusCode).toBe(400)
    }
  })
})

describe('GET /api/platform/snapshots/diff —— 两版差异可追到原始行', () => {
  it('新增 / 消失 / 字段变化,都带源行号;两版身份一并返回', () => {
    const body = call(diff, { from: String(OLD), to: String(NEW) })
    expect((body.from as { id: number }).id).toBe(OLD)
    expect((body.to as { id: number }).id).toBe(NEW)

    const d = body.diff as {
      added: Array<{ usccRaw: string; sourceRowNo: number }>
      removed: Array<{ usccRaw: string; sourceRowNo: number }>
      changed: Array<{ usccRaw: string; fromSourceRowNo: number; toSourceRowNo: number; fields: unknown[] }>
      unchanged: number
    }
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
    for (const q of [{}, { from: String(OLD) }, { to: String(NEW) }, { from: 'x', to: String(NEW) }]) {
      expect(() => call(diff, q)).toThrow()
    }
  })

  it('批号不存在 ⇒ 404(不是空差异)', () => {
    try {
      call(diff, { from: '999999', to: String(NEW) })
      throw new Error('本应抛')
    } catch (error) {
      expect((error as { statusCode: number }).statusCode).toBe(404)
    }
  })

  it('跨称号比较被挡下(拿中小表比创新型表只会全是增删,没有意义)⇒ 400', () => {
    try {
      call(diff, { from: String(OLD), to: String(OTHER) })
      throw new Error('本应抛')
    } catch (error) {
      expect((error as { statusCode: number }).statusCode).toBe(400)
    }
  })
})

describe('可发现契约:两条读路由都带 defineRouteMeta(spec 的唯一输入)', () => {
  it('snapshots.get.ts 与 snapshots/diff.get.ts 的宏写在**顶层**', async () => {
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
