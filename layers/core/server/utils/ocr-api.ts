import { credentialContext, resolveCredential } from './credential-state'
import { resolvePostgresCredential } from './credential-state-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
/**
 * **通路 a:在线 PaddleOCR API**(票 14)。每次异步提交一张已渲染页图 → 轮询 → 取 JSONL 结果。
 *
 * 不本地部署(SPEC 明写),走百度的 AIStudio 托管接口 —— 与用户给的那份 MCP 配置
 * (`uvx --from paddleocr-mcp paddleocr_mcp`)是**同一个服务、同一个 token**:
 *
 * | 步骤 | 请求 |
 * |---|---|
 * | 提交 | `POST {base}/api/v2/ocr/jobs`,multipart(`file` + `model` + `optionalPayload`),`Authorization: Bearer <token>` → `{code:0,data:{jobId}}` |
 * | 轮询 | `GET {base}/api/v2/ocr/jobs/{jobId}` → `data.state: pending\|running\|done\|failed`、`data.extractProgress:{totalPages,extractedPages}`、`data.resultUrl.jsonUrl` |
 * | 取结果 | `GET <jsonUrl>` → **JSONL**,每行 `result.layoutParsingResults[].markdown.text` |
 *
 * 选 `PaddleOCR-VL-*`(文档解析模型,不是纯 OCR 模型)是有意的:它**直接出 markdown**
 * (标题层级与表格都是 markdown),正是本票要的产物;而 `PP-OCRv5` 出的是逐行文本 +
 * 坐标,我们要再自己拼版面 —— 那段代码没有信息可依,拼出来的只会是「一行行文字的堆叠」。
 *
 * OCR 任务只接收由 PDF 渲染流程生成的 PNG。调用方将单图结果绑定到自己的页码;
 * Paddle 响应不携带源 PDF 页号,因此不依赖服务端推断页码。单张 PNG 识别流程遇到
 * HTTP 5xx(提交、查询或任务终态返回)时最多尝试三次(250ms、500ms 间隔);4xx、超时与网络错误不重试。
 *
 * ── 凭证 ───────────────────────────────────────────────────────────────
 * **不入库、不入仓库**(SPEC 硬约束)。从外置页面配置或环境变量读:`NUXT_OCR_TOKEN`,或与 MCP 配置
 * 同名的那颗 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`。仓库里只有 `.env.example` 的占位名。
 */

import { createHash } from 'node:crypto'

/** AIStudio 的 PaddleOCR 服务地址(SDK 里的 `DEFAULT_BASE_URL`,不是猜的)。 */
export const OCR_BASE_URL = 'https://paddleocr.aistudio-app.com'

/** 任务端点。`POST` 提交、`GET .../{jobId}` 轮询。 */
export const OCR_JOBS_PATH = '/api/v2/ocr/jobs'

/** 默认模型:文档解析、**直接出 markdown**(与用户 MCP 配置里的 `PADDLEOCR_MCP_MODEL` 一致)。 */
export const DEFAULT_OCR_MODEL = 'PaddleOCR-VL-1.6'

/**
 * 与用户官网 PaddleOCR-VL-1.6 配置一致。400 DPI A4 页图约 15.5 MP;
 * 300 DPI 默认页图约 8.7 MP,再由 maxPixels 限制模型实际输入尺寸。
 */
export const DEFAULT_OCR_OPTIONAL_PAYLOAD = {
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
} as const

/**
 * **影响识别结果的有效选项指纹** —— 模型 + 实际提交的 `optionalPayload`。
 *
 * 这是「输入相同 ⇒ 结果相同」的判据里,除了页图内容之外的那一半(页图内容由调用方
 * 自己按 sha256 判,见 `ocr-page-cache.ts`)。它必须与 `ocrImageFileAttempt` 真正发出去的
 * 那两个字段**同源**:`model` 直接进来,payload 就是下面这个常量本身 —— 所以改了
 * `DEFAULT_OCR_OPTIONAL_PAYLOAD`(如换 temperature、开 chartRecognition),指纹自动变,
 * 旧的页结果缓存立刻不再命中,**不需要谁记得去清缓存**。
 *
 * `payload` 参数只为测试留一个口子(生产路径从不传):用来断言「选项变了 ⇒ 指纹变了」。
 * 默认值就是真发出去的那份,所以给不给都一样。
 */
