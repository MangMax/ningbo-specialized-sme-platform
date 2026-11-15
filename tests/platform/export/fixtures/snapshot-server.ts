/**
 * 一个**真实**的 HTTP 服务:同时挂名录导入写面(RL-11)与平台快照读面(RL-05)。
 *
 * ── 为什么起真端口而不是起 `nuxt dev` / 起 `createNitro` ─────────────────
 * 契约验收要求「经真实 HTTP 调 `POST /api/roster/import/commit`」并「回到读侧闭环」。
 * 本仓的 vitest 跑在裸 node 下,进程内 `createNitro` 拿不到业务路由 —— 理由与做法见
 * [`http-fixture.ts`](./http-fixture.ts) 顶部的说明(那里是共用底座)。这里只提供路由表:
 * 两份核心 `handleRosterImportRequest` / `handlePlatformSnapshotRequest`,Nitro 路由也只是
 * 薄薄地转调它们 —— 测的不是替身实现,契约只有一份。
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { handlePlatformSnapshotRequest } from '../../../../server/utils/platform-snapshots-http'
import { handleRosterImportRequest } from '../../../../server/utils/roster-import-http'
import { startHttpFixture, type FixtureHandler } from '../../../support/http'

type Db = BetterSQLite3Database<typeof schema>

export interface RosterPlatformServer {
  baseUrl: string
  close(): Promise<void>
}

export async function startRosterPlatformApi(options: {
  db: Db
  apiToken: string | null | undefined
}): Promise<RosterPlatformServer> {
  const importRoute: FixtureHandler = async (request) => {
    const out = await handleRosterImportRequest(
      request.path.endsWith('/commit') ? 'commit' : 'preflight',
      { method: request.method, headers: request.headers, body: request.body },
      { db: options.db, apiToken: options.apiToken },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }
  const snapshotRoute: FixtureHandler = (request) => {
    const out = handlePlatformSnapshotRequest(
      request.path.endsWith('/diff') ? 'diff' : 'snapshots',
      { method: request.method, query: request.query },
      { db: options.db },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }

  return startHttpFixture({
    routes: {
      '/api/roster/import/preflight': importRoute,
      '/api/roster/import/commit': importRoute,
    },
    getRoutes: {
      '/api/platform/snapshots': snapshotRoute,
      '/api/platform/snapshots/diff': snapshotRoute,
    },
  })
}
