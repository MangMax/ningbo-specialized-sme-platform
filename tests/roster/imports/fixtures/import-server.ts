/** Real HTTP routes for import preflight, commit, replay and evidence-page updates. */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { authorizeRosterWrite, handleRosterImportRequest, type RosterImportAction } from '../../../../layers/sme-roster/server/utils/roster-import-http'
import { readAnnouncementIntake, supplementAnnouncement, supplementSchema } from '../../../../layers/sme-roster/server/utils/announcement-intake'
import { ImportReceiptError } from '../../../../layers/sme-roster/server/utils/import-receipts'
import { EnterpriseKernelError } from '../../../../layers/core/public'
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

export function matchFixtureIntakeRoute(db: Db, token: string | null | undefined, filesDir?: string) {
  return (path: string): FixtureHandler | undefined => {
    const coordinate = /^\/api\/roster\/import\/intake\/(\d+)(\/supplement)?$/.exec(path)
    if (!coordinate) return
    const id = Number(coordinate[1])
    return async request => {
      const auth = authorizeRosterWrite(request, token)
      if (!auth.ok) return auth
      const source = db as Parameters<typeof readAnnouncementIntake>[0]
      try {
        if (!coordinate[2] && request.method === 'GET') return { status: 200, body: readAnnouncementIntake(source, id) }
        if (coordinate[2] && request.method === 'POST') {
          const input = supplementSchema.parse(request.body)
          return { status: 200, body: await supplementAnnouncement(source, id, input, filesDir) }
        }
        return { status: 405, body: { message: 'Method not allowed' } }
      } catch (error) {
        if (error instanceof ImportReceiptError || error instanceof EnterpriseKernelError) {
          return { status: error.statusCode, body: { code: error.code, message: error.message } }
        }
        throw error
      }
    }
  }
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
    matchRoute: matchFixtureIntakeRoute(options.db, options.apiToken, options.filesDir),
    routes: {
      '/api/roster/import/preflight': importRoute,
      '/api/roster/import/commit': importRoute,
      '/api/roster/import/replay': importRoute,
      '/api/roster/evidence/pages': evidencePagesRoute,
    },
  })
}
