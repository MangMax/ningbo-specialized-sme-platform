/**
 * 一个**真实**的名录导入 HTTP 服务(RL-11 的验收夹具)。
 *
 * 契约验收要求「以真实 HTTP 契约测试预检、提交、重复重放、失败恢复及完整性,不以直接
 * 数据库写入代替 API 验收」。起端口 / 读 body / 404 与 500 信封等**逐字重复**的部分已经
 * 抽到 [`http-fixture.ts`](./http-fixture.ts);这里只剩本夹具的路由表 ——
 * 把**同一份** `handleRosterImportRequest`(Nitro 路由也调它)挂上去,测的不是替身实现。
 *
 * 只认四条路径:`/api/roster/import/preflight`、`/commit`、`/replay`(RL-19 的收敛重放)
 * 与 `/api/roster/evidence/pages`(RL-10 的出处页码补录);其余一律 404。
 *
 * RL-10 那条**没有**新起一份夹具:它和导入面共用同一个 `db` / `apiToken`,起两个端口
 * 等于让一批测试同时握两个服务(端口更多、关不干净的风险更大),而它们的路由互不重叠。
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleRosterImportRequest, type RosterImportAction } from '../../server/utils/roster-import-http'
import { handleEvidencePagesRequest } from '../../server/utils/roster-evidence-pages'
import { startHttpFixture, type FixtureHandler } from './http-fixture'

type Db = BetterSQLite3Database<typeof schema>

export interface RosterApiServer {
  baseUrl: string
  close(): Promise<void>
}

export async function startRosterApi(options: {
  db: Db
  apiToken: string | null | undefined
  filesDir?: string
}): Promise<RosterApiServer> {
  // 写面只有这一条核心:`/preflight`、`/commit`、`/replay` 只差一个动作参数。
  const importRoute: FixtureHandler = async (request) => {
    const action: RosterImportAction = request.path.endsWith('/commit')
      ? 'commit'
      : request.path.endsWith('/replay')
        ? 'replay'
        : 'preflight'
    const out = await handleRosterImportRequest(
      action,
      { method: request.method, headers: request.headers, body: request.body },
      { db: options.db, apiToken: options.apiToken, filesDir: options.filesDir },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }

  // RL-10 的出处页码补录:Nitro 路由(`server/api/roster/evidence/pages.post.ts`)调的
  // 是同一个 `handleEvidencePagesRequest`,所以这里回放的不是替身实现。
  const evidencePagesRoute: FixtureHandler = (request) => {
    const out = handleEvidencePagesRequest(
      { method: request.method, headers: request.headers, body: request.body },
      { db: options.db, apiToken: options.apiToken, filesDir: options.filesDir },
    )
    return out.then(({ status, headers, body }) => ({ status, headers, body }))
  }

  return startHttpFixture({
    routes: {
      '/api/roster/import/preflight': importRoute,
      '/api/roster/import/commit': importRoute,
      '/api/roster/import/replay': importRoute,
      '/api/roster/evidence/pages': evidencePagesRoute,
    },
  })
}
