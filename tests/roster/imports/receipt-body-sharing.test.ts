import { afterEach, expect, it } from 'vitest'
import { nativeImportDb } from './fixtures/native-import'
import { recordImportReceipt } from '../../../layers/sme-roster/server/utils/import-receipt-ledger'
import { readImportReceipt } from '../../../layers/sme-roster/server/utils/import-receipts'
import { sql } from 'drizzle-orm'
const dbs: ReturnType<typeof nativeImportDb>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.$client.close() })
it('retains one exact body for preflight and commit while preserving different bodies', () => {
  const db = nativeImportDb(); dbs.push(db)
  const request = { idempotencyKey: 'sharing', sourceKind: 'announcement' as const, sourceIdentity: 'synthetic', payload: {} }
  for (const [operation, body] of [['preflight', request], ['commit', request], ['preflight', { ...request, payload: { officialEvidencePlanHash: '不同' } }]] as const) {
    recordImportReceipt(db, operation, body, () => ({ status: operation === 'commit' ? 'failed' : 'preflight' }))
  }
  const rows = db.all<{request_body:string}>(sql`SELECT request_body FROM import_receipt ORDER BY id`)
  expect(rows[0]!.request_body).toContain('sharing')
  expect(rows[1]!.request_body).toBe('')
  expect(rows[2]!.request_body).toContain('不同')
  const first = readImportReceipt(db, 'request', { receiptId: 1 }) as { data: string }
  const shared = readImportReceipt(db, 'request', { receiptId: 2 }) as { data: string }
  expect(shared.data).toBe(first.data)
  expect(Buffer.from(shared.data, 'base64').toString()).toBe(rows[0]!.request_body)
})
