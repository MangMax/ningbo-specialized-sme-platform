import { createHash } from 'node:crypto'
import { asc, desc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { FileMaintenanceError, getStoredFile, parseDisplayNamePatch, parseMetadataPatch, renameStoredFileDisplayName, restoreVerifiedStoredFile, softRemoveStoredFile, updateStoredFile, verifyStoredFileRestoration, type StoredFileRow } from './stored-files'

type Db = BetterSQLite3Database<typeof schema>
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
export function fileMaintenanceRevision(db: Db, id: number) {
  return db.select({ revision: schema.fileMaintenanceAudit.revision }).from(schema.fileMaintenanceAudit).where(eq(schema.fileMaintenanceAudit.fileId, id)).orderBy(desc(schema.fileMaintenanceAudit.revision)).limit(1).get()?.revision ?? 0
}
function snapshot(file: StoredFileRow): Record<string, unknown> {
  const { source, kind, year, batch, titleCode, displayName, removedAt, categoryState, filename, relPath, bytes, sha256 } = file
  return { source, kind, year, batch, titleCode, displayName, removedAt, categoryState, filename, relPath, bytes, sha256 }
}
function hashRequest(id: number, action: FileMaintenanceAction, patch: unknown, options: FileMaintenanceOptions) {
  return createHash('sha256').update(JSON.stringify({ id, action, patch, expectedRevision: options.expectedRevision ?? null, actor: options.actor ?? null, basis: options.basis ?? null })).digest('hex')
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
  let patch: ReturnType<typeof parseMetadataPatch> | { displayName: string } = {}
  try {
    if (action === 'update') {
      patch = rawPatch && typeof rawPatch === 'object' && 'displayName' in rawPatch
        ? { displayName: parseDisplayNamePatch(rawPatch) } : parseMetadataPatch(rawPatch)
      if (!Object.keys(patch).length && options.expectedRevision !== undefined) throw new Error('至少给一个元数据字段或 displayName')
    }
  } catch (error) { throw new FileMaintenanceError(400, (error as Error).message) }
  // Normalize field order for transport-independent retries.
  patch = Object.fromEntries(Object.entries(patch).sort(([a], [b]) => a.localeCompare(b)))
  const hash = hashRequest(id, action, patch, options)
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
    else after = updateStoredFile(tx, id, patch)!
    const beforeValues = snapshot(current), afterValues = snapshot(after)
    // An unkeyed no-op needs no duplicate audit. Keyed no-ops retain a replay receipt.
    if (options.idempotencyKey || JSON.stringify(beforeValues) !== JSON.stringify(afterValues)) {
      tx.insert(schema.fileMaintenanceAudit).values({ fileId: id, revision: revision + 1, action, idempotencyKey: options.idempotencyKey ?? null, requestHash: hash, mode: options.expectedRevision === undefined ? 'legacy' : 'versioned', actor: options.actor ?? null, basis: options.basis ?? null, before: beforeValues, after: afterValues }).run()
    }
    return after
  }, { behavior: 'immediate' })
}
export function readFileMaintenance(db: Db, id: number, page = 1, pageSize = 50) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw new FileMaintenanceError(400, 'page 必须为正整数,pageSize 范围 1–100')
  return db.transaction(tx => {
    const file = getStoredFile(tx, id)
    if (!file) throw new FileMaintenanceError(404, '文件不存在')
    const where = eq(schema.fileMaintenanceAudit.fileId, id)
    const total = tx.select({ n: sql<number>`count(*)` }).from(schema.fileMaintenanceAudit).where(where).get()!.n
    const rows = tx.select().from(schema.fileMaintenanceAudit).where(where).orderBy(asc(schema.fileMaintenanceAudit.revision)).limit(pageSize).offset((page - 1) * pageSize).all()
    return { file, revision: fileMaintenanceRevision(tx, id), total, rows, page, pageSize }
  })
}

export async function maintainStoredFile(db: Db, root: string, id: number, action: FileMaintenanceAction, patch: unknown, options: FileMaintenanceOptions = {}) {
  if (action !== 'restore') return maintainStoredFileSync(db, id, action, patch, options)
  const parsed = parseFileMaintenanceOptions(options)
  const repeated = replay(db, parsed.idempotencyKey, hashRequest(id, action, {}, parsed), id)
  if (repeated) return repeated
  const revision = fileMaintenanceRevision(db, id)
  const file = await verifyStoredFileRestoration(db, root, id)
  return maintainStoredFileSync(db, id, action, {}, parsed, { file, revision })
}

export function requireVersionedFileMaintenanceOptions(value: unknown): FileMaintenanceOptions {
  const options = parseFileMaintenanceOptions(value)
  if (options.expectedRevision === undefined) throw new FileMaintenanceError(400, '新维护命令必须提供完整的版本化封套')
  return options
}
export function hasFileMaintenanceControls(value: unknown): boolean {
  return !!value && typeof value === 'object' && controls.some(key => key in value)
}

/** Registration is an existing blind-write adapter too; its factual refresh invalidates modern edits. */
export function recordLegacyFileMaintenanceWrite(db: Db, before: StoredFileRow, after: StoredFileRow): void {
  const beforeValues = snapshot(before), afterValues = snapshot(after)
  if (JSON.stringify(beforeValues) === JSON.stringify(afterValues)) return
  db.insert(schema.fileMaintenanceAudit).values({ fileId: after.id, revision: fileMaintenanceRevision(db, after.id) + 1, action: 'update', mode: 'legacy', requestHash: hashRequest(after.id, 'update', afterValues, {}), actor: null, basis: null, before: beforeValues, after: afterValues }).run()
}