export function ocrRequestVariant(
  model: string,
  payload: unknown = DEFAULT_OCR_OPTIONAL_PAYLOAD,
): string {
  return createHash('sha256')
    .update(`${model}\u0000${JSON.stringify(payload)}`)
    .digest('hex')
    .slice(0, 32)
}

/** 轮询间隔(毫秒)。API 是分钟级的活,2 秒一次足够且不至于把服务问烦。 */
export const DEFAULT_POLL_INTERVAL_MS = 2000

/** 单份文件的总等待上限(毫秒)。97 页实测数分钟;10 分钟兜住异常。 */
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000

/** 一次外部调用的网络超时(毫秒)。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120 * 1000

/** 单张图片提交遇到 5xx 时最多尝试三次(含首次)。 */
export const MAX_IMAGE_ATTEMPTS = 3

/** 同一进程最多同时有 8 个 Paddle 单页 job 在提交/轮询;服务端 503 表示当前请求过多。 */
export const MAX_CONCURRENT_PADDLE_JOBS = 8

/** 5xx 重试间隔:250ms、500ms。 */
export const IMAGE_RETRY_BASE_DELAY_MS = 250

let paddleJobsInFlight = 0
const paddleJobWaiters: Array<() => void> = []

/** 在不同 OCR/PDF job 间共享的公平信号量,限制未完成的远端单页任务数。 */
async function withPaddleJobPermit<T>(
  isCancelled: OcrApiOptions['isCancelled'],
  action: () => Promise<T>,
): Promise<T> {
  if (await isCancelled?.()) throw new OcrApiError('识别已按取消请求停止(尚未提交页图)。', 499)
  if (paddleJobsInFlight < MAX_CONCURRENT_PADDLE_JOBS) {
    paddleJobsInFlight += 1
  } else {
    await new Promise<void>(resolve => paddleJobWaiters.push(resolve))
  }

  try {
    if (await isCancelled?.()) throw new OcrApiError('识别已按取消请求停止(尚未提交页图)。', 499)
    return await action()
  } finally {
    const next = paddleJobWaiters.shift()
    if (next) next()
    else paddleJobsInFlight -= 1
  }
}

/** 认得的 `fetch`(测试注入用;形状与全局 `fetch` 一致)。 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    signal?: AbortSignal
  },
) => Promise<Response>

/** 引擎/服务端给出的错。`statusCode` 是**我们这边**对外的建议码(路由/tool 用)。 */
export class OcrApiError extends Error {
  readonly statusCode: number
  readonly remoteStatus: number | null
  /** Runtime classification only; never changes the public status or message. */
  readonly failureKind: 'failure' | 'timeout'
  constructor(message: string, statusCode = 502, remoteStatus: number | null = null, failureKind: 'failure' | 'timeout' = 'failure') {
    super(message)
    this.name = 'OcrApiError'
    this.statusCode = statusCode
    this.remoteStatus = remoteStatus
    this.failureKind = failureKind
  }
}

/** 一页的识别结果。 */
export interface OcrPageOut {
  /** 页码,从 1 起(结果里的第 i 段就是第 i 页)。 */
  page: number
  /** 该页 markdown。**可以是空串**(空白页照样占一个页号)。 */
  markdown: string
  /** 引擎对那一页说的原文(留着「识别错了」时回看)。 */
  raw: unknown
}

/** 一张图片的识别产物。 */
export interface OcrImageOut {
  jobId: string
  model: string
  /** 单张 PNG 必须恰好返回一页;页码 1 只是该图片内部序号。 */
  page: OcrPageOut
  /** 服务端报的总页数(有时没有)。 */
  totalPages: number | null
  elapsedMs: number
}

