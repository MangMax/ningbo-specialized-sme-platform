/**
 * **通路 a:在线 PaddleOCR API**(票 14)。异步提交 → 轮询 → 取 JSONL 结果。
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
 * ── 为什么提交 **整份 PDF**,而不是逐页 PNG ──────────────────────────────
 * 票 13 的产物是页图,API 也确实收图片。但整份 PDF 提交有三个决胜点:
 *  1. **页码天然对齐**:结果里第 i 段就是第 i 页,不必自己按提交顺序数;
 *  2. **一次调用一份文件**,而不是 97 页 97 次提交 + 97 次轮询(实测 97 页 PDF
 *     逐页提交会把一次几分钟的活拖成十几分钟,还更容易撞限流);
 *  3. 界面/版式上下文更全(VL 模型看得见前后页),跨页表格与页眉识别更稳。
 * 代价是「页图那一环没进一来一回」——但页图仍然是**可以核对的**:任务的产出里带了
 * 「OCR 出的页数 vs 票 13 已渲染的页图数」,对不上会被报出来(见 `jobs/ocr.ts`)。
 * 代理若要逐页自己跑,走 MCP 的 `list_page_images` 取图 + `save_ocr_result` 写回(通路 c)。
 *
 * ── 凭证 ───────────────────────────────────────────────────────────────
 * **不入库、不入仓库**(SPEC 硬约束)。从环境变量读:`NUXT_OCR_TOKEN`,或与 MCP 配置
 * 同名的那颗 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`。仓库里只有 `.env.example` 的占位名。
 */

/** AIStudio 的 PaddleOCR 服务地址(SDK 里的 `DEFAULT_BASE_URL`,不是猜的)。 */
export const OCR_BASE_URL = 'https://paddleocr.aistudio-app.com'

/** 任务端点。`POST` 提交、`GET .../{jobId}` 轮询。 */
export const OCR_JOBS_PATH = '/api/v2/ocr/jobs'

/** 默认模型:文档解析、**直接出 markdown**(与用户 MCP 配置里的 `PADDLEOCR_MCP_MODEL` 一致)。 */
export const DEFAULT_OCR_MODEL = 'PaddleOCR-VL-1.6'

/** 轮询间隔(毫秒)。API 是分钟级的活,2 秒一次足够且不至于把服务问烦。 */
export const DEFAULT_POLL_INTERVAL_MS = 2000

/** 单份文件的总等待上限(毫秒)。97 页实测数分钟;10 分钟兜住异常。 */
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000

/** 一次外部调用的网络超时(毫秒)。提交要上传整份 PDF,给宽一点。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120 * 1000

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
  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'OcrApiError'
    this.statusCode = statusCode
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

/** 一份文件的识别产物。 */
export interface OcrFileOut {
  jobId: string
  model: string
  pages: OcrPageOut[]
  /** 服务端报的总页数(有时没有 —— 那时按结果里的页数)。 */
  totalPages: number | null
  elapsedMs: number
}

/** 跑一次识别需要的输入。 */
export interface OcrApiOptions {
  token: string
  /** 要识别的 PDF 的**绝对路径**。 */
  filePath: string
  /** 提交时的文件名(带扩展名;API 靠它判类型)。 */
  fileName?: string
  baseUrl?: string
  model?: string
  pageRanges?: string
  fetchImpl?: FetchLike
  pollIntervalMs?: number
  pollTimeoutMs?: number
  requestTimeoutMs?: number
  /** 进度回调:`{done,total}` 是**页**数(服务端报的)。 */
  onProgress?: (done: number, total: number) => void
  /** 取消检查 —— 每个轮询周期问一次(这就是「尽力而为」的检查点)。 */
  isCancelled?: () => boolean
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
      throw new OcrApiError(`结果不是合法 JSONL(第 ${i + 1} 行):${(error as Error).message}`)
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
    )
  } finally {
    clearTimeout(timer)
  }
}

async function readErrorText(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      return messageOf(parsed) ?? text.slice(0, 300)
    } catch {
      return text.slice(0, 300)
    }
  } catch {
    return '(响应体读不出来)'
  }
}

