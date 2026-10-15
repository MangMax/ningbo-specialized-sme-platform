import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseOcrParams, runOcr } from '../server/utils/jobs/ocr'
import { listOcrResults, writeOcrResult } from '../server/utils/ocr-result'
import { pagesFromJsonl, resolveOcrConfig } from '../server/utils/ocr-api'
import { DEFAULT_DPI } from '../lib/pdf-page'
import { renderPdfPages } from '../server/utils/pdf-pages'
import { minimalPdf } from './helpers/minimal-pdf'
import { startMiniOcrApi, type MiniOcrApi } from './helpers/ocr-mini-api'

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
 * 写在票里(`.scratch/ingest-pipeline/issues/14-ocr.md`),脚本与口径与本文件一致。
 */

let dir: string
let filesDir: string
let db: ReturnType<(typeof import('../db'))['useDb']>
let schema: typeof import('../db')['schema']
let api: MiniOcrApi | null = null

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-ocr-job-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  filesDir = join(dir, 'files')
  await mkdir(filesDir, { recursive: true })
  const mod = await import('../db')
  db = mod.useDb()
  schema = mod.schema
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.NUXT_DB_PATH
})

beforeEach(async () => {
  db.delete(schema.ocrResult).run()
  db.delete(schema.storedFile).run()
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
  await writeFile(abs, minimalPdf({ pages }))
  const base = relPath.split('/').pop()!
  return db
    .insert(schema.storedFile)
    .values({
      relPath,
      filename: base,
      ext: 'pdf',
      bytes: 1,
      sha256: '0'.repeat(64),
      source: 'jxj',
      kind: 'announcement',
      categoryState: 'set',
    })
    .returning({ id: schema.storedFile.id })
    .get().id
}

/** 跑一次 ocr 任务,附上 ctx。 */
function ctxOf(overrides: { cancelled?: () => boolean } = {}) {
  const seen: Array<[number, number]> = []
  return {
    seen,
    ctx: {
      jobId: 'test-ocr',
      filesDir,
      db,
      progress: (done: number, total: number) => seen.push([done, total]),
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
      expect(rows.map((r) => r.page)).toEqual([1, 2, 3])
      expect(rows.map((r) => r.markdown)).toEqual(pages)
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