/** 跑一次识别需要的输入。 */
export interface OcrApiOptions {
  /** Versioned publisher freezes the exact uploaded PNG bytes, including ABA
   * replacement between hashing and the asynchronous multipart request. */
  expectedImageSha256?: string
  /** Durable OCR owner may resume polling an accepted job without another POST. */
  resumeJobId?: string
  onSubmissionStarted?: () => void | Promise<void>
  onSubmitted?: (jobId: string) => void | Promise<void>
  onSubmissionRejected?: () => void | Promise<void>
  onRemoteFailed?: () => void | Promise<void>
  token: string
  /** 要识别的 PNG 页图的**绝对路径**。 */
  filePath: string
  /** 提交时的 PNG 文件名;API 靠它判类型。 */
  fileName?: string
  baseUrl?: string
  model?: string
  fetchImpl?: FetchLike
  pollIntervalMs?: number
  pollTimeoutMs?: number
  requestTimeoutMs?: number
  /** 进度回调:`{done,total}` 是**页**数(服务端报的)。 */
  onProgress?: (done: number, total: number) => void
  /** 取消检查 —— 每个轮询周期问一次(这就是「尽力而为」的检查点)。 */
  isCancelled?: () => boolean | Promise<boolean>
  /** 测试用:跳过真实 `setTimeout` 等待。 */
  sleep?: (ms: number) => Promise<void>
}

function realFetch(input: string, init?: Parameters<FetchLike>[1]): Promise<Response> {
  return fetch(input, init as RequestInit)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把服务端的 `{code, data}` 拆开;`code != 0` 一律当错(与 SDK 的 `unwrap_api_response` 同判据)。 */
function unwrap(payload: unknown, where: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new OcrApiError(`${where}:响应不是 JSON 对象`)
  }
  const obj = payload as Record<string, unknown>
  const code = obj.code
  if (code !== undefined && code !== null && code !== 0) {
    const msg = messageOf(obj) ?? JSON.stringify(obj).slice(0, 300)
    throw new OcrApiError(`${where}:服务端返回错误 code=${String(code)}:${msg}`)
  }
  const data = obj.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new OcrApiError(`${where}:响应里没有对象字段 data`)
  }
  return data as Record<string, unknown>
}

function messageOf(obj: Record<string, unknown>): string | null {
  for (const key of ['msg', 'errorMsg', 'message']) {
    const v = obj[key]
    if (typeof v === 'string' && v) return v
  }
  const data = obj.data
  if (data && typeof data === 'object') {
    const inner = (data as Record<string, unknown>).errorMsg
    if (typeof inner === 'string' && inner) return inner
  }
  return null
}

/**
 * 从一条 JSONL 记录里取出**每页**的 markdown。
 *
 * 形状按 PaddleOCR 官方 SDK 的 `parse_doc_parsing_result` 逐字对齐:
 * `line.result.layoutParsingResults[].markdown.text`。**一条 JSONL 里可以有多个
 * layoutParsingResults**(服务端会分批),所以是平铺,不是取第一个。
 *
 * 认不出形状时**不猜**:抛错并把那一行的前几个键报出来 —— 「一片空白的结果」比
 * 「明确说形状不对」难查得多。
 */
export function pagesFromJsonlLine(line: unknown, index: number): OcrPageOut[] {
  if (!line || typeof line !== 'object') {
    throw new OcrApiError(`结果第 ${index + 1} 行不是 JSON 对象`)
  }
  const result = (line as Record<string, unknown>).result
  if (!result || typeof result !== 'object') {
    throw new OcrApiError(`结果第 ${index + 1} 行没有对象字段 result`)
  }
  const items = (result as Record<string, unknown>).layoutParsingResults
  if (!Array.isArray(items)) {
    throw new OcrApiError(
      `结果第 ${index + 1} 行的 result 里没有 layoutParsingResults 数组` +
        `(键:${Object.keys(result as Record<string, unknown>).join(' / ') || '(无)'})` +
        ' —— 多半是模型不是文档解析类(PaddleOCR-VL-*)。',
    )
  }
  return items.map((item) => {
    const it = (item ?? {}) as Record<string, unknown>
    const md = it.markdown
    const text =
      md && typeof md === 'object' && typeof (md as Record<string, unknown>).text === 'string'
        ? ((md as Record<string, unknown>).text as string)
        : ''
    return { page: 0, markdown: text, raw: it }
  })
}

