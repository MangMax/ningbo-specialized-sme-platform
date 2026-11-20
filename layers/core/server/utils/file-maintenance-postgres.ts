import { sql } from 'drizzle-orm'
import type { LogContext } from '../../lib/logging'
import {
  fileMaintenanceRequestHash, fileMaintenanceSnapshot, logFileMaintenance, normalizeFileMaintenancePatch,
  parseFileMaintenanceOptions, validateFileMaintenancePage, type FileMaintenanceAction, type FileMaintenanceOptions,
} from './file-maintenance'
import { FileMaintenanceError, verifyFileRestorationBytes, type FileRow } from './file-store'
import { updatePostgresFileMetadata } from '../../../../server/file-store'
import { extensionSnapshot, parseMetadataPatch } from './stored-files'
import {
  activePostgresPhysicalIntent, lockPostgresFile, readPostgresFile, requirePostgresFileWrite, type PostgresFileDb,
} from './file-store-postgres'

export async function postgresFileRevision(db: PostgresFileDb, id: number) {
  const { rows: [latest] } = await db.execute<{ revision: string }>(sql`
    SELECT revision FROM file_maintenance_audit WHERE file_id = ${id} ORDER BY revision DESC LIMIT 1`)
  return Number(latest?.revision ?? 0)
}

export function checkPostgresFileRevision(actual: number, expected: number | undefined) {
  if (expected !== undefined && actual !== expected) throw new FileMaintenanceError(409, '文件维护修订已变化,请重新读取')
}

