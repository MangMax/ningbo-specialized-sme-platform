import type { useDb } from '../../db/client'
import { getDbOwnerIdentity } from '../../db/client'
import { listRosterRecognitions, type RosterRecognitionFilter } from '../../lib/roster/recognitions'
import { restoreReaderError } from '../../lib/roster/offmain-read-protocol'
import { enterpriseReads } from './enterprise-read'
import { createReadTurns, runReadTurn } from './read-turn'

/** New-consumer policy only. Normal operations submit directly to the singleton;
 * fallback is exactly one original synchronous reader on its acquired owner. */
export async function readRecognitions(owner: ReturnType<typeof useDb>, filter: RosterRecognitionFilter, signal?: AbortSignal,
  executor: Pick<typeof enterpriseReads, 'recognitions'> = enterpriseReads) {
  if (signal?.aborted) return
  const identity = getDbOwnerIdentity(owner)
  if (identity) {
    const outcome = await executor.recognitions({ operation: 'recognitions', dbPath: identity.dbPath, owner: identity, filter }, signal)
    if (signal?.aborted || outcome.type === 'cancelled') return
    if (outcome.type === 'complete') return outcome.body
    if (outcome.type === 'reader-error') throw restoreReaderError(outcome.error)
  }
  if (signal?.aborted) return
  const input = { ...filter }
  const original = createReadTurns((options: typeof input) => listRosterRecognitions(owner, options))
  return runReadTurn(original, input, signal)
}