/** 把 JSONL 正文解析成**按页升序**的页(页号 = 出现顺序,从 1 起)。 */
export function pagesFromJsonl(text: string): OcrPageOut[] {
  const pages: OcrPageOut[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.trim()
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new OcrApiError(`结果不是合法 JSONL(第 ${i + 1} 行)`)
    }
    for (const page of pagesFromJsonlLine(parsed, i)) pages.push(page)
  }
  return pages.map((p, i) => ({ ...p, page: i + 1 }))
}

/** 带超时的 fetch;超时给一条**能看懂**的话(不是裸的 AbortError)。 */
async function fetchWithTimeout(
  impl: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  timeoutMs: number,
  what: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await impl(url, { ...init, signal: controller.signal })
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError'
    throw new OcrApiError(
      aborted
        ? `${what}超时(${Math.round(timeoutMs / 1000)} s):网络或服务端没有响应`
        : `${what}失败:${(error as Error).message}`,
      502, null, aborted ? 'timeout' : 'failure',
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Common reversible wire representations, longest first so an inner raw value
 * cannot leave a reconstructable escaped prefix/suffix behind. Kept local to OCR. */
function ocrTokenRedactor(token: string): (text: string) => string {
  if (!token) return text => text
  const json = JSON.stringify(token).slice(1, -1)
  const forms = new Set([token, json, json.replaceAll('/', '\\/'), encodeURI(token), encodeURIComponent(token), new URLSearchParams({ token }).toString().slice(6)])
  // JSON permits a Unicode escape for any character, and slash escaping is optional.
  forms.add(token.split('').map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))
  for (const form of [...forms]) {
    forms.add(encodeURIComponent(form))
    forms.add(JSON.stringify(form).slice(1, -1))
  }
  for (const form of [...forms]) forms.add(form.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()))
  const ordered = [...forms].sort((a, b) => b.length - a.length)
  return text => ordered.reduce((result, form) => result.split(form).join('[REDACTED]'), text)
}

async function readErrorText(res: Response, token: string): Promise<string> {
  try {
    const rawText = await res.text()
    const redact = ocrTokenRedactor(token)
    let detail = rawText
    try {
      detail = messageOf(JSON.parse(rawText) as Record<string, unknown>) ?? rawText
    } catch {
      // Plain text (or malformed JSON) still needs scrubbing before truncation.
    }
    return redact(detail).slice(0, 300)
  } catch {
    return '(响应体读不出来)'
  }
}

/**
 * 跑一张 PNG 的识别:提交 → 轮询 → 取 JSONL。
 *
 * **不落库、不决定源 PDF 页码**:它只回答「这一张图的 markdown 是什么」。调用方按
 * 渲染清单里的页号绑定结果。每次 POST 只包含一个 PNG;只对该 POST 的 HTTP 5xx 重试。
 */
