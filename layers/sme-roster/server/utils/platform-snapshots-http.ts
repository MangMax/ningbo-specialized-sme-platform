import { type PlatformSnapshotAction, type PlatformSnapshotHttpRequest, type PlatformSnapshotHttpResponse, parseSnapshotRequest, listResult, invalidDiff, diffResult } from './platform-snapshots-http-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { getPlatformExportRows, getPlatformSnapshotBatch, listPlatformSnapshots } from '../../lib/platform-snapshots'
type Db = BetterSQLite3Database<typeof schema>
/** SQLite fixture adapter for snapshot contract tests. */
export function handlePlatformSnapshotRequest(
  action: PlatformSnapshotAction,
  request: PlatformSnapshotHttpRequest,
  deps: { db: Db },
): PlatformSnapshotHttpResponse {
  const selection = parseSnapshotRequest(action, request)
  if ('status' in selection) return selection
  if (selection.action === 'snapshots') return listResult(listPlatformSnapshots(deps.db, selection.filter))
  const { fromId, toId } = selection
  const from = getPlatformSnapshotBatch(deps.db, fromId)
  const to = getPlatformSnapshotBatch(deps.db, toId)
  if (!from || !to || from.titleCode !== to.titleCode) return invalidDiff(fromId, toId, from, to)
  return diffResult(from, to, getPlatformExportRows(deps.db, fromId), getPlatformExportRows(deps.db, toId))
}
export { type PlatformSnapshotAction, type PlatformSnapshotHttpRequest, type PlatformSnapshotHttpResponse, handlePostgresPlatformSnapshotRequest } from './platform-snapshots-http-postgres'
