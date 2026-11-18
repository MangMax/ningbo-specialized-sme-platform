import { createClassifiedFile } from '../../../layers/sme-roster/server/utils/roster-file-classification'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeAttachment } from '../../../layers/sme-roster/lib/attachment'
import {
  aggregateParts,
  compareParts,
  joinSeries,
  partBatches,
  partKey,
  partYears,
  seriesLabel,
  type FilePart,
} from '../../../layers/sme-roster/lib/file-parts'
import { backfillFileParts, listFileParts } from '../../../layers/sme-roster/server/utils/file-parts'
import { applyParseResult } from '../../../layers/sme-roster/server/utils/parse-result'
import { listStoredFiles } from '../../../layers/core/server/utils/stored-files'

/**
 * 票 17 —— **文件含多段**:年份/批次/事件按「段」建模。
 *
 * 分三块:
 *  1. 附件名归一(`layers/sme-roster/lib/attachment.ts`)——「附件」「附 件 1」「附件1」「附件2」同形状;
 *  2. 段聚合与排序(`layers/sme-roster/lib/file-parts.ts`)—— 纯函数,口径可单测;
 *  3. 回填(`layers/sme-roster/server/utils/file-parts.ts`)—— 对**真实形状**的种子核对 192号 = 2 段、
 *     145号 = 2 段,以及幂等。
 *
 * 种子用的是 `files/` 里那两份文件的**真实路径、真实段与真实行数**(389/67 与 301/413),
 * 断言里的数字就是台账里的数字,不是编出来的。
 */

// ---------------------------------------------------------------------------
// 1. 附件名归一
// ---------------------------------------------------------------------------

