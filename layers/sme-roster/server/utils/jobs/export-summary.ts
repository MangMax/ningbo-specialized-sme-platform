import type { TaskSummaryAccess } from '../../../../core/server/utils/job-runner-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { resolveDbPath } from '../../../../../db/client'
import type { TaskSummary } from '../../../lib/sme-roster/task-summary'
import { TASK_EXPORTS } from '../../../lib/sme-roster/task-exports'
import { isJobId } from '../../../../core/lib/job'
import type { useApplicationDb } from '../../../../../db/client'
import { currentArtifact, currentExportDbPath } from '../current-export-artifact'
import type { ProjectedTask } from './task-summary'
import { sql } from 'drizzle-orm'
import { schema } from '../../../../../db/client'
interface ExportRead {
  regenerateOf: string | null; phase: string; generatedAt: string | null; snapshotStartedAt: string | null
  ruleVersion: string; dataVersion: string
  counts: NonNullable<TaskSummary['export']>['counts']
  artifact: Omit<NonNullable<NonNullable<TaskSummary['export']>['artifact']>, 'downloadUrl' | 'filename' | 'availability'>
}
const j = schema.job
export const exportProjection = {
  exportTitle: sql<string>`substr(json_extract(${j.params}, '$.titleCode'),1,40)`,
  exportMeta: sql<string>`case when ${j.kind} = 'current-roster-export' then json_object('regenerateOf',substr(json_extract(${j.params},'$.regenerateOf'),1,26),'phase',substr(json_extract(${j.result},'$.phase'),1,20),'generatedAt',substr(json_extract(${j.result},'$.generatedAt'),1,30),'snapshotStartedAt',substr(json_extract(${j.result},'$.snapshotStartedAt'),1,30),'ruleVersion',substr(json_extract(${j.result},'$.ruleVersion'),1,60),'dataVersion',substr(json_extract(${j.result},'$.dataVersion'),1,72),'counts',json_object('eligible',json_extract(${j.result},'$.counts.eligible'),'pending',json_extract(${j.result},'$.counts.pending'),'excluded',json_extract(${j.result},'$.counts.excluded')),'artifact',json_object('id',substr(json_extract(${j.result},'$.artifact.id'),1,26),'size',json_extract(${j.result},'$.artifact.size'),'sha256',substr(json_extract(${j.result},'$.artifact.sha256'),1,64),'generatedAt',substr(json_extract(${j.result},'$.artifact.generatedAt'),1,30),'expiresAt',substr(json_extract(${j.result},'$.artifact.expiresAt'),1,30))) else '{}' end`,
}

export const exportTitleFilter = (title: string) => sql`json_extract(${j.params}, '$.titleCode') = ${title}`

type ExportSummaryRow = Pick<ProjectedTask, 'id' | 'kind' | 'state' | 'exportTitle' | 'exportMeta'>

export function readExportSummary(row: ProjectedTask, authorized: boolean, db: ReturnType<typeof useApplicationDb>) {
  return projectExportSummary(row, authorized, row.kind === 'current-roster-export' ? currentExportDbPath(db) : '', true)
}

async function projectExportSummary(row: ExportSummaryRow, authorized: boolean, dbPath: string, writable: boolean) {
  const active = row.state === 'queued' || row.state === 'running'
  let exported: TaskSummary['export']
  if (row.kind === 'current-roster-export') {
    const meta = JSON.parse(row.exportMeta || '{}') as ExportRead
    const title = TASK_EXPORTS.find(t => t.titleCode === row.exportTitle)
    const date = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null
    const raw = meta.artifact
    let artifact: NonNullable<TaskSummary['export']>['artifact'] = null
    if (title && row.state === 'done' && raw?.id === row.id && Number.isSafeInteger(raw.size) && raw.size > 0 && /^[a-f0-9]{64}$/.test(raw.sha256) && date(raw.generatedAt) && date(raw.expiresAt)) {
      // Reuse the artifact authority on a bounded, whitelisted projection. Never
      // load the full job result or forward its path/URL/filename fields.
      artifact = await currentArtifact({ id: row.id, kind: row.kind, state: row.state,
        result: { artifact: { ...raw, filename: `current-${title.titleCode}.xlsx`, downloadUrl: `/api/job-artifacts/${row.id}` } } }, dbPath)
    }
    exported = {
      titleCode: title?.titleCode ?? null, regenerateOf: isJobId(meta.regenerateOf) ? meta.regenerateOf : null,
      phase: ['starting','workbook','complete'].includes(meta.phase) ? meta.phase : 'unknown',
      generatedAt: date(meta.generatedAt), snapshotStartedAt: date(meta.snapshotStartedAt),
      // This is a displayed label, not a qualification policy selector.
      ruleVersion: /^current-roster-116-v[1-9]\d*$/.test(meta.ruleVersion) ? meta.ruleVersion : null,
      dataVersion: /^sha256:[a-f0-9]{64}$/.test(meta.dataVersion) ? meta.dataVersion : null,
      counts: meta.counts && Object.values(meta.counts).every(n => Number.isSafeInteger(n) && Number(n) >= 0) ? meta.counts : null,
      artifact, canDownload: authorized && artifact?.availability === 'available', canRegenerate: writable && authorized && !active && !!title,
    }
  }
  return exported
}

export async function readPostgresExportSummaries(db: NodePgDatabase, ids: string[], _detail: boolean, { authorized, writable }: TaskSummaryAccess) {
  const { rows } = await db.execute<ExportSummaryRow>(sql`
    SELECT id, kind, state, left(business.job_params_for_query(params)->>'titleCode',40) AS "exportTitle",
      json_build_object(
        'regenerateOf',left(business.job_params_for_query(params)->>'regenerateOf',26),
        'phase',left(result::json->>'phase',20),'generatedAt',left(result::json->>'generatedAt',30),
        'snapshotStartedAt',left(result::json->>'snapshotStartedAt',30),
        'ruleVersion',left(result::json->>'ruleVersion',60),'dataVersion',left(result::json->>'dataVersion',72),
        'counts',json_build_object('eligible',result::json#>'{counts,eligible}',
          'pending',result::json#>'{counts,pending}','excluded',result::json#>'{counts,excluded}'),
        'artifact',json_build_object('id',left(result::json#>>'{artifact,id}',26),
          'size',result::json#>'{artifact,size}','sha256',left(result::json#>>'{artifact,sha256}',64),
          'generatedAt',left(result::json#>>'{artifact,generatedAt}',30),
          'expiresAt',left(result::json#>>'{artifact,expiresAt}',30)))::text AS "exportMeta"
    FROM business.job WHERE id=ANY(${sql.param(ids)}::text[]) AND kind='current-roster-export'`)
  const dbPath = resolveDbPath()
  const result = new Map<string, Pick<TaskSummary, 'export'>>()
  for (const row of rows) result.set(row.id, { export: await projectExportSummary(row, authorized, dbPath, writable) })
  return result
}
