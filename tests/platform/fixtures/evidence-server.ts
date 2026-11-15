/** Real in-process HTTP contracts. Worker isolation is verified in its dedicated suite. */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { handleRosterImportRequest } from '../../../server/utils/roster-import-http'
import { executeNativeImport } from '../../roster/imports/fixtures/import-server'
import { startHttpFixture, type FixtureHandler } from '../../support/http'

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
  /**
   * 路径 → 处理器,**任意方法**都交给它(走 `http-fixture` 的 `routes` 表)。
   *
   * 给「同一个路径上 GET 与 POST 语义不同」的读面用(如 RL-06 的 `uscc-research`:
   * `GET` 只跑库内路径、`POST` 还要收公开来源/判定文件)。处理器拿得到 `request.method`,
   * 自己按方法分派 —— 方法守卫留在被测那一层,夹具不替它做白名单(与底座同一条规则)。
   */
  routes?: Record<string, FixtureHandler>
}

export async function startEvidenceServer(options: EvidenceServerOptions): Promise<EvidenceServer> {
  const importRoute: FixtureHandler = async (request) => {
    const out = await handleRosterImportRequest(
      request.path.endsWith('/commit') ? 'commit' : 'preflight',
      { method: request.method, headers: request.headers, body: request.body },
      { db: options.db, apiToken: options.apiToken, executeImport: executeNativeImport },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }

  // 读侧的处理器直接返回响应体;抛异常由底座翻成对应状态码(与旧夹具同口径)。
  const getRoutes: Record<string, FixtureHandler> = {}
  for (const [path, handler] of Object.entries(options.getRoutes)) {
    getRoutes[path] = async (request) => ({ status: 200, body: await handler(request.url) })
  }

  return startHttpFixture({
    routes: {
      '/api/roster/import/preflight': importRoute,
      '/api/roster/import/commit': importRoute,
      ...(options.routes ?? {}),
    },
    getRoutes,
  })
}
