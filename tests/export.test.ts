import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allRecords, listRecords, type RecordQuery, type RecordRow } from '../lib/query'

let dir: string
let db: (typeof import('../db'))['useDb']
let schema: typeof import('../db/schema')

/**
 * 直接铺一份跨「来源 × 称号 × 区县 × 事件类型 × 年份 × 快照」的固定数据集,
 * 用于断言导出(`allRecords`)与列表(`listRecords`)在同一筛选下结果集一致。
 *
 * 快照 1:8 条记录(经信局 5 + 工信部 3),覆盖 award/review/maintain/nurture 与 2021/2023/2024/2025。
 * 快照 2:1 条记录(工信部),用于验证快照筛选隔离。
 */
function seed() {
  const d = db()
  const batch1 = d.insert(schema.importBatch).values({ label: 'snap-1', sourceRoot: '/tmp/1' }).returning({ id: schema.importBatch.id }).get().id
  const batch2 = d.insert(schema.importBatch).values({ label: 'snap-2', sourceRoot: '/tmp/2' }).returning({ id: schema.importBatch.id }).get().id

  const ent = (uscc: string | null, name: string, district: string) =>
    d.insert(schema.enterprise)
      .values({ usccNorm: uscc, name, nameNorm: name, district })
      .returning({ id: schema.enterprise.id })
      .get().id

  const e1 = ent('91330200AAAA000001', '宁波甲科技有限公司', '海曙区')
  const e2 = ent('91330200AAAA000002', '宁波乙机械有限公司', '鄞州区')
  const e3 = ent(null, '宁波丙材料有限公司', '北仑区') // 无统代
  const e4 = ent('91330200AAAA000004', '宁波丁电子有限公司', '慈溪市')
  const e5 = ent('91330200AAAA000005', '宁波戊装备有限公司', '海曙区')
  const e6 = ent('91330200AAAA000006', '宁波己智能有限公司', '海曙区')

  const rec = (
    importBatchId: number,
    enterpriseId: number,
    titleCode: string,
    source: 'jxj' | 'miit',
    district: string,
    events: { type: string; year: number | null; seq: number | null }[],
  ) => {
    const id = d
      .insert(schema.record)
      .values({ importBatchId, enterpriseId, titleCode, source, district })
      .returning({ id: schema.record.id })
      .get().id
    for (const ev of events) {
      const eventId = d
        .insert(schema.recordEvent)
        .values({ recordId: id, eventType: ev.type as never, year: ev.year, batchSeq: ev.seq, sortKey: ev.year ?? 0 })
        .returning({ id: schema.recordEvent.id })
        .get().id
      d.insert(schema.recordEvidence)
        .values({ recordEventId: eventId, sourceFile: `${source}.docx`, attachment: '第一部分', listNo: ev.seq })
        .run()
    }
    return id
  }

  // 快照 1
  rec(batch1, e1, 'specialized_sme', 'jxj', '海曙区', [
    { type: 'award', year: 2024, seq: 2 },
    { type: 'review', year: 2021, seq: 2 },
  ])
  rec(batch1, e2, 'specialized_sme', 'jxj', '鄞州区', [{ type: 'award', year: 2024, seq: 2 }])
  rec(batch1, e3, 'specialized_sme', 'jxj', '北仑区', [{ type: 'nurture', year: 2021, seq: null }])
  rec(batch1, e1, 'specialized_sme', 'miit', '海曙区', [{ type: 'maintain', year: 2025, seq: 1 }])
  rec(batch1, e4, 'little_giant', 'miit', '慈溪市', [{ type: 'maintain', year: 2025, seq: 1 }])
  rec(batch1, e5, 'innovative_sme', 'jxj', '海曙区', [{ type: 'award', year: 2023, seq: 1 }])
  rec(batch1, e5, 'innovative_sme', 'miit', '海曙区', [{ type: 'maintain', year: 2025, seq: 1 }])
  rec(batch1, e1, 'little_giant', 'miit', '海曙区', [{ type: 'maintain', year: 2024, seq: 1 }])

  // 快照 2(仅一条,用于验证 batch 隔离)
  rec(batch2, e6, 'innovative_sme', 'miit', '海曙区', [{ type: 'maintain', year: 2025, seq: 1 }])
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-export-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  ;({ useDb: db } = await import('../db'))
  schema = (await import('../db')).schema
  seed()
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 可见字段组成的记录键,用于跨导出/列表比较结果集。 */
function keyOf(r: Pick<RecordRow, 'name' | 'uscc' | 'district' | 'titleCode' | 'source'>): string {
  return [r.name, r.uscc ?? '', r.district ?? '', r.titleCode, r.source].join('|')
}

/** 用列表端点同样的分页上限翻完所有页(导出不分页)。 */
function listAll(params: RecordQuery): { rows: RecordRow[]; total: number } {
  const rows: RecordRow[] = []
  let page = 1
  let total = 0
  for (;;) {
    const res = listRecords(db(), { ...params, page, pageSize: 200 })
    total = res.total
    rows.push(...res.rows)
    if (rows.length >= total || res.rows.length === 0) break
    page++
  }
  return { rows, total }
}

/** 同一筛选下,导出与列表的条数与结果集(名称等可见字段)必须一致。 */
function assertConsistent(params: RecordQuery, label: string): number {
  const exported = allRecords(db(), params)
  const listed = listAll(params)
  expect(exported.length, `${label} · 条数`).toBe(listed.total)
  expect(exported.map(keyOf).sort(), `${label} · 结果集`).toEqual(listed.rows.map(keyOf).sort())
  return listed.total
}

describe('export ↔ list filter consistency', () => {
  it('exports every record when unfiltered', () => {
    expect(assertConsistent({}, 'all')).toBe(9)
  })

  it('stays consistent across title / source / district filters', () => {
    assertConsistent({ title: 'specialized_sme' }, 'title=specialized_sme')
    assertConsistent({ title: 'little_giant' }, 'title=little_giant')
    assertConsistent({ title: 'innovative_sme' }, 'title=innovative_sme')
    assertConsistent({ source: 'jxj' }, 'source=jxj')
    assertConsistent({ source: 'miit' }, 'source=miit')
    assertConsistent({ district: '海曙区' }, 'district=海曙区(快照1+2)')
  })

  it('stays consistent across eventType and year filters', () => {
    expect(assertConsistent({ eventType: 'award' }, 'eventType=award')).toBe(3)
    expect(assertConsistent({ eventType: 'review' }, 'eventType=review')).toBe(1)
    expect(assertConsistent({ eventType: 'maintain' }, 'eventType=maintain')).toBe(5)
    expect(assertConsistent({ eventType: 'nurture' }, 'eventType=nurture')).toBe(1)
    expect(assertConsistent({ year: 2021 }, 'year=2021')).toBe(2)
    expect(assertConsistent({ year: 2024 }, 'year=2024')).toBe(3)
    expect(assertConsistent({ year: 2025 }, 'year=2025')).toBe(4)
  })

  it('stays consistent across combined filters', () => {
    expect(assertConsistent({ source: 'miit', eventType: 'maintain' }, 'miit+maintain')).toBe(5)
    expect(assertConsistent({ source: 'jxj', eventType: 'award' }, 'jxj+award')).toBe(3)
    expect(assertConsistent({ title: 'specialized_sme', year: 2021 }, 'spec+2021')).toBe(2)
    expect(assertConsistent({ source: 'jxj', eventType: 'review', year: 2021 }, 'jxj+review+2021')).toBe(1)
    expect(assertConsistent({ district: '海曙区', eventType: 'maintain' }, '海曙区+maintain')).toBe(4)
    expect(assertConsistent({ q: '宁波甲' }, 'q=宁波甲')).toBe(3)
    // 无命中:两边都应为空集。
    expect(assertConsistent({ eventType: 'award', year: 2025 }, 'award+2025(空)')).toBe(0)
    expect(assertConsistent({ title: 'little_giant', source: 'jxj' }, 'little_giant+jxj(空)')).toBe(0)
  })

  it('scopes the result set to a single import snapshot', () => {
    expect(assertConsistent({ batchId: 1 }, 'batch=1')).toBe(8)
    expect(assertConsistent({ batchId: 2 }, 'batch=2')).toBe(1)
    // 快照 1 不含快照 2 的企业。
    expect(allRecords(db(), { batchId: 1 }).some((r) => r.name === '宁波己智能有限公司')).toBe(false)
    expect(allRecords(db(), { batchId: 2 }).map((r) => r.name)).toEqual(['宁波己智能有限公司'])
    // 快照筛选与其它条件叠加。
    expect(assertConsistent({ batchId: 1, source: 'miit' }, 'batch=1+miit')).toBe(4)
  })

  it('exports the full event timeline of each matching record', () => {
    const rows = allRecords(db(), { title: 'specialized_sme', source: 'jxj', q: '宁波甲' })
    expect(rows).toHaveLength(1)
    // 甲(jxj 专精特新)有 award 2024-2 与 review 2021-2 两条事件,压成一行文本。
    expect(rows[0]!.events.split('; ').sort()).toEqual(['认定 2024-2', '复核 2021-2'].sort())
  })

  it('includes a non-empty 出处 (evidence) cell per record', () => {
    const rows = allRecords(db(), { title: 'specialized_sme', source: 'jxj', q: '宁波甲' })
    expect(rows).toHaveLength(1)
    // 两条事件各带一条出处,渲染为「文件 / 附件 / 序号N」并以 "; " 连接。
    expect(rows[0]!.evidence).toContain('jxj.docx')
    expect(rows[0]!.evidence).toContain('序号2')
    expect(rows[0]!.evidence.split('; ')).toHaveLength(2)
  })
})
