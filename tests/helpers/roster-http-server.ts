/**
 * 一个**真实**的名录导入 HTTP 服务(RL-11 的验收夹具)。
 *
 * 契约验收要求「以真实 HTTP 契约测试预检、提交、重复重放、失败恢复及完整性,不以直接
 * 数据库写入代替 API 验收」。起端口 / 读 body / 404 与 500 信封等**逐字重复**的部分已经
 * 抽到 [`http-fixture.ts`](./http-fixture.ts);这里只剩本夹具的路由表 ——
 * 把**同一份** `handleRosterImportRequest`(Nitro 路由也调它)挂上去,测的不是替身实现。
 *
 * 认这几条路径:`/api/roster/import/preflight`、`/commit`、`/replay`(RL-19 的收敛重放)、
 * `/api/roster/evidence/pages`(RL-10 的出处页码补录),以及 RL-07 的年度增量两条只读面
 * (`/annual/preview` 与 `/batches`);其余一律 404。
 *
 * RL-10 与 RL-07 那几条**都没有**各自新起一份夹具:它们和导入面共用同一个 `db` / `apiToken`,
 * 起多个端口等于让一批测试同时握多个服务(端口更多、关不干净的风险更大),而它们的路由互不重叠。
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleRosterImportRequest, type RosterImportAction } from '../../server/utils/roster-import-http'
import { handleEvidencePagesRequest } from '../../server/utils/roster-evidence-pages'
import { handleAnnualPreviewRequest, handleImportBatchesRequest } from '../../server/utils/roster-annual-http'
import { startHttpFixture, type FixtureHandler } from './http-fixture'

type Db = BetterSQLite3Database<typeof schema>

export interface RosterApiServer {
  baseUrl: string
  close(): Promise<void>
}

export async function startRosterApi(options: { db: Db; apiToken: string | null | undefined }): Promise<RosterApiServer> {
  // 写面只有这一条核心:`/preflight`、`/commit`、`/replay` 只差一个动作参数。
  const importRoute: FixtureHandler = (request) => {
    const action: RosterImportAction = request.path.endsWith('/commit')
      ? 'commit'
      : request.path.endsWith('/replay')
        ? 'replay'
        : 'preflight'
    const out = handleRosterImportRequest(
      action,
      { method: request.method, headers: request.headers, body: request.body },
      { db: options.db, apiToken: options.apiToken },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }

  // RL-10 的出处页码补录:Nitro 路由(`server/api/roster/evidence/pages.post.ts`)调的
  // 是同一个 `handleEvidencePagesRequest`,所以这里回放的不是替身实现。
  const evidencePagesRoute: FixtureHandler = (request) => {
    const out = handleEvidencePagesRequest(
      { method: request.method, headers: request.headers, body: request.body },
      { db: options.db, apiToken: options.apiToken },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }

  // RL-07 的两条**只读**面:年度增量预览与批次流水。与上面同一个分法 —— 挂的是 Nitro 路由
  // 也在调的同一份核心函数(`server/utils/roster-annual-http.ts`)。
  const annualPreview: FixtureHandler = (request) => {
    const out = handleAnnualPreviewRequest(
      { method: request.method, body: request.body },
      { db: options.db },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }
  const batchList: FixtureHandler = (request) => {
    const out = handleImportBatchesRequest({ method: request.method, query: request.query }, { db: options.db })
    return { status: out.status, headers: out.headers, body: out.body }
  }

  return startHttpFixture({
    routes: {
      '/api/roster/import/preflight': importRoute,
      '/api/roster/import/commit': importRoute,
      '/api/roster/import/replay': importRoute,
      '/api/roster/evidence/pages': evidencePagesRoute,
      '/api/roster/import/annual/preview': annualPreview,
    },
    getRoutes: { '/api/roster/import/batches': batchList },
  })
}
