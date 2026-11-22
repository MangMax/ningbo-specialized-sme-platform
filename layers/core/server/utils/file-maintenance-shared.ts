import { createHash } from 'node:crypto'
import { appLog, type LogContext } from '../../lib/logging'
import { FileMaintenanceError, parseDisplayNamePatch, type FileRow } from './file-store-contract'

export type FileMaintenanceAction = 'update' | 'remove' | 'restore'
export interface FileMaintenanceOptions { expectedRevision?: number; idempotencyKey?: string; actor?: string; basis?: string }
const controls = ['expectedRevision', 'idempotencyKey', 'actor', 'basis'] as const
export function parseFileMaintenanceOptions(value: unknown): FileMaintenanceOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FileMaintenanceError(400, '请求体必须是对象')
  const body = value as Record<string, unknown>
  const supplied = controls.filter(key => body[key] !== undefined)
  if (supplied.length && supplied.length !== controls.length) throw new FileMaintenanceError(400, '现代维护封套必须同时提供 expectedRevision/idempotencyKey/actor/basis')
  const options: FileMaintenanceOptions = {}
  for (const key of controls) {
    const raw = body[key]
    if (raw === undefined) continue
    if (key === 'expectedRevision') {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new FileMaintenanceError(400, 'expectedRevision 必须是非负整数')
      options.expectedRevision = raw
    } else {
      if (typeof raw !== 'string' || !raw.trim() || raw.length > (key === 'basis' ? 2000 : 200)) throw new FileMaintenanceError(400, `${key} 必须是有界非空文本`)
      options[key] = raw.trim()
    }
  }
  return options
}
export function splitFileMaintenanceBody(body: unknown, action: FileMaintenanceAction) {
  const options = parseFileMaintenanceOptions(body)
  const patch = Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => !(controls as readonly string[]).includes(key)))
  if (action !== 'update' && Object.keys(patch).length) throw new FileMaintenanceError(400, '移出或恢复只接受维护控制字段')
  return { options, patch }
}

export function fileMaintenanceSnapshot(file: FileRow, extension: Record<string, unknown> = {}): Record<string, unknown> {
  const { displayName, removedAt, filename, relPath, bytes, sha256 } = file
  return { ...extension, displayName, removedAt, filename, relPath, bytes, sha256 }
}
export function fileMaintenanceRequestHash(id: number, action: FileMaintenanceAction, patch: unknown, options: FileMaintenanceOptions) {
  return createHash('sha256').update(JSON.stringify({ id, action, patch, expectedRevision: options.expectedRevision ?? null, actor: options.actor ?? null, basis: options.basis ?? null })).digest('hex')
}

export function normalizeFileMaintenancePatch(action: FileMaintenanceAction, rawPatch: unknown, options: FileMaintenanceOptions, parseMetadata: (input: unknown) => Record<string, unknown>) {
  let patch: Record<string, unknown> | { displayName: string } = {}
  try {
    if (action === 'update') {
      patch = rawPatch && typeof rawPatch === 'object' && 'displayName' in rawPatch
        ? { displayName: parseDisplayNamePatch(rawPatch) } : parseMetadata(rawPatch)
      if (!Object.keys(patch).length && options.expectedRevision !== undefined) throw new Error('至少给一个元数据字段或 displayName')
    }
  } catch (error) {
    if (error instanceof FileMaintenanceError) throw error
    throw new FileMaintenanceError(400, (error as Error).message)
  }
  // Normalize field order for transport-independent retries.
  return Object.fromEntries(Object.entries(patch).sort(([a], [b]) => a.localeCompare(b)))
}

export function validateFileMaintenancePage(page: number, pageSize: number) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw new FileMaintenanceError(400, 'page 必须为正整数,pageSize 范围 1–100')
}

export function requireVersionedFileMaintenanceOptions(value: unknown): FileMaintenanceOptions {
  const options = parseFileMaintenanceOptions(value)
  if (options.expectedRevision === undefined) throw new FileMaintenanceError(400, '新维护命令必须提供完整的版本化封套')
  return options
}
export function hasFileMaintenanceControls(value: unknown): boolean {
  return !!value && typeof value === 'object' && controls.some(key => key in value)
}

export async function logFileMaintenance<Row extends FileRow>(id: number, action: FileMaintenanceAction, context: LogContext, run: () => Promise<Row>) {
  const startedAt = Date.now()
  try {
    const result = await run()
    appLog({ module: 'core', source: 'file', operation: `file.maintenance.${action}`, outcome: 'success', fileId: result.id, durationMs: Date.now() - startedAt }, context)
    return result
  } catch (error) {
    // The attempted target: a failed command must not imply the file exists.
    const attemptedFileId = Number.isSafeInteger(id) && id > 0 ? id : undefined
    appLog({ module: 'core', source: 'file', operation: `file.maintenance.${action}`, outcome: error instanceof FileMaintenanceError ? 'denied' : 'failure', level: 'error', errorCode: 'file_maintenance_failed', durationMs: Date.now() - startedAt, ...(attemptedFileId ? { fileId: attemptedFileId } : {}) }, context)
    throw error
  }
}
