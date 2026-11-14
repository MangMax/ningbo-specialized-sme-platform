/** Complete migration defers repeated whole-database scans to its final transaction.
 * Standalone stages continue to validate the full database. */
import type Database from 'better-sqlite3'
import { realpathSync, fstatSync } from 'node:fs'
import { resolve } from 'node:path'
let completeTarget: string | undefined
let finalValidated = false
const snapshotDigests = new Map<string, string>()
const databaseDigests = new WeakMap<Database.Database, { state:string; values:Map<string,string> }>()
export function completeUpgradeActive() { return completeTarget !== undefined }
/** Reuse exact stream digests only while SQLite reports no intervening change. */
export function upgradeMemoizedDigest(db:Database.Database, key:string, read:()=>string):string {
  if (!completeTarget) return read()
  const state=JSON.stringify([db.prepare('SELECT total_changes()').pluck().get(),db.pragma('data_version',{simple:true}),db.pragma('schema_version',{simple:true}),db.pragma('user_version',{simple:true})])
  let entry=databaseDigests.get(db)
  if (!entry || entry.state!==state) { entry={state,values:new Map()};databaseDigests.set(db,entry) }
  const cached=entry.values.get(key)
  if(cached!==undefined)return cached
  const digest=read();entry.values.set(key,digest);return digest
}
/** Frozen offline files have no writers. Re-read bytes when file identity or
 * metadata changes, and force the complete source hash again before retirement. */
export function upgradeSnapshotHash(fd: number, read: () => string, force: boolean): string {
  if (!completeTarget) return read()
  const stat = fstatSync(fd, { bigint: true })
  const key = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  const cached = force ? undefined : snapshotDigests.get(key)
  if (cached !== undefined) return cached
  const digest = read()
  snapshotDigests.set(key, digest)
  return digest
}
/** FK enforcement remains ON during every write; the full catalog scan is final. */
export function upgradeForeignKeyFailures(db: Database.Database): unknown[] {
  return completeTarget ? [] : db.prepare('PRAGMA foreign_key_check').all()
}
/** Non-platform domains are untouched by projection stages. Their own transfer
 * owners retain their byte manifests; do not rehash all audit bodies per stage. */
export function upgradeProjectionTables<T extends {name:string}>(tables: T[], owners: readonly string[] = []): T[] {
  const unchangedBodies = ['record_correspondence', 'record_correspondence_audit', 'import_receipt', 'job']
  return completeTarget ? tables.filter(table => !unchangedBodies.includes(table.name) || owners.includes(table.name)) : tables
}
export function upgradeIntegrityGate(db: Database.Database, final = false): boolean {
  if (completeTarget && !final) return true
  const valid = db.pragma('integrity_check', { simple: true }) === 'ok'
  if (valid && final && completeTarget && realpathSync(completeTarget) === realpathSync(db.name)) finalValidated = true
  return valid
}
export function withFinalUpgradeIntegrity<T>(target: string, action: () => T): T {
  if (completeTarget) throw new Error('Nested complete migration is unsupported')
  completeTarget = resolve(target)
  finalValidated = false
  snapshotDigests.clear()
  try {
    const result = action()
    if (!finalValidated) throw new Error('Complete migration did not perform final integrity validation')
    return result
  } finally { completeTarget = undefined; finalValidated = false; snapshotDigests.clear() }
}
