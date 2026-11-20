import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, ne, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { compareFileContentIdentity, readStoredFileContentIdentity } from './file-content-identity'
import { fileMaintenanceRevision, maintainStoredFileSync, requireVersionedFileMaintenanceOptions, type FileMaintenanceOptions } from './file-maintenance'
import { getStoredFile } from './stored-files'
import { FileMaintenanceError } from './file-store'
import { movePhysicalFile, verifyPhysicalOriginal } from './file-physical-disk'

type Db = BetterSQLite3Database<typeof schema>
type Intent = typeof schema.filePhysicalIntent.$inferSelect
const table = schema.filePhysicalIntent
const fail = (message: string): never => { throw new FileMaintenanceError(409, message) }

function registered(db: Db, intent: Intent) {
  const identity = readStoredFileContentIdentity(db, intent.fileId)
  if (!identity || identity.relPath !== intent.relPath || compareFileContentIdentity(identity, intent)) fail('登记文件身份已变化，不能继续')
}
function checkRevision(db: Db, id: number, options: FileMaintenanceOptions) {
  if (fileMaintenanceRevision(db, id) !== options.expectedRevision) fail('文件维护修订已变化,请重新读取')
}
export function filePhysicalRequestHash(id: number, action: string, intentId: string | undefined, options: FileMaintenanceOptions) {
  return createHash('sha256').update(JSON.stringify([id, action, intentId ?? null, options.expectedRevision, options.actor, options.basis])).digest('hex')
}
function keyAvailable(db: Db, key: string) {
  const row = db.select().from(table).where(or(eq(table.deleteKey, key), eq(table.recoverKey, key))).get()
  if (row) fail('幂等键已用于其他物理命令')
  if (db.select({ id: schema.fileMaintenanceAudit.id }).from(schema.fileMaintenanceAudit).where(eq(schema.fileMaintenanceAudit.idempotencyKey, key)).get()) fail('幂等键已用于普通维护命令')
}
export function filePhysicalReceipt(row: Pick<NonNullable<ReturnType<typeof getStoredFile>>, 'removedAt' | 'referenceCount'>, intent: Intent) {
  return { removed: row.removedAt !== null, diskDeleted: false, diskQuarantined: intent.state === 'quarantined', referenceCount: row.referenceCount, intent: { id: intent.id, fileId: intent.fileId, relPath: intent.relPath, sha256: intent.sha256, bytes: intent.bytes, state: intent.state } }
}

/** The intent commit precedes any rename. A later SQL rollback never claims to undo disk changes. */
export function quarantineStoredFile(db: Db, root: string, id: number, rawOptions: FileMaintenanceOptions) {
  const options = requireVersionedFileMaintenanceOptions(rawOptions), key = options.idempotencyKey!
  const hash = filePhysicalRequestHash(id, 'quarantine', undefined, options)
  const intent = db.transaction(tx => {
    const old = tx.select().from(table).where(eq(table.deleteKey, key)).get()
    if (old) {
      if (old.deleteHash !== hash) fail('幂等键已用于不同请求')
      return old
    }
    keyAvailable(tx, key)
    const identity = readStoredFileContentIdentity(tx, id)
    if (!identity) throw new FileMaintenanceError(404, '文件不存在')
    checkRevision(tx, id, options)
    if (getStoredFile(tx, id)!.referenceCount) fail('文件仍被正式出处引用,禁止删除磁盘文件')
    if (tx.select({ id: table.id }).from(table).where(and(eq(table.fileId, id), ne(table.state, 'recovered'))).get()) fail('已有未恢复的物理删除意图')
    const proposed: Intent = { id: randomUUID(), ...identity, state: 'pending', deleteKey: key, deleteHash: hash, deleteReceipt: null, recoverKey: null, recoverHash: null, recoverReceipt: null, createdAt: new Date().toISOString() }
    verifyPhysicalOriginal(root, proposed)
    tx.insert(table).values(proposed).run()
    return proposed
  }, { behavior: 'immediate' })
  if (intent.deleteReceipt) return intent.deleteReceipt
  return db.transaction(tx => {
    const current = tx.select().from(table).where(eq(table.id, intent.id)).get()!
    if (current.deleteReceipt) return current.deleteReceipt
    if (current.state !== 'pending') fail('意图已进入恢复，不再执行删除')
    registered(tx, current)
    checkRevision(tx, id, options)
    if (getStoredFile(tx, id)!.referenceCount) fail('文件仍被正式出处引用,禁止删除磁盘文件')
    movePhysicalFile(root, current, 'quarantine')
    maintainStoredFileSync(tx, id, 'remove', {}, { ...options, idempotencyKey: `physical:${current.id}:remove` })
    const result = filePhysicalReceipt(getStoredFile(tx, id)!, { ...current, state: 'quarantined' })
    tx.update(table).set({ state: 'quarantined', deleteReceipt: result }).where(eq(table.id, current.id)).run()
    return result
  }, { behavior: 'immediate' })
}

export function recoverStoredFile(db: Db, root: string, id: number, intentId: string, rawOptions: FileMaintenanceOptions) {
  const options = requireVersionedFileMaintenanceOptions(rawOptions), key = options.idempotencyKey!
  const hash = filePhysicalRequestHash(id, 'recover', intentId, options)
  const intent = db.transaction(tx => {
    const current = tx.select().from(table).where(and(eq(table.id, intentId), eq(table.fileId, id))).get()
    if (!current) throw new FileMaintenanceError(404, '物理删除意图不存在')
    if (current.recoverKey) {
      if (current.recoverKey !== key || current.recoverHash !== hash) fail('恢复请求与已登记请求冲突')
      return current
    }
    keyAvailable(tx, key)
    checkRevision(tx, id, options)
    registered(tx, current)
    tx.update(table).set({ state: 'recovering', recoverKey: key, recoverHash: hash }).where(eq(table.id, intentId)).run()
    return { ...current, state: 'recovering' as const, recoverKey: key, recoverHash: hash }
  }, { behavior: 'immediate' })
  if (intent.recoverReceipt) return intent.recoverReceipt
  return db.transaction(tx => {
    const current = tx.select().from(table).where(eq(table.id, intentId)).get()!
    if (current.recoverReceipt) return current.recoverReceipt
    registered(tx, current)
    checkRevision(tx, id, options)
    movePhysicalFile(root, current, 'recover')
    const file = getStoredFile(tx, id)!
    maintainStoredFileSync(tx, id, 'restore', {}, { ...options, idempotencyKey: `physical:${current.id}:restore` }, { file, revision: options.expectedRevision! })
    const result = filePhysicalReceipt(getStoredFile(tx, id)!, { ...current, state: 'recovered' })
    tx.update(table).set({ state: 'recovered', recoverReceipt: result }).where(eq(table.id, intentId)).run()
    return result
  }, { behavior: 'immediate' })
}

export function readPhysicalIntent(db: Db, id: number, intentId?: string) {
  const row = db.select().from(table).where(and(eq(table.fileId, id), intentId ? eq(table.id, intentId) : undefined)).orderBy(desc(table.createdAt), desc(table.id)).limit(1).get()
  if (!row) throw new FileMaintenanceError(404, '物理删除意图不存在')
  return { ...filePhysicalReceipt(getStoredFile(db, id)!, row), deleteReceipt: row.deleteReceipt, recoverReceipt: row.recoverReceipt }
}
