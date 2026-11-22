import type Database from 'better-sqlite3'
import type { ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import type { LogContext } from '../../../core/lib/logging'
import { prepareCurrentReader, type CurrentTitle } from './current-qualification'
import type { CurrentCandidateReader } from './current-candidate-reader'
import { createCurrentTargetContext } from './current-target-context'
import { writeCurrentWorkbookFromSource, type CurrentWorkbookSource } from './current-workbook-renderer'

export { CURRENT_HEADERS, CurrentWorkbookLimitError } from './current-workbook-renderer'

/** Streaming rows in one pinned SQLite read transaction, owned by the independent executor. */
export async function writeCurrentWorkbook(db: Database.Database, title: CurrentTitle, filename: string, progress: (done: number,total: number,snapshotStartedAt: string) => void, logContext?: LogContext, receiptRuntime?: ReceiptRuntimeContext) {
  return writeCurrentWorkbookBody(db, title, filename, progress, undefined, logContext, receiptRuntime)
}
/** Explicit R4 dependency seam; target qualification and coverage remain R5/X1. */
export async function writeCurrentWorkbookWithCandidates(db: Database.Database, title: CurrentTitle, filename: string, progress: (done: number,total: number,snapshotStartedAt: string) => void, candidateReader: CurrentCandidateReader, logContext?: LogContext, receiptRuntime?: ReceiptRuntimeContext) {
  if(candidateReader.connection!==db)throw new Error('Candidate reader must use the caller connection')
  return writeCurrentWorkbookBody(db, title, filename, progress, candidateReader, logContext, receiptRuntime)
}
async function writeCurrentWorkbookBody(db: Database.Database, title: CurrentTitle, filename: string, progress: (done: number,total: number,snapshotStartedAt: string) => void, candidateReader: CurrentCandidateReader | undefined, logContext?: LogContext, receiptRuntime?: ReceiptRuntimeContext) {
  const generatedAt = new Date().toISOString()
  prepareCurrentReader(db)
  db.exec('BEGIN')
  try {
    const target = createCurrentTargetContext(db, receiptRuntime)
    const candidates = candidateReader ?? target.candidates
    const queryKeys = target.keys.queries
    const assessment = target.assessment
    const source: CurrentWorkbookSource = {
      *candidateIds() { for (const { id } of candidates.iterate(title)) yield id },
      classify(ids, asOf) {
        return candidateReader === undefined ? assessment.readEffectiveTitles(ids, asOf, title)
          : new Map(ids.map(id => [id, assessment.readEffectiveTitle(id, title, asOf).effectiveStatus]))
      },
      readRows(ids, asOf) {
        const rows = candidateReader === undefined ? assessment.readWorkbookRowsBatch(ids, asOf, title, queryKeys)
          : ids.map(id => assessment.readWorkbook(id, asOf, title, queryKeys))
        return new Map(ids.map((id, index) => [id, rows[index]!]))
      },
    }
    const result = await writeCurrentWorkbookFromSource(source, title, filename, progress, logContext,
      candidateReader === undefined ? 'current-export-assessment-title-v3' : 'current-export-assessment-409-v2', generatedAt)
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  }
}
