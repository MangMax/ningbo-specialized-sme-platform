import { projectPlatformComparisonProcesses } from './platform-comparison-input-model'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import type { CandidateComparisonInput } from '../../lib/roster/platform-comparison'
import { readAnnualComparisonInputs } from './annual-correspondence-read'
/** Only actual identifiers cross this internal boundary. The caller owns one
 * SQLite read snapshot. No callbacks, supplied facts or confirmation switches. */
export function readPlatformComparisonProcesses(sqlite: Database.Database, request: Parameters<typeof readAnnualComparisonInputs>[2]): CandidateComparisonInput['processes'] {
  try {
    const { processes } = readAnnualComparisonInputs(sqlite, drizzle(sqlite, { schema }), request)
    return projectPlatformComparisonProcesses(processes)
  } catch (error) {
    if (error instanceof Error && (['platform_comparison_scope_unavailable', 'input_resource_limit'].includes(error.message) || (error as Error & { code?: string }).code?.startsWith('SQLITE_BUSY'))) throw error
    throw new Error('platform_comparison_scope_unavailable')
  }
}
export { projectPlatformComparisonProcesses } from './platform-comparison-input-model'
