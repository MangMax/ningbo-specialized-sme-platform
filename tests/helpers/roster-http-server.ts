/**
 * 一个**真实**的名录导入 HTTP 服务(RL-11 的验收夹具)。
 *
 * 契约验收要求「以真实 HTTP 契约测试预检、提交、重复重放、失败恢复及完整性,不以直接
 * 数据库写入代替 API 验收」。起端口 / 读 body / 404 与 500 信封等**逐字重复**的部分已经
 * 抽到 [`http-fixture.ts`](./http-fixture.ts);这里只剩本夹具的路由表 ——
 * 把**同一份** `handleRosterImportRequest`(Nitro 路由也调它)挂上去,测的不是替身实现。
 *
 * 只认两条路径:`/api/roster/import/preflight` 与 `/commit`;其余一律 404。
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleRosterImportRequest } from '../../server/utils/roster-import-http'
import { startHttpFixture, type FixtureHandler } from './http-fixture'

type Db = BetterSQLite3Database<typeof schema>

export interface RosterApiServer {
  baseUrl: string
  close(): Promise<void>
}

export async function startRosterApi(options: { db: Db; apiToken: string | null | undefined }): Promise<RosterApiServer> {
  // 写面只有这一条核心:`/commit` 与 `/preflight` 只差一个动作参数。
  const importRoute: FixtureHandler = (request) => {
    const out = handleRosterImportRequest(
      request.path.endsWith('/commit') ? 'commit' : 'preflight',
      { method: request.method, headers: request.headers, body: request.body },
      { db: options.db, apiToken: options.apiToken },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }

  return startHttpFixture({
    postRoutes: {
      '/api/roster/import/preflight': importRoute,
      '/api/roster/import/commit': importRoute,
    },
  })
}
