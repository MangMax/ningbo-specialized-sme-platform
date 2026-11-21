import { asc, count, desc, eq, or, sql } from 'drizzle-orm'
import { fileMaintenanceAudit, filePhysicalIntent, storedFile, storedFileAudit } from '../../../../db/postgresql/file-tables'
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
  const [latest] = await db.select({ revision: fileMaintenanceAudit.revision }).from(fileMaintenanceAudit)
    .where(eq(fileMaintenanceAudit.fileId, id)).orderBy(desc(fileMaintenanceAudit.revision)).limit(1)
  return latest?.revision ?? 0
}

export function checkPostgresFileRevision(actual: number, expected: number | undefined) {
  if (expected !== undefined && actual !== expected) throw new FileMaintenanceError(409, '文件维护修订已变化,请重新读取')
}

export async function lockPostgresFileRequestKey(db: PostgresFileDb, key: string | undefined) {
  if (key === undefined) return
  if (key.includes('\0')) throw new FileMaintenanceError(400, '幂等键不能包含 NUL')
  // Drizzle 0.45 has no transaction-scoped advisory lock API. This lock serializes
  // the same request key across the maintenance and physical-intent tables.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`file-maintenance:${key}`}, 0))`)
}

export async function postgresMaintenanceHash(db: PostgresFileDb, key: string) {
  const [row] = await db.select({ requestHash: fileMaintenanceAudit.requestHash }).from(fileMaintenanceAudit)
    .where(eq(fileMaintenanceAudit.idempotencyKey, key))
  return row?.requestHash
}

async function replay(db: PostgresFileDb, id: number, key: string | undefined, hash: string) {
  if (!key) return
  const previous = await postgresMaintenanceHash(db, key)
  if (previous === undefined) return
  if (previous !== hash) throw new FileMaintenanceError(409, '幂等键已用于不同请求')
  return readPostgresFile(db, id)
}

export async function postgresPhysicalRequestKeyExists(db: PostgresFileDb, key: string) {
  const rows = await db.select({ id: filePhysicalIntent.id }).from(filePhysicalIntent)
    .where(or(eq(filePhysicalIntent.deleteKey, key), eq(filePhysicalIntent.recoverKey, key))).limit(1)
  return rows.length !== 0
}

export function rejectNewPhysicalInternalKey(key: string | undefined) {
  if (key && /^physical:[0-9a-f-]{36}:(remove|restore)$/.test(key)) {
    throw new FileMaintenanceError(409, '幂等键保留给物理命令')
  }
}

export function physicalMaintenanceKey(intentId: string, action: 'remove' | 'restore') {
  return `physical:${intentId}:${action}`
}

interface VerifiedFileState { file: FileRow; revision: number }

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
    await db.update(storedFile).set({ removedAt: now }).where(eq(storedFile.id, id))
    after = { ...current, removedAt: now }
  } else if (action === 'restore' && current.removedAt) {
    await db.update(storedFile).set({ removedAt: null }).where(eq(storedFile.id, id))
    after = { ...current, removedAt: null }
  } else if (action === 'update' && typeof patch.displayName === 'string' && patch.displayName !== current.displayName) {
    const displayName = patch.displayName
    await db.update(storedFile).set({ displayName: displayName === current.filename ? null : displayName }).where(eq(storedFile.id, id))
    await db.insert(storedFileAudit).values({
      storedFileId: id, oldDisplayName: current.displayName, newDisplayName: displayName, createdAt: now,
    })
    after = { ...current, displayName }
  } else if (action === 'update' && !('displayName' in patch) && Object.keys(patch).length) {
    await updatePostgresFileMetadata(db, current, patch)
    after = await readPostgresFile(db, id)
  }

  await recordPostgresFileMaintenance(db, current, after, { revision, action, options, hash, now })
  return after
}

async function recordPostgresFileMaintenance(
  db: PostgresFileDb, current: FileRow, after: FileRow,
  { revision, action, options, hash, now }: {
    revision: number; action: FileMaintenanceAction; options: FileMaintenanceOptions; hash?: string; now: string
  },
) {
  const beforeJson = JSON.stringify(fileMaintenanceSnapshot(current, extensionSnapshot(current)))
  const afterValues = fileMaintenanceSnapshot(after, extensionSnapshot(after))
  const afterJson = JSON.stringify(afterValues)
  if (options.idempotencyKey || beforeJson !== afterJson) {
    const requestHash = hash ?? fileMaintenanceRequestHash(current.id, action, afterValues, options)
    await db.insert(fileMaintenanceAudit).values({
      fileId: current.id, revision: revision + 1, action, idempotencyKey: options.idempotencyKey ?? null, requestHash,
      mode: options.expectedRevision === undefined ? 'legacy' : 'versioned', actor: options.actor ?? null,
      basis: options.basis ?? null, before: beforeJson, after: afterJson, createdAt: now,
    })
  }
}

export async function recordLegacyPostgresFileMaintenanceWrite(db: PostgresFileDb, before: FileRow, after: FileRow) {
  const revision = await postgresFileRevision(db, before.id)
  await recordPostgresFileMaintenance(db, before, after, { revision, action: 'update', options: {}, now: new Date().toISOString() })
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

export function readPostgresFileMaintenance(db: PostgresFileDb, id: number, page: number, pageSize: number) {
  validateFileMaintenancePage(page, pageSize)
  return db.transaction(async tx => {
    const file = await readPostgresFile(tx, id)
    const revision = await postgresFileRevision(tx, id)
    const where = eq(fileMaintenanceAudit.fileId, id)
    const [counted] = await tx.select({ total: count() }).from(fileMaintenanceAudit).where(where)
    const rows = await tx.select().from(fileMaintenanceAudit).where(where)
      .orderBy(asc(fileMaintenanceAudit.revision)).limit(pageSize).offset((page - 1) * pageSize)
    return {
      file, revision, total: counted!.total, page, pageSize,
      rows: rows.map(row => ({
        ...row,
        before: JSON.parse(row.before), after: JSON.parse(row.after),
      })),
    }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
