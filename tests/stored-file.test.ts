import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { categoryStateOf, deriveClassification, deriveParts, parseBatch } from '../lib/stored-file'
import {
  backfillFromDisk,
  backfillStoredFiles,
  listStoredFiles,
  parseMetadataPatch,
  removeStoredFile,
  scanFileStore,
  updateStoredFile,
} from '../server/utils/stored-files'

/**
 * 票 09 —— 文件表与文件管理页的**规则层**测试。
 *
 * 分三块:
 *  1. 分类规则(`lib/stored-file.ts`)——从目录反推 source/kind/year/batch;
 *  2. 回填幂等 —— 重跑两次行数不变;
 *  3. 元数据 PATCH 只改元数据 —— 不动 `rel_path`、不动磁盘。
 *
 * 最后一块额外对**真实的 `files/`** 跑一遍,核对「23 个文件逐个对得上」这条验收。
 */

// ---------------------------------------------------------------------------
// 1. 分类规则
// ---------------------------------------------------------------------------

describe('parseBatch(照抄 pipeline/src/normalize.ts)', () => {
  it('解析「第 N 批」与年份', () => {
    expect(parseBatch('2024年度第一批')).toEqual({ year: 2024, seq: 1 })
    expect(parseBatch('2023年第二批')).toEqual({ year: 2023, seq: 2 })
  })

  it('取**第一个**四位年份 —— 正是「年份必须取目录而非文件名」的原因', () => {
    // 文号里的〔2024〕在前、正文里的 2023 在后:parseBatch 会取 2024(发布年),
    // 而这份文件的**公布年份**其实是 2023(目录说了算)。取文件名会串年份。
    expect(parseBatch('甬经信中小〔2024〕19号关于公布2023年第二批宁波市创新型中小企业名单的通知.pdf')).toEqual({
      year: 2024,
      seq: 2,
    })
  })

  it('年份区间取首年、无批次', () => {
    expect(parseBatch('2021-2022宁波市“专精特新”入库培育')).toEqual({ year: 2021, seq: null })
  })

  it('汉字批次号', () => {
    expect(parseBatch('第一批')).toEqual({ year: null, seq: 1 })
  })

  it('解析不出时对应项为 null,不硬猜', () => {
    expect(parseBatch('公布.pdf')).toEqual({ year: null, seq: null })
    expect(parseBatch('')).toEqual({ year: null, seq: null })
  })
})

describe('deriveParts 从目录反推分类', () => {
  it('年份取目录,批次取年份段后的数字段', () => {
    expect(deriveParts('jxj/announcement/2024/1/某通知.pdf')).toEqual({
      source: 'jxj',
      kind: 'announcement',
      year: 2024,
      batch: 1,
    })
  })

  it('年份一律取目录、不取文件名 —— 文件名里的年份常是复核的原始认定年份', () => {
    // 2024 年发布的「2021年度第一批复核」:目录说 2024,文件名里有 2021。取目录。
    expect(deriveParts('jxj/announcement/2024/1/甬经信中小〔2024〕143号关于公布2021年度第一批…复核通过…的通知.pdf'))
      .toMatchObject({ year: 2024, batch: 1 })
  })

  it('无批次目录时批次为 null(目录给不出就留空,不硬填)', () => {
    expect(deriveParts('jxj/announcement/2022/公布.pdf')).toEqual({
      source: 'jxj',
      kind: 'announcement',
      year: 2022,
      batch: null,
    })
  })

  it('工信部导出表无年份批次', () => {
    expect(deriveParts('miit/export/专精特新小巨人导出Excel.xlsx')).toEqual({
      source: 'miit',
      kind: 'export',
      year: null,
      batch: null,
    })
  })

  it('冲突消歧的来源子目录段不会被误当批次', () => {
    expect(deriveParts('jxj/announcement/2023/2/省专/甬经信中小〔2023〕121号…通知.pdf')).toEqual({
      source: 'jxj',
      kind: 'announcement',
      year: 2023,
      batch: 2,
    })
  })

  it('认不出的路径返回 null(回填时跳过,不猜)', () => {
    expect(deriveParts('misc/random.pdf')).toBeNull()
    expect(deriveParts('README.md')).toBeNull()
  })

  it('目录**给不出**年份/批次时,才回退文件名解析(files/README.md 第 3 条,与 pipeline 同规则)', () => {
    // 正常文件库里不会有这种路径(文件库就是按年/批次分层放的)。这条只在缺目录段时兜底。
    // 注意风险:文件名里的四位数字可能是**文号**年份而非公布年份 —— 所以**目录有就绝不用文件名**(见上一条)。
    expect(deriveParts('jxj/announcement/2024年第二批的通知.pdf')).toEqual({
      source: 'jxj',
      kind: 'announcement',
      year: 2024,
      batch: 2,
    })
  })
})

