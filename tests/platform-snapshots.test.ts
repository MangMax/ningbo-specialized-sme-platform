/**
 * RL-05 —— 快照读侧(`GET /api/platform/snapshots`,契约 §7.7)与**版本比较**的单元层。
 *
 * 缝:
 *   - `diffPlatformSnapshots(from, to)` —— 纯函数;新增 / 消失 / 字段变化 + 源行号追溯;
 *   - `listPlatformSnapshots(db, q)` / `getPlatformExportRows(db, id)` —— 读侧。
 *
 * 夹具直接落临时库(测试夹具用临时库,不走生产写路径;生产写入见契约 §8,由 RL-11 提供)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  diffPlatformSnapshots,
  getPlatformExportRows,
  getPlatformSnapshotBatch,
  listPlatformSnapshots,
  snapshotRowKey,
  type SnapshotRow,
} from '../lib/platform-snapshots'

const dir = mkdtempSync(join(tmpdir(), 'spztx-snapshots-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const row = (over: Partial<SnapshotRow> & { sourceRowNo: number }): SnapshotRow => ({
  usccRaw: null,
  nameRaw: null,
  province: '浙江省',
  city: '宁波市',
  district: null,
  regStatus: null,
  ...over,
})

// ---------------------------------------------------------------------------

describe('diffPlatformSnapshots:新增 / 消失 / 字段变化,都能追到源行号', () => {
  const before = [
    row({ sourceRowNo: 3, usccRaw: 'CODE1', nameRaw: '甲公司', district: '鄞州区', regStatus: '待审核' }),
    row({ sourceRowNo: 4, usccRaw: 'CODE2', nameRaw: '乙公司', district: '海曙区', regStatus: '省已审' }),
    row({ sourceRowNo: 5, usccRaw: 'CODE3', nameRaw: '丙公司', district: '江北区', regStatus: '待审核' }),
  ]
  const after = [
    // CODE1 不动。
    row({ sourceRowNo: 3, usccRaw: 'CODE1', nameRaw: '甲公司', district: '鄞州区', regStatus: '待审核' }),
    // CODE2 更名 + 换区 + 审核状态推进。
    row({ sourceRowNo: 4, usccRaw: 'CODE2', nameRaw: '乙公司(新)', district: '北仑区', regStatus: '终审通过' }),
    // CODE4 是本轮新增。
    row({ sourceRowNo: 6, usccRaw: 'CODE4', nameRaw: '丁公司', district: '镇海区', regStatus: '待审核' }),
  ]

  it('新增 / 消失按统代判定,带源行号', () => {
    const diff = diffPlatformSnapshots(before, after)
    expect(diff.added.map((r) => [r.usccRaw, r.sourceRowNo])).toEqual([['CODE4', 6]])
    expect(diff.removed.map((r) => [r.usccRaw, r.sourceRowNo])).toEqual([['CODE3', 5]])
  })

  it('字段变化逐字段报出「从什么到什么」,并带两侧源行号', () => {
    const diff = diffPlatformSnapshots(before, after)
    expect(diff.changed).toHaveLength(1)
    const change = diff.changed[0]!
    expect(change).toMatchObject({ key: 'CODE2', usccRaw: 'CODE2', fromSourceRowNo: 4, toSourceRowNo: 4 })
    expect(change.fields).toEqual([
      { field: 'name', from: '乙公司', to: '乙公司(新)' },
      { field: 'district', from: '海曙区', to: '北仑区' },
      { field: 'regStatus', from: '省已审', to: '终审通过' },
    ])
  })

  it('计数如实:未变的不进 changed,两边总量都报出来', () => {
    const diff = diffPlatformSnapshots(before, after)
    expect(diff.unchanged).toBe(1)
    expect(diff.fromCount).toBe(3)
    expect(diff.toCount).toBe(3)
  })

  it('同一文件重放(完全相同的两批)⇒ 全未变,不产生任何差异', () => {
    const diff = diffPlatformSnapshots(before, before)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
    expect(diff.unchanged).toBe(3)
  })

  it('统代缺失时退化为按名称做身份键(防御分支,不是主路径)', () => {
    const a = [row({ sourceRowNo: 3, usccRaw: null, nameRaw: '无码公司' })]
    const b = [row({ sourceRowNo: 3, usccRaw: null, nameRaw: '无码公司', regStatus: '省已审' })]
    expect(snapshotRowKey(a[0]!)).toBe('name:无码公司')
    const diff = diffPlatformSnapshots(a, b)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toHaveLength(1)
  })

  it('统代大小写/空白差异不制造假差异', () => {
    const a = [row({ sourceRowNo: 3, usccRaw: '91330201aaaaaaa001' })]
    const b = [row({ sourceRowNo: 9, usccRaw: ' 91330201AAAAAAA001 ' })]
    const diff = diffPlatformSnapshots(a, b)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 读侧:某称号某年度的采集快照与版本(契约 §7.7 的数据来源)
// ---------------------------------------------------------------------------

const dbPath = join(dir, 'snapshots.db')
process.env.NUXT_DB_PATH = dbPath
const { schema, useDb } = await import('../db')
const db = useDb({ dbPath })

function seedBatch(over: {
  titleCode: string
  year: number
  sha256: string
  collectedOn?: string
  originalFilename?: string
  importStatus?: 'pending' | 'imported' | 'failed'
  replacedBatchId?: number | null
}): number {
  return db
    .insert(schema.platformExportBatch)
    .values({
      titleCode: over.titleCode,
      year: over.year,
      collectedOn: over.collectedOn ?? '2026-10-15',
      originalFilename: over.originalFilename ?? `${over.titleCode}-${over.sha256}.xlsx`,
      sha256: over.sha256,
      rowCount: 0,
      importStatus: over.importStatus ?? 'imported',
      replacedBatchId: over.replacedBatchId ?? null,
    })
    .returning({ id: schema.platformExportBatch.id })
    .get().id
}

function seedRow(batchId: number, over: Partial<typeof schema.platformExportRow.$inferInsert> & { sourceRowNo: number }) {
  db.insert(schema.platformExportRow)
    .values({ batchId, usccRaw: null, nameRaw: null, ...over })
    .run()
}

const batchA = seedBatch({ titleCode: 'specialized_sme', year: 2026, sha256: 'a'.repeat(64), importStatus: 'imported' })
const batchB = seedBatch({ titleCode: 'specialized_sme', year: 2026, sha256: 'b'.repeat(64), replacedBatchId: batchA })
const batchC = seedBatch({ titleCode: 'innovative_sme', year: 2026, sha256: 'c'.repeat(64), collectedOn: '2026-10-16' })
const batchD = seedBatch({ titleCode: 'specialized_sme', year: 2025, sha256: 'd'.repeat(64), importStatus: 'failed' })

seedRow(batchA, { sourceRowNo: 4, usccRaw: 'CODE2', nameRaw: '乙公司', district: '海曙区', province: '浙江省', city: '宁波市', regStatus: '待审核' })
seedRow(batchA, { sourceRowNo: 3, usccRaw: 'CODE1', nameRaw: '甲公司', district: '鄞州区', province: '浙江省', city: '宁波市', regStatus: '待审核' })

describe('listPlatformSnapshots:批次与版本', () => {
  it('列出全部,按 称号 → 年度 → id 排序', () => {
    const items = listPlatformSnapshots(db)
    expect(items.map((i) => [i.batch.titleCode, i.batch.year, i.batch.id])).toEqual([
      ['innovative_sme', 2026, batchC],
      ['specialized_sme', 2025, batchD],
      ['specialized_sme', 2026, batchA],
      ['specialized_sme', 2026, batchB],
    ])
  })

  it('响应行形状 = { batch, replacedBatchId, rowCount, importStatus }(契约 §7.7)', () => {
    const item = listPlatformSnapshots(db, { title: ['specialized_sme'], year: [2026] }).find(
      (i) => i.batch.id === batchB,
    )!
    expect(Object.keys(item).sort()).toEqual(['batch', 'importStatus', 'replacedBatchId', 'rowCount'])
    expect(item.batch).toMatchObject({
      id: batchB,
      titleCode: 'specialized_sme',
      year: 2026,
      collectedOn: '2026-10-15',
      sha256: 'b'.repeat(64),
      importStatus: 'imported',
    })
    // 替换关系:新版本指向被替换的旧版本。
    expect(item.replacedBatchId).toBe(batchA)
  })

  it('被替换的旧快照**仍在列表里**(旧版不因替换而消失)', () => {
    const ids = listPlatformSnapshots(db).map((i) => i.batch.id)
    expect(ids).toContain(batchA)
    expect(listPlatformSnapshots(db).find((i) => i.batch.id === batchA)!.replacedBatchId).toBeNull()
  })

  it('按称号 / 年度筛选(多值命中任一)', () => {
    expect(listPlatformSnapshots(db, { title: ['specialized_sme'] }).map((i) => i.batch.id)).toEqual([
      batchD,
      batchA,
      batchB,
    ])
    expect(listPlatformSnapshots(db, { year: [2025] }).map((i) => i.batch.id)).toEqual([batchD])
    expect(listPlatformSnapshots(db, { title: ['innovative_sme'], year: [2026] }).map((i) => i.batch.id)).toEqual([batchC])
    expect(listPlatformSnapshots(db, { title: ['nope'] })).toEqual([])
  })

  it('导入状态如实带出(failed 也是可见状态,不是隐藏)', () => {
    expect(listPlatformSnapshots(db, { year: [2025] })[0]!.importStatus).toBe('failed')
  })

  it('getPlatformExportRows 按源行号升序,字段完整(供比较与追溯)', () => {
    const rows = getPlatformExportRows(db, batchA)
    expect(rows.map((r) => r.sourceRowNo)).toEqual([3, 4])
    expect(rows[0]).toEqual({
      sourceRowNo: 3,
      usccRaw: 'CODE1',
      nameRaw: '甲公司',
      province: '浙江省',
      city: '宁波市',
      district: '鄞州区',
      regStatus: '待审核',
    })
  })

  it('getPlatformSnapshotBatch 查无此批返回 null(不编造)', () => {
    expect(getPlatformSnapshotBatch(db, 999_999)).toBeNull()
    expect(getPlatformSnapshotBatch(db, batchC)!.titleCode).toBe('innovative_sme')
  })

  it('快照行与公布历史分开:这里只读 platform_export_*,没有 record* 参与', () => {
    // 库里的 record / record_event 计数不受快照读侧影响(读侧是只读的)。
    const records = db.$client.prepare('select count(*) n from record').get() as { n: number }
    listPlatformSnapshots(db)
    getPlatformExportRows(db, batchA)
    const after = db.$client.prepare('select count(*) n from record').get() as { n: number }
    expect(after.n).toBe(records.n)
  })
})
