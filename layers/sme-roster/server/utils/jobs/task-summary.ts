import { readSnapshotSummary, snapshotTaskLinks } from './snapshot-summary'
import { annualProjection, readAnnualSummary, annualTaskLinks } from './annual-summary'
import { readCandidateSummary, candidateProjection, candidateTaskLinks } from './candidate-summary'
import { readExportSummary, exportProjection, exportRetryReason, exportTaskLabel, exportTaskProgress } from './export-summary'
import { readReconcileSummary, reconcileProjection } from './reconcile-summary'
import { readBatchSummary, batchProjection } from './batch-summary'
import { readOcrLinks, ocrProjection } from '../../../../core/server/utils/jobs/ocr-summary'
import { desc, sql, type SQL } from 'drizzle-orm'
import { schema, type useApplicationDb } from '../../../../../db/client'
import { type TaskSummary } from '../../../lib/sme-roster/task-summary'
import { taskSummaryBase, taskSummaryCapabilities } from '../../../../core/server/utils/task-summary'
import { annualTaskReason, platformTaskLinks, rosterTaskError, taskRetryReason } from './task-presentation'

type Db = ReturnType<typeof useApplicationDb>
const j = schema.job
// SQLite projects only scalar fields and bounded ID/status arrays. Raw params,
// OCR markdown and platform segment/page/row payloads never enter JS list memory.
const projection = {
  id: j.id, kind: j.kind, state: j.state, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  done: sql<number>`json_extract(${j.progress}, '$.done')`, total: sql<number>`json_extract(${j.progress}, '$.total')`,
  hasError: sql<number>`(${j.error} is not null)`, restarted: sql<number>`coalesce(instr(${j.error}, '服务重启'),0) > 0`,

  ...ocrProjection,
  ...batchProjection,
  ...reconcileProjection,
  ...exportProjection,
  ...candidateProjection,
  ...annualProjection,
}
export function readTasks(db: Db, where: SQL | undefined, limit: number, offset = 0) {
  return db.select(projection).from(j).where(where).orderBy(desc(j.createdAt), desc(j.id)).limit(limit).offset(offset).all()
}
export type ProjectedTask = ReturnType<typeof readTasks>[number]
export async function summarize(row: ProjectedTask, authorized: boolean, db: Db, detail = false): Promise<TaskSummary> {
  const base = taskSummaryBase(row)
  const isRosterExport = row.kind === 'current-roster-export'
  const { items, retryItemIds, outcome, retry: batchRetry } = readBatchSummary(row, detail)
  const candidate = readCandidateSummary(row, detail)
  const retry = candidate.discoveryRetry || batchRetry
  const { reconcile, reconcileCollection } = readReconcileSummary(row)
  const annual = readAnnualSummary(row)
  const links = readOcrLinks(row)
  if (row.kind === 'difference-snapshot') links.push(...snapshotTaskLinks(row.id))
  else if (annual) links.push(...annualTaskLinks(row.id))
  else if (candidate.discovery) links.push(...candidateTaskLinks(candidate, detail))
  else if (base.module === 'sme-roster' && base.group === 'platform') links.push(...platformTaskLinks())
  const exported = await readExportSummary(row, authorized, db)
  const exportProgress = isRosterExport ? exportTaskProgress(row.state, exported?.phase) : undefined

  return {
    ...base,
    ...(row.kind === 'difference-snapshot' && authorized && detail ? { snapshot: readSnapshotSummary(db, row.id) } : {}),
    ...(annual ? { annual } : {}),
    ...(exported ? { export: exported } : {}),
    ...(reconcile ? { reconcile, reconcileCollection } : {}),
    ...(candidate.summary ? { discovery: candidate.summary } : {}),
    label: exportTaskLabel(exported?.titleCode) ?? base.label,
    progress: exportProgress ? {
      ...base.progress, total: exportProgress.totalVisible ? base.progress.total : null,
      unit: exportProgress.unit, stage: exportProgress.stage,
    } : base.progress,
    error: rosterTaskError(row),
    ...(detail ? { items } : {}),
    outcome,
    capabilities: taskSummaryCapabilities(row.state, authorized, true, retry, retryItemIds,
      annual ? annualTaskReason : retry ? taskRetryReason : isRosterExport ? exportRetryReason : undefined),
    links,
  }
}
