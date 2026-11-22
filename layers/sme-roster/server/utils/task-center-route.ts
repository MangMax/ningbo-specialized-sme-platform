import { sql } from 'drizzle-orm'
import { postgresJobHandler } from '../../../core/server/utils/job-runner-postgres'
import { TASK_EXPORTS } from '../../lib/sme-roster/task-exports'
import { postgresExportDirectory } from './current-export-artifact'
export function rosterPostgresTaskListOptions(query: Record<string, unknown>) {
  const title = TASK_EXPORTS.find(item => item.titleCode === query.titleCode)
  return {
    filter: title ? sql`kind = 'current-roster-export' AND business.job_params_for_query(params) ->> 'titleCode' = ${title.titleCode}` : undefined,
    exportReady: Boolean(postgresJobHandler('current-roster-export') && postgresExportDirectory()),
  }
}
