import type { useDb } from '../../db/client'
import { getDbOwnerIdentity } from '../../db/client'
import { readWholeComparisonSummary, type ComparisonSummaryOptions } from '../../lib/comparison-summary-read'
import { restoreReaderError } from '../../lib/roster/offmain-read-protocol'
import { enterpriseReads } from './enterprise-read'
import { createReadTurns, runReadTurn } from './read-turn'

/** Eligible reads enter the existing child directly; only the original whole,
 * synchronous callback uses the shared FIFO for at-most-once fallback. */
export async function readSummary(owner: ReturnType<typeof useDb>, options: ComparisonSummaryOptions, signal?: AbortSignal,
  executor: Pick<typeof enterpriseReads, 'summary'> = enterpriseReads) {
  if (signal?.aborted) return
  const identity = getDbOwnerIdentity(owner)
  if (identity) {
    const outcome = await executor.summary({ operation: 'summary', dbPath: identity.dbPath, owner: identity, options }, signal)
    if (signal?.aborted || outcome.type === 'cancelled') return
    if (outcome.type === 'complete') return outcome.body
    if (outcome.type === 'reader-error') throw restoreReaderError(outcome.error)
  }
  if (signal?.aborted) return
  const input = { ...options }
  const original = createReadTurns((value: typeof input) => readWholeComparisonSummary(owner, value))
  return runReadTurn(original, input, signal)
}
