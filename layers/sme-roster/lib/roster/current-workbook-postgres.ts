import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { LogContext } from '../../../core/lib/logging'
import type { ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import type { CurrentTitle } from './current-titles'
import { readPostgresCurrentCandidateIds } from './current-candidates-postgres'
import { readPostgresCurrentStatusBatch, readPostgresCurrentWorkbookBatch } from './current-qualification-postgres'
import { createPostgresPlatformQualificationReader } from './platform-qualification-postgres'
import { writeCurrentWorkbookFromSource } from './current-workbook-renderer'

export function writePostgresCurrentWorkbook(
  db: NodePgDatabase, title: CurrentTitle, filename: string,
  progress: (done: number, total: number, snapshotStartedAt: string) => void, logContext?: LogContext, receiptRuntime?: ReceiptRuntimeContext,
) {
  return db.transaction(tx => {
    const readPlatform = createPostgresPlatformQualificationReader(tx)
    return writeCurrentWorkbookFromSource({
      candidateIds: () => readPostgresCurrentCandidateIds(tx, title),
      classify: (ids, asOf) => readPostgresCurrentStatusBatch(tx, ids, title, asOf, readPlatform),
      readRows: (ids, asOf) => readPostgresCurrentWorkbookBatch(tx, ids, title, asOf, readPlatform, receiptRuntime),
    }, title, filename, progress, logContext)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
