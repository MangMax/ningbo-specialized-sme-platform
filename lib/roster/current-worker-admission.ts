import type Database from 'better-sqlite3'
import { assertApplicationRuntime } from '../../db/schema-phase'

/** Request boundary for current list/workbook only. Never cache this admission
 * on a shared connection; each consumer still owns its snapshot and readiness. */
export function assertCurrentWorkerRuntime(db: Database.Database) {
  assertApplicationRuntime(db)
}