async function ocrImageFileAttempt(options: OcrApiOptions): Promise<OcrImageOut> {
  const startedAt = Date.now()
  const sleep = options.sleep ?? defaultSleep
  const token = options.token?.trim()
  if (!token) {
    throw new OcrApiError(
      '缺少 OCR token:设 `NUXT_OCR_TOKEN`(或 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`)。' +
        '凭证不入库、不入仓库;可在配置页面保存或使用部署环境值。',
      401,
    )
  }
  const base = (options.baseUrl?.trim() || OCR_BASE_URL).replace(/\/+$/, '')
  const jobsUrl = `${base}${OCR_JOBS_PATH}`
  const model = options.model?.trim() || DEFAULT_OCR_MODEL
  const impl = options.fetchImpl ?? realFetch
  const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const pollTimeout = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const auth = { Authorization: `Bearer ${token}` }

  // ---- 1. 提交(multipart;一张 PNG 一个 job)----------------------------------
  //
  // **流式上传**,不把页图 `readFile` 成 Buffer 后再复制一份;`openAsBlob`(Node 20+)
  // 让 undici 直接从磁盘流式读。多 PDF/多页并发由共享信号量限制为最多 8 个远端 job。
  let jobId = options.resumeJobId
  if (!jobId) {
    let blob: Blob
    try {
      // `stat` 走 promises 版(`node:fs` 上那个是回调式,promise 化会在运行时才炸);
      // `openAsBlob` 只在 `node:fs` 上有(`node:fs/promises` 里没有这个导出)。
      const { stat, readFile } = await import('node:fs/promises')
      const { openAsBlob } = await import('node:fs')
      // 先 stat 一次:不存在/不是文件时给一句人话,而不是让 undici 抛 ENOENT。
      const info = await stat(options.filePath)
      if (!info.isFile()) throw new Error('不是文件')
      if (options.expectedImageSha256) {
        const { createHash } = await import('node:crypto')
        const bytes = await readFile(options.filePath)
        if (createHash('sha256').update(bytes).digest('hex') !== options.expectedImageSha256) throw new Error('OCR 输入页图内容冲突')
        blob = new Blob([Uint8Array.from(bytes)], { type: 'image/png' })
      } else blob = await openAsBlob(options.filePath, { type: 'image/png' })
    } catch (error) {
      throw new OcrApiError(`读不到要识别的文件:${(error as Error).message}`, 404)
    }
    const fileName = options.fileName ?? options.filePath.split('/').pop() ?? 'input.png'
    if (!fileName.toLowerCase().endsWith('.png')) {
      throw new OcrApiError(`OCR 只接受 PNG 页图:${fileName}`, 400)
    }

    const makeForm = () => {
      const form = new FormData()
      form.append('file', blob, fileName)
      form.append('model', model)
      // 与官方 SDK 一致:`optionalPayload` 是**字符串**化的 JSON。
      form.append('optionalPayload', JSON.stringify(DEFAULT_OCR_OPTIONAL_PAYLOAD))
      return form
    }

    if (await options.isCancelled?.()) {
      throw new OcrApiError('识别已按取消请求停止(尚未提交页图)。', 499)
    }

    await options.onSubmissionStarted?.()
    const submitRes = await fetchWithTimeout(
      impl,
      jobsUrl,
      { method: 'POST', headers: auth, body: makeForm() },
      requestTimeout,
      '提交单张 PNG OCR 任务',
    )
    if (!submitRes.ok) {
      if (submitRes.status >= 400 && submitRes.status < 500 && submitRes.status !== 408) await options.onSubmissionRejected?.()
      const detail = await readErrorText(submitRes, token)
      throw new OcrApiError(
        `提交 OCR 任务被拒(HTTP ${submitRes.status}):${detail}`,
        submitRes.status === 401 || submitRes.status === 403 ? 401 : 502,
        submitRes.status,
      )
    }
    const submitted = unwrap(await safeJson(submitRes, '提交响应'), '提交 OCR 任务')
    jobId = submitted.jobId as string
    if (typeof jobId !== 'string' || !jobId) throw new OcrApiError('提交响应里没有 jobId')
    if (options.onSubmitted && ocrTokenRedactor(token)(jobId) !== jobId) throw new OcrApiError('远端任务 ID 不可安全保存;提交结果保持未知')
    await options.onSubmitted?.(jobId)
  }

  // ---- 2. 轮询 ----------------------------------------------------------------
  const deadline = Date.now() + pollTimeout
  let totalPages: number | null = null
  let jsonUrl: string | null = null
  for (;;) {
    if (await options.isCancelled?.()) {
      throw new OcrApiError(`识别已按取消请求停止(服务端任务 ${jobId} 可凭原回执继续查询)。`, 499)
    }
    const statusRes = await fetchWithTimeout(
      impl,
      `${jobsUrl}/${encodeURIComponent(jobId)}`,
      { method: 'GET', headers: auth },
      requestTimeout,
      '查询 OCR 任务',
    )
    if (!statusRes.ok) {
      throw new OcrApiError(
        `查询 OCR 任务失败(HTTP ${statusRes.status}):${await readErrorText(statusRes, token)}`,
        statusRes.status === 401 || statusRes.status === 403 ? 401 : 502,
        statusRes.status,
      )
    }
    const data = unwrap(await safeJson(statusRes, '查询响应'), '查询 OCR 任务')
    const state = data.state
    if (!['pending', 'running', 'done', 'failed'].includes(String(state))) {
      throw new OcrApiError(`OCR 任务状态不可识别:${String(state)}`)
    }
    const progress = data.extractProgress as Record<string, unknown> | undefined
    if (progress && typeof progress === 'object') {
      const total = Number(progress.totalPages)
      const done = Number(progress.extractedPages)
      if (Number.isFinite(total) && total > 0) {
        totalPages = total
        options.onProgress?.(Number.isFinite(done) ? done : 0, total)
      }
    }

    if (state === 'done') {
      const resultUrl = data.resultUrl
      const url =
        resultUrl && typeof resultUrl === 'object'
          ? (resultUrl as Record<string, unknown>).jsonUrl
          : null
      if (typeof url !== 'string' || !url) throw new OcrApiError('任务完成但结果里没有 resultUrl.jsonUrl')
      jsonUrl = url
      break
    }
    if (state === 'failed') {
      await options.onRemoteFailed?.()
      const why = typeof data.errorMsg === 'string' && data.errorMsg ? data.errorMsg : '(无 errorMsg)'
      const statusMatch = /(?:HTTP\s*|状态码\s*)(\d{3})/i.exec(why)
      const remoteStatus = statusMatch ? Number(statusMatch[1]) : null
      throw new OcrApiError(`OCR 任务失败:${why}`, 502, remoteStatus)
    }
    if (Date.now() > deadline) {
      throw new OcrApiError(
        `OCR 任务等待超时(${Math.round(pollTimeout / 1000)} s,任务 ${jobId} 仍未完成)。` +
          '任务在服务端可能仍在跑;调大 `NUXT_OCR_POLL_TIMEOUT_MS` 或稍后重试同一份文件。',
        502, null, 'timeout',
      )
    }
    await sleep(pollInterval)
  }

  // ---- 3. 取结果(JSONL)------------------------------------------------------
  const jsonRes = await fetchWithTimeout(
    impl,
    jsonUrl,
    { method: 'GET' },
    requestTimeout,
    '下载 OCR 结果',
  )
  if (!jsonRes.ok) {
    throw new OcrApiError(
      `下载 OCR 结果失败(HTTP ${jsonRes.status}):${await readErrorText(jsonRes, token)}`,
      jsonRes.status === 401 || jsonRes.status === 403 ? 401 : 502,
      jsonRes.status,
    )
  }
  const pages = pagesFromJsonl(await jsonRes.text())
  if (pages.length !== 1) {
    throw new OcrApiError(`单张 PNG 应返回 1 页,实际返回 ${pages.length} 页`)
  }

  options.onProgress?.(1, totalPages ?? 1)
  return { jobId, model, page: { ...pages[0]!, page: 1 }, totalPages, elapsedMs: Date.now() - startedAt }
}

