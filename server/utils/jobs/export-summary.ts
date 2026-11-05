import type { TaskSummary } from '../../../lib/task-center'
import { TASK_EXPORTS } from '../../../lib/task-center'
import { isJobId } from '../../../lib/job'
import type { useDb } from '../../../db/client'
import { currentArtifact, currentExportDbPath } from '../current-export-artifact'
import { CURRENT_RULE_VERSION, LEGACY_CURRENT_RULE_VERSION } from '../../../lib/roster/current-qualification'
import type { ProjectedTask } from './task-summary'
import { sql } from 'drizzle-orm'
import { schema } from '../../../db/client'
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

export async function readExportSummary(row: ProjectedTask, authorized: boolean, db: ReturnType<typeof useDb>) {
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
      artifact = await currentArtifact({ id: row.id, kind: row.kind, state: row.state, params: {}, progress: { done: 0, total: 0 }, error: null, createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
        result: { artifact: { ...raw, filename: `current-${title.titleCode}.xlsx`, downloadUrl: `/api/job-artifacts/${row.id}` } } }, currentExportDbPath(db))
    }
    exported = {
      titleCode: title?.titleCode ?? null, regenerateOf: isJobId(meta.regenerateOf) ? meta.regenerateOf : null,
      phase: ['starting','workbook','complete'].includes(meta.phase) ? meta.phase : 'unknown',
      generatedAt: date(meta.generatedAt), snapshotStartedAt: date(meta.snapshotStartedAt),
      // Whitelist the live rule version plus its predecessor: a bump must not turn
      // fresh exports into "unknown rule" in the task center.
      ruleVersion: [CURRENT_RULE_VERSION, LEGACY_CURRENT_RULE_VERSION, 'current-roster-116-v1', 'current-roster-116-v2', 'current-roster-116-v3', 'current-roster-116-v4', 'current-roster-116-v5', 'current-roster-116-v6', 'current-roster-116-v7'].includes(meta.ruleVersion) ? meta.ruleVersion : null,
      dataVersion: /^sha256:[a-f0-9]{64}$/.test(meta.dataVersion) ? meta.dataVersion : null,
      counts: meta.counts && Object.values(meta.counts).every(n => Number.isSafeInteger(n) && Number(n) >= 0) ? meta.counts : null,
      artifact, canDownload: authorized && artifact?.availability === 'available', canRegenerate: authorized && !active && !!title,
    }
  }
  return exported
}
