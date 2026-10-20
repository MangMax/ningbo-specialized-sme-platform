import { realpathSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { preflightRosterImport, commitRosterImport } from '../../server/utils/roster-import'
import { ImportReceiptError } from '../../server/utils/import-receipts'
import type { ImportExecutionMessage } from '../../server/utils/import-execution'

// The parent has already migrated the DB. Keep exactly one native connection;
// do not migrate, retain credentials or change SQLite durability settings here.
let connection: Database.Database | undefined, identity: string | undefined
const send = (value: object) => new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve()))
process.on('disconnect', () => { connection?.close(); process.exit(0) })
process.on('message', async (message: ImportExecutionMessage) => {
  try {
    const path = realpathSync(message.dbPath), stat = statSync(path)
    if (stat.dev !== message.identity.dev || stat.ino !== message.identity.ino) throw new ImportReceiptError(503, 'import_source_changed', 'Import database identity changed before execution')
    const key = `${path}\0${stat.dev}\0${stat.ino}\0${message.readonly}`
    if (identity !== key) {
      connection?.close()
      connection = new Database(path, { readonly: message.readonly, fileMustExist: true })
      connection.pragma('foreign_keys = ON')
      identity = key
    }
    const migration = connection!.prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get()
    if (connection!.pragma('schema_version', { simple: true }) !== message.identity.schemaVersion || JSON.stringify(migration) !== JSON.stringify(message.identity.migration)) throw new ImportReceiptError(503, 'import_source_changed', 'Import database schema or migration identity changed before execution')
    const db = drizzle(connection!, { schema })
    const request = JSON.parse(Buffer.from(message.payload).toString('utf8'))
    const result = message.action === 'preflight' ? preflightRosterImport(db, request, message.pageCountErrors) : commitRosterImport(db, request, message.pageCountErrors)
    await send({ type: 'result', id: message.id, result })
  } catch (error) {
    const known = error instanceof ImportReceiptError
    await send({ type: 'failure', id: message.id, error: { known, message: error instanceof Error ? error.message : 'Import execution failed', ...(known ? { statusCode: error.statusCode, code: error.code } : {}) } })
  }
})
void send({ type: 'ready', pid: process.pid })
