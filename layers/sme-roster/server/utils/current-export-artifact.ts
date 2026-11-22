import { createReadStream } from 'node:fs'
import { stat, unlink, realpath, readdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import type { JobRow } from '../../../core/server/utils/job-contract'
import { appLog, type LogContext } from '../../../core/lib/logging'
export const EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function postgresExportDirectory() {
  const directory = process.env.NUXT_ROSTER_EXPORT_DIR
  return directory?.trim() ? resolve(directory) : undefined
}
export interface ExportArtifact { id: string; filename: string; size: number; sha256: string; generatedAt: string; expiresAt: string; downloadUrl: string; availability: 'available'|'expired'|'missing' }
type ExportJobRecord = Pick<JobRow, 'id' | 'kind' | 'state' | 'result'>
export function currentExportReceipt(row: ExportJobRecord | null | undefined): ExportArtifact | null {
  const artifact = (row?.result as {artifact?: ExportArtifact}|null)?.artifact
  if (row?.kind !== 'current-roster-export' || row.state !== 'done' || !artifact || artifact.id !== row.id) return null
  return artifact
}
export const isExportArtifactExpired = (artifact: ExportArtifact, cutoff = Date.now()) => cutoff >= Date.parse(artifact.expiresAt)

export async function currentArtifact(row: ExportJobRecord, directory: string | undefined, logContext?: LogContext): Promise<ExportArtifact | null> {
  const artifact = currentExportReceipt(row)
  if (!artifact) return null
  const expired = isExportArtifactExpired(artifact)
  if (!directory) return { ...artifact, availability: expired ? 'expired' : 'missing' }
  const path = join(directory, row.id + '.xlsx')
  if (expired) {
    await unlink(path).then(() => {
      appLog({ module: 'sme-roster', source: 'export', operation: 'export.artifact.expire', outcome: 'success', taskId: row.id, resourceType: 'export_artifact', resourceId: artifact.id }, logContext)
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') appLog({ module: 'sme-roster', source: 'export', operation: 'export.artifact.expire', outcome: 'failure', level: 'error', errorCode: 'artifact_cleanup_failed', taskId: row.id, resourceType: 'export_artifact', resourceId: artifact.id }, logContext)
    })
    return { ...artifact, availability: 'expired' }
  }
  try {
    if (dirname(await realpath(path)) !== await realpath(directory) || (await stat(path)).size !== artifact.size) return { ...artifact, availability: 'missing' }
    return { ...artifact, availability: 'available' }
  } catch { return { ...artifact, availability: 'missing' } }
}
export function artifactStream(directory: string, id: string) { return createReadStream(join(directory, id + '.xlsx')) }

/** Only export-owned files from inactive jobs are eligible for removal. */
export async function cleanupExportArtifacts(directory: string | undefined, readJob: (id: string) => JobRow | undefined | Promise<JobRow | undefined>, logContext?: LogContext) {
  if (!directory) return
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}\.(part|xlsx)$/.test(name)) continue
    const row=await readJob(name.slice(0,26))
    if (row?.kind !== 'current-roster-export' || ['queued','running'].includes(row.state)) continue
    const artifact=row.state === 'done' ? await currentArtifact(row,directory) : null
    if (name.endsWith('.part') || !artifact || artifact.availability !== 'available') {
      const resourceId = name.slice(0,26)
      await unlink(join(directory,name)).then(() => {
        appLog({ module: 'sme-roster', source: 'export', operation: 'export.artifact.cleanup', outcome: 'success', resourceType: 'export_artifact', resourceId, taskId: row.id }, logContext)
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') appLog({ module: 'sme-roster', source: 'export', operation: 'export.artifact.cleanup', outcome: 'failure', level: 'error', errorCode: 'artifact_cleanup_failed', resourceType: 'export_artifact', resourceId, taskId: row.id }, logContext)
      })
    }
  }
}
