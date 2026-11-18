import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import type { CandidateComparisonInput } from '../../lib/roster/platform-comparison'
import { readAnnualComparisonInputs } from '../../../../server/utils/annual-correspondence-read'

/** Only actual identifiers cross this internal boundary. The caller owns one
 * SQLite read snapshot. No callbacks, supplied facts or confirmation switches. */
export function readPlatformComparisonProcesses(sqlite: Database.Database, request: Parameters<typeof readAnnualComparisonInputs>[2]): CandidateComparisonInput['processes'] {
  try {
    const { processes } = readAnnualComparisonInputs(sqlite, drizzle(sqlite, { schema }), request)
    return processes.map(p => ({ ...p, input: { ...p.input, groups: p.input.groups.map(group => ({ ...group, observationRefs: group.observationRefs.map(ref => {
      // Source generation was computed from the original full annual projection.
      // Core receives only its established evidence allowlist, without rebuilding it.
      const process = ref.evidence.process as CandidateComparisonInput['processes'][number]['input']['groups'][number]['observationRefs'][number]['evidence']['process']
      const temporal = ref.evidence.temporal as CandidateComparisonInput['processes'][number]['input']['groups'][number]['observationRefs'][number]['evidence']['temporal']
      const source = ref.evidence.source as { identityOnly: boolean }
      return { ...ref, evidence: { process, temporal, source: { identityOnly: source.identityOnly } } }
    }) })) } }))
  } catch (error) {
    if (error instanceof Error && (['platform_comparison_scope_unavailable', 'input_resource_limit'].includes(error.message) || (error as Error & { code?: string }).code?.startsWith('SQLITE_BUSY'))) throw error
    throw new Error('platform_comparison_scope_unavailable')
  }
}
