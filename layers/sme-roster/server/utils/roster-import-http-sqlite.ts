import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { hasAnnouncementRows } from '../../lib/roster-import-client'
import { stageAnnouncement } from './announcement-intake'
import { importExecutor } from './import-execution'
import { replayRosterImport } from './roster-import'
import { validateRosterImportPageCounts } from './roster-import-page-validation'
import { handleImportSubmission, type ImportContext, type RosterHttpRequest, type RosterImportAction } from './roster-import-http'
export { authorizeRosterWrite } from './roster-import-http'
export type { RosterHttpRequest, RosterImportAction } from './roster-import-http'

type Db = BetterSQLite3Database<typeof schema>

export function handleRosterImportRequest(
  action: RosterImportAction,
  request: RosterHttpRequest,
  deps: ImportContext & { db: Db; executeImport?: typeof importExecutor.execute },
) {
  return handleImportSubmission(action, request, deps, async input => {
    const pageCountErrors = (action === 'preflight' || action === 'commit') && deps.filesDir
      ? await validateRosterImportPageCounts(input, deps.filesDir)
      : []

    if (action === 'replay') return replayRosterImport(deps.db, input, deps.logContext)
    if (action === 'commit' && hasAnnouncementRows(input)) {
      const staged = deps.executeImport
        ? stageAnnouncement(deps.db as Parameters<typeof stageAnnouncement>[0], input, pageCountErrors)
        : await importExecutor.stage(deps.db, input, pageCountErrors, deps.logContext)
      if (staged) return staged
    }
    return (deps.executeImport ?? importExecutor.execute)(deps.db, action, input, pageCountErrors, deps.logContext, { filesDir: deps.filesDir })
  })
}
