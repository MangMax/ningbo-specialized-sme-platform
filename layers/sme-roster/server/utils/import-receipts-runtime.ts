import { type ImportReceiptAction } from './import-receipt-model'
import { readPostgresImportReceipt } from './import-receipts-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'

export async function readRuntimeImportReceipt(action: ImportReceiptAction, args: Record<string, unknown>) {
  const db = usePostgresRosterDb()
  return readPostgresImportReceipt(db, action, args)
}
