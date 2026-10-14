import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 一个**假的 PaddleOCR 服务**:照 `server/utils/ocr-api.ts` 用的那三个端点的形状回话。
 *
 * 为什么要有它:通路 a 的全部逻辑(提交 multipart → 轮询状态 → 取 JSONL → 按页切)
 * 只有**真的走一遍 HTTP** 才算验过。用一个假服务把它跑通,换来三件事:
 *
 *  1. **不碰外网、不花那份 token 的额度** —— 测试可以每次 CI 都跑;
 *  2. **能演我们演不出来的分支** —— `pending → running → done` 的中间态、
 *     `state:"failed"`、结果里少一页,这些在真服务上没法按需触发;
 *  3. **形状是照官方 SDK 抄的** —— 从 `paddleocr` 的 `_api_client/_poller.py`
 *     (`parse_doc_parsing_result` 读 `line.result.layoutParsingResults[].markdown.text`)
 *     与 `_http.py`(端点 `/api/v2/ocr/jobs`、`{code,data}` 信封、`resultUrl.jsonUrl`)
 *     逐字对齐。形状抄错的话,这个测试会「绿」而真调用照样崩 —— 所以对齐这一点写在票里。
 *
 * 端口用 `0`(系统分配),不与 dev 端口冲突。
 */
export interface ModelApiFixture {
  /** 每一页的 markdown(顺序即页号,第 i 项 = 第 i 页)。 */
  pages: string[]
  /** 轮询第几次才 `done`(默认 1:第一次查就是 done;给 2 会先回一次 running)。 */
  doneAfterPolls?: number
  /** 直接让任务失败(演 `state:"failed"` + `errorMsg`)。 */
  failWith?: string
  /** 服务端报的总页数(默认 = `pages.length`)。 */
  totalPages?: number
  /** 提交时用的模型名回显(默认不校验)。 */
  expectModel?: string
  /** 每次提交收到的 multipart 字段名(供断言「确实传了 file」)。 */
  onSubmit?: (fields: string[]) => void
}

export interface MiniOcrApi {
  /** 形如 `http://127.0.0.1:<port>`;把这个设进 `NUXT_OCR_BASE_URL`。 */
  origin: string
  /** 收到的提交次数、查询次数(断言轮询真的发生过)。 */
  stats: { submits: number; polls: number; jsonlFetches: number }
  /** 见过的 Authorization 头(校验 token 真的带上了)。 */
  authSeen: string[]
  close(): Promise<void>
}

/** 读掉请求体(不读会让 keep-alive 连接卡住)。 */
function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/** 从 multipart 体里抠出 `name="…"` 的字段名(够断言用,不做完整 multipart 解析)。 */
function fieldNames(body: Buffer): string[] {
  const names: string[] = []
  for (const m of body.toString('latin1').matchAll(/name="([^"]+)"/g)) names.push(m[1]!)
  return names
}

export async function startMiniOcrApi(fixture: ModelApiFixture): Promise<MiniOcrApi> {
  const stats = { submits: 0, polls: 0, jsonlFetches: 0 }
  const authSeen: string[] = []
  let port = 0

  const jsonl = () =>
    fixture.pages
      .map((markdown) => JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: markdown } }] } }))
      .join('\n')

  const server: HttpServer = createServer(async (req, res) => {
    authSeen.push(String(req.headers.authorization ?? ''))
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const body = req.method === 'POST' ? await drain(req) : Buffer.alloc(0)

    const send = (status: number, payload: unknown, contentType = 'application/json') => {
      res.statusCode = status
      res.setHeader('content-type', contentType)
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
      return
    }

    // 提交
    if (req.method === 'POST' && url.pathname === '/api/v2/ocr/jobs') {
      stats.submits += 1
      const fields = fieldNames(body)
      fixture.onSubmit?.(fields)
      if (fixture.expectModel && !body.toString('latin1').includes(fixture.expectModel)) {
        return send(400, { code: 1, msg: `model 不是 ${fixture.expectModel}` })
      }
      if (!fields.includes('file')) return send(400, { code: 1, msg: '缺少 file' })
      return send(200, { code: 0, data: { jobId: 'JOB-1' } })
    }

    // 轮询
    if (req.method === 'GET' && url.pathname === '/api/v2/ocr/jobs/JOB-1') {
      stats.polls += 1
      if (fixture.failWith) {
        return send(200, { code: 0, data: { state: 'failed', errorMsg: fixture.failWith } })
      }
      const need = fixture.doneAfterPolls ?? 1
      if (stats.polls < need) {
        return send(200, {
          code: 0,
          data: {
            state: 'running',
            extractProgress: { totalPages: fixture.totalPages ?? fixture.pages.length, extractedPages: stats.polls },
          },
        })
      }
      return send(200, {
        code: 0,
        data: {
          state: 'done',
          resultUrl: { jsonUrl: `http://127.0.0.1:${port}/result.jsonl` },
          extractProgress: { totalPages: fixture.totalPages ?? fixture.pages.length, extractedPages: fixture.pages.length },
        },
      })
    }

    // 取结果
    if (req.method === 'GET' && url.pathname === '/result.jsonl') {
      stats.jsonlFetches += 1
      return send(200, jsonl(), 'application/jsonl')
    }

    // 鉴权失败的样子(供「没带 token」的用例)
    if (url.pathname.startsWith('/api/v2/ocr/jobs')) {
      return send(401, { code: 1, msg: 'token 无效' })
    }
    return send(404, { code: 1, msg: `没有这个路径:${url.pathname}` })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  return {
    origin: `http://127.0.0.1:${port}`,
    stats,
    authSeen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