describe('categoryStateOf 分类是否已定', () => {
  it('公布文件要年份才算定;没年份归 unset 交回写', () => {
    expect(categoryStateOf({ source: 'jxj', kind: 'announcement', year: 2024, batch: 1 })).toBe('set')
    expect(categoryStateOf({ source: 'jxj', kind: 'announcement', year: null, batch: null })).toBe('unset')
  })

  it('导出表只要来源类别在就算定(它本来就没有年份批次)', () => {
    expect(categoryStateOf({ source: 'miit', kind: 'export', year: null, batch: null })).toBe('set')
  })

  it('deriveClassification 合并两者', () => {
    expect(deriveClassification('miit/export/a.xlsx')).toEqual({
      source: 'miit',
      kind: 'export',
      year: null,
      batch: null,
      categoryState: 'set',
    })
  })
})

// ---------------------------------------------------------------------------
// 2/3. 回填与 PATCH(需要库与磁盘)
// ---------------------------------------------------------------------------

let dir: string
let filesRoot: string
let useDb: (typeof import('../db'))['useDb']
let db: ReturnType<(typeof import('../db'))['useDb']>
let schema: typeof import('../db')['schema']

/** 在临时文件库里铺一份最小样本:两个公布文件 + 一个导出表。 */
async function seedDisk() {
  const put = async (rel: string, body: string) => {
    const abs = join(filesRoot, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, body)
  }
  await put('jxj/announcement/2024/1/甬经信中小〔2024〕72号 通知.pdf', 'pdf-one')
  await put('jxj/announcement/2024/1/甬经信中小〔2024〕58号 通知.pdf', 'pdf-two')
  await put('jxj/announcement/2022/公布.pdf', 'pdf-three')
  await put('miit/export/创新型中小企业导出Excel.xlsx', 'xlsx-one')
  // 系统/临时文件与 README 不该入表。
  await put('jxj/announcement/2024/1/.DS_Store', 'junk')
  await put('jxj/announcement/2024/1/.~信中小〔2021〕160号.docx', 'junk')
  await put('README.md', '说明')
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-stored-'))
  filesRoot = join(dir, 'files')
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  ;({ useDb } = await import('../db'))
  schema = (await import('../db')).schema
  db = useDb()
  await seedDisk()
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('stored_file 回填', () => {
  it('扫描跳过 README 与系统/临时文件', async () => {
    const scanned = await scanFileStore(filesRoot)
    expect(scanned.map((f) => f.relPath).sort()).toEqual([
      'jxj/announcement/2022/公布.pdf',
      'jxj/announcement/2024/1/甬经信中小〔2024〕58号 通知.pdf',
      'jxj/announcement/2024/1/甬经信中小〔2024〕72号 通知.pdf',
      'miit/export/创新型中小企业导出Excel.xlsx',
    ])
  })

  it('回填写入分类与磁盘事实,并算出 SHA-256', async () => {
    const stats = await backfillFromDisk(db, filesRoot)
    expect(stats.inserted).toBe(4)
    expect(stats.skipped).toEqual([])

    const rows = db.select().from(schema.storedFile).all()
    expect(rows).toHaveLength(4)
    const notice = rows.find((r) => r.relPath.includes('72号'))!
    expect(notice).toMatchObject({
      source: 'jxj',
      kind: 'announcement',
      year: 2024,
      batch: 1,
      categoryState: 'set',
      parseState: 'unparsed',
    })
    expect(notice.ext).toBe('pdf')
    expect(notice.bytes).toBeGreaterThan(0)
    expect(notice.sha256).toMatch(/^[0-9a-f]{64}$/)

    // 目录给不出批次的文件:年份在、批次空。
    const gongbu = rows.find((r) => r.relPath.endsWith('公布.pdf'))!
    expect(gongbu).toMatchObject({ year: 2022, batch: null, categoryState: 'set' })

    // 导出表:无年份批次,但分类是定的。
    const exp = rows.find((r) => r.relPath.endsWith('.xlsx'))!
    expect(exp).toMatchObject({ year: null, batch: null, categoryState: 'set' })
  })

  it('回填幂等:再跑两次,行数不变', async () => {
    const before = db.select().from(schema.storedFile).all().length
    const second = await backfillFromDisk(db, filesRoot)
    const third = await backfillFromDisk(db, filesRoot)
    expect(second.inserted).toBe(0)
    expect(third.inserted).toBe(0)
    expect(second.unchanged + second.updated).toBe(4)
    expect(db.select().from(schema.storedFile).all().length).toBe(before)
  })

  it('回填不覆盖已被人工改过的分类(只刷新磁盘事实)', () => {
    const row = db.select().from(schema.storedFile).all().find((r) => r.relPath.includes('58号'))!
    updateStoredFile(db, row.id, { year: 2019 })
    backfillStoredFiles(db, [
      { relPath: row.relPath, filename: row.filename, ext: row.ext, bytes: 999, sha256: 'x'.repeat(64) },
    ])
    const after = db.select().from(schema.storedFile).all().find((r) => r.id === row.id)!
    expect(after.year).toBe(2019) // 分类保住了
    expect(after.bytes).toBe(999) // 磁盘事实刷新了
  })

  it('认不出分类的路径跳过并报出,不入表', () => {
    const stats = backfillStoredFiles(db, [
      { relPath: 'misc/random.pdf', filename: 'random.pdf', ext: 'pdf', bytes: 1, sha256: 'a'.repeat(64) },
    ])
    expect(stats.inserted).toBe(0)
    expect(stats.skipped).toEqual(['misc/random.pdf'])
    expect(db.select().from(schema.storedFile).all().some((r) => r.relPath === 'misc/random.pdf')).toBe(false)
  })
})

describe('PATCH 只改元数据', () => {
  it('改年份:rel_path 不变、磁盘文件不变、列表立刻反映', () => {
    const row = db.select().from(schema.storedFile).all().find((r) => r.relPath.includes('72号'))!
    const abs = join(filesRoot, row.relPath)
    const diskBefore = existsSync(abs)

    const updated = updateStoredFile(db, row.id, { year: 2021 })!
    expect(updated.year).toBe(2021)
    expect(updated.relPath).toBe(row.relPath)
    expect(updated.filename).toBe(row.filename)
    expect(updated.bytes).toBe(row.bytes)
    expect(updated.sha256).toBe(row.sha256)
    expect(existsSync(abs)).toBe(diskBefore)

    // 列表按筛选立刻拿到新值。
    const listed = listStoredFiles(db, { q: '72号' }).rows[0]!
    expect(listed.year).toBe(2021)

    // 还原,免得影响后面的断言。
    updateStoredFile(db, row.id, { year: 2024 })
  })

  it('补齐分类后 unset 自动提升为 set;清空则退回 unset', () => {
    const id = db
      .insert(schema.storedFile)
      .values({
        relPath: 'jxj/announcement/2027/1/待定.pdf',
        filename: '待定.pdf',
        ext: 'pdf',
        bytes: 10,
        sha256: 'b'.repeat(64),
        source: 'jxj',
        kind: 'announcement',
        year: null,
        categoryState: 'unset',
      })
      .returning({ id: schema.storedFile.id })
      .get().id

    expect(updateStoredFile(db, id, { year: 2027 })!.categoryState).toBe('set')
    expect(updateStoredFile(db, id, { year: null })!.categoryState).toBe('unset')
  })

  it('parseMetadataPatch 只收票面允许的五个字段,其余一律拒掉', () => {
    // 磁盘事实不能改。
    expect(() => parseMetadataPatch({ relPath: 'x/y.pdf' })).toThrow(/不可修改/)
    expect(() => parseMetadataPatch({ bytes: 1 })).toThrow(/不可修改/)
    expect(() => parseMetadataPatch({ sha256: 'x' })).toThrow(/不可修改/)
    // 状态不是元数据,由分类补齐 / 解析管线维持,也不许手改(票 09 只给这五项)。
    expect(() => parseMetadataPatch({ categoryState: 'set' })).toThrow(/不可修改/)
    expect(() => parseMetadataPatch({ parseState: 'parsed' })).toThrow(/不可修改/)
    // 取值校验。
    expect(() => parseMetadataPatch({ source: 'other' })).toThrow(/白名单/)
    expect(() => parseMetadataPatch({ kind: 'other' })).toThrow(/白名单/)
    expect(() => parseMetadataPatch({ year: 24 })).toThrow(/四位/)
    expect(() => parseMetadataPatch({ batch: 0 })).toThrow(/正整数/)
    expect(() => parseMetadataPatch({ titleCode: 'nope' })).toThrow(/白名单/)
    expect(() => parseMetadataPatch([])).toThrow()
  })

  it('解析合法 patch:空串视为清空', () => {
    expect(parseMetadataPatch({ source: '', year: '', batch: '', titleCode: '' })).toEqual({
      source: null,
      year: null,
      batch: null,
      titleCode: null,
    })
  })

  it('updateStoredFile 对不存在的 id 返回 null', () => {
    expect(updateStoredFile(db, 999999, { year: 2024 })).toBeNull()
  })
})

describe('列表与筛选', () => {
  it('按来源筛选', () => {
    expect(listStoredFiles(db, { source: ['miit'] }).rows.every((r) => r.source === 'miit')).toBe(true)
    expect(listStoredFiles(db, { source: ['jxj'] }).total).toBeGreaterThanOrEqual(3)
  })

  it('按分类状态筛选', () => {
    const unset = listStoredFiles(db, { categoryState: ['unset'] }).rows
    expect(unset.every((r) => r.categoryState === 'unset')).toBe(true)
    const set = listStoredFiles(db, { categoryState: ['set'] }).rows
    expect(set.every((r) => r.categoryState === 'set')).toBe(true)
    expect(set.length).toBeGreaterThan(0)
  })

  it('按文件名搜索', () => {
    const rows = listStoredFiles(db, { q: '58号' }).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]!.filename).toContain('58号')
  })

  it('排序:来源(经信局先)→ 年份倒序 → 批次倒序,空值排最后', () => {
    const rows = listStoredFiles(db, { pageSize: 200 }).rows
    const sources = rows.map((r) => r.source)
    expect(sources.indexOf('jxj')).toBeLessThan(sources.indexOf('miit'))
    const jxjYears = rows.filter((r) => r.source === 'jxj' && r.year !== null).map((r) => r.year!)
    const sorted = [...jxjYears].sort((a, b) => b - a)
    expect(jxjYears).toEqual(sorted)
  })

  it('被引用数按 record_evidence.source_file 精确匹配计数', () => {
    const row = db.select().from(schema.storedFile).all().find((r) => r.relPath.includes('72号'))!
    const ev = db
      .insert(schema.enterprise)
      .values({ name: '引用测试', nameNorm: '引用测试' })
      .returning({ id: schema.enterprise.id })
      .get().id
    const rec = db
      .insert(schema.record)
      .values({ enterpriseId: ev, titleCode: 'specialized_sme', source: 'jxj' })
      .returning({ id: schema.record.id })
      .get().id
    const recEvent = db
      .insert(schema.recordEvent)
      .values({ recordId: rec, eventType: 'award', year: 2024, batchSeq: 1 })
      .returning({ id: schema.recordEvent.id })
      .get().id
    db.insert(schema.recordEvidence)
      .values([
        { recordEventId: recEvent, sourceFile: row.relPath },
        // 近似的路径**不算**:必须精确匹配。
        { recordEventId: recEvent, sourceFile: `${row.relPath}.bak` },
      ])
      .run()

    expect(listStoredFiles(db, { q: '72号' }).rows[0]!.referenceCount).toBe(1)
  })
})