/**
 * 重试边界是一张 PNG 的完整 Paddle 请求,而不是只重试 HTTP 提交。
 * 异步 OCR job 可能在提交成功后以 5xx 失败,因此新建 job 再识别同一张图;
 * 4xx、超时、网络错误和不含 5xx 状态码的失败均原样返回。
 */
async function ocrImageFileWithRetries(options: OcrApiOptions): Promise<OcrImageOut> {
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt += 1) {
    try {
      return await ocrImageFileAttempt(options)
    } catch (error) {
      const remoteStatus = error instanceof OcrApiError ? error.remoteStatus : null
      const retryable = remoteStatus !== null && remoteStatus >= 500 && remoteStatus <= 599
      // A durable owner retains unknown submissions/accepted IDs. Retrying the
      // whole POST here would hide a second paid job behind the same receipt.
      if (!retryable || options.onSubmissionStarted || options.resumeJobId) throw error
      if (attempt === MAX_IMAGE_ATTEMPTS) {
        const original = error as OcrApiError
        throw new OcrApiError(
          `${original.message};已用尽 ${attempt}/${MAX_IMAGE_ATTEMPTS} 次尝试`,
          original.statusCode,
          remoteStatus,
        )
      }
      await sleep(IMAGE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
    }
  }
  throw new OcrApiError('单张 PNG OCR 任务失败')
}

