import { sql } from 'drizzle-orm'
import { postgresExportDirectory } from '../current-export-artifact'
import * as schema from '../../../../../db/schema'
import type { ProjectedTask } from './task-summary'
import { projectExportSummary } from './export-summary-postgres'

export { exportRetryReason, exportTaskLabel, exportTaskProgress } from './export-summary-postgres'

const j = schema.job
export const exportProjection = {
  exportTitle: sql<string>`substr(json_extract(${j.params}, '$.titleCode'),1,40)`,
  exportMeta: sql<string>`case when ${j.kind} = 'current-roster-export' then json_object('regenerateOf',substr(json_extract(${j.params},'$.regenerateOf'),1,26),'phase',substr(json_extract(${j.result},'$.phase'),1,20),'generatedAt',substr(json_extract(${j.result},'$.generatedAt'),1,30),'snapshotStartedAt',substr(json_extract(${j.result},'$.snapshotStartedAt'),1,30),'ruleVersion',substr(json_extract(${j.result},'$.ruleVersion'),1,60),'dataVersion',substr(json_extract(${j.result},'$.dataVersion'),1,72),'counts',json_object('eligible',json_extract(${j.result},'$.counts.eligible'),'pending',json_extract(${j.result},'$.counts.pending'),'excluded',json_extract(${j.result},'$.counts.excluded')),'artifact',json_object('id',substr(json_extract(${j.result},'$.artifact.id'),1,26),'size',json_extract(${j.result},'$.artifact.size'),'sha256',substr(json_extract(${j.result},'$.artifact.sha256'),1,64),'generatedAt',substr(json_extract(${j.result},'$.artifact.generatedAt'),1,30),'expiresAt',substr(json_extract(${j.result},'$.artifact.expiresAt'),1,30))) else '{}' end`,
}

export const exportTitleFilter = (title: string) => sql`json_extract(${j.params}, '$.titleCode') = ${title}`

export function readExportSummary(row: ProjectedTask, authorized: boolean) {
  const directory = row.kind === 'current-roster-export' ? postgresExportDirectory() : undefined
  return projectExportSummary(row, authorized, directory, true)
}
