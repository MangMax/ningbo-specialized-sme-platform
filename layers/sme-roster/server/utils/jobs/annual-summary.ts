import { annualTaskSummary } from './annual-summary-postgres'
import { ANNUAL_CORRESPONDENCE_KIND } from '../../../lib/roster/annual-correspondence'
import type { ProjectedTask } from './task-summary'
export function readAnnualSummary(row: ProjectedTask) {
  if (row.kind !== ANNUAL_CORRESPONDENCE_KIND) return undefined
  return annualTaskSummary(row.annualTotal, row.annualDone, row.annualFailed, row.annualAttempt)
}
export { annualTaskLinks, summarizePostgresAnnualJobs } from './annual-summary-postgres'
