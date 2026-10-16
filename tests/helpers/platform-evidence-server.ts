/**
 * 一个**真实**的进程内 HTTP 服务(RL-03 的端到端夹具)。
 *
 * 同一条 `node:http` 服务同时挂两类路由,用它跑「写入 → 读回」的闭环:
 *  - **写**:`POST /api/roster/import/{preflight,commit}` → RL-11 的
 *    `handleRosterImportRequest`(Nitro 路由调的就是这一个,不是替身);
 *  - **读**:调用方注入的 GET 处理器(本票注入的是**真的**两块路由模块:
 *    `server/api/platform/queries.get.ts` 与 `server/api/comparison.get.ts`)。
 *
 * ── 为什么不是 `createNitro` ──────────────────────────────────────────────
 * 实测本仓 `createNitro({rootDir})` **不扫 `server/api`**(`options.handlers` 为空、
 * 也没有 `localFetch`):要么 `build()` 出产物再 import —— 而那份产物是**自带监听**的
 * 入口(一 import 就占端口),要么起 dev server。两条都既慢又不好收口。
 * `agent-http.test.ts` 里那次 `createNitro` 只用来问路由**注册表**,不是拿来服务的。
 * 所以照 RL-11 的先例(`tests/helpers/roster-http-server.ts`)用 `node:http`:
 * 真的起端口、真的走 HTTP、真的调同一份路由逻辑。**不 spawn 进程、不手动 `nuxt dev`**。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleRosterImportRequest } from '../../server/utils/roster-import-http'

type Db = BetterSQLite3Database<typeof schema>

/** 一个 GET 处理器:拿真实 URL(含 query)返回响应体;抛 `{statusCode}` 即该状态码。 */
export type GetHandler = (url: URL) => unknown

export interface EvidenceServer {
  baseUrl: string
  close(): Promise<void>
}

export interface EvidenceServerOptions {
  db: Db
  apiToken: string | null | undefined
  /** 路径(不含 query)→ 处理器。未注册的 GET 一律 404。 */
  getRoutes: Record<string, GetHandler>
}

const IMPORT_PATHS = new Set(['/api/roster/import/preflight', '/api/roster/import/commit'])

export async function startEvidenceServer(options: EvidenceServerOptions): Promise<EvidenceServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      if (req.method === 'POST' && IMPORT_PATHS.has(path)) {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        try {
          body = raw ? JSON.parse(raw) : null
        } catch {
          body = raw
        }
        const out = handleRosterImportRequest(
          path.endsWith('/commit') ? 'commit' : 'preflight',
          {
            method: 'POST',
            headers: {
              authorization: headerOf(req.headers.authorization),
              'x-api-token': headerOf(req.headers['x-api-token']),
            },
            body,
          },
          { db: options.db, apiToken: options.apiToken },
        )
        res.writeHead(out.status, out.headers)
        res.end(JSON.stringify(out.body ?? null))
        return
      }

      const handler = req.method === 'GET' ? options.getRoutes[path] : undefined
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ message: 'not found' }))
        return
      }
      try {
        const body = handler(url)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body ?? null))
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 500
        res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function headerOf(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}