/**
 * 跑一次识别:提交 → 轮询 → 取 JSONL → 按页切好。
 *
 * **不落库、不碰 page 号推导之外的任何业务**:它只回答「这份 PDF 每页的 markdown 是什么」。
 * 落库(`ocr_result`)是 `server/utils/ocr-result.ts` 的事,编排是 `jobs/ocr.ts` 的事 ——
 * 三件事分开,才能让这一层用一个假 `fetch` 单测(真网络不进测试)。
 */
export async function ocrPdfFile(options: OcrApiOptions): Promise<OcrFileOut> {
  const startedAt = Date.now()
  const token = options.token?.trim()
  if (!token) {
    throw new OcrApiError(
      '缺少 OCR token:设 `NUXT_OCR_TOKEN`(或 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`)。' +
        '凭证不入库、不入仓库,只从环境变量/`.env` 读。',
      401,
    )
  }
  const base = (options.baseUrl?.trim() || OCR_BASE_URL).replace(/\/+$/, '')
  const jobsUrl = `${base}${OCR_JOBS_PATH}`
  const model = options.model?.trim() || DEFAULT_OCR_MODEL
  const impl = options.fetchImpl ?? realFetch
  const sleep = options.sleep ?? defaultSleep
  const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const pollTimeout = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const auth = { Authorization: `Bearer ${token}` }

  // ---- 1. 提交(multipart;整份 PDF 一个 job)----------------------------------
  //
  // **流式上传**,不把整份 PDF 读进内存:97 页的扫描件可能上百 MB,而 `readFile` 一份
  // + `Blob` 再一份 = 峰值两份;app 的任务是**单进程串行**跑的,峰值过高会连带拖垮
  // 页图渲染与 HTTP(--max-old-space-size 之下直接 OOM)。`openAsBlob`(Node 20+)
  // 让 undici 直接从磁盘流式读,内存里始终只有一块缓冲区。
  let blob: Blob
  try {
    // `stat` 走 promises 版(`node:fs` 上那个是回调式,promise 化会在运行时才炸);
    // `openAsBlob` 只在 `node:fs` 上有(`node:fs/promises` 里没有这个导出)。
    const { stat } = await import('node:fs/promises')
    const { openAsBlob } = await import('node:fs')
    // 先 stat 一次:不存在/不是文件时给一句人话,而不是让 undici 抛 ENOENT。
    const info = await stat(options.filePath)
    if (!info.isFile()) throw new Error('不是文件')
    blob = await openAsBlob(options.filePath, { type: 'application/pdf' })
  } catch (error) {
    throw new OcrApiError(`读不到要识别的文件:${(error as Error).message}`, 404)
  }
  const fileName = options.fileName ?? options.filePath.split('/').pop() ?? 'input.pdf'

  const form = new FormData()
  form.append('file', blob, fileName)
  form.append('model', model)
  // 与 SDK 一致:`optionalPayload` 是**字符串**化的 JSON。
  form.append('optionalPayload', JSON.stringify({}))
  if (options.pageRanges) form.append('pageRanges', options.pageRanges)

  const submitRes = await fetchWithTimeout(
    impl,
    jobsUrl,
    { method: 'POST', headers: auth, body: form },
    requestTimeout,
    '提交 OCR 任务',
  )
  if (!submitRes.ok) {
    const detail = await readErrorText(submitRes)
    throw new OcrApiError(
      `提交 OCR 任务被拒(HTTP ${submitRes.status}):${detail}`,
      submitRes.status === 401 || submitRes.status === 403 ? 401 : 502,
    )
  }
  const submitted = unwrap(await safeJson(submitRes, '提交响应'), '提交 OCR 任务')
  const jobId = submitted.jobId
  if (typeof jobId !== 'string' || !jobId) throw new OcrApiError('提交响应里没有 jobId')

  // ---- 2. 轮询 ----------------------------------------------------------------
  const deadline = Date.now() + pollTimeout
  let totalPages: number | null = null
  let jsonUrl: string | null = null
  for (;;) {
    if (options.isCancelled?.()) {
      throw new OcrApiError(`识别已按取消请求停止(服务端任务 ${jobId} 仍在跑,结果丢弃)。`, 499)
    }
    const statusRes = await fetchWithTimeout(
      impl,
      `${jobsUrl}/${encodeURIComponent(jobId)}`,
      { method: 'GET', headers: auth },
      requestTimeout,
      '查询 OCR 任务',
    )
    if (!statusRes.ok) {
      throw new OcrApiError(`查询 OCR 任务失败(HTTP ${statusRes.status}):${await readErrorText(statusRes)}`)
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
      const why = typeof data.errorMsg === 'string' && data.errorMsg ? data.errorMsg : '(无 errorMsg)'
      throw new OcrApiError(`OCR 任务失败:${why}`)
    }
    if (Date.now() > deadline) {
      throw new OcrApiError(
        `OCR 任务等待超时(${Math.round(pollTimeout / 1000)} s,任务 ${jobId} 仍未完成)。` +
          '任务在服务端可能仍在跑;调大 `NUXT_OCR_POLL_TIMEOUT_MS` 或稍后重试同一份文件。',
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
    throw new OcrApiError(`下载 OCR 结果失败(HTTP ${jsonRes.status}):${await readErrorText(jsonRes)}`)
  }
  const pages = pagesFromJsonl(await jsonRes.text())
  if (!pages.length) throw new OcrApiError('OCR 结果里一页都没有(服务端返回了空的 JSONL)')

  options.onProgress?.(pages.length, totalPages ?? pages.length)
  return { jobId, model, pages, totalPages, elapsedMs: Date.now() - startedAt }
}

async function safeJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json()
  } catch (error) {
    throw new OcrApiError(`${what}不是合法 JSON:${(error as Error).message}`)
  }
}

