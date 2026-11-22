import type { JobSpec } from '../../../../core/server/public'
import { ANNUAL_CORRESPONDENCE_KIND as KIND } from '../../../lib/roster/annual-correspondence'
import { runPostgresAnnualCorrespondence } from './annual-correspondence-postgres'
import { summarizePostgresAnnualJobs } from './annual-summary-postgres'

export const postgresAnnualCorrespondenceSpec: JobSpec = {
  kind: KIND, status: 'ready', summary: '完整年度过程对应与最终资格核对',
  paramsHint: '请使用年度专属入口；显式eventIds 1..200，来源代次由服务器计算。',
  parse: () => ({ ok: false, message: '请使用年度对应任务入口' }),
  postgres: { run: runPostgresAnnualCorrespondence, taskCenter: { summaries: summarizePostgresAnnualJobs } },
}