/**
 * 同一进程内共享 8 个远端 job 槽位;一个槽会一直占到 OCR 结果取回或重试耗尽。
 * 这样不同 PDF 的页图可以交错推进,又不会在多份 PDF 同时展开时无上限地冲击 Paddle。
 */
export async function ocrImageFile(options: OcrApiOptions): Promise<OcrImageOut> {
  const token = options.token?.trim() || ''
  const redact = ocrTokenRedactor(token)
  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value)
    if (Array.isArray(value)) return value.map(redactValue)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), redactValue(entry)]))
    return value
  }
  try {
    const result = await withPaddleJobPermit(options.isCancelled, () => ocrImageFileWithRetries(options))
    return redactValue(result) as OcrImageOut
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error))
    throw new OcrApiError(message, error instanceof OcrApiError ? error.statusCode : 502, error instanceof OcrApiError ? error.remoteStatus : undefined, error instanceof OcrApiError ? error.failureKind : 'failure')
  }
}

async function safeJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json()
  } catch (error) {
    throw new OcrApiError(`${what}不是合法 JSON`)
  }
}

/**
 * 取 OCR 配置(token / 地址 / 模型 / 等待上限)。
 *
 * ── 取值顺序(每一档都有人真的会用)────────────────────────────────────
 *  - **token**:显式 override → 页面保存值 → `NUXT_OCR_TOKEN`(`runtimeConfig.ocrToken`)→
 *    `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`。最后一档是**与用户 MCP 配置同名的那颗变量**
 *    (见 SPEC 的技术前提表:同一颗 token 同时给 MCP 与 API)—— 让人为同一样东西配两遍
 *    是没必要的,而且那一档在用户机器上**本来就已经是满的**。
 *  - **baseUrl / model**:`NUXT_OCR_BASE_URL` / `PADDLEOCR_MCP_AISTUDIO_BASE_URL`、
 *    `NUXT_OCR_MODEL`。有了它,测试可以指到一个**本地假服务**上跑完整的
 *    「提交 → 轮询 → 取 JSONL」,不必碰外网;也可以指到自建网关。
 *
 * ── 空 token 不是「无鉴权」──────────────────────────────────────────────
 * 它是**没配**。提交时 `ocrImageFile` 会挡下来并给出怎么配的一句话 —— 而**上传通路
 * (b)完全不需要 token**,这条路上没配 token 不影响任何事。
 *
 * `useRuntimeConfig` 在 nitro 之外(裸 node 跑测试)不存在,所以用 `typeof` 探一下 ——
 * 这不是给生产写的兼容层,而是让这个函数能被单测直接调。
 */
export function resolveOcrConfig(override: { token?: string } = {}) {
  const token = resolveCredential('core.ocrToken', credentialContext(), override.token).value
  return { ...ocrProviderOptions(), token }
}

export async function resolvePostgresOcrConfig(db: NodePgDatabase) {
  const token = (await resolvePostgresCredential(db, 'core.ocrToken')).value
  return { ...ocrProviderOptions(), token }
}

function ocrProviderOptions() {
  const config = (
    typeof useRuntimeConfig === 'function'
      ? (useRuntimeConfig() as {
          ocrBaseUrl?: string
          ocrModel?: string
          ocrPollTimeoutMs?: number
        })
      : {}
  ) as {
    ocrBaseUrl?: string
    ocrModel?: string
    ocrPollTimeoutMs?: number
  }
  const env = process.env
  const pollTimeoutMs = firstNumber(
    [config.ocrPollTimeoutMs, Number(env.NUXT_OCR_POLL_TIMEOUT_MS)],
    DEFAULT_POLL_TIMEOUT_MS,
  )
  return {
    baseUrl:
      clean(config.ocrBaseUrl) ||
      clean(env.NUXT_OCR_BASE_URL) ||
      clean(env.PADDLEOCR_MCP_AISTUDIO_BASE_URL) ||
      OCR_BASE_URL,
    model: clean(config.ocrModel) || clean(env.NUXT_OCR_MODEL) || DEFAULT_OCR_MODEL,
    pollTimeoutMs,
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstNumber(values: readonly unknown[], fallback: number): number {
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return fallback
}
