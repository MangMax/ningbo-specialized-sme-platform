import type { LogContext } from '../../layers/core/lib/logging'
import type { RosterDifferenceFilter } from '../../layers/sme-roster/lib/roster/enterprise-roster'
import type { useApplicationDb } from '../../db/client'
import { getDbOwnerIdentity } from '../../db/client'
import { listRosterDifferences } from '../../lib/roster/difference-list'
import { restoreReaderError } from '../../layers/sme-roster/lib/roster/offmain-read-protocol'
import { enterpriseReads } from '../../layers/sme-roster/server/utils/enterprise-read'
import { createReadTurns, runReadTurn } from '../../layers/core/server/utils/read-turn'

/** New-consumer policy only. Normal operations submit directly to the singleton;
 * fallback is exactly one original synchronous reader on its acquired owner. */
export async function readDifferences(owner: ReturnType<typeof useApplicationDb>, filter: RosterDifferenceFilter, signal?: AbortSignal,
  executor: Pick<typeof enterpriseReads, 'differences'> = enterpriseReads, logContext?: LogContext) {
  if (signal?.aborted) return
  const identity = getDbOwnerIdentity(owner)
  if (identity) {
    const outcome = await executor.differences({ operation: 'differences', dbPath: identity.dbPath, owner: identity, filter }, signal, logContext)
    if (signal?.aborted || outcome.type === 'cancelled') return
    if (outcome.type === 'complete') return outcome.body
    if (outcome.type === 'reader-error') throw restoreReaderError(outcome.error)
  }
  if (signal?.aborted) return
  const input = { ...filter }
  const original = createReadTurns((options: typeof input) => listRosterDifferences(owner, options))
  return runReadTurn(original, input, signal)
}
