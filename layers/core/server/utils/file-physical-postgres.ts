import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import { filePhysicalIntent as intentTable } from '../../../../db/postgresql/file-tables'
import { compareFileContentIdentity } from './file-identity'
import { fileMaintenanceRequestHash, requireVersionedFileMaintenanceOptions, type FileMaintenanceOptions } from './file-maintenance-shared'
import {
  applyPostgresFileMaintenance, checkPostgresFileRevision, lockPostgresFileRequestKey, physicalMaintenanceKey,
  postgresFileRevision, postgresMaintenanceHash, postgresPhysicalRequestKeyExists, rejectNewPhysicalInternalKey,
} from './file-maintenance-postgres'
import { filePhysicalReceipt, filePhysicalRequestHash } from './file-physical-receipt'
import { movePhysicalFile, verifyPhysicalOriginal } from './file-physical-disk'
import { FileMaintenanceError, type FileRow } from './file-store-contract'
import {
  activePostgresPhysicalIntent, lockPostgresFile, postgresFileIdentity, readPostgresFile,
  requirePostgresFileWrite, type PostgresFileDb,
} from './file-store-postgres'

type Intent = Omit<typeof intentTable.$inferSelect, 'bytes' | 'deleteReceipt' | 'recoverReceipt'> & {
  bytes: number
  deleteReceipt: ReturnType<typeof filePhysicalReceipt> | null
  recoverReceipt: ReturnType<typeof filePhysicalReceipt> | null
}
function fail(message: string): never {
  throw new FileMaintenanceError(409, message)
}

async function findIntent(db: PostgresFileDb, where: SQL): Promise<Intent | undefined> {
  // Drizzle has no COLLATE API. Keep the bytewise ordering used by the history index.
  const [row] = await db.select().from(intentTable).where(where).orderBy(
    desc(sql`${intentTable.createdAt} COLLATE "C"`), desc(sql`${intentTable.id} COLLATE "C"`),
  ).limit(1)
  if (row) return {
    ...row, bytes: Number(row.bytes),
    deleteReceipt: row.deleteReceipt === null ? null : JSON.parse(row.deleteReceipt),
    recoverReceipt: row.recoverReceipt === null ? null : JSON.parse(row.recoverReceipt),
  }
}

function checkIdentity(file: FileRow, intent: Intent) {
  if (file.relPath !== intent.relPath || compareFileContentIdentity(postgresFileIdentity(file), intent)) {
    fail('登记文件身份已变化，不能继续')
  }
}

async function checkKeyAvailable(db: PostgresFileDb, key: string) {
  if (await postgresPhysicalRequestKeyExists(db, key)) fail('幂等键已用于其他物理命令')
  if (await postgresMaintenanceHash(db, key)) fail('幂等键已用于普通维护命令')
}

function physicalOptions(value: FileMaintenanceOptions) {
  requirePostgresFileWrite()
  const options = requireVersionedFileMaintenanceOptions(value)
  if ([options.idempotencyKey, options.actor, options.basis].some(value => value?.includes('\0'))) {
    throw new FileMaintenanceError(400, '维护控制字段不能包含 NUL')
  }
  return options
}

async function completePhysicalCommand(
  db: PostgresFileDb, root: string, id: number, intentId: string, action: 'quarantine' | 'recover', options: FileMaintenanceOptions,
) {
  return db.transaction(async tx => {
    await lockPostgresFile(tx, id)
    const intent = await findIntent(tx, and(eq(intentTable.fileId, id), eq(intentTable.id, intentId))!)
    if (!intent) throw new FileMaintenanceError(404, '物理删除意图不存在')
    const quarantine = action === 'quarantine'
    const previous = quarantine ? intent.deleteReceipt : intent.recoverReceipt
    if (previous) return previous
    if (intent.state !== (quarantine ? 'pending' : 'recovering')) fail('物理意图状态已变化')
    const current = await readPostgresFile(tx, id)
    checkIdentity(current, intent)
    const revision = await postgresFileRevision(tx, id)
    checkPostgresFileRevision(revision, options.expectedRevision)
    if (quarantine && current.referenceCount) fail('文件仍被正式出处引用,禁止删除磁盘文件')

    const maintenanceAction = quarantine ? 'remove' : 'restore'
    const maintenance = { ...options, idempotencyKey: physicalMaintenanceKey(intent.id, maintenanceAction) }
    await lockPostgresFileRequestKey(tx, maintenance.idempotencyKey)
    await checkKeyAvailable(tx, maintenance.idempotencyKey)
    movePhysicalFile(root, intent, action)
    const after = await applyPostgresFileMaintenance(tx, current, revision, maintenanceAction, {}, maintenance,
      fileMaintenanceRequestHash(id, maintenanceAction, {}, maintenance))
    const state = quarantine ? 'quarantined' : 'recovered'
    const receipt = filePhysicalReceipt(after, { ...intent, state })
    const receiptJson = JSON.stringify(receipt)
    await tx.update(intentTable).set({
      state, ...(quarantine ? { deleteReceipt: receiptJson } : { recoverReceipt: receiptJson }),
    }).where(eq(intentTable.id, intent.id))
    return receipt
  })
}

