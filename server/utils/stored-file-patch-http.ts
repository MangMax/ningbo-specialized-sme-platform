import {
  parseDisplayNamePatch,
  parseMetadataPatch,
  renameStoredFileDisplayName,
  updateStoredFile,
} from './stored-files'

type Db = Parameters<typeof updateStoredFile>[0]

export interface StoredFilePatchResponse {
  status: number
  body: unknown
}

/** Shared PATCH contract used by the Nitro route and real-HTTP tests. */
export function handleStoredFilePatchRequest(
  method: string,
  idValue: unknown,
  body: unknown,
  db: Db,
): StoredFilePatchResponse {
  if (method !== 'PATCH') return { status: 405, body: { message: '只允许 PATCH' } }

  const id = Number(idValue)
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, body: { message: '文件 id 非法' } }
  }

  let row
  try {
    if (body && typeof body === 'object' && !Array.isArray(body) && 'displayName' in body) {
      row = renameStoredFileDisplayName(db, id, parseDisplayNamePatch(body))
    } else {
      row = updateStoredFile(db, id, parseMetadataPatch(body))
    }
  } catch (error) {
    return { status: 400, body: { message: (error as Error).message } }
  }

  if (!row) return { status: 404, body: { message: '文件不存在' } }
  return { status: 200, body: row }
}
