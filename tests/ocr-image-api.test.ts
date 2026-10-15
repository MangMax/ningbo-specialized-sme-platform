import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ocrImageFile } from '../server/utils/ocr-api'
import { startMiniOcrApi, type MiniOcrApi } from './helpers/ocr-mini-api'

let dir: string
let imagePath: string
let api: MiniOcrApi | null = null

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-ocr-image-api-'))
  await mkdir(dir, { recursive: true })
  imagePath = join(dir, 'p001.png')
  // 最小 PNG 夹具;fake 服务会验证上传名与 MIME 都对应单张 PNG。
  await writeFile(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vVQAAAAASUVORK5CYII=',
      'base64',
    ),
  )
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

afterEach(async () => {
  await api?.close()
  api = null
})

async function runImage(waits: number[]) {
  if (!api) throw new Error('fake Paddle API not started')
  return ocrImageFile({
    token: 'test-token',
    baseUrl: api.origin,
    filePath: imagePath,
    fileName: 'p001.png',
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
}

describe('ocrImageFile 单张 PNG 重试', () => {
  it('提交用户官网配置的 PaddleOCR-VL 参数', async () => {
    api = await startMiniOcrApi({ pages: ['按官网参数识别'] })
    await runImage([])

    expect(api.optionalPayloads).toHaveLength(1)
    expect(JSON.parse(api.optionalPayloads[0]!)).toEqual({
      markdownIgnoreLabels: [
        'header',
        'header_image',
        'footer',
        'footer_image',
        'number',
        'footnote',
        'aside_text',
      ],
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useLayoutDetection: true,
      useChartRecognition: false,
      useSealRecognition: true,
      useOcrForImageBlock: false,
      mergeTables: true,
      relevelTitles: true,
      layoutShapeMode: 'auto',
      promptLabel: 'ocr',
      repetitionPenalty: 1,
      temperature: 0,
      topP: 1,
      minPixels: 147384,
      maxPixels: 2822400,
      layoutNms: true,
      restructurePages: true,
    })
  }, 10_000)

  it('多张 PNG 并发识别时全局 Paddle job 数限制为 8', async () => {
    api = await startMiniOcrApi({
      pages: ['并发结果'],
      doneAfterPolls: 2,
      pollDelayMsByPage: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, 50])),
    })
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        ocrImageFile({
          token: 'test-token',
          baseUrl: api!.origin,
          filePath: imagePath,
          fileName: `p${String(index + 1).padStart(3, '0')}.png`,
          sleep: async () => {},
        }),
      ),
    )

    expect(results).toHaveLength(12)
    expect(api.stats.submits).toBe(12)
    expect(api.stats.maxActiveJobs).toBe(8)
    expect(api.stats.activeJobs).toBe(0)
  }, 10_000)

  it('等待并发槽位期间收到取消时不再提交那张 PNG', async () => {
    api = await startMiniOcrApi({
      pages: ['并发结果'],
      doneAfterPolls: 2,
      pollDelayMsByPage: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, 80])),
    })
    const firstEight = Array.from({ length: 8 }, (_, index) =>
      ocrImageFile({
        token: 'test-token',
        baseUrl: api!.origin,
        filePath: imagePath,
        fileName: `p${String(index + 1).padStart(3, '0')}.png`,
        sleep: async () => {},
      }),
    )
    const deadline = Date.now() + 1000
    while (api.stats.activeJobs < 8 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(api.stats.activeJobs).toBe(8)

    let cancelled = false
    const ninth = ocrImageFile({
      token: 'test-token',
      baseUrl: api.origin,
      filePath: imagePath,
      fileName: 'p009.png',
      isCancelled: () => cancelled,
      sleep: async () => {},
    })
    cancelled = true

    await expect(ninth).rejects.toThrow(/取消请求停止/)
    await Promise.all(firstEight)
    expect(api.stats.submits).toBe(8)
    expect(api.stats.activeJobs).toBe(0)
  }, 10_000)

  it('HTTP 5xx 后成功:同一页 PNG 重试并返回单页结果', async () => {
    api = await startMiniOcrApi({ pages: ['第 1 页正文'], submitStatuses: [503] })
    const waits: number[] = []

    const result = await runImage(waits)

    expect(result.page).toMatchObject({ page: 1, markdown: '第 1 页正文' })
    expect(api.stats).toMatchObject({ submits: 2, pngUploads: 2, pdfUploads: 0, polls: 1, jsonlFetches: 1 })
    expect(waits).toEqual([250])
  }, 10_000)

  it('连续 5xx:三次提交后耗尽,不创建 OCR job', async () => {
    api = await startMiniOcrApi({ pages: ['不会返回'], submitStatuses: [500, 502, 503] })
    const waits: number[] = []

    await expect(runImage(waits)).rejects.toThrow(/HTTP 503.*3\/3 次尝试/)

    expect(api.stats).toMatchObject({ submits: 3, pngUploads: 3, pdfUploads: 0, polls: 0, jsonlFetches: 0 })
    expect(waits).toEqual([250, 500])
  }, 10_000)

  it('HTTP 4xx 不重试,即使后续模拟响应是 5xx', async () => {
    api = await startMiniOcrApi({ pages: ['不会返回'], submitStatuses: [429, 503] })
    const waits: number[] = []

    await expect(runImage(waits)).rejects.toThrow(/HTTP 429/)

    expect(api.stats).toMatchObject({ submits: 1, pngUploads: 1, pdfUploads: 0, polls: 0, jsonlFetches: 0 })
    expect(waits).toEqual([])
  }, 10_000)

  it('异步 job 尚未完成时等待并继续轮询', async () => {
    api = await startMiniOcrApi({ pages: ['等待后的正文'], doneAfterPolls: 2 })
    const waits: number[] = []

    const result = await runImage(waits)

    expect(result.page.markdown).toBe('等待后的正文')
    expect(api.stats).toMatchObject({ submits: 1, polls: 2, jsonlFetches: 1 })
    expect(waits).toEqual([2000])
  }, 10_000)

  it('异步 OCR job 返回 5xx 后重建同一页任务并成功', async () => {
    api = await startMiniOcrApi({
      pages: ['重试后的正文'],
      failOnSubmit: { submit: 1, message: 'OCR服务请求失败，状态码 500' },
    })
    const waits: number[] = []

    const result = await runImage(waits)

    expect(result.page.markdown).toBe('重试后的正文')
    expect(api.stats).toMatchObject({ submits: 2, pngUploads: 2, pdfUploads: 0, polls: 2, jsonlFetches: 1 })
    expect(waits).toEqual([250])
  }, 10_000)

  it('异步 OCR job 连续 5xx 三次后耗尽,不继续提交', async () => {
    api = await startMiniOcrApi({ pages: ['不会返回'], failWith: 'OCR服务请求失败，状态码 500' })
    const waits: number[] = []

    await expect(runImage(waits)).rejects.toThrow(/状态码 500.*3\/3 次尝试/)

    expect(api.stats).toMatchObject({ submits: 3, pngUploads: 3, pdfUploads: 0, polls: 3, jsonlFetches: 0 })
    expect(waits).toEqual([250, 500])
  }, 10_000)

  it('异步 OCR job 返回 4xx 不重试', async () => {
    api = await startMiniOcrApi({ pages: ['不会返回'], failWith: 'OCR服务请求失败，状态码 400' })
    const waits: number[] = []

    await expect(runImage(waits)).rejects.toThrow(/状态码 400/)

    expect(api.stats).toMatchObject({ submits: 1, pngUploads: 1, pdfUploads: 0, polls: 1, jsonlFetches: 0 })
    expect(waits).toEqual([])
  }, 10_000)

  it('拒绝以 PDF 文件名调用图片接口', async () => {
    api = await startMiniOcrApi({ pages: ['不会返回'] })

    await expect(
      ocrImageFile({
        token: 'test-token',
        baseUrl: api.origin,
        filePath: imagePath,
        fileName: 'source.pdf',
      }),
    ).rejects.toThrow(/只接受 PNG 页图/)

    expect(api.stats.submits).toBe(0)
  }, 10_000)
})
