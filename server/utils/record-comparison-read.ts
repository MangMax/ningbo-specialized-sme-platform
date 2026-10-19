import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { setImmediate } from 'node:timers/promises'
import type { useDb } from '../../db/client'
import * as schema from '../../db/schema'
import type { ComparisonSourceCatalogInput, RecordComparisonInput } from '../../lib/roster/record-comparison'
import { iterateRecordComparison, iterateRecordComparisonSources } from './record-comparison'
import { resolveVerifiedComparisonEvidence } from './comparison-scope-proof'

/** An independent readonly connection keeps a single SQLite snapshot across yields.
 * It never shares an async transaction with the app's cached writer connection. */
export async function readRecordComparison(owner: ReturnType<typeof useDb>, input: RecordComparisonInput, signal?: AbortSignal) {
  return readComparisonSnapshot(owner, db => {
    const evidence = resolveVerifiedComparisonEvidence(db, input.proofIds ?? [], input)
    return iterateRecordComparison(db, input, evidence)
  }, signal)
}
export async function readRecordComparisonSources(owner: ReturnType<typeof useDb>, input: ComparisonSourceCatalogInput, signal?: AbortSignal) {
  return readComparisonSnapshot(owner, db => iterateRecordComparisonSources(db, input), signal)
}
async function readComparisonSnapshot<T>(owner: ReturnType<typeof useDb>, iterate: (db: ReturnType<typeof useDb>) => Generator<void, T>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const connection = new Database(owner.$client.name, { readonly: true, fileMustExist: true })
  const db = drizzle(connection, { schema })
  let steps: Generator<void, T> | undefined
  try {
    connection.exec('BEGIN')
    steps = iterate(db)
    while (true) {
      signal?.throwIfAborted()
      const step = steps.next()
      if (step.done) return step.value
      await setImmediate()
    }
  } finally {
    // Close a suspended native iterator before releasing its read transaction.
    steps?.return(undefined as never)
    if (connection.inTransaction) connection.exec('ROLLBACK')
    connection.close()
  }
}
