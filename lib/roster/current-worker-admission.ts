import type Database from 'better-sqlite3'
import { assertExpandRuntime } from '../../db/schema-phase'
import { LEGACY_PROVENANCE_VERSION, requireLegacyProvenanceReady } from '../platform/legacy-provenance-catalog'
import { resolveRecognizedFactSource } from './recognized-filter-source'

/** Request boundary for current list/workbook only. Never cache this admission
 * on a shared connection; each consumer still owns its snapshot and readiness. */
export function assertCurrentWorkerRuntime(db: Database.Database) {
  if (db.pragma('user_version', { simple: true }) !== LEGACY_PROVENANCE_VERSION) {
    assertExpandRuntime(db)
    return
  }
  if (resolveRecognizedFactSource() !== 'typed') throw new Error('Current target worker requires typed recognized source')
  requireLegacyProvenanceReady(db)
}
