import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/** 一个本地 Paddle API 替身:每个成功的 PNG 提交独立生成一个单页 job。 */
export interface ModelApiFixture {
  /** 每次成功提交一张 PNG 时返回的 markdown,按成功提交顺序循环。 */
  pages: string[]
  /** 轮询第几次才 `done`(默认 1)。 */
  doneAfterPolls?: number
  /** 按 PNG 页号延迟状态响应,用来验证完成顺序不会改变源页顺序。 */
  pollDelayMsByPage?: Record<number, number>
  /** 让所有 job 进入服务端 failed 状态。 */
  failWith?: string
  /** 仅让指定成功提交序号对应的页失败(页号从 1 起)。 */
  failOnPage?: { page: number; message: string }
  /** 仅让指定提交创建的 job 失败(提交序号从 1 起)。 */
  failOnSubmit?: { submit: number; message: string }
  /** 提交尝试序号对应的 HTTP 状态;用于模拟 Paddle 返回 5xx/4xx。 */
  submitStatuses?: number[]
  /** 服务端报的总页数(单张 PNG 默认 1)。 */
  totalPages?: number
  expectModel?: string
  onSubmit?: (fields: string[]) => void
  /** Deterministic backpressure gate for orchestration tests. */
  waitForPoll?: () => Promise<void>
}

export interface MiniOcrApi {
  origin: string
  stats: {
    submits: number
    polls: number
    jsonlFetches: number
    pngUploads: number
    pdfUploads: number
    activeJobs: number
    maxActiveJobs: number
  }
  authSeen: string[]
  optionalPayloads: string[]
  close(): Promise<void>
}

interface JobState {
  pageNo: number
  markdown: string
  polls: number
  failure?: string
  settled?: boolean
}

function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

function fieldNames(body: Buffer): string[] {
  return [...body.toString('latin1').matchAll(/name="([^"]+)"/g)].map((match) => match[1]!)
}

function filePart(body: Buffer): { filename: string; contentType: string } | null {
  const match = /name="file"; filename="([^"]+)"\r?\nContent-Type: ([^\r\n]+)/i.exec(
    body.toString('latin1'),
  )
  return match ? { filename: match[1]!, contentType: match[2]!.trim().toLowerCase() } : null
}

export async function startMiniOcrApi(fixture: ModelApiFixture): Promise<MiniOcrApi> {
  const stats = {
    submits: 0,
    polls: 0,
    jsonlFetches: 0,
    pngUploads: 0,
    pdfUploads: 0,
    activeJobs: 0,
    maxActiveJobs: 0,
  }
  const authSeen: string[] = []
  const optionalPayloads: string[] = []
  const jobs = new Map<string, JobState>()
  let successfulSubmits = 0
  let port = 0

  const send = (res: import('node:http').ServerResponse, status: number, payload: unknown, contentType = 'application/json') => {
    res.statusCode = status
    res.setHeader('content-type', contentType)
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  }

  const server: HttpServer = createServer(async (req, res) => {
    authSeen.push(String(req.headers.authorization ?? ''))
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const body = req.method === 'POST' ? await drain(req) : Buffer.alloc(0)

    if (req.method === 'POST' && url.pathname === '/api/v2/ocr/jobs') {
      stats.submits += 1
      const fields = fieldNames(body)
      const file = filePart(body)
      const optionalPayload = /name="optionalPayload"\r\n\r\n([\s\S]*?)\r\n--/i.exec(
        body.toString('utf8'),
      )?.[1]
      if (optionalPayload !== undefined) optionalPayloads.push(optionalPayload)
      fixture.onSubmit?.(fields)
      if (file?.filename.toLowerCase().endsWith('.png') && file.contentType === 'image/png') {
        stats.pngUploads += 1
      }
      if (file?.filename.toLowerCase().endsWith('.pdf') || file?.contentType === 'application/pdf') {
        stats.pdfUploads += 1
      }
      if (fixture.expectModel && !body.toString('latin1').includes(fixture.expectModel)) {
        return send(res, 400, { code: 1, msg: `model 不是 ${fixture.expectModel}` })
      }
      if (!fields.includes('file') || !file) return send(res, 400, { code: 1, msg: '缺少 file' })
      if (!file.filename.toLowerCase().endsWith('.png') || file.contentType !== 'image/png') {
        return send(res, 400, { code: 1, msg: '只接受单张 PNG' })
      }

      const injectedStatus = fixture.submitStatuses?.[stats.submits - 1]
      if (injectedStatus) {
        return send(res, injectedStatus, { code: 1, msg: `模拟提交状态 ${injectedStatus}` })
      }

      successfulSubmits += 1
      const jobId = `JOB-${stats.submits}`
      const pageNo = Number(/p(\d+)\.png$/i.exec(file.filename)?.[1] ?? successfulSubmits)
      const markdown = fixture.pages.length ? fixture.pages[(pageNo - 1) % fixture.pages.length]! : ''
      const failure = fixture.failOnSubmit?.submit === successfulSubmits ? fixture.failOnSubmit.message : undefined
      jobs.set(jobId, { pageNo, markdown, polls: 0, failure })
      stats.activeJobs += 1
      stats.maxActiveJobs = Math.max(stats.maxActiveJobs, stats.activeJobs)
      return send(res, 200, { code: 0, data: { jobId } })
    }

    const jobMatch = /^\/api\/v2\/ocr\/jobs\/(JOB-\d+)$/.exec(url.pathname)
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]!)
      if (!job) return send(res, 404, { code: 1, msg: 'unknown job' })
      await fixture.waitForPoll?.()
      const delayMs = fixture.pollDelayMsByPage?.[job.pageNo] ?? 0
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      stats.polls += 1
      job.polls += 1
      const injectedFailure = fixture.failOnPage?.page === job.pageNo ? fixture.failOnPage.message : null
      const failure = fixture.failWith ?? job.failure ?? injectedFailure
      if (failure) {
        if (!job.settled) {
          stats.activeJobs -= 1
          job.settled = true
        }
        return send(res, 200, { code: 0, data: { state: 'failed', errorMsg: failure } })
      }
      const need = fixture.doneAfterPolls ?? 1
      if (job.polls < need) {
        return send(res, 200, {
          code: 0,
          data: {
            state: 'running',
            extractProgress: { totalPages: fixture.totalPages ?? 1, extractedPages: 0 },
          },
        })
      }
      if (!job.settled) {
        stats.activeJobs -= 1
        job.settled = true
      }
      return send(res, 200, {
        code: 0,
        data: {
          state: 'done',
          resultUrl: { jsonUrl: `http://127.0.0.1:${port}/result/${jobMatch[1]}.jsonl` },
          extractProgress: { totalPages: fixture.totalPages ?? 1, extractedPages: 1 },
        },
      })
    }

    const resultMatch = /^\/result\/(JOB-\d+)\.jsonl$/.exec(url.pathname)
    if (req.method === 'GET' && resultMatch) {
      const job = jobs.get(resultMatch[1]!)
      if (!job) return send(res, 404, { code: 1, msg: 'unknown result' })
      stats.jsonlFetches += 1
      const line = JSON.stringify({
        result: { layoutParsingResults: [{ markdown: { text: job.markdown } }] },
      })
      return send(res, 200, line, 'application/jsonl')
    }

    if (url.pathname.startsWith('/api/v2/ocr/jobs')) {
      return send(res, 401, { code: 1, msg: 'token 无效' })
    }
    return send(res, 404, { code: 1, msg: `没有这个路径:${url.pathname}` })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  return {
    origin: `http://127.0.0.1:${port}`,
    stats,
    authSeen,
    optionalPayloads,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
