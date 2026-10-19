import { maintainStoredFileSync, splitFileMaintenanceBody } from './file-maintenance'
import type { updateStoredFile } from './stored-files'
type Db = Parameters<typeof updateStoredFile>[0]
export interface StoredFilePatchResponse { status: number; body: unknown }
/** Shared PATCH contract; the Nitro route handles transport authorization. */
export function handleStoredFilePatchRequest(method: string, idValue: unknown, body: unknown, db: Db): StoredFilePatchResponse {
  if (method !== 'PATCH') return { status: 405, body: { message: '只允许 PATCH' } }
  const id = Number(idValue)
  if (!Number.isSafeInteger(id) || id <= 0) return { status: 400, body: { message: '文件 id 非法' } }
  try {
    const { options, patch } = splitFileMaintenanceBody(body, 'update')
    return { status: 200, body: maintainStoredFileSync(db, id, 'update', patch, options) }
  } catch (error) {
    return { status: (error as { statusCode?: number }).statusCode ?? 500, body: { message: (error as Error).message } }
  }
}
