import type { LogContext } from '../../lib/logging'
import { asc, desc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { FileMaintenanceError } from './file-store-contract'
import {
  fileMaintenanceRequestHash, fileMaintenanceSnapshot, logFileMaintenance, normalizeFileMaintenancePatch,
  parseFileMaintenanceOptions, validateFileMaintenancePage, type FileMaintenanceAction, type FileMaintenanceOptions,
} from './file-maintenance-shared'
import { getStoredFile, extensionSnapshot, parseMetadataPatch, renameStoredFileDisplayName, restoreVerifiedStoredFile, softRemoveStoredFile, updateStoredFile, verifyStoredFileRestoration, type StoredFileRow } from './stored-files'
export * from './file-maintenance-shared'

type Db = BetterSQLite3Database<typeof schema>
export function fileMaintenanceRevision(db: Db, id: number) {
  return db.select({ revision: schema.fileMaintenanceAudit.revision }).from(schema.fileMaintenanceAudit).where(eq(schema.fileMaintenanceAudit.fileId, id)).orderBy(desc(schema.fileMaintenanceAudit.revision)).limit(1).get()?.revision ?? 0
}
function replay(db: Db, key: string | undefined, hash: string, id: number) {
  if (!key) return null
  const previous = db.select({ requestHash: schema.fileMaintenanceAudit.requestHash }).from(schema.fileMaintenanceAudit).where(eq(schema.fileMaintenanceAudit.idempotencyKey, key)).get()
  if (!previous) return null
  if (previous.requestHash !== hash) throw new FileMaintenanceError(409, '幂等键已用于不同请求')
  return getStoredFile(db, id)!
}
/** Both transports use this transaction; receipts contain only bounded metadata snapshots. */
export function maintainStoredFileSync(db: Db, id: number, action: FileMaintenanceAction, rawPatch: unknown, rawOptions: FileMaintenanceOptions = {}, verifiedState?: { file: StoredFileRow; revision: number }) {
  const options = parseFileMaintenanceOptions(rawOptions)
  const patch = normalizeFileMaintenancePatch(action, rawPatch, options, parseMetadataPatch)
  const hash = fileMaintenanceRequestHash(id, action, patch, options)
  const repeated = replay(db, options.idempotencyKey, hash, id)
  if (repeated) return repeated
  const verified = verifiedState?.file
  return db.transaction((tx) => {
    const repeated = replay(tx, options.idempotencyKey, hash, id)
    if (repeated) return repeated
    const current = getStoredFile(tx, id)
    if (!current) throw new FileMaintenanceError(404, '文件不存在')
    const revision = fileMaintenanceRevision(tx, id)
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision) throw new FileMaintenanceError(409, '文件维护修订已变化,请重新读取')
    if (verified && revision !== verifiedState!.revision) throw new FileMaintenanceError(409, '核验期间文件状态变化,请重试')
    if (action === 'update' && current.removedAt && options.expectedRevision !== undefined) throw new FileMaintenanceError(409, '文件已移出库,请先恢复')
    let after: StoredFileRow
    if (action === 'remove') after = softRemoveStoredFile(tx, id)!
    else if (action === 'restore') after = restoreVerifiedStoredFile(tx, verified!)
    else if ('displayName' in patch) after = renameStoredFileDisplayName(tx, id, patch.displayName as string)!
    else {
      const updated = updateStoredFile(tx, id, patch)
      if (!updated) throw new FileMaintenanceError(404, '未找到可更新的文件分类')
      after = updated
    }
    const beforeValues = fileMaintenanceSnapshot(current, extensionSnapshot(current)), afterValues = fileMaintenanceSnapshot(after, extensionSnapshot(after))
    // An unkeyed no-op needs no duplicate audit. Keyed no-ops retain a replay receipt.
    if (options.idempotencyKey || JSON.stringify(beforeValues) !== JSON.stringify(afterValues)) {
      tx.insert(schema.fileMaintenanceAudit).values({ fileId: id, revision: revision + 1, action, idempotencyKey: options.idempotencyKey ?? null, requestHash: hash, mode: options.expectedRevision === undefined ? 'legacy' : 'versioned', actor: options.actor ?? null, basis: options.basis ?? null, before: beforeValues, after: afterValues }).run()
    }
    return after
  }, { behavior: 'immediate' })
}
export function readFileMaintenance(db: Db, id: number, page = 1, pageSize = 50) {
  validateFileMaintenancePage(page, pageSize)
  return db.transaction(tx => {
    const file = getStoredFile(tx, id)
    if (!file) throw new FileMaintenanceError(404, '文件不存在')
    const where = eq(schema.fileMaintenanceAudit.fileId, id)
    const total = tx.select({ n: sql<number>`count(*)` }).from(schema.fileMaintenanceAudit).where(where).get()!.n
    const rows = tx.select().from(schema.fileMaintenanceAudit).where(where).orderBy(asc(schema.fileMaintenanceAudit.revision)).limit(pageSize).offset((page - 1) * pageSize).all()
    return { file, revision: fileMaintenanceRevision(tx, id), total, rows, page, pageSize }
  })
}

async function maintainStoredFileUnlogged(db: Db, root: string, id: number, action: FileMaintenanceAction, patch: unknown, options: FileMaintenanceOptions = {}) {
  if (action !== 'restore') return maintainStoredFileSync(db, id, action, patch, options)
  const parsed = parseFileMaintenanceOptions(options)
  const repeated = replay(db, parsed.idempotencyKey, fileMaintenanceRequestHash(id, action, {}, parsed), id)
  if (repeated) return repeated
  const revision = fileMaintenanceRevision(db, id)
  const file = await verifyStoredFileRestoration(db, root, id)
  return maintainStoredFileSync(db, id, action, {}, parsed, { file, revision })
}

/** Registration is an existing blind-write adapter too; its factual refresh invalidates modern edits. */
export function recordLegacyFileMaintenanceWrite(db: Db, before: StoredFileRow, after: StoredFileRow): void {
  const beforeValues = fileMaintenanceSnapshot(before, extensionSnapshot(before)), afterValues = fileMaintenanceSnapshot(after, extensionSnapshot(after))
  if (JSON.stringify(beforeValues) === JSON.stringify(afterValues)) return
  db.insert(schema.fileMaintenanceAudit).values({ fileId: after.id, revision: fileMaintenanceRevision(db, after.id) + 1, action: 'update', mode: 'legacy', requestHash: fileMaintenanceRequestHash(after.id, 'update', afterValues, {}), actor: null, basis: null, before: beforeValues, after: afterValues }).run()
}

export async function maintainStoredFile(db: Db, root: string, id: number, action: FileMaintenanceAction, patch: unknown, options: FileMaintenanceOptions = {}, context: LogContext = {}) {
  return logFileMaintenance(id, action, context, () => maintainStoredFileUnlogged(db, root, id, action, patch, options))
}
