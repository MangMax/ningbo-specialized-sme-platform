import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { setImmediate } from 'node:timers/promises'
import type { useDb } from '../../db/client'
import * as schema from '../../db/schema'
import type { RecordComparisonInput } from '../../lib/roster/record-comparison'
import { iterateRecordComparison } from './record-comparison'
import { resolveVerifiedComparisonEvidence } from './comparison-scope-proof'

/** An independent readonly connection keeps a single SQLite snapshot across yields.
 * It never shares an async transaction with the app's cached writer connection. */
export async function readRecordComparison(owner: ReturnType<typeof useDb>, input: RecordComparisonInput, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const connection = new Database(owner.$client.name, { readonly: true, fileMustExist: true })
  const db = drizzle(connection, { schema })
  let steps: ReturnType<typeof iterateRecordComparison> | undefined
  try {
    connection.exec('BEGIN')
    const evidence = resolveVerifiedComparisonEvidence(db, input.proofIds ?? [], input)
    steps = iterateRecordComparison(db, input, evidence)
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