/**
 * 取 OCR 配置(token / 地址 / 模型 / 等待上限)。
 *
 * ── 取值顺序(每一档都有人真的会用)────────────────────────────────────
 *  - **token**:显式 override → `NUXT_OCR_TOKEN`(`runtimeConfig.ocrToken`)→
 *    `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`。最后一档是**与用户 MCP 配置同名的那颗变量**
 *    (见 SPEC 的技术前提表:同一颗 token 同时给 MCP 与 API)—— 让人为同一样东西配两遍
 *    是没必要的,而且那一档在用户机器上**本来就已经是满的**。
 *  - **baseUrl / model**:`NUXT_OCR_BASE_URL` / `PADDLEOCR_MCP_AISTUDIO_BASE_URL`、
 *    `NUXT_OCR_MODEL`。有了它,测试可以指到一个**本地假服务**上跑完整的
 *    「提交 → 轮询 → 取 JSONL」,不必碰外网;也可以指到自建网关。
 *
 * ── 空 token 不是「无鉴权」──────────────────────────────────────────────
 * 它是**没配**。提交时 `ocrPdfFile` 会挡下来并给出怎么配的一句话 —— 而**上传通路
 * (b)完全不需要 token**,这条路上没配 token 不影响任何事。
 *
 * `useRuntimeConfig` 在 nitro 之外(裸 node 跑测试)不存在,所以用 `typeof` 探一下 ——
 * 这不是给生产写的兼容层,而是让这个函数能被单测直接调。
 */
export function resolveOcrConfig(override: { token?: string } = {}): {
  token: string
  baseUrl: string
  model: string
  pollTimeoutMs: number
} {
  const config = (
    typeof useRuntimeConfig === 'function'
      ? (useRuntimeConfig() as {
          ocrToken?: string
          ocrBaseUrl?: string
          ocrModel?: string
          ocrPollTimeoutMs?: number
        })
      : {}
  ) as {
    ocrToken?: string
    ocrBaseUrl?: string
    ocrModel?: string
    ocrPollTimeoutMs?: number
  }
  const env = process.env
  const token =
    clean(override.token) ||
    clean(config.ocrToken) ||
    clean(env.NUXT_OCR_TOKEN) ||
    clean(env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN) ||
    ''
  const pollTimeoutMs = firstNumber(
    [config.ocrPollTimeoutMs, Number(env.NUXT_OCR_POLL_TIMEOUT_MS)],
    DEFAULT_POLL_TIMEOUT_MS,
  )
  return {
    token,
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
