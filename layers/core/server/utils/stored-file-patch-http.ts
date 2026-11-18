import { appLog, type LogContext } from '../../lib/logging'
import { maintainStoredFileSync, splitFileMaintenanceBody } from './file-maintenance'
import type { updateStoredFile } from './stored-files'
type Db = Parameters<typeof updateStoredFile>[0]
export interface StoredFilePatchResponse { status: number; body: unknown }
/** Shared PATCH contract; the Nitro route handles transport authorization. */
export function handleStoredFilePatchRequest(method: string, idValue: unknown, body: unknown, db: Db, context: LogContext = {}): StoredFilePatchResponse {
  if (method !== 'PATCH') return { status: 405, body: { message: '只允许 PATCH' } }
  const id = Number(idValue)
  if (!Number.isSafeInteger(id) || id <= 0) return { status: 400, body: { message: '文件 id 非法' } }
  try {
    const { options, patch } = splitFileMaintenanceBody(body, 'update')
    const row = maintainStoredFileSync(db, id, 'update', patch, options)
    appLog({ module: 'core', source: 'file', operation: 'file.maintenance.update', outcome: 'success', fileId: row.id }, context)
    return { status: 200, body: row }
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    appLog({ module: 'core', source: 'file', operation: 'file.maintenance.update', outcome: status < 500 ? 'denied' : 'failure', level: 'error', errorCode: 'file_maintenance_failed', fileId: id }, context)
    return { status, body: { message: (error as Error).message } }
  }
}
