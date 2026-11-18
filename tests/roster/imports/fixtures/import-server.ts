/** Real HTTP routes for import preflight, commit, replay and evidence-page updates. */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { handleRosterImportRequest, type RosterImportAction } from '../../../../layers/sme-roster/server/utils/roster-import-http'
import { handleEvidencePagesRequest } from '../../../../layers/sme-roster/server/utils/roster-evidence-pages'
import { startHttpFixture, type FixtureHandler } from '../../../support/http'
import type { importExecutor } from '../../../../layers/sme-roster/server/utils/import-execution'
import { commitRosterImport, preflightRosterImport } from '../../../../layers/sme-roster/server/utils/roster-import'

// HTTP contract tests exercise the actual import core; worker ownership has its own suite.
export const executeNativeImport: typeof importExecutor.execute = async (db, action, request, errors, context, source) =>
  action === 'preflight'
    ? preflightRosterImport(db, request, errors, { ...context, filesDir: source?.filesDir })
    : commitRosterImport(db, request, errors, { ...context, filesDir: source?.filesDir, deferCandidateTasks: true })

type Db = BetterSQLite3Database<typeof schema>

export interface RosterApiServer {
  baseUrl: string
  close(): Promise<void>
}

export async function startRosterApi(options: {
  db: Db
  apiToken: string | null | undefined
  filesDir?: string
  executeImport?: typeof importExecutor.execute
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
      { db: options.db, apiToken: options.apiToken, filesDir: options.filesDir, executeImport: options.executeImport },
    )
    return { status: out.status, headers: out.headers, body: out.body }
  }

  // RL-10 的出处页码补录:Nitro 路由(`layers/sme-roster/server/api/roster/evidence/pages.post.ts`)调的
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