export async function quarantinePostgresFile(db: PostgresFileDb, root: string, id: number, rawOptions: FileMaintenanceOptions) {
  const options = physicalOptions(rawOptions)
  const key = options.idempotencyKey!
  const hash = filePhysicalRequestHash(id, 'quarantine', undefined, options)
  const intent = await db.transaction(async tx => {
    await lockPostgresFile(tx, id)
    await lockPostgresFileRequestKey(tx, key)
    const prior = await findIntent(tx, eq(intentTable.deleteKey, key))
    if (prior) {
      if (prior.deleteHash !== hash) fail('幂等键已用于不同请求')
      return prior
    }
    rejectNewPhysicalInternalKey(key)
    await checkKeyAvailable(tx, key)
    checkPostgresFileRevision(await postgresFileRevision(tx, id), options.expectedRevision)
    const file = await readPostgresFile(tx, id)
    if (file.referenceCount) fail('文件仍被正式出处引用,禁止删除磁盘文件')
    if (await activePostgresPhysicalIntent(tx, id)) fail('已有未恢复的物理删除意图')

    const intentId = randomUUID()
    verifyPhysicalOriginal(root, { id: intentId, ...postgresFileIdentity(file) })
    await tx.insert(intentTable).values({
      id: intentId, fileId: id, relPath: file.relPath, sha256: file.sha256, bytes: BigInt(file.bytes),
      state: 'pending', deleteKey: key, deleteHash: hash, createdAt: new Date().toISOString(),
    })
    return { id: intentId, deleteReceipt: null }
  })
  return intent.deleteReceipt ?? completePhysicalCommand(db, root, id, intent.id, 'quarantine', options)
}

export async function recoverPostgresFile(
  db: PostgresFileDb, root: string, id: number, intentId: string, rawOptions: FileMaintenanceOptions,
) {
  const options = physicalOptions(rawOptions)
  const key = options.idempotencyKey!
  const hash = filePhysicalRequestHash(id, 'recover', intentId, options)
  const priorReceipt = await db.transaction(async tx => {
    await lockPostgresFile(tx, id)
    await lockPostgresFileRequestKey(tx, key)
    const intent = await findIntent(tx, and(eq(intentTable.fileId, id), eq(intentTable.id, intentId))!)
    if (!intent) throw new FileMaintenanceError(404, '物理删除意图不存在')
    if (intent.recoverKey) {
      if (intent.recoverKey !== key || intent.recoverHash !== hash) fail('恢复请求与已登记请求冲突')
      return intent.recoverReceipt
    }
    rejectNewPhysicalInternalKey(key)
    await checkKeyAvailable(tx, key)
    checkPostgresFileRevision(await postgresFileRevision(tx, id), options.expectedRevision)
    checkIdentity(await readPostgresFile(tx, id), intent)
    await tx.update(intentTable).set({ state: 'recovering', recoverKey: key, recoverHash: hash }).where(eq(intentTable.id, intentId))
    return null
  })
  return priorReceipt ?? completePhysicalCommand(db, root, id, intentId, 'recover', options)
}

export function readPostgresPhysicalIntent(db: PostgresFileDb, id: number, intentId?: string) {
  return db.transaction(async tx => {
    const intent = await findIntent(tx, intentId ? and(eq(intentTable.fileId, id), eq(intentTable.id, intentId))! : eq(intentTable.fileId, id))
    if (!intent) throw new FileMaintenanceError(404, '物理删除意图不存在')
    return { ...filePhysicalReceipt(await readPostgresFile(tx, id), intent), deleteReceipt: intent.deleteReceipt, recoverReceipt: intent.recoverReceipt }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