/** Serialize client keys across the maintenance and physical journals. File locks are acquired first. */
export async function lockPostgresFileRequestKey(db: PostgresFileDb, key: string | undefined) {
  if (key === undefined) return
  if (key.includes('\0')) throw new FileMaintenanceError(400, '幂等键不能包含 NUL')
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`file-maintenance:${key}`}, 0))`)
}

export async function postgresMaintenanceHash(db: PostgresFileDb, key: string) {
  const { rows: [row] } = await db.execute<{ request_hash: string }>(sql`
    SELECT request_hash FROM file_maintenance_audit WHERE idempotency_key = ${key}`)
  return row?.request_hash
}

async function replay(db: PostgresFileDb, id: number, key: string | undefined, hash: string) {
  if (!key) return
  const previous = await postgresMaintenanceHash(db, key)
  if (previous === undefined) return
  if (previous !== hash) throw new FileMaintenanceError(409, '幂等键已用于不同请求')
  return readPostgresFile(db, id)
}

export async function postgresPhysicalRequestKeyExists(db: PostgresFileDb, key: string) {
  const { rows } = await db.execute(sql`
    SELECT 1 FROM file_physical_intent WHERE delete_key = ${key} OR recover_key = ${key} LIMIT 1`)
  return rows.length !== 0
}

export function rejectNewPhysicalInternalKey(key: string | undefined) {
  // These keys are generated from durable intent IDs and written by the physical completer.
  if (key && /^physical:[0-9a-f-]{36}:(remove|restore)$/.test(key)) {
    throw new FileMaintenanceError(409, '幂等键保留给物理命令')
  }
}

export function physicalMaintenanceKey(intentId: string, action: 'remove' | 'restore') {
  return `physical:${intentId}:${action}`
}

interface VerifiedFileState { file: FileRow; revision: number }

/** Caller owns the stored_file row lock. The physical completer joins its existing transaction. */
export async function applyPostgresFileMaintenance(
  db: PostgresFileDb, current: FileRow, revision: number, action: FileMaintenanceAction,
  patch: Record<string, unknown>, options: FileMaintenanceOptions, hash: string,
) {
  const id = current.id
  checkPostgresFileRevision(revision, options.expectedRevision)
  if (action === 'update' && current.removedAt && options.expectedRevision !== undefined) {
    throw new FileMaintenanceError(409, '文件已移出库,请先恢复')
  }

  const now = new Date().toISOString()
  let after = current
  if (action === 'remove' && !current.removedAt) {
    await db.execute(sql`UPDATE stored_file SET removed_at = ${now} WHERE id = ${id}`)
    after = { ...current, removedAt: now }
  } else if (action === 'restore' && current.removedAt) {
    await db.execute(sql`UPDATE stored_file SET removed_at = NULL WHERE id = ${id}`)
    after = { ...current, removedAt: null }
  } else if (action === 'update' && typeof patch.displayName === 'string' && patch.displayName !== current.displayName) {
    const displayName = patch.displayName
    await db.execute(sql`UPDATE stored_file SET display_name = ${displayName === current.filename ? null : displayName} WHERE id = ${id}`)
    await db.execute(sql`INSERT INTO stored_file_audit (stored_file_id, old_display_name, new_display_name, created_at)
      VALUES (${id}, ${current.displayName}, ${displayName}, ${now})`)
    after = { ...current, displayName }
  } else if (action === 'update' && !('displayName' in patch) && Object.keys(patch).length) {
    await updatePostgresFileMetadata(db, current, patch)
    after = await readPostgresFile(db, id)
  }

  const beforeJson = JSON.stringify(fileMaintenanceSnapshot(current, extensionSnapshot(current)))
  const afterJson = JSON.stringify(fileMaintenanceSnapshot(after, extensionSnapshot(after)))
  if (options.idempotencyKey || beforeJson !== afterJson) {
    await db.execute(sql`INSERT INTO file_maintenance_audit
      (file_id, revision, action, idempotency_key, request_hash, mode, actor, basis, before_json, after_json, created_at)
      VALUES (${id}, ${revision + 1}, ${action}, ${options.idempotencyKey ?? null}, ${hash},
        ${options.expectedRevision === undefined ? 'legacy' : 'versioned'}, ${options.actor ?? null}, ${options.basis ?? null},
        ${beforeJson}, ${afterJson}, ${now})`)
  }
  return after
}

export function maintainPostgresFile(
  db: PostgresFileDb, root: string, id: number, action: FileMaintenanceAction,
  rawPatch: unknown, rawOptions: FileMaintenanceOptions, context?: LogContext,
  { requireActive = false } = {},
) {
  const run = async () => {
    requirePostgresFileWrite()
    const options = parseFileMaintenanceOptions(rawOptions)
    const patch = normalizeFileMaintenancePatch(action, rawPatch, options, parseMetadataPatch)
    const hash = fileMaintenanceRequestHash(id, action, patch, options)
    const key = options.idempotencyKey
    if (key?.includes('\0') || options.actor?.includes('\0') || options.basis?.includes('\0')) {
      throw new FileMaintenanceError(400, '维护控制字段不能包含 NUL')
    }
    let checked: VerifiedFileState | undefined
    if (action === 'restore') {
      const prior = await replay(db, id, key, hash)
      if (prior) return prior
      checked = await db.transaction(async tx => ({
        file: await readPostgresFile(tx, id), revision: await postgresFileRevision(tx, id),
      }), { isolationLevel: 'repeatable read', accessMode: 'read only' })
      await verifyFileRestorationBytes(root, checked.file)
    }
    return db.transaction(async tx => {
      await lockPostgresFile(tx, id)
      await lockPostgresFileRequestKey(tx, key)
      const prior = await replay(tx, id, key, hash)
      if (prior) return prior
      rejectNewPhysicalInternalKey(key)
      if (key && await postgresPhysicalRequestKeyExists(tx, key)) throw new FileMaintenanceError(409, '幂等键已用于其他物理命令')
      const current = await readPostgresFile(tx, id)
      if (requireActive && current.removedAt) throw new FileMaintenanceError(404, '文件已移出库')
      const revision = await postgresFileRevision(tx, id)
      const state = await activePostgresPhysicalIntent(tx, id)
      if (state === 'pending' || state === 'recovering' || (state && action === 'restore')) {
        throw new FileMaintenanceError(409, '文件正在隔离或恢复，请使用物理恢复命令')
      }
      if (checked && (revision !== checked.revision || current.relPath !== checked.file.relPath ||
          current.sha256 !== checked.file.sha256 || current.bytes !== checked.file.bytes || current.removedAt !== checked.file.removedAt)) {
        throw new FileMaintenanceError(409, '核验期间文件状态变化,请重试')
      }
      return applyPostgresFileMaintenance(tx, current, revision, action, patch, options, hash)
    })
  }
  return context ? logFileMaintenance(id, action, context, run) : run()
}

type PgAudit = {
  id: string; fileId: string; revision: string; action: FileMaintenanceAction; idempotencyKey: string | null
  requestHash: string; mode: 'legacy' | 'versioned'; actor: string | null; basis: string | null
  before: string; after: string; createdAt: string
}

export function readPostgresFileMaintenance(db: PostgresFileDb, id: number, page: number, pageSize: number) {
  validateFileMaintenancePage(page, pageSize)
  return db.transaction(async tx => {
    const file = await readPostgresFile(tx, id)
    const revision = await postgresFileRevision(tx, id)
    const { rows: [total] } = await tx.execute<{ total: string }>(sql`
      SELECT count(*) AS total FROM file_maintenance_audit WHERE file_id = ${id}`)
    const { rows } = await tx.execute<PgAudit>(sql`
      SELECT id, file_id AS "fileId", revision, action, idempotency_key AS "idempotencyKey", request_hash AS "requestHash",
        mode, actor, basis, before_json AS "before", after_json AS "after", created_at AS "createdAt"
      FROM file_maintenance_audit WHERE file_id = ${id} ORDER BY revision
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
    return {
      file, revision, total: Number(total!.total), page, pageSize,
      rows: rows.map(row => ({
        ...row, id: Number(row.id), fileId: Number(row.fileId), revision: Number(row.revision),
        before: JSON.parse(row.before), after: JSON.parse(row.after),
      })),
    }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
