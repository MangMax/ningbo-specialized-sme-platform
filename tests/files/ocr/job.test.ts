import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseOcrParams, runOcr } from '../../../server/utils/jobs/ocr'
import { listOcrResults, writeOcrResult } from '../../../server/utils/ocr-result'
import {
  DEFAULT_OCR_OPTIONAL_PAYLOAD,
  ocrRequestVariant,
  pagesFromJsonl,
  resolveOcrConfig,
} from '../../../server/utils/ocr-api'
import { ocrPageCacheDirAbs, ocrPageCacheKey } from '../../../server/utils/ocr-page-cache'
import { DEFAULT_DPI } from '../../../lib/pdf-page'
import { renderPdfPages } from '../../../server/utils/pdf-pages'
import { minimalPdf } from '../../helpers/minimal-pdf'
import { startMiniOcrApi, type MiniOcrApi } from '../../helpers/ocr-mini-api'
import { createJob, markJobRunning } from '../../../server/utils/job-store'
import { newJobId } from '../../../lib/job'

/**
 * 票 14 通路 a —— **在线 PaddleOCR API**(异步、可批量)。
 *
 * 这里用 `tests/helpers/ocr-mini-api.ts` 起一个**形状照官方 SDK 抄**的本地假服务,
 * 把「PDF 先渲染增强 → 每张 PNG 独立提交 multipart → 轮询状态 → 按源页号入库」整条路真走一遍 HTTP。
 * 所以这个文件验的是**协议与编排**,不是「函数被调用了」:
 *  - 每个 Paddle job 只提交一张 `image/png`,并带 `file`、`model` 与 `Authorization: Bearer`;
 *  - `pending/running` 时会继续轮询(`doneAfterPolls: 2` 演中间态);
 *  - `failed` 时把服务端的 `errorMsg` 原样报出来;
 *  - 结果按 `layoutParsingResults[].markdown.text` 逐页切(与官方 `_poller.py` 同一形状)。
 *
 * **真 token 的真实外网调用**不进单测(它花钱、看网络、结果会变);那一次实跑的证据
 * 写在票里,脚本与口径与本文件一致。
 */

let dir: string
let filesDir: string
let db: ReturnType<(typeof import('../../../db'))['useDb']>
let schema: typeof import('../../../db')['schema']
let api: MiniOcrApi | null = null

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-ocr-job-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  filesDir = join(dir, 'files')
  process.env.NUXT_FILES_DIR = filesDir
  await mkdir(filesDir, { recursive: true })
  const mod = await import('../../../db')
  db = mod.initializeDb({ create: true })
  schema = mod.schema
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.NUXT_FILES_DIR
  delete process.env.NUXT_DB_PATH
})

beforeEach(async () => {
  db.delete(schema.job).run()
  db.delete(schema.serviceCredential).run()
  db.delete(schema.ocrResult).run()
  db.delete(schema.storedFile).run()
  // 页图与「成功页中转」都是派生缓存,会留在盘上跨用例。不清的话,后面某个用例
  // 会用前面同一张页图 + 同一模型命中缓存 —— 于是它一次都不提交,断言全是假的。
  await rm(filesDir, { recursive: true, force: true })
  await mkdir(filesDir, { recursive: true })
  // token 与地址都从环境变量读(见 `resolveOcrConfig`)—— 测试不碰真服务。
  process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN = 'test-token'
  delete process.env.NUXT_OCR_TOKEN
})

afterEach(async () => {
  await api?.close()
  api = null
  delete process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN
  delete process.env.NUXT_OCR_BASE_URL
  delete process.env.PADDLEOCR_MCP_AISTUDIO_BASE_URL
})

/** 登记文件 + 在磁盘上放一份真 PDF(3 页)。 */
async function seedPdf(relPath: string, pages = 3): Promise<number> {
  const abs = join(filesDir, relPath)
  await mkdir(dirname(abs), { recursive: true })
  const bytes = minimalPdf({ pages })
  await writeFile(abs, bytes)
  const base = relPath.split('/').pop()!
  return db
    .insert(schema.storedFile)
    .values({
      relPath,
      filename: base,
      ext: 'pdf',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      source: 'jxj',
      kind: 'announcement',
      categoryState: 'set',
    })
    .returning({ id: schema.storedFile.id })
    .get().id
}

/** 跑一次 ocr 任务,附上 ctx。 */
function ctxOf(overrides: { cancelled?: () => boolean; onProgress?: (done: number, total: number) => void } = {}) {
  const seen: Array<[number, number]> = []
  // Paid submissions require a durable running task, just like the public
  // runner. Retain every existing protocol/cache assertion with that real row.
  const jobId = newJobId()
  createJob(db, { id: jobId, kind: 'ocr', params: {} })
  markJobRunning(db, jobId)
  return {
    seen,
    ctx: {
      jobId,
      filesDir,
      db,
      progress: (done: number, total: number) => { seen.push([done, total]); overrides.onProgress?.(done, total) },
      cancelled: overrides.cancelled ?? (() => false),
    },
  }
}

