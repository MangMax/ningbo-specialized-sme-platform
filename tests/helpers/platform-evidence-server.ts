/**
 * 一个**真实**的进程内 HTTP 服务(RL-03 的端到端夹具)。
 *
 * 同一条服务同时挂两类路由,用它跑「写入 → 读回」的闭环:
 *  - **写**:`POST /api/roster/import/{preflight,commit}` → RL-11 的
 *    `handleRosterImportRequest`(Nitro 路由调的就是这一个,不是替身);
 *  - **读**:调用方注入的 GET 处理器(本票注入的是**真的**两块路由模块:
 *    `server/api/platform/queries.get.ts` 与 `server/api/comparison.get.ts`)。
 *
 * 起端口 / 读 body / 404 / 异常 → 状态码等细节见共用底座
 * [`http-fixture.ts`](./http-fixture.ts)(`agent-http.test.ts` 里那次 `createNitro`
 * 只用来问路由**注册表**,不是拿来服务的 —— 进程内它扫不到 `server/api`)。
 * 这里只留「哪些路径交给谁」。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleRosterImportRequest } from '../../server/utils/roster-import-http'
import { startHttpFixture, type FixtureHandler } from './http-fixture'

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

export async function startEvidenceServer(options: EvidenceServerOptions): Promise<EvidenceServer> {
  const importRoute: FixtureHandler = (request) => {
    const out = handleRosterImportRequest(
      request.path.endsWith('/commit') ? 'commit' : 'preflight',
      { method: request.method, headers: request.headers, body: request.body },
      { db: options.db, apiToken: options.apiToken },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }

  // 读侧的处理器直接返回响应体;抛异常由底座翻成对应状态码(与旧夹具同口径)。
  const getRoutes: Record<string, FixtureHandler> = {}
  for (const [path, handler] of Object.entries(options.getRoutes)) {
    getRoutes[path] = (request) => ({ status: 200, body: handler(request.url) })
  }

  return startHttpFixture({
    routes: {
      '/api/roster/import/preflight': importRoute,
      '/api/roster/import/commit': importRoute,
    },
    getRoutes,
  })
}
