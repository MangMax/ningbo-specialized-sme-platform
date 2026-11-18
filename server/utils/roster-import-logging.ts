import { appLog, type LogContext } from '../../layers/core/lib/logging'
import { ImportReceiptError } from './import-receipts'

/** Only application-owned codes cross the logging boundary; never error text or keys. */
export function logImportFailure(operation: string, error: unknown, context: LogContext = {}) {
  const code = error instanceof ImportReceiptError && [
    'idempotency_conflict', 'import_busy', 'import_outcome_unknown',
    'import_worker_unavailable', 'import_executor_closed', 'import_source_changed',
  ].includes(error.code) ? error.code : 'import_execution_failed'
  appLog({ module: 'sme-roster', source: 'import', operation,
    outcome: code === 'import_outcome_unknown' ? 'unknown' : code === 'idempotency_conflict' || code === 'import_busy' ? 'denied' : 'failure',
    level: code === 'idempotency_conflict' || code === 'import_busy' ? 'warn' : 'error', errorCode: code,
  }, context)
}
