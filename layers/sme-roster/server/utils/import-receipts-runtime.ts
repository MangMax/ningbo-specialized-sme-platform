import { useDb } from '@db'
import { readImportReceipt, type ImportReceiptAction } from './import-receipts'
import { readPostgresImportReceipt } from './import-receipts-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'

export async function readRuntimeImportReceipt(action: ImportReceiptAction, args: Record<string, unknown>) {
  const db = usePostgresRosterDb()
  return db ? readPostgresImportReceipt(db, action, args) : readImportReceipt(useDb(), action, args)
}
