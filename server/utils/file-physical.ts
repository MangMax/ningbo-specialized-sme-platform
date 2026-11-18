import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, fstatSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { and, desc, eq, ne, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { compareFileContentIdentity, readStoredFileContentIdentity } from './file-content-identity'
import { fileMaintenanceRevision, maintainStoredFileSync, requireVersionedFileMaintenanceOptions, type FileMaintenanceOptions } from './file-maintenance'
import { getStoredFile } from './stored-files'
import { FileMaintenanceError, resolveInsideRoot } from './file-store'

type Db = BetterSQLite3Database<typeof schema>
type Intent = typeof schema.filePhysicalIntent.$inferSelect
const table = schema.filePhysicalIntent
const fail = (message: string): never => { throw new FileMaintenanceError(409, message) }

function paths(root: string, intent: Intent) {
  if (!/^[0-9a-f-]{36}$/.test(intent.id)) fail('隔离意图 ID 非法')
  const base = realpathSync(root)
  const original = resolveInsideRoot(base, intent.relPath)
  if (!original) return fail('文件路径越界')
  if (original === base || intent.relPath.split(/[\\/]/).some(p => p.startsWith('.'))) fail('文件路径越界或属于保留目录')
  if (!realpathSync(dirname(original)).startsWith(base + sep) && realpathSync(dirname(original)) !== base) fail('文件父目录越界')
  const quarantineDir = join(base, '.physical-quarantine')
  mkdirSync(quarantineDir, { recursive: true, mode: 0o700 })
  if (!lstatSync(quarantineDir).isDirectory() || lstatSync(quarantineDir).isSymbolicLink() || realpathSync(quarantineDir) !== resolve(quarantineDir)) fail('隔离目录必须是库内真实目录')
  return { original: original!, quarantine: join(quarantineDir, intent.id), base }
}
function verify(path: string, intent: Intent) {
  if (!existsSync(path)) fail('原字节不可用；不能恢复或隔离')
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail('恢复或隔离对象必须是原始普通文件')
  const fd = openSync(path, 'r')
  try {
    const before = fstatSync(fd), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    let count: number
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count))
    const after = fstatSync(fd)
    if (compareFileContentIdentity({ fileId: intent.fileId, relPath: intent.relPath, sha256: intent.sha256, bytes: intent.bytes }, { sha256: hash.digest('hex'), bytes: after.size }) || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('登记 SHA 或字节数不匹配；保留现状等待人工处理')
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
function syncDirs(...paths: string[]) {
  for (const path of new Set(paths.map(dirname))) {
    const fd = openSync(path, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}
function registered(db: Db, intent: Intent) {
  const identity = readStoredFileContentIdentity(db, intent.fileId)
  if (!identity || identity.relPath !== intent.relPath || compareFileContentIdentity(identity, intent)) fail('登记文件身份已变化，不能继续')
}
function checkRevision(db: Db, id: number, options: FileMaintenanceOptions) {
  if (fileMaintenanceRevision(db, id) !== options.expectedRevision) fail('文件维护修订已变化,请重新读取')
}
function requestHash(id: number, action: string, intentId: string | undefined, options: FileMaintenanceOptions) {
  return createHash('sha256').update(JSON.stringify([id, action, intentId ?? null, options.expectedRevision, options.actor, options.basis])).digest('hex')
}
function keyAvailable(db: Db, key: string) {
  const row = db.select().from(table).where(or(eq(table.deleteKey, key), eq(table.recoverKey, key))).get()
  if (row) fail('幂等键已用于其他物理命令')
  if (db.select({ id: schema.fileMaintenanceAudit.id }).from(schema.fileMaintenanceAudit).where(eq(schema.fileMaintenanceAudit.idempotencyKey, key)).get()) fail('幂等键已用于普通维护命令')
}
function receipt(db: Db, intent: Intent) {
  const row = getStoredFile(db, intent.fileId)!
  return { removed: row.removedAt !== null, diskDeleted: false, diskQuarantined: intent.state === 'quarantined', referenceCount: row.referenceCount, intent: { id: intent.id, fileId: intent.fileId, relPath: intent.relPath, sha256: intent.sha256, bytes: intent.bytes, state: intent.state } }
}

/** The intent commit precedes any rename. A later SQL rollback never claims to undo disk changes. */
export function quarantineStoredFile(db: Db, root: string, id: number, rawOptions: FileMaintenanceOptions) {
  const options = requireVersionedFileMaintenanceOptions(rawOptions), key = options.idempotencyKey!
  const hash = requestHash(id, 'quarantine', undefined, options)
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
    const p = paths(root, proposed)
    verify(p.original, proposed)
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
    const p = paths(root, current)
    if (lstatSync(p.quarantine, { throwIfNoEntry: false })) {
      if (lstatSync(p.original, { throwIfNoEntry: false })) fail('原路径和隔离副本同时存在，保留两者等待处理')
      verify(p.quarantine, current)
    } else {
      verify(p.original, current)
      renameSync(p.original, p.quarantine)
    }
    syncDirs(p.original, p.quarantine, join(p.base, 'directory-entry'))
    maintainStoredFileSync(tx, id, 'remove', {}, { ...options, idempotencyKey: `physical:${current.id}:remove` })
    const result = receipt(tx, { ...current, state: 'quarantined' })
    tx.update(table).set({ state: 'quarantined', deleteReceipt: result }).where(eq(table.id, current.id)).run()
    return result
  }, { behavior: 'immediate' })
}

export function recoverStoredFile(db: Db, root: string, id: number, intentId: string, rawOptions: FileMaintenanceOptions) {
  const options = requireVersionedFileMaintenanceOptions(rawOptions), key = options.idempotencyKey!
  const hash = requestHash(id, 'recover', intentId, options)
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
    const p = paths(root, current)
    if (lstatSync(p.quarantine, { throwIfNoEntry: false })) {
      if (lstatSync(p.original, { throwIfNoEntry: false })) fail('原路径已存在，禁止覆盖')
      verify(p.quarantine, current)
      renameSync(p.quarantine, p.original)
    } else verify(p.original, current)
    syncDirs(p.original, p.quarantine, join(p.base, 'directory-entry'))
    const file = getStoredFile(tx, id)!
    maintainStoredFileSync(tx, id, 'restore', {}, { ...options, idempotencyKey: `physical:${current.id}:restore` }, { file, revision: options.expectedRevision! })
    const result = receipt(tx, { ...current, state: 'recovered' })
    tx.update(table).set({ state: 'recovered', recoverReceipt: result }).where(eq(table.id, intentId)).run()
    return result
  }, { behavior: 'immediate' })
}

export function readPhysicalIntent(db: Db, id: number, intentId?: string) {
  const row = db.select().from(table).where(and(eq(table.fileId, id), intentId ? eq(table.id, intentId) : undefined)).orderBy(desc(table.createdAt), desc(table.id)).limit(1).get()
  if (!row) throw new FileMaintenanceError(404, '物理删除意图不存在')
  return { ...receipt(db, row), deleteReceipt: row.deleteReceipt, recoverReceipt: row.recoverReceipt }
}
