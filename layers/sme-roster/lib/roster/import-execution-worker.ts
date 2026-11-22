import { appManifests } from '../../../../lib/installed-manifests'
import { installAppModules } from '../../../../lib/app-modules'
import { assertApplicationSchema } from '../../../../db/schema-phase'
import { deserialize } from 'node:v8'
import { realpathSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createDrizzleLogger } from '../../../core/lib/logging/drizzle'
import * as schema from '../../../../db/schema'
import { preflightRosterImport, commitRosterImport } from '../../server/utils/roster-import'
import { ImportReceiptError } from '../../server/utils/import-receipt-model'
import type { ImportExecutionMessage } from '../../server/utils/import-execution'
import { stageAnnouncement, supplementAnnouncement } from '../../server/utils/announcement-intake'
import { OfficialFactError } from '../../server/utils/official-evidence-claim-model'
import { EnterpriseKernelError } from '../../../core/server/public'
import { initializeWorkerLogging, closeApplicationLogging } from '../../../core/lib/logging'

installAppModules(appManifests)
initializeWorkerLogging()

// The parent has already migrated the DB. Keep exactly one native connection;
// do not migrate, retain credentials or change SQLite durability settings here.
let connection: Database.Database | undefined, identity: string | undefined
const send = (value: object) => new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve()))
let closing: Promise<void> | undefined
const shutdown = () => closing ??= (async () => { connection?.close(); await closeApplicationLogging(); process.exit(0) })()
process.on('disconnect', () => { void shutdown() })
process.on('message', async (message: ImportExecutionMessage | { type: 'shutdown' }) => {
  if ('type' in message) { await shutdown(); return }
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
    assertApplicationSchema(connection!)
    const db = drizzle(connection!, { schema, logger: createDrizzleLogger({ connection: 'import_execution', execution: 'worker', context: message.logContext }) })
    const input = deserialize(message.payload)
    const options = { ...message.logContext, filesDir: message.filesDir }
    const errors = message.pageCountErrors ?? []
    const result = message.action === 'supplement'
      ? await supplementAnnouncement(db, input.intakeId, input.review, options.filesDir, options)
      : message.action === 'stage'
        ? stageAnnouncement(db, input, errors)
        : message.action === 'preflight'
          ? preflightRosterImport(db, input, errors, options)
          : commitRosterImport(db, input, errors, { ...options, deferCandidateTasks: true })
    await send({ type: 'result', id: message.id, result })
  } catch (error) {
    const known = error instanceof ImportReceiptError || error instanceof EnterpriseKernelError || error instanceof OfficialFactError
    await send({ type: 'failure', id: message.id, error: { known, message: error instanceof Error ? error.message : 'Import execution failed', ...(known ? { statusCode: error.statusCode, code: error.code } : {}) } })
  }
})
void send({ type: 'ready', pid: process.pid })
