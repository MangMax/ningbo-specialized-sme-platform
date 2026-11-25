import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isJobId } from '../../../../core/lib/job'
import { appLog, type LogContext } from '../../../../core/lib/logging'
import { getJob, type JobCompletion, type JobSpec } from '../../../../core/server/public'
import type { JobRow } from '../../../../core/server/utils/job-contract'
import { currentExportReceipt, isExportArtifactExpired, postgresExportDirectory } from '../current-export-artifact'

const paramsSchema = z.strictObject({
  clientRequestId: z.string().trim().min(1).max(128).refine(value => !value.includes('\0')),
})

async function sweepExpiredExports(
  directory: string | undefined,
  readJob: (id: string) => JobRow | null | undefined | Promise<JobRow | null | undefined>,
  ctx: { cancelled(): boolean | Promise<boolean>; logContext?: Readonly<LogContext> },
): Promise<JobCompletion> {
  const result = { removed: 0, failed: 0 }
  if (!directory) return { result, error: '清理需要持久化的名录导出目录' }

  const cutoff = Date.now()
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { result }
    return { result, error: '无法读取名录导出目录' }
  }

  for (const name of entries) {
    if (!name.endsWith('.xlsx')) continue
    const id = name.slice(0, -'.xlsx'.length)
    if (!isJobId(id)) continue
    if (await ctx.cancelled()) return { result, cancelled: true }

    let row: JobRow | null | undefined
    try {
      row = await readJob(id)
    } catch {
      return { result, error: '无法读取名录导出任务记录' }
    }
    const artifact = currentExportReceipt(row)
    if (!artifact || typeof artifact.expiresAt !== 'string' || !isExportArtifactExpired(artifact, cutoff)) continue

    const log = {
      module: 'sme-roster', source: 'export', operation: 'export.artifact.cleanup',
      resourceType: 'export_artifact', resourceId: id,
    } as const
    try {
      await unlink(join(directory, name))
      result.removed++
      appLog({ ...log, outcome: 'success' }, ctx.logContext)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      result.failed++
      appLog({ ...log, outcome: 'failure', level: 'error', errorCode: 'artifact_cleanup_failed' }, ctx.logContext)
    }
  }
  return result.failed
    ? { result, error: '部分过期名录导出文件未能清理' }
    : { result }
}

export const rosterExportCleanupSpec: JobSpec = {
  kind: 'roster_export_cleanup',
  status: 'ready',
  deduplicateRequest: true,
  summary: '清理超过保留期的当前名录 XLSX 导出文件',
  paramsHint: '{ clientRequestId: string }',
  parse(raw) {
    const parsed = paramsSchema.safeParse(raw)
    return parsed.success
      ? { ok: true, params: parsed.data }
      : { ok: false, message: '需要有效的 clientRequestId' }
  },
  postgres: {
    run(ctx) {
      return sweepExpiredExports(postgresExportDirectory(), async id => (await getJob(ctx.db, id))?.row, ctx)
    },
  },
}