describe('ocr 任务的参数校验(纯函数,提交时跑)', () => {
  it('files 非空、必须是 PDF;model 给成非字符串就报错', () => {
    expect(parseOcrParams({}).ok).toBe(false)
    expect(parseOcrParams({ files: [] }).ok).toBe(false)
    expect(parseOcrParams({ files: [1] }).ok).toBe(false)
    const notPdf = parseOcrParams({ files: ['jxj/announcement/2024/1/x.docx'] })
    expect(notPdf.ok).toBe(false)
    if (!notPdf.ok) expect(notPdf.message).toContain('只吃 PDF')
    expect(parseOcrParams({ files: ['a.pdf'], model: 3 }).ok).toBe(false)

    const good = parseOcrParams({ files: [' jxj/a.pdf '], model: ' PaddleOCR-VL-1.6 ' })
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(good.params).toEqual({ files: ['jxj/a.pdf'], model: 'PaddleOCR-VL-1.6' })
  })

  it('★ 显式拒掉 pageRanges(只识别某几页会让页码静默错位)', () => {
    const r = parseOcrParams({ files: ['a.pdf'], pageRanges: '3-5' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('pageRanges')
      expect(r.message).toContain('页码')
    }
    expect(parseOcrParams({ files: ['a.pdf'], pages: '1' }).ok).toBe(false)
    expect(parseOcrParams({ files: ['a.pdf'], range: '1-2' }).ok).toBe(false)
    // 空值不算「用了」这个参数。
    expect(parseOcrParams({ files: ['a.pdf'], pageRanges: '' }).ok).toBe(true)
  })
})

describe('通路 a:批量 OCR(本地假服务,真走 HTTP)', () => {
  const relA = 'jxj/announcement/2024/1/72号.pdf'
  const relB = 'jxj/announcement/2024/1/166号.pdf'
  const pages = [
    '# 宁波市经济和信息化局文件\n\n甬经信中小〔2024〕72号',
    '### 附件1\n\n| 序号 | 属地 | 企业名称 |\n| --- | --- | --- |\n| 1 | 海曙区 | 宁波甲科技有限公司 |',
    '### 附件2\n\n| 序号 | 属地 | 企业名称 |\n| --- | --- | --- |\n| 1 | 北仑区 | 宁波丙新材料有限公司 |',
  ]

  it('文件级背压:远端前两份未完成时第三份不启动;完成后按输入顺序读回', async () => {
    const files = Array.from({ length: 4 }, (_, i) => `jxj/announcement/2024/1/背压${i}.pdf`)
    const ids: number[] = []
    for (const file of files) {
      ids.push(await seedPdf(file, 1))
      await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI })
    }
    let releasePoll!: () => void
    const pollGate = new Promise<void>((resolve) => { releasePoll = resolve })
    api = await startMiniOcrApi({ pages: ['原文🙂'], waitForPoll: () => pollGate })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const { ctx, seen } = ctxOf()
    const running = runOcr(ctx, { files, model: null })
    try {
      for (let i = 0; i < 200 && api.stats.submits < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(api.stats.submits).toBe(2)
    } finally {
      releasePoll()
    }
    const completion = await running
    expect(completion.error).toBeUndefined()
    const result = completion.result as { files: Array<{ file: string; ok: boolean; pages: number }>; pages: number }
    expect(result.files.map(outcome => outcome.file)).toEqual(files)
    expect(result.files.map(outcome => [outcome.ok, outcome.pages])).toEqual([[true, 1], [true, 1], [true, 1], [true, 1]])
    expect(result.pages).toBe(4)
    expect(api.stats.submits).toBe(4)
    expect(seen).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]])
    for (const id of ids) expect(listOcrResults(db, id).map(row => [row.page, row.markdown])).toEqual([[1, '原文🙂']])
  }, 60_000)

  it('取消后的新任务只补排队文件:已完成页缓存复用,正式结果不重复', async () => {
    const files = Array.from({ length: 4 }, (_, i) => `jxj/announcement/2024/1/续跑${i}.pdf`)
    const ids: number[] = []
    for (const file of files) {
      ids.push(await seedPdf(file, 1))
      await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI })
    }
    api = await startMiniOcrApi({ pages: ['续跑原文🙂'] })
    process.env.NUXT_OCR_BASE_URL = api.origin
    let cancel = false
    const first = await runOcr(ctxOf({ cancelled: () => cancel, onProgress: () => { cancel = true } }).ctx, { files, model: null })
    expect(first.cancelled).toBe(true)
    const partial = first.result as { done: number; files: Array<{ file: string }> }
    expect(partial.done).toBeGreaterThanOrEqual(1)
    expect(partial.done).toBeLessThanOrEqual(2)
    expect([[files[0]], [files[1]], [files[0], files[1]]]).toContainEqual(partial.files.map(outcome => outcome.file))
    expect(api.stats.submits).toBeLessThanOrEqual(2)
    for (const id of ids.slice(2)) expect(listOcrResults(db, id)).toEqual([])

    const submitsBeforeResume = api.stats.submits
    const resumed = await runOcr(ctxOf().ctx, { files, model: null })
    expect(resumed.error).toBeUndefined()
    const final = resumed.result as { files: Array<{ file: string; cachedPages: number }> }
    expect(final.files.map(outcome => outcome.file)).toEqual(files)
    expect(final.files.filter(outcome => partial.files.some(done => done.file === outcome.file)).every(outcome => outcome.cachedPages === 1)).toBe(true)
    expect(api.stats.submits - submitsBeforeResume).toBe(4 - final.files.filter(outcome => outcome.cachedPages === 1).length)
    for (const id of ids) expect(listOcrResults(db, id).map(row => [row.page, row.markdown])).toEqual([[1, '续跑原文🙂']])
  }, 60_000)

  it('一份文件失败后继续处理排队文件,逐项结果仍按输入顺序报告', async () => {
    const missing = 'jxj/announcement/2024/1/未入库.pdf'
    const good = ['jxj/announcement/2024/1/后续甲.pdf', 'jxj/announcement/2024/1/后续乙.pdf']
    for (const file of good) {
      await seedPdf(file, 1)
      await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI })
    }
    api = await startMiniOcrApi({ pages: ['后续原文'] })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const { ctx, seen } = ctxOf()
    const completion = await runOcr(ctx, { files: [missing, ...good], model: null })
    expect(completion.error).toContain('3 份里 1 份识别失败')
    const result = completion.result as { files: Array<{ file: string; ok: boolean; error?: string }>; ok: number; failed: number }
    expect(result.files.map(outcome => [outcome.file, outcome.ok])).toEqual([[missing, false], [good[0], true], [good[1], true]])
    expect(result.files[0]?.error).toContain('stored_file')
    expect([result.ok, result.failed]).toEqual([2, 1])
    expect(api.stats.submits).toBe(2)
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]])
  }, 60_000)

  it('★ 批量:一次提交两份 → 并发识别并按页码入库,进度按份报', async () => {
    const idA = await seedPdf(relA)
    const idB = await seedPdf(relB)
    await renderPdfPages(filesDir, relA, { dpi: DEFAULT_DPI })
    await renderPdfPages(filesDir, relB, { dpi: DEFAULT_DPI })
    expect(
      writeOcrResult(db, {
        fileId: idA,
        pages: [
          { page: 1, markdown: '旧的整份 PDF OCR 结果' },
          { page: 4, markdown: '旧结果残页' },
        ],
        channel: 'api',
        model: 'legacy-pdf-upload',
      }).ok,
    ).toBe(true)
    api = await startMiniOcrApi({
      pages,
      expectModel: 'PaddleOCR-VL-1.6',
      doneAfterPolls: 2,
      pollDelayMsByPage: { 1: 30 },
    })
    process.env.NUXT_OCR_BASE_URL = api.origin

    const parsed = parseOcrParams({ files: [relA, relB] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const { ctx, seen } = ctxOf()

    const completion = await runOcr(ctx, parsed.params)
    expect(completion.error).toBeUndefined()

    const result = completion.result as {
      total: number
      ok: number
      failed: number
      pages: number
      channel: string
      files: Array<{
        file: string
        ok: true
        fileId: number
        pages: number
        renderedPageImages: number
        engine: string
        model: string
        apiJobIds: string[]
        elapsedMs: number
      }>
    }
    expect(result.channel).toBe('api')
    expect([result.total, result.ok, result.failed]).toEqual([2, 2, 0])
    expect(result.pages).toBe(6)
    expect(result.files.map((f) => f.pages)).toEqual([3, 3])
    // 引擎与模型如实落进产出(便于回看「这批是什么引擎跑的」)。
    expect(result.files[0]!.engine).toBe('paddleocr')
    expect(result.files[0]!.model).toBe('PaddleOCR-VL-1.6')
    expect(result.files[0]!.renderedPageImages).toBe(3)
    expect(result.files[0]!.apiJobIds).toHaveLength(3)

    // 两份文件各自入库,页号 1..3,内容就是假服务给的那三段。
    for (const [fileId, file] of [
      [idA, result.files[0]!],
      [idB, result.files[1]!],
    ] as const) {
      const rows = listOcrResults(db, fileId)
      expect(rows.map((r) => r.page)).toEqual(fileId === idA ? [1, 2, 3, 4] : [1, 2, 3])
      expect(rows.filter(r => r.page <= 3).map((r) => r.markdown)).toEqual(pages)
      if (fileId === idA) expect(rows[3]!.markdown).toBe('旧结果残页')
      expect(rows[0]!.channel).toBe('api')
      expect(rows[0]!.model).toBe('PaddleOCR-VL-1.6')
      expect(rows[1]!.pageRelPath).toContain('.pages/p002.png')
      expect(file.fileId).toBe(fileId)
    }

    // 进度按「份」报:每做完一份一次。
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ])
    // 真的走了提交 / 轮询 / 取结果三趟,且带了 token。
    expect(api.stats.submits).toBe(6)
    expect(api.stats.pngUploads).toBe(6)
    expect(api.stats.pdfUploads).toBe(0)
    expect(api.stats.polls).toBe(12)
    expect(api.stats.jsonlFetches).toBe(6)
    // The two PDF file groups overlap instead of serially waiting page-by-page.
    expect(api.stats.maxActiveJobs).toBeGreaterThan(1)
    expect(api.stats.activeJobs).toBe(0)
    // 提交与轮询都带上了 token;取结果那一步**不带**(官方给的是预签名对象存储链接,
    // 带 Authorization 反而可能被拒)—— 所以只看非空的那几次。
    expect(new Set(api.authSeen.filter(Boolean))).toEqual(new Set(['Bearer test-token']))
    expect(api.authSeen.filter(Boolean)).toHaveLength(18) // 6 张 PNG 各 1 次提交与 2 次轮询
  }, 60_000)

  it('服务端 `running` 时继续轮询,直到 `done`(异步语义)', async () => {
    await seedPdf(relA)
    await renderPdfPages(filesDir, relA, { dpi: DEFAULT_DPI })
    api = await startMiniOcrApi({ pages, doneAfterPolls: 2 })
    process.env.NUXT_OCR_BASE_URL = api.origin

    const parsed = parseOcrParams({ files: [relA] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const { ctx } = ctxOf()
    const completion = await runOcr(ctx, parsed.params)
    expect(completion.error).toBeUndefined()
    // 第一次是 running(有 extractProgress),第二次才 done。
    expect(api.stats.polls).toBe(6)
  }, 60_000)

  it('服务端报 failed → 逐项 ok:false 带服务端原话,任务记 failed', async () => {
    await seedPdf(relA, 1)
    await renderPdfPages(filesDir, relA, { dpi: DEFAULT_DPI })
    api = await startMiniOcrApi({ pages, failWith: '页数超出套餐额度' })
    process.env.NUXT_OCR_BASE_URL = api.origin

    const parsed = parseOcrParams({ files: [relA] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const { ctx } = ctxOf()
    const completion = await runOcr(ctx, parsed.params)

    expect(completion.error).toContain('1 份里 1 份识别失败')
    const result = completion.result as { files: Array<{ ok: false; error: string }> }
    expect(result.files[0]!.ok).toBe(false)
    expect(result.files[0]!.error).toContain('页数超出套餐额度')
    // 失败了就不该有半截结果落库。
    expect(db.select().from(schema.ocrResult).all()).toHaveLength(0)
  }, 60_000)

  it('文件库里没有这份文件 → 这一项失败并说明先回填 stored_file', async () => {
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const parsed = parseOcrParams({ files: ['jxj/announcement/2024/1/不在库.pdf'] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const { ctx } = ctxOf()
    const completion = await runOcr(ctx, parsed.params)
    const result = completion.result as { files: Array<{ ok: false; error: string }> }
    expect(result.files[0]!.error).toContain('stored_file')
    // 都没提交出去。
    expect(api.stats.submits).toBe(0)
  }, 60_000)

  it('未渲染页图时拒绝提交,不把源 PDF 直接发给 Paddle', async () => {
    const relShort = 'jxj/announcement/2024/1/未渲染.pdf'
    await seedPdf(relShort, 2)
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin

    const parsed = parseOcrParams({ files: [relShort] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const completion = await runOcr(ctxOf().ctx, parsed.params)
    const result = completion.result as { files: Array<{ ok: false; error: string }> }

    expect(result.files[0]!.error).toContain('请先提交 render-pages')
    expect(api.stats.submits).toBe(0)
    expect(api.stats.pdfUploads).toBe(0)
  }, 60_000)

  it('只有低于 300 DPI 的页图时拒绝 OCR,要求先重渲染到默认分辨率', async () => {
    const relShort = 'jxj/announcement/2024/1/旧分辨率.pdf'
    await seedPdf(relShort, 2)
    await renderPdfPages(filesDir, relShort, { dpi: 200 })
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin

    const parsed = parseOcrParams({ files: [relShort] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const completion = await runOcr(ctxOf().ctx, parsed.params)
    const result = completion.result as { files: Array<{ ok: false; error: string }> }

    expect(result.files[0]!.error).toContain('300 DPI')
    expect(api.stats.submits).toBe(0)
  }, 60_000)

  it('默认改为 300 DPI 后仍接受完整的旧 400 DPI 页图', async () => {
    const relHigh = 'jxj/announcement/2024/1/现有400dpi.pdf'
    const fileId = await seedPdf(relHigh, 2)
    await renderPdfPages(filesDir, relHigh, { dpi: 400 })
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin

    const parsed = parseOcrParams({ files: [relHigh] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const completion = await runOcr(ctxOf().ctx, parsed.params)
    const result = completion.result as { files: Array<{ ok: boolean; renderedPageImages: number }> }

    expect(completion.error).toBeUndefined()
    expect(result.files[0]).toMatchObject({ ok: true, renderedPageImages: 2 })
    expect(listOcrResults(db, fileId).map((row) => row.page)).toEqual([1, 2])
    expect(api.stats.submits).toBe(2)
  }, 60_000)

  it('第 2 张 PNG 失败时不写半份新结果,保留上一版 OCR', async () => {
    const relShort = 'jxj/announcement/2024/1/逐页失败.pdf'
    const fileId = await seedPdf(relShort, 3)
    await renderPdfPages(filesDir, relShort, { dpi: DEFAULT_DPI })
    writeOcrResult(db, {
      fileId,
      pages: [
        { page: 1, markdown: '上一版第一页' },
        { page: 5, markdown: '上一版残留页' },
      ],
      channel: 'upload',
    })
    api = await startMiniOcrApi({ pages, failOnPage: { page: 2, message: '第二页服务失败' } })
    process.env.NUXT_OCR_BASE_URL = api.origin

    const parsed = parseOcrParams({ files: [relShort] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const completion = await runOcr(ctxOf().ctx, parsed.params)
    const result = completion.result as { files: Array<{ ok: false; error: string }> }

    expect(result.files[0]!.error).toContain('第 2 页 OCR 失败:OCR 任务失败:第二页服务失败')
    expect(listOcrResults(db, fileId).map((row) => [row.page, row.markdown])).toEqual([
      [1, '上一版第一页'],
      [5, '上一版残留页'],
    ])
    // Page 3 must still finish even though page 2 failed; all started page jobs settle before reporting.
    expect(api.stats.submits).toBe(3)
    expect(api.stats.pdfUploads).toBe(0)
  }, 60_000)

  it('★ 没配 token:动手之前就报一句人话,一份都不提交', async () => {
    await seedPdf(relA)
    delete process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin

    const parsed = parseOcrParams({ files: [relA] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const { ctx } = ctxOf()
    await expect(runOcr(ctx, parsed.params)).rejects.toThrow(/NUXT_OCR_TOKEN/)
    expect(api.stats.submits).toBe(0)
  }, 60_000)

  it('取消:在第一份之前就置标记 → 不提交,带 cancelled 收尾', async () => {
    await seedPdf(relA)
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const parsed = parseOcrParams({ files: [relA] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const { ctx } = ctxOf({ cancelled: () => true })
    const completion = await runOcr(ctx, parsed.params)
    expect(completion.cancelled).toBe(true)
    const result = completion.result as { cancelled?: boolean; done?: number }
    expect(result.cancelled).toBe(true)
    expect(result.done).toBe(0)
    expect(api.stats.submits).toBe(0)
  }, 60_000)
})

describe('ocr-api 的纯解析件', () => {
  it('JSONL 按 `layoutParsingResults[].markdown.text` 平铺成页,页号从 1 起', () => {
    const jsonl = [
      JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: 'p1' } }, { markdown: { text: 'p2' } }] } }),
      JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: 'p3' } }] } }),
    ].join('\n')
    expect(pagesFromJsonl(jsonl).map((p) => [p.page, p.markdown])).toEqual([
      [1, 'p1'],
      [2, 'p2'],
      [3, 'p3'],
    ])
  })

  it('形状不对(不是文档解析模型)时明确报错,不静默给空结果', () => {
    const bad = JSON.stringify({ result: { ocrResults: [] } })
    expect(() => pagesFromJsonl(bad)).toThrow(/layoutParsingResults/)
  })

  it('resolveOcrConfig:token 依次取 NUXT_OCR_TOKEN → MCP 同名变量;地址可覆盖', () => {
    const saved = { ...process.env }
    try {
      delete process.env.NUXT_OCR_TOKEN
      delete process.env.NUXT_OCR_BASE_URL
      delete process.env.PADDLEOCR_MCP_AISTUDIO_BASE_URL
      process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN = 'from-mcp'
      expect(resolveOcrConfig().token).toBe('from-mcp')
      expect(resolveOcrConfig().baseUrl).toBe('https://paddleocr.aistudio-app.com')

      process.env.NUXT_OCR_TOKEN = 'from-nuxt'
      expect(resolveOcrConfig().token).toBe('from-nuxt')
      // 显式给的最优先。
      expect(resolveOcrConfig({ token: 'explicit' }).token).toBe('explicit')

      process.env.PADDLEOCR_MCP_AISTUDIO_BASE_URL = 'http://127.0.0.1:9/'
      expect(resolveOcrConfig().baseUrl).toBe('http://127.0.0.1:9/')
      // 一颗 token 都没有时是空串(调用方据此报「没配」),不是 undefined。
      delete process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN
      delete process.env.NUXT_OCR_TOKEN
      expect(resolveOcrConfig().token).toBe('')
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
})

/**
 * 票 14 断点续跑 —— **成功页中转**(`server/utils/ocr-page-cache.ts`)。
 *
 * 实证的故障:并发提交时 Paddle 会回 HTTP 429,而 4xx **不自动重试**;`runOcr` 原本把
 * 成功页只留在内存、`persistPages` 只在全页成功时跑一次,于是「12 页成功 7 页、5 页 429」
 * 的下一步是**整份重跑、把那 7 页再发一遍** —— 而重跑正是最容易再次限流的动作。
 *
 * 下面用本地假服务在**真实的 PNG 边界**上验四件事:
 *  1. 部分失败时正式库(`ocr_result`)**不半份替换**,成功页进中转;
 *  2. **重跑只请求失败页**,补齐后整份**原子写入**(页码 / 内容 / 模型 / raw 都对);
 *  3. 页图内容、模型、影响识别结果的有效选项任一变了 ⇒ 中转失效,整份重识别;
 *  4. 取消不留半份结果;缓存条目损坏当未命中重识别。
 */
describe('成功页中转:部分失败后重跑只补失败页', () => {
  const pages = ['第一页正文', '第二页正文', '第三页正文']

  /** 一份 PDF 的中转里现有多少条有效条目(没有目录就是 0)。 */
  async function cacheFileCount(relPath: string): Promise<number> {
    try {
      const names = await readdir(ocrPageCacheDirAbs(filesDir, relPath))
      return names.filter((n) => n.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  it('★ 部分成功一页失败:正式库不半份替换,成功页进中转,重跑只请求失败页', async () => {
    const rel = 'jxj/announcement/2024/1/续跑.pdf'
    const fileId = await seedPdf(rel, 3)
    await renderPdfPages(filesDir, rel, { dpi: DEFAULT_DPI })
    // 上一版整份结果:部分失败时必须**原样保留**,不能被半份新结果替掉。
    writeOcrResult(db, {
      fileId,
      pages: [
        { page: 1, markdown: '上一版第一页' },
        { page: 5, markdown: '上一版残留页' },
      ],
      channel: 'upload',
    })

    // 第 1 轮:第 2 页失败(模拟 Paddle 429),第 1、3 页成功。
    api = await startMiniOcrApi({
      pages,
      failOnPage: { page: 2, message: '请求频率过高，请稍后重试' },
    })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const parsed = parseOcrParams({ files: [rel] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const first = await runOcr(ctxOf().ctx, parsed.params)

    expect(first.error).toContain('1 份里 1 份识别失败')
    const firstFiles = (first.result as { files: Array<{ ok: boolean; error?: string }> }).files
    expect(firstFiles[0]!.ok).toBe(false)
    expect(firstFiles[0]!.error).toContain('第 2 页 OCR 失败')
    // ① 正式库**没有被半份替换**:上一版两页一个字节都没动。
    expect(listOcrResults(db, fileId).map((r) => [r.page, r.markdown])).toEqual([
      [1, '上一版第一页'],
      [5, '上一版残留页'],
    ])
    // ② 成功的那两页已经进了中转 —— 不等全份成功。
    expect(await cacheFileCount(rel)).toBe(2)

    // 第 2 轮:换一个「服务正常」的假服务,它只该收到**失败的那一页**。
    await api.close()
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const second = await runOcr(ctxOf().ctx, parsed.params)

    expect(second.error).toBeUndefined()
    expect(api.stats.submits).toBe(1)
    expect(api.stats.pngUploads).toBe(1)
    expect((second.result as { files: Array<Record<string, unknown>> }).files[0]).toMatchObject({
      ok: true,
      pages: 3,
      renderedPageImages: 3,
      cachedPages: 2,
    })

    // #309 只发布实际目标页,未处理的第 5 页原样保留。
    const rows = db
      .select()
      .from(schema.ocrResult)
      .all()
      .sort((a, b) => a.pageNo - b.pageNo)
    expect(rows.map((r) => r.pageNo)).toEqual([1, 2, 3, 5])
    expect(rows.filter(r => r.pageNo <= 3).map((r) => r.markdown)).toEqual(pages)
    expect(rows[3]!.markdown).toBe('上一版残留页')
    expect(rows.filter(r => r.pageNo <= 3).every((r) => r.model === 'PaddleOCR-VL-1.6')).toBe(true)
    expect(rows.filter(r => r.pageNo <= 3).every((r) => r.channel === 'api')).toBe(true)
    expect(rows.filter(r => r.pageNo <= 3).every((r) => r.raw !== null && r.raw !== undefined)).toBe(true)
  }, 60_000)

  it('★ 同一份再跑一次:全命中,零提交,结果照旧整份写入', async () => {
    const rel = 'jxj/announcement/2024/1/全命中.pdf'
    const fileId = await seedPdf(rel, 2)
    await renderPdfPages(filesDir, rel, { dpi: DEFAULT_DPI })
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const parsed = parseOcrParams({ files: [rel] })
    if (!parsed.ok) throw new Error('参数本应通过')
    expect((await runOcr(ctxOf().ctx, parsed.params)).error).toBeUndefined()
    expect(api.stats.submits).toBe(2)
    await api.close()

    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const again = await runOcr(ctxOf().ctx, parsed.params)
    expect(again.error).toBeUndefined()
    expect(api.stats.submits).toBe(0)
    expect((again.result as { files: Array<Record<string, unknown>> }).files[0]).toMatchObject({
      ok: true,
      pages: 2,
      cachedPages: 2,
    })
    expect(listOcrResults(db, fileId).map((r) => [r.page, r.markdown])).toEqual([
      [1, pages[0]],
      [2, pages[1]],
    ])
  }, 60_000)

  it('★ 页图内容变了(重渲染到另一分辨率)⇒ 中转不命中,整份重识别', async () => {
    const rel = 'jxj/announcement/2024/1/换图.pdf'
    const fileId = await seedPdf(rel, 2)
    await renderPdfPages(filesDir, rel, { dpi: DEFAULT_DPI })
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const parsed = parseOcrParams({ files: [rel] })
    if (!parsed.ok) throw new Error('参数本应通过')
    expect((await runOcr(ctxOf().ctx, parsed.params)).error).toBeUndefined()
    expect(api.stats.submits).toBe(2)
    await api.close()

    // 换分辨率重渲染 ⇒ 页图字节变了 ⇒ sha256 变了 ⇒ 旧条目不再是同一页。
    await renderPdfPages(filesDir, rel, { dpi: 400 })
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const again = await runOcr(ctxOf().ctx, parsed.params)
    expect(again.error).toBeUndefined()
    expect(api.stats.submits).toBe(2)
    expect((again.result as { files: Array<{ cachedPages: number }> }).files[0]!.cachedPages).toBe(0)
    expect(listOcrResults(db, fileId).map((r) => r.page)).toEqual([1, 2])
  }, 60_000)

  it('★ 换模型 ⇒ 中转不命中,整份重识别;换回原模型仍命中', async () => {
    const rel = 'jxj/announcement/2024/1/换模型.pdf'
    const fileId = await seedPdf(rel, 2)
    await renderPdfPages(filesDir, rel, { dpi: DEFAULT_DPI })
    const parsed = parseOcrParams({ files: [rel] })
    if (!parsed.ok) throw new Error('参数本应通过')

    api = await startMiniOcrApi({ pages, expectModel: 'PaddleOCR-VL-1.6' })
    process.env.NUXT_OCR_BASE_URL = api.origin
    expect((await runOcr(ctxOf().ctx, parsed.params)).error).toBeUndefined()
    expect(api.stats.submits).toBe(2)
    await api.close()

    // 换模型:同一张页图,另一个模型可能给出不同结果 ⇒ 必须重识别。
    const alt = parseOcrParams({ files: [rel], model: 'Other-VL-9' })
    if (!alt.ok) throw new Error('参数本应通过')
    api = await startMiniOcrApi({ pages, expectModel: 'Other-VL-9' })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const swapped = await runOcr(ctxOf().ctx, alt.params)
    expect(swapped.error).toBeUndefined()
    expect(api.stats.submits).toBe(2)
    expect(db.select().from(schema.ocrResult).all().every((r) => r.model === 'Other-VL-9')).toBe(true)
    await api.close()

    // 换回原模型:原模型那批中转还在 ⇒ 一次都不提交。
    api = await startMiniOcrApi({ pages, expectModel: 'PaddleOCR-VL-1.6' })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const back = await runOcr(ctxOf().ctx, parsed.params)
    expect(back.error).toBeUndefined()
    expect(api.stats.submits).toBe(0)
    expect((back.result as { files: Array<{ cachedPages: number }> }).files[0]!.cachedPages).toBe(2)
    expect(listOcrResults(db, fileId)).toHaveLength(2)
    expect(db.select().from(schema.ocrResult).all().every((r) => r.model === 'PaddleOCR-VL-1.6')).toBe(true)
  }, 60_000)

  it('★ 取消:不写半份结果、不动上一版,且之后仍能续跑补齐', async () => {
    const rel = 'jxj/announcement/2024/1/取消.pdf'
    const fileId = await seedPdf(rel, 3)
    await renderPdfPages(filesDir, rel, { dpi: DEFAULT_DPI })
    writeOcrResult(db, { fileId, pages: [{ page: 1, markdown: '上一版' }], channel: 'upload' })

    let cancel = false
    api = await startMiniOcrApi({
      pages,
      // 第一张 PNG 一提交就请求取消 —— 之后页池不再启动新请求。
      onSubmit: () => {
        cancel = true
      },
    })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const parsed = parseOcrParams({ files: [rel] })
    if (!parsed.ok) throw new Error('参数本应通过')
    const completion = await runOcr(ctxOf({ cancelled: () => cancel }).ctx, parsed.params)

    expect(completion.cancelled).toBe(true)
    expect((completion.result as { done?: number }).done).toBe(0)
    // 正式库:上一版原样保留,没有半份新结果。
    expect(listOcrResults(db, fileId).map((r) => [r.page, r.markdown])).toEqual([[1, '上一版']])

    // 取消不留死结:再跑一次(不取消)照样整份补齐。
    await api.close()
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const resumed = await runOcr(ctxOf().ctx, parsed.params)
    expect(resumed.error).toBeUndefined()
    expect(listOcrResults(db, fileId).map((r) => r.page)).toEqual([1, 2, 3])
  }, 60_000)

  it('★ 缓存条目损坏 ⇒ 当未命中重识别,不把坏数据当结果', async () => {
    const rel = 'jxj/announcement/2024/1/坏缓存.pdf'
    const fileId = await seedPdf(rel, 3)
    await renderPdfPages(filesDir, rel, { dpi: DEFAULT_DPI })
    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const parsed = parseOcrParams({ files: [rel] })
    if (!parsed.ok) throw new Error('参数本应通过')
    expect((await runOcr(ctxOf().ctx, parsed.params)).error).toBeUndefined()
    expect(api.stats.submits).toBe(3)
    await api.close()

    // 弄坏**其中一条**:坏的那页必须重识别,好的两页照旧命中。
    const cacheDir = ocrPageCacheDirAbs(filesDir, rel)
    const entries = (await readdir(cacheDir)).filter((n) => n.endsWith('.json'))
    expect(entries).toHaveLength(3)
    await writeFile(join(cacheDir, entries[0]!), '{ 这不是 JSON')

    api = await startMiniOcrApi({ pages })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const again = await runOcr(ctxOf().ctx, parsed.params)
    expect(again.error).toBeUndefined()
    expect(api.stats.submits).toBe(1)
    expect((again.result as { files: Array<{ cachedPages: number }> }).files[0]!.cachedPages).toBe(2)
    expect(listOcrResults(db, fileId).map((r) => [r.page, r.markdown])).toEqual(
      pages.map((markdown, i) => [i + 1, markdown]),
    )
  }, 60_000)
})

describe('中转命中判据(纯函数)', () => {
  it('ocrRequestVariant:同模型同选项稳定;模型或有效选项变则指纹变', () => {
    expect(ocrRequestVariant('m')).toBe(ocrRequestVariant('m'))
    expect(ocrRequestVariant('m')).not.toBe(ocrRequestVariant('m2'))
    // 「影响 OCR 的选项」就是实际发出的 optionalPayload —— 它一变,指纹必须变。
    const tweaked = { ...DEFAULT_OCR_OPTIONAL_PAYLOAD, temperature: 0.2 }
    expect(ocrRequestVariant('m')).not.toBe(ocrRequestVariant('m', tweaked))
  })

  it('ocrPageCacheKey:页图哈希或指纹任一不同 ⇒ key 不同', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(ocrPageCacheKey(a, 'v')).toBe(ocrPageCacheKey(a, 'v'))
    expect(ocrPageCacheKey(a, 'v')).not.toBe(ocrPageCacheKey(b, 'v'))
    expect(ocrPageCacheKey(a, 'v')).not.toBe(ocrPageCacheKey(a, 'v2'))
  })
})

it('uses saved credentials for new OCR runs while a running submit and poll retain their startup snapshot', async () => {
  const { updateCredential } = await import('../../../server/utils/credential-state')
  try {
    updateCredential('ocrToken', 'synthetic-start-value', { db, env: {} })
    const file = 'credential-snapshot.pdf'
    const credentialFileId = await seedPdf(file, 1)
    await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI })
    api = await startMiniOcrApi({ pages: ['# synthetic result'], onSubmit: () => {
      updateCredential('ocrToken', 'synthetic-replacement', { db, env: {} })
    } })
    process.env.NUXT_OCR_BASE_URL = api.origin
    const params = { files: [file], model: null }
    const first = await runOcr(ctxOf().ctx, params)
    expect(first.error).toBeUndefined()
    expect(api.authSeen.filter(Boolean).every(value => value === 'Bearer synthetic-start-value')).toBe(true)
    expect(api.stats.polls).toBeGreaterThan(0)
    expect(JSON.stringify({ params, result: first }).includes('synthetic-start-value')).toBe(false)
    expect(JSON.stringify(listOcrResults(db, credentialFileId)).includes('synthetic-start-value')).toBe(false)
    await api.close()
    api = await startMiniOcrApi({ pages: ['# second result'] })
    process.env.NUXT_OCR_BASE_URL = api.origin
    // Remove only derived cache so the next run makes an actual external request.
    await rm(ocrPageCacheDirAbs(filesDir, file), { recursive: true, force: true })
    expect((await runOcr(ctxOf().ctx, params)).error).toBeUndefined()
    expect(api.authSeen.filter(Boolean).every(value => value === 'Bearer synthetic-replacement')).toBe(true)
    expect(resolveOcrConfig({ token: 'synthetic-explicit' }).token === 'synthetic-explicit').toBe(true)
  } finally { db.delete(schema.serviceCredential).run() }
})
it('redacts credential echoes from external OCR failures before task results are persisted', async () => {
  const secret = 'synthetic-error-secret'
  process.env.NUXT_OCR_TOKEN = secret
  const rel = 'credential-error.pdf'
  await seedPdf(rel, 1)
  await renderPdfPages(filesDir, rel, { dpi: DEFAULT_DPI })
  api = await startMiniOcrApi({ pages: [], failWith: `authorization ${secret} rejected` })
  process.env.NUXT_OCR_BASE_URL = api.origin
  const result = await runOcr(ctxOf().ctx, { files: [rel], model: null })
  expect(result.error).toBeDefined()
  expect(JSON.stringify(result).includes(secret)).toBe(false)
})
it('fails closed with a sanitized error when the credential database is unavailable before OCR starts', async () => {
  db.$client.exec('ALTER TABLE service_credential RENAME TO unavailable_credential')
  try {
    await expect(runOcr(ctxOf().ctx, { files: ['unopened.pdf'], model: null })).rejects.toThrow('凭据配置存储不可用')
  } finally { db.$client.exec('ALTER TABLE unavailable_credential RENAME TO service_credential') }
})

it('queued OCR retains its submission credential for submit and poll without persisting it in job history', async () => {
  const { clearJobSpecs, registerJob, submitJob, whenIdle } = await import('../../../server/utils/job-runner')
  const { ocrSpec } = await import('../../../server/utils/jobs/ocr')
  const { getJob } = await import('../../../server/utils/job-store')
  const { updateCredential } = await import('../../../server/utils/credential-state')
  let release: (() => void) | undefined
  try {
    const file = 'queued-credential.pdf'
    await seedPdf(file, 1); await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI })
    api = await startMiniOcrApi({ pages: ['# queued synthetic result'] })
    process.env.NUXT_OCR_BASE_URL = api.origin
    updateCredential('ocrToken', 'synthetic-queued-ocr-A', { db, env: {} })
    clearJobSpecs(); registerJob(ocrSpec)
    registerJob({ kind: 'hold', status: 'ready', summary: 'synthetic gate', parse: () => ({ ok: true, params: {} }), run: async () => { await new Promise<void>(r => { release = r }); return { result: {} } } })
    submitJob(db, { kind: 'hold', params: {}, filesDir })
    const row = submitJob(db, { kind: 'ocr', params: { files: [file], model: null }, filesDir })
    updateCredential('ocrToken', 'synthetic-queued-ocr-B', { db, env: {} })
    release!(); release = undefined; await whenIdle()
    expect(getJob(db, row.id)?.state).toBe('done')
    expect(api.stats.submits).toBe(1)
    expect(api.stats.polls).toBeGreaterThan(0)
    expect(api.authSeen.filter(Boolean).every(value => value === 'Bearer synthetic-queued-ocr-A')).toBe(true)
    const text = JSON.stringify(getJob(db, row.id))
    expect(text.includes('synthetic-queued-ocr-A') || text.includes('synthetic-queued-ocr-B')).toBe(false)
  } finally { release?.(); await whenIdle(); db.delete(schema.serviceCredential).run(); clearJobSpecs() }
})

it.each([{ name: 'failed', failed: true }, { name: 'successful', failed: false }])('keeps encoded OCR credentials out of persisted job history and OCR rows ($name)', async ({ failed }) => {
  const { clearJobSpecs, registerJob, submitJob, whenIdle } = await import('../../../server/utils/job-runner')
  const { ocrSpec } = await import('../../../server/utils/jobs/ocr')
  const { getJob } = await import('../../../server/utils/job-store')
  const { updateCredential } = await import('../../../server/utils/credential-state')
  const token = 'synthetic-"quoted"\\+/=task-secret'
  const echoes = [token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1)]
  try {
    updateCredential('ocrToken', token, { db, env: {} })
    const file = 'encoded-echo.pdf'
    const fileId = await seedPdf(file, 1)
    await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI })
    const text = `echoes ${echoes.join(' | ')} end`
    api = await startMiniOcrApi({ pages: [text], ...(failed ? { failWith: text } : {}) })
    process.env.NUXT_OCR_BASE_URL = api.origin
    clearJobSpecs(); registerJob(ocrSpec)
    const submitted = submitJob(db, { kind: 'ocr', params: { files: [file] }, filesDir })
    await whenIdle()
    const job = getJob(db, submitted.id)
    expect(job?.state).toBe(failed ? 'failed' : 'done')
    expect(api.stats.submits).toBe(1)
    expect(api.stats.polls).toBeGreaterThan(0)
    expect(api.authSeen.filter(Boolean).every(value => value === `Bearer ${token}`)).toBe(true)
    const output = JSON.stringify({ job, ocr: listOcrResults(db, fileId) })
    expect(echoes.some(echo => output.includes(JSON.stringify(echo).slice(1, -1)))).toBe(false)
    expect(output.includes('[REDACTED]')).toBe(true)
    expect(listOcrResults(db, fileId).length).toBe(failed ? 0 : 1)
  } finally {
    await whenIdle(); clearJobSpecs(); db.delete(schema.serviceCredential).run()
  }
})
