import { getJob, toJobDto } from './job-store'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { createReadStream } from 'node:fs'
import { stat, unlink, realpath, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { JobRow } from './job-store'
import { appLog, type LogContext } from '../../lib/logging'
export const EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const exportDirectory = (dbPath: string) => dbPath + '.exports'
export interface ExportArtifact { id: string; filename: string; size: number; sha256: string; generatedAt: string; expiresAt: string; downloadUrl: string; availability: 'available'|'expired'|'missing' }
export async function currentArtifact(row: JobRow, dbPath: string, logContext?: LogContext): Promise<ExportArtifact | null> {
  const artifact = (row.result as {artifact?: ExportArtifact}|null)?.artifact
  if (row.kind !== 'current-roster-export' || row.state !== 'done' || !artifact || artifact.id !== row.id) return null
  const path = join(exportDirectory(dbPath), row.id + '.xlsx')
  if (Date.now() >= Date.parse(artifact.expiresAt)) {
    await unlink(path).then(() => {
      appLog({ module: 'sme-roster', source: 'export', operation: 'export.artifact.expire', outcome: 'success', taskId: row.id, resourceType: 'export_artifact', resourceId: artifact.id }, logContext)
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') appLog({ module: 'sme-roster', source: 'export', operation: 'export.artifact.expire', outcome: 'failure', level: 'error', errorCode: 'artifact_cleanup_failed', taskId: row.id, resourceType: 'export_artifact', resourceId: artifact.id }, logContext)
    })
    return { ...artifact, availability: 'expired' }
  }
  try {
    if (dirname(await realpath(path)) !== await realpath(exportDirectory(dbPath)) || (await stat(path)).size !== artifact.size) return { ...artifact, availability: 'missing' }
    return { ...artifact, availability: 'available' }
  } catch { return { ...artifact, availability: 'missing' } }
}
export function artifactStream(dbPath: string, id: string) { return createReadStream(join(exportDirectory(dbPath), id + '.xlsx')) }

export const currentExportDbPath = (db: BetterSQLite3Database<typeof schema>) => db.all<{name:string;file:string}>(sql`pragma database_list`).find(row => row.name === 'main')!.file
/** Availability is evaluated on every history read; expired task history persists. */
export async function currentJobDto(row: JobRow, dbPath: string) {
  const dto = toJobDto(row)
  const artifact = await currentArtifact(row,dbPath)
  return artifact ? {...dto,result:{...(row.result as object),artifact}} : dto
}

/** Lazy startup/submission sweep. Only export-owned IDs are considered; active
 * executions and completed unexpired artifacts are never removed by another job. */
export async function cleanupCurrentExports(db: BetterSQLite3Database<typeof schema>, logContext?: LogContext) {
  const dbPath=currentExportDbPath(db)
  if (!dbPath) return
  const dir=exportDirectory(dbPath)
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}\.(part|xlsx)$/.test(name)) continue
    const row=getJob(db,name.slice(0,26))
    if (row && ['queued','running'].includes(row.state)) continue
    const artifact=row?.state === 'done' ? await currentArtifact(row,dbPath) : null
    if (name.endsWith('.part') || !artifact || artifact.availability !== 'available') {
      const resourceId = name.slice(0,26)
      await unlink(join(dir,name)).then(() => {
        appLog({ module: 'sme-roster', source: 'export', operation: 'export.artifact.cleanup', outcome: 'success', resourceType: 'export_artifact', resourceId, ...(row ? { taskId: row.id } : {}) }, logContext)
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') appLog({ module: 'sme-roster', source: 'export', operation: 'export.artifact.cleanup', outcome: 'failure', level: 'error', errorCode: 'artifact_cleanup_failed', resourceType: 'export_artifact', resourceId, ...(row ? { taskId: row.id } : {}) }, logContext)
      })
    }
  }
}