describe('normalizeAttachment 附件名归一', () => {
  it('实测的四种写法归成同一形状', () => {
    expect(normalizeAttachment('附件')).toBe('附件')
    expect(normalizeAttachment('附 件 1')).toBe('附件1') // ← 空格位置不一是本次要治的毛病
    expect(normalizeAttachment('附件1')).toBe('附件1')
    expect(normalizeAttachment('附件2')).toBe('附件2')
  })

  it('全角空格与不同空白位置一并收掉', () => {
    expect(normalizeAttachment('附　件　1')).toBe('附件1')
    expect(normalizeAttachment(' 附 件  2 ')).toBe('附件2')
    expect(normalizeAttachment('\t附件\n')).toBe('附件')
  })

  it('编号一律读成阿拉伯数字(中文数字、全角、前置零)', () => {
    expect(normalizeAttachment('附件一')).toBe('附件1')
    expect(normalizeAttachment('附件十二')).toBe('附件12')
    expect(normalizeAttachment('附件二十三')).toBe('附件23')
    expect(normalizeAttachment('附件０１')).toBe('附件1')
  })

  it('「附件」不补编号 —— 源里没有编号就不造一个(空值优于错值)', () => {
    // 145号 只有一个附件、源里就写「附件」,里面并置了 2021 与 2022 两段名单。
    expect(normalizeAttachment('附件')).toBe('附件')
    expect(normalizeAttachment('附件')).not.toBe('附件1')
  })

  it('空值 / 全空白 → null(「没有附件」用 null 表示,不用空串)', () => {
    expect(normalizeAttachment(null)).toBeNull()
    expect(normalizeAttachment(undefined)).toBeNull()
    expect(normalizeAttachment('')).toBeNull()
    expect(normalizeAttachment('   ')).toBeNull()
  })

  it('认不出的写法原样保留(去掉空白),不猜也不丢', () => {
    expect(normalizeAttachment('附表 1')).toBe('附表1')
    expect(normalizeAttachment('附件甲')).toBe('附件甲')
  })

  it('幂等:归一再归一,结果不变', () => {
    for (const raw of ['附件', '附 件 1', '附件2', '附件一', '附件０１', '附件甲']) {
      const once = normalizeAttachment(raw)
      expect(normalizeAttachment(once)).toBe(once)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. 段聚合与排序(纯函数)
// ---------------------------------------------------------------------------

function makePart(over: Partial<FilePart> = {}): FilePart {
  return {
    titleCode: 'specialized_sme',
    eventKind: 'award',
    year: null,
    batch: null,
    attachment: null,
    rowCount: 1,
    ...over,
  }
}

describe('aggregateParts 段聚合', () => {
  it('同坐标合并、行数相加;不同附件不合并', () => {
    const parts = aggregateParts([
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附件1' },
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附件1' },
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附件2' },
    ])
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({ attachment: '附件1', rowCount: 2 })
    expect(parts[1]).toMatchObject({ attachment: '附件2', rowCount: 1 })
  })

  it('null 年份与「年份是某值」不会撞键', () => {
    expect(
      partKey({ titleCode: 'a', eventKind: 'award', year: null, batch: null, attachment: null }),
    ).not.toBe(partKey({ titleCode: 'a', eventKind: 'award', year: 1, batch: null, attachment: null }))
  })

  it('排序:事件次序优先(认定在前、复核在后)→ 年份 → 批次', () => {
    const parts = aggregateParts([
      { titleCode: 'specialized_sme', eventKind: 'review', year: 2021, batch: 2, attachment: '附件2' },
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附件1' },
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2021, batch: null, attachment: '附件' },
    ])
    expect(parts.map((p) => `${p.eventKind}/${p.year}`)).toEqual([
      'award/2021',
      'award/2024',
      'review/2021',
    ])
  })

  it('称号等级优先于事件次序(小巨人段排在专精特新段之前)', () => {
    const parts = aggregateParts([
      { titleCode: 'innovative_sme', eventKind: 'award', year: 2024, batch: 1, attachment: null },
      { titleCode: 'little_giant', eventKind: 'maintain', year: 2024, batch: 1, attachment: null },
    ])
    expect(parts.map((p) => p.titleCode)).toEqual(['little_giant', 'innovative_sme'])
  })

  it('空输入 → 空数组', () => {
    expect(aggregateParts([])).toEqual([])
  })
})

describe('段的派生展示值', () => {
  it('年份 / 批次去重升序', () => {
    const parts = [
      makePart({ year: 2024, batch: 2 }),
      makePart({ year: 2021, batch: 2 }),
      makePart({ year: 2021, batch: null }),
    ]
    expect(partYears(parts)).toEqual([2021, 2024])
    expect(partBatches(parts)).toEqual([2])
  })

  it('全是 null 时给空数组,由页面走「—」', () => {
    expect(partYears([makePart({ year: null })])).toEqual([])
    expect(partBatches([makePart({ batch: null })])).toEqual([])
  })

  it('joinSeries 用顿号连接;空数组给 null', () => {
    expect(joinSeries([2021, 2022])).toBe('2021、2022')
    expect(joinSeries([2])).toBe('2')
    expect(joinSeries([])).toBeNull()
  })

  it('seriesLabel 超过上限只列前几个并缀 +剩 N(工信部导出跨六七年,全列会撑破窄列)', () => {
    expect(seriesLabel([2021, 2022])).toBe('2021、2022')
    expect(seriesLabel([2021, 2022, 2023])).toBe('2021、2022 +1')
    expect(seriesLabel([2021, 2022, 2023, 2024, 2025, 2026])).toBe('2021、2022 +4')
    expect(seriesLabel([])).toBeNull()
    // 上限可调。
    expect(seriesLabel([1, 2, 3, 4], 1)).toBe('1 +3')
    expect(seriesLabel([1, 2, 3], 3)).toBe('1、2、3')
  })

  it('compareParts 把无年份/无批次的段排在同类的最后', () => {
    const withYear = makePart({ year: 2024 })
    const without = makePart({ year: null })
    expect([without, withYear].sort(compareParts)).toEqual([withYear, without])
  })
})

// ---------------------------------------------------------------------------
// 3. 回填(库 + 真实形状的种子)
// ---------------------------------------------------------------------------

/** `files/` 里两份真实文件的路径(取自磁盘,不是编的)。 */
const FILE_192 =
  'jxj/announcement/2024/2/甬经信中小〔2024〕192号关于公布2024年第二批认定及2021年第二批到期复核通过宁波市“专精特新”中小企业名单的通知.pdf'
const FILE_145 =
  'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'
const FILE_MIIT = 'miit/export/创新型中小企业导出Excel.xlsx'
/** 没有引用、留待票 11 的文件(实测就是那 2 份 `.doc`)。 */
const FILE_NO_EVIDENCE = 'jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.doc'

let dir: string
let db: ReturnType<(typeof import('../../../db'))['useDb']>
let schema: typeof import('../../../db')['schema']

function seedFile(relPath: string, over: Partial<{ year: number; batch: number }> = {}): number {
  const segments = relPath.split('/')
  const miit = relPath.startsWith('miit')
  return createClassifiedFile(db, { relPath, filename: segments[segments.length - 1]!, ext: miit ? 'xlsx' : 'pdf', bytes: 1, sha256: 'a'.repeat(64) }, { source: miit ? 'miit' : 'jxj', kind: miit ? 'export' : 'announcement', year: over.year ?? null, batch: over.batch ?? null, categoryState: 'set' }).id
}

let seq = 0
/** 造一条记录 + 一个事件,并按 `rows` 条引用写进去 —— 段的行数就是这么来的。 */
function seedEvidence(o: {
  relPath: string
  titleCode: string
  eventKind: 'award' | 'review' | 'maintain' | 'nurture'
  year: number | null
  batch: number | null
  attachment: string | null
  rows: number
}) {
  seq += 1
  const enterpriseId = db
    .insert(schema.enterprise)
    .values({ name: `企业${seq}`, nameNorm: `企业${seq}` })
    .returning({ id: schema.enterprise.id })
    .get().id
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId, titleCode: o.titleCode, source: 'jxj' })
    .returning({ id: schema.record.id })
    .get().id
  const eventId = db
    .insert(schema.recordEvent)
    .values({ recordId, eventType: o.eventKind, year: o.year, batchSeq: o.batch })
    .returning({ id: schema.recordEvent.id })
    .get().id
  db.insert(schema.recordEvidence)
    .values(
      Array.from({ length: o.rows }, () => ({
        recordEventId: eventId,
        sourceFile: o.relPath,
        attachment: o.attachment,
      })),
    )
    .run()
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-parts-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  const mod = await import('../../../db')
  schema = mod.schema
  db = mod.initializeDb({ create: true })

  seedFile(FILE_192, { year: 2024, batch: 2 })
  seedFile(FILE_145, { year: 2022 })
  seedFile(FILE_MIIT)
  seedFile(FILE_NO_EVIDENCE, { year: 2023, batch: 1 })

  // 192号:认定 2024/2(附件1,389 行)+ 复核 2021/2(附件2,67 行)。
  // 认定那段的附件名源里写的是「附 件 1」—— 归一是它俩不分裂成两段的前提。
  seedEvidence({
    relPath: FILE_192,
    titleCode: 'specialized_sme',
    eventKind: 'award',
    year: 2024,
    batch: 2,
    attachment: '附 件 1',
    rows: 389,
  })
  seedEvidence({
    relPath: FILE_192,
    titleCode: 'specialized_sme',
    eventKind: 'review',
    year: 2021,
    batch: 2,
    attachment: '附件2',
    rows: 67,
  })

  // 145号:同一个「附件」里并置 2021 与 2022 两段认定名单(年份不同、附件相同)。
  seedEvidence({
    relPath: FILE_145,
    titleCode: 'specialized_sme',
    eventKind: 'award',
    year: 2021,
    batch: null,
    attachment: '附件',
    rows: 301,
  })
  seedEvidence({
    relPath: FILE_145,
    titleCode: 'specialized_sme',
    eventKind: 'award',
    year: 2022,
    batch: null,
    attachment: '附件',
    rows: 413,
  })

  // 工信部导出:维护批次跨年,无附件。
  for (const [year, rows] of [
    [2024, 5],
    [2025, 7],
  ] as const) {
    seedEvidence({
      relPath: FILE_MIIT,
      titleCode: 'innovative_sme',
      eventKind: 'maintain',
      year,
      batch: 1,
      attachment: null,
      rows,
    })
  }

  backfillFileParts(db)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 段的规范快照(忽略自增 id),用来比「两次回填结果一致」。 */
function partSnapshot(): string[] {
  return db
    .select()
    .from(schema.storedFilePart)
    .all()
    .map(
      (p) =>
        `${p.fileId}|${p.titleCode}|${p.eventKind}|${p.year}|${p.batch}|${p.attachment}|${p.rowCount}|${p.origin}|${p.hasConflict}`,
    )
    .sort()
}

const fileIdOf = (relPath: string) =>
  db.select().from(schema.storedFile).all().find((f) => f.relPath === relPath)!.id

describe('从 record_evidence 回填段', () => {
  it('192号 = 2 段:认定 2024/2 附件1、复核 2021/2 附件2', () => {
    const fileId = fileIdOf(FILE_192)
    expect(listFileParts(db, [fileId]).get(fileId)).toEqual([
      {
        titleCode: 'specialized_sme',
        eventKind: 'award',
        year: 2024,
        batch: 2,
        attachment: '附件1', // ← 「附 件 1」归一
        rowCount: 389,
        origin: 'derived',
        hasConflict: false,
      },
      {
        titleCode: 'specialized_sme',
        eventKind: 'review',
        year: 2021,
        batch: 2,
        attachment: '附件2',
        rowCount: 67,
        origin: 'derived',
        hasConflict: false,
      },
    ])
  })

  it('145号 = 2 段:认定 2021、认定 2022(同附件、不同年份)', () => {
    const fileId = fileIdOf(FILE_145)
    expect(listFileParts(db, [fileId]).get(fileId)).toEqual([
      {
        titleCode: 'specialized_sme',
        eventKind: 'award',
        year: 2021,
        batch: null,
        attachment: '附件',
        rowCount: 301,
        origin: 'derived',
        hasConflict: false,
      },
      {
        titleCode: 'specialized_sme',
        eventKind: 'award',
        year: 2022,
        batch: null,
        attachment: '附件',
        rowCount: 413,
        origin: 'derived',
        hasConflict: false,
      },
    ])
  })

  it('回填幂等:重跑两次,行数与内容都不变', () => {
    const before = partSnapshot()
    backfillFileParts(db)
    backfillFileParts(db)
    expect(partSnapshot()).toEqual(before)
    expect(db.select().from(schema.storedFilePart).all()).toHaveLength(before.length)
  })

  it('列表行带上段,且年份/批次汇总是内容年份(页面「年份」列就靠它)', () => {
    const rows = listStoredFiles(db, { pageSize: 200 }).rows
    const byPath = new Map(rows.map((r) => [r.relPath, r]))

    // 192号 年份列显示两个年 —— 验收里的那一条。
    expect(byPath.get(FILE_192)!.parts).toHaveLength(2)
    expect(partYears(byPath.get(FILE_192)!.parts!).map(String).join('、')).toBe('2021、2024')
    expect(partBatches(byPath.get(FILE_192)!.parts!)).toEqual([2])

    // 145号 年份列也是两个年(同一附件、两年名单)。
    expect(partYears(byPath.get(FILE_145)!.parts!).map(String).join('、')).toBe('2021、2022')

    // 公布年份/批次仍是文件级的单值,与内容年份互不影响。
    const f192 = byPath.get(FILE_192)!
    expect([f192.year, f192.batch]).toEqual([2024, 2])
  })

  it('工信部导出也按维护批次分段(attachment 为空)', () => {
    const miit = listStoredFiles(db, { q: '导出Excel' }).rows.find((r) => r.relPath === FILE_MIIT)!
    expect(miit.parts!.map((p) => `${p.eventKind}/${p.year}`)).toEqual([
      'maintain/2024',
      'maintain/2025',
    ])
    expect(miit.parts!.every((p) => p.attachment === null)).toBe(true)
    expect(partYears(miit.parts!)).toEqual([2024, 2025])
  })

  it('没有引用的文件不留段(留给票 11 解析时写),但公布年份还在', () => {
    const row = listStoredFiles(db, { pageSize: 200 }).rows.find(
      (r) => r.relPath === FILE_NO_EVIDENCE,
    )!
    expect(row.parts).toEqual([])
    expect(row.year).toBe(2023) // 文件级与段是两回事
  })

  it('段的展示顺序与文件正文一致(认定在前、复核在后)', () => {
    const fileId = fileIdOf(FILE_192)
    expect(listFileParts(db, [fileId]).get(fileId)!.map((p) => p.eventKind)).toEqual([
      'award',
      'review',
    ])
  })
})

// ---------------------------------------------------------------------------
// 4. 边界:野引用与删除级联(放最后 —— 会改库)
// ---------------------------------------------------------------------------

describe('回填的边界', () => {
  it('有引用但库里没有对应文件时跳过并报出(不猜、不建野段)', () => {
    seedEvidence({
      relPath: 'jxj/announcement/2099/1/还没入库.pdf',
      titleCode: 'innovative_sme',
      eventKind: 'award',
      year: 2099,
      batch: 1,
      attachment: '附件',
      rows: 1,
    })
    const stats = backfillFileParts(db)
    expect(stats.orphanPaths).toEqual(['jxj/announcement/2099/1/还没入库.pdf'])
    expect(db.select().from(schema.storedFilePart).all().some((p) => p.year === 2099)).toBe(false)
    // 其余文件照常回填,没被这一条带坏。
    expect(stats.files).toBe(3)
  })

  it('evidence 被清掉后,残留的段跟着清掉(段整体派生于 evidence,不是只增不减)', () => {
    const relPath = 'jxj/announcement/2099/2/将失效.pdf'
    const fileId = seedFile(relPath, { year: 2099, batch: 2 })
    seedEvidence({
      relPath,
      titleCode: 'innovative_sme',
      eventKind: 'award',
      year: 2099,
      batch: 2,
      attachment: '附件',
      rows: 2,
    })
    backfillFileParts(db)
    expect(listFileParts(db, [fileId]).get(fileId)).toHaveLength(1)

    db.delete(schema.recordEvidence).where(eq(schema.recordEvidence.sourceFile, relPath)).run()
    backfillFileParts(db)
    expect(listFileParts(db, [fileId]).has(fileId)).toBe(false)
  })

  it('文件被删时它的段级联删掉,不留孤儿', () => {
    const fileId = fileIdOf(FILE_MIIT)
    expect(listFileParts(db, [fileId]).has(fileId)).toBe(true)
    db.delete(schema.storedFile).where(eq(schema.storedFile.id, fileId)).run()
    expect(listFileParts(db, [fileId]).has(fileId)).toBe(false)
  })

  it('保留无 evidence 文件的代理段,同坐标冲突时代理段胜出且冲突可查', () => {
    const emptyFileId = fileIdOf(FILE_NO_EVIDENCE)
    const agentOnly = applyParseResult(db, emptyFileId, {
      parts: [
        {
          titleCode: 'specialized_sme',
          eventKind: 'award',
          year: 2023,
          batch: 1,
          attachment: null,
          rowCount: 12,
        },
      ],
    })
    expect(agentOnly.ok).toBe(true)

    const file192Id = fileIdOf(FILE_192)
    const agentWins = applyParseResult(db, file192Id, {
      parts: [
        {
          titleCode: 'specialized_sme',
          eventKind: 'award',
          year: 2024,
          batch: 2,
          attachment: '附件1',
          rowCount: 10,
        },
      ],
    })
    expect(agentWins.ok).toBe(true)

    backfillFileParts(db)

    expect(listFileParts(db, [emptyFileId]).get(emptyFileId)).toEqual([
      {
        titleCode: 'specialized_sme',
        eventKind: 'award',
        year: 2023,
        batch: 1,
        attachment: null,
        rowCount: 12,
        origin: 'agent',
        hasConflict: false,
      },
    ])
    expect(listFileParts(db, [file192Id]).get(file192Id)).toEqual([
      {
        titleCode: 'specialized_sme',
        eventKind: 'award',
        year: 2024,
        batch: 2,
        attachment: '附件1',
        rowCount: 10,
        origin: 'agent',
        hasConflict: true,
      },
      {
        titleCode: 'specialized_sme',
        eventKind: 'review',
        year: 2021,
        batch: 2,
        attachment: '附件2',
        rowCount: 67,
        origin: 'derived',
        hasConflict: false,
      },
    ])

    // 新代理结果不再包含旧覆盖坐标时,evidence 派生段会随这次全量替换恢复。
    const replacement = applyParseResult(db, file192Id, {
      parts: [
        {
          titleCode: 'specialized_sme',
          eventKind: 'review',
          year: 2021,
          batch: 2,
          attachment: '附件2',
          rowCount: 67,
        },
      ],
    })
    expect(replacement.ok).toBe(true)
    expect(listFileParts(db, [file192Id]).get(file192Id)).toEqual([
      {
        titleCode: 'specialized_sme',
        eventKind: 'award',
        year: 2024,
        batch: 2,
        attachment: '附件1',
        rowCount: 389,
        origin: 'derived',
        hasConflict: false,
      },
      {
        titleCode: 'specialized_sme',
        eventKind: 'review',
        year: 2021,
        batch: 2,
        attachment: '附件2',
        rowCount: 67,
        origin: 'agent',
        hasConflict: false,
      },
    ])

    const conflictedSnapshot = partSnapshot()
    backfillFileParts(db)
    expect(partSnapshot()).toEqual(conflictedSnapshot)
  })

  it('旧来源行与 evidence 一致时归为 derived,行数冲突时保留 legacy 并标记', () => {
    const exactFileId = fileIdOf(FILE_192)
    const exactRow = db
      .select()
      .from(schema.storedFilePart)
      .all()
      .find((row) => row.fileId === exactFileId && row.eventKind === 'award')!
    db.update(schema.storedFilePart)
      .set({ origin: 'legacy' })
      .where(eq(schema.storedFilePart.id, exactRow.id))
      .run()

    const conflictFileId = fileIdOf(FILE_145)
    const conflictRow = db
      .select()
      .from(schema.storedFilePart)
      .all()
      .find((row) => row.fileId === conflictFileId && row.year === 2021)!
    db.update(schema.storedFilePart)
      .set({ origin: 'legacy', rowCount: 300 })
      .where(eq(schema.storedFilePart.id, conflictRow.id))
      .run()

    backfillFileParts(db)

    const exact = listFileParts(db, [exactFileId]).get(exactFileId)!
    expect(exact.find((part) => part.eventKind === 'award')).toMatchObject({
      rowCount: 389,
      origin: 'derived',
      hasConflict: false,
    })
    const conflict = listFileParts(db, [conflictFileId]).get(conflictFileId)!
    expect(conflict.find((part) => part.year === 2021)).toMatchObject({
      rowCount: 300,
      origin: 'legacy',
      hasConflict: true,
    })

    const afterFirstBackfill = partSnapshot()
    backfillFileParts(db)
    expect(partSnapshot()).toEqual(afterFirstBackfill)
  })
})