describe('DELETE 默认不删磁盘', () => {
  it('移出只打标;显式 deleteDisk 才删盘', async () => {
    const keep = db.select().from(schema.storedFile).all().find((r) => r.relPath.includes('58号'))!
    const keepAbs = join(filesRoot, keep.relPath)

    const soft = await removeStoredFile(db, filesRoot, keep.id)!
    expect(soft!.diskDeleted).toBe(false)
    expect(existsSync(keepAbs)).toBe(true)
    // 默认列表不再显示它。
    expect(listStoredFiles(db, {}).rows.some((r) => r.id === keep.id)).toBe(false)
    expect(listStoredFiles(db, { includeRemoved: true }).rows.some((r) => r.id === keep.id)).toBe(true)

    const doomed = db.select().from(schema.storedFile).all().find((r) => r.relPath.endsWith('.xlsx'))!
    const doomedAbs = join(filesRoot, doomed.relPath)
    const hard = await removeStoredFile(db, filesRoot, doomed.id, { deleteDisk: true })
    expect(hard!.diskDeleted).toBe(true)
    expect(existsSync(doomedAbs)).toBe(false)

    // 回填不会把移出的文件又插回来。
    const again = await backfillFromDisk(db, filesRoot)
    expect(again.inserted).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. 对真实文件库的验收核对
// ---------------------------------------------------------------------------

describe('对真实 files/ 的验收:23 个文件逐个对得上', () => {
  it('回填恰好 23 行,且元数据与目录规则一致', async () => {
    // vitest 的工作目录就是 app 根,files/ 是仓库里的真实文件库。
    const realRoot = join(process.cwd(), 'files')
    const scanned = await scanFileStore(realRoot)
    expect(scanned).toHaveLength(23)

    // 逐个按规则算一遍,再与「目录规则」人工核对的期望值比。
    const derived = scanned.map((f) => {
      const parts = deriveParts(f.relPath)!
      return {
        rel: f.relPath,
        source: parts.source,
        kind: parts.kind,
        year: parts.year,
        batch: parts.batch,
        state: categoryStateOf(parts),
      }
    })

    // 全部认得出分类(没有一个落到 skipped)。
    expect(derived.every((d) => d.source && d.kind)).toBe(true)

    // 分布核对:20 份经信局公布文件 + 3 份工信部导出表。
    expect(derived.filter((d) => d.source === 'jxj')).toHaveLength(20)
    expect(derived.filter((d) => d.source === 'miit')).toHaveLength(3)

    // 年份分布(按目录):2022×2、2023×6、2024×5、2025×4、2026×3、miit×3(无年份)。
    const byYear = new Map<number | null, number>()
    for (const d of derived) byYear.set(d.year, (byYear.get(d.year) ?? 0) + 1)
    expect(byYear.get(2022)).toBe(2)
    expect(byYear.get(2023)).toBe(6)
    expect(byYear.get(2024)).toBe(5)
    expect(byYear.get(2025)).toBe(4)
    expect(byYear.get(2026)).toBe(3)
    expect(byYear.get(null)).toBe(3)

    // 两份 2022 的目录里没有批次段 → 批次为空(不是补出来的)。
    const y2022 = derived.filter((d) => d.year === 2022)
    expect(y2022.every((d) => d.batch === null)).toBe(true)

    // 批次只可能是 1 或 2(目录里只出现这两个批次目录)。
    const batches = new Set(derived.filter((d) => d.batch !== null).map((d) => d.batch))
    expect([...batches].sort()).toEqual([1, 2])

    // 全部 23 个「分类已定」(含 3 份导出表与 2 份无批次的年份公布文件)。
    expect(derived.every((d) => d.state === 'set')).toBe(true)
  })
})
