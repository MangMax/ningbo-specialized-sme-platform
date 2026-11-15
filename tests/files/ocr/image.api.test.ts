import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ocrImageFile } from '../../../server/utils/ocr-api'
import { startMiniOcrApi, type MiniOcrApi } from './fixtures/provider-api'

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
  it("never sends an echoed credential to the durable remote-ID callback", async () => {
    const saved: string[] = []
    await expect(ocrImageFile({
      token: 'synthetic-echo-secret', filePath: imagePath,
      onSubmitted: id => { saved.push(id) },
      fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { jobId: 'synthetic-echo-secret' } }), { headers: { 'content-type': 'application/json' } }),
    })).rejects.toThrow('提交结果保持未知')
    expect(saved).toEqual([])
  })

  it("versioned upload freezes the hashed bytes before the asynchronous POST", async () => {
    const original = await readFile(imagePath)
    const hash = createHash('sha256').update(original).digest('hex')
    api = await startMiniOcrApi({ pages: ['immutable upload'] })
    try {
      const out = await ocrImageFile({
        token: 'test-token', baseUrl: api.origin, filePath: imagePath,
        expectedImageSha256: hash,
        fetchImpl: async (input, init) => {
          if (init?.method === 'POST') {
            await writeFile(imagePath, 'replaced after request construction')
            const uploaded = (init.body as FormData).get('file') as Blob
            expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(original)
          }
          return fetch(input, init as RequestInit)
        },
      })
      expect(out.page.markdown).toBe('immutable upload')
      expect(api.stats.submits).toBe(1)
      await expect(ocrImageFile({ token: 'test-token', baseUrl: api.origin, filePath: imagePath, expectedImageSha256: hash })).rejects.toThrow('输入页图内容冲突')
      expect(api.stats.submits).toBe(1)
    } finally { await writeFile(imagePath, original) }
  })

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
it('redacts a long credential before truncating a plain-text upstream error', async () => {
  const token = 'synthetic-' + 'z'.repeat(400) + '-tail'
  let message = ''
  try {
    await ocrImageFile({ token, filePath: imagePath, fetchImpl: async () => new Response(token, { status: 403 }) })
  } catch (error) { message = (error as Error).message }
  expect(message.includes(token.slice(0, 100))).toBe(false)
  expect(message.includes('[REDACTED]')).toBe(true)
})
it('removes credential echoes from successful OCR markdown and nested raw results', async () => {
  const token = 'synthetic-success-secret'
  api = await startMiniOcrApi({ pages: [`text ${token} end`] })
  const result = await ocrImageFile({ token, baseUrl: api.origin, filePath: imagePath })
  expect(JSON.stringify(result).includes(token)).toBe(false)
  expect(JSON.stringify(result).includes('[REDACTED]')).toBe(true)
})

it('redacts URL-encoded credentials in upstream JSON errors at the public image boundary', async () => {
  const token = 'synthetic+/=encoding-secret'
  const encoded = encodeURIComponent(token)
  let message = ''
  try {
    await ocrImageFile({ token, filePath: imagePath, fetchImpl: async () => Response.json({ message: `denied ${encoded}` }, { status: 401 }) })
  } catch (error) { message = (error as Error).message }
  expect(message.includes(encoded)).toBe(false)
  expect(message.includes('[REDACTED]')).toBe(true)
})

const echoForms = [
  { name: 'raw', encode: (value: string) => value },
  { name: 'json-escaped', encode: (value: string) => JSON.stringify(value).slice(1, -1) },
  { name: 'json-slash-escaped', encode: (value: string) => JSON.stringify(value).slice(1, -1).replaceAll('/', '\\/') },
  { name: 'url', encode: encodeURIComponent },
  { name: 'url-lowercase', encode: (value: string) => encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()) },
  { name: 'form', encode: (value: string) => new URLSearchParams({ token: value }).toString().slice(6) },
  { name: 'nested-url', encode: (value: string) => encodeURIComponent(encodeURIComponent(value)) },
  { name: 'unicode-json', encode: (value: string) => value.split('').map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('') },
]

const errorStages = [
  'submit-http-json', 'submit-http-text', 'poll-http', 'download-http',
  'submit-api', 'poll-api', 'failed-job', 'network', 'unknown-state',
] as const

for (const stage of errorStages) {
  it.each(echoForms)(`scrubs ${stage} credential echoes before returning errors ($name)`, async ({ encode }) => {
    const token = 'synthetic "quoted"\\path+/= ' + 'z'.repeat(400) + '-tail'
    const echo = encode(token)
    let calls = 0
    let message = ''
    try {
      await ocrImageFile({ token, filePath: imagePath, fetchImpl: async () => {
        calls += 1
        const submitted = () => Response.json({ code: 0, data: { jobId: 'safe-job' } })
        const done = () => Response.json({ code: 0, data: { state: 'done', resultUrl: { jsonUrl: 'http://fake.invalid/result' } } })
        if (stage === 'network') throw new Error(`network ${echo}`)
        if (stage === 'submit-http-json') return Response.json({ message: `denied ${echo}` }, { status: 401 })
        if (stage === 'submit-http-text') return new Response(`denied ${echo}`, { status: 403 })
        if (stage === 'submit-api') return Response.json({ code: 1, message: `denied ${echo}` })
        if (calls === 1) return submitted()
        if (stage === 'poll-http') return new Response(`denied ${echo}`, { status: 403 })
        if (stage === 'poll-api') return Response.json({ code: 1, message: `denied ${echo}` })
        if (stage === 'failed-job') return Response.json({ code: 0, data: { state: 'failed', errorMsg: `denied ${echo}` } })
        if (stage === 'unknown-state') return Response.json({ code: 0, data: { state: echo } })
        if (calls === 2) return done()
        return new Response(`denied ${echo}`, { status: 403 })
      } })
    } catch (error) { message = (error as Error).message }
    // Boolean assertions keep synthetic credentials out of failure diagnostics.
    expect(message.includes(echo.slice(0, 100))).toBe(false)
    expect(message.includes(token.slice(0, 100))).toBe(false)
    expect(message.includes('[REDACTED]')).toBe(true)
    if (stage.includes('http')) expect(message.length).toBeLessThan(370)
  })
}

it.each(echoForms)('scrubs successful job IDs, markdown, nested raw values and keys ($name)', async ({ encode }) => {
  const token = 'synthetic "quoted"\\path+/= secret'
  const echo = encode(token)
  let calls = 0
  const result = await ocrImageFile({ token, filePath: imagePath, fetchImpl: async () => {
    calls += 1
    if (calls === 1) return Response.json({ code: 0, data: { jobId: echo } })
    if (calls === 2) return Response.json({ code: 0, data: { state: 'done', resultUrl: { jsonUrl: 'http://fake.invalid/result' } } })
    return new Response(JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: `text ${echo} end` }, nested: { [echo]: [echo] } }] } }))
  } })
  expect(result.jobId === '[REDACTED]').toBe(true)
  expect(result.page.markdown === 'text [REDACTED] end').toBe(true)
  // Normalize the serialization layer before checking for literal wire echoes.
  const raw = JSON.stringify(result.page.raw)
  expect(raw.includes(JSON.stringify(echo).slice(1, -1))).toBe(false)
  expect(raw.includes('"nested":{"[REDACTED]":["[REDACTED]"]}')).toBe(true)
})
