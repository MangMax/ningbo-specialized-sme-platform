import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { useDb } from '../db/client'
import { commitRosterImport } from '../server/utils/roster-import'
import { readImportReceipt } from '../server/utils/import-receipts'

it.each([
  { phase: 'reservation', transaction: 1 },
  { phase: 'execution', transaction: 2 },
])('keeps import $phase atomic when another writer attempts to change its read snapshot', ({ transaction }) => {
  const dir = mkdtempSync(join(tmpdir(), 'import-writer-contention-'))
  const db = useDb({ dbPath: join(dir, 'isolated.db') })
  // A synthetic second connection represents the automatic candidate writer.
  // timeout=0 makes this probe report lock ownership immediately; it changes no
  // application connection setting and neither waits nor retries a business write.
  const contender = new Database(db.$client.name, { timeout: 0 })
  db.$client.exec('CREATE TABLE synthetic_writer_probe(value INTEGER); INSERT INTO synthetic_writer_probe VALUES(0)')
  const prepare = db.$client.prepare.bind(db.$client)
  const nativeTransaction = db.$client.transaction.bind(db.$client)
  let transactionNumber = 0, transactionDepth = 0, attempted = false, contenderCode: string | undefined
  db.$client.transaction = ((run: (...args: any[]) => any) => nativeTransaction((...args: any[]) => {
    if (transactionDepth++ === 0) transactionNumber++
    try { return run(...args) } finally { transactionDepth-- }
  })) as typeof nativeTransaction
  db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    for (const method of ['get', 'all'] as const) {
      const read = statement[method].bind(statement)
      statement[method] = ((...values: any[]) => {
        const result = (read as any)(...values)
        if (!attempted && db.$client.inTransaction && transactionNumber === transaction && /^select\b/i.test(args[0])) {
          attempted = true
          try { contender.exec('UPDATE synthetic_writer_probe SET value=value+1') }
          catch (cause) { contenderCode = (cause as { code: string }).code }
        }
        return result
      }) as any
    }
    return statement
  }) as typeof prepare
  const request = {
    idempotencyKey: 'synthetic-contention', sourceKind: 'announcement' as const,
    sourceIdentity: 'synthetic/contention', payload: { announcement: {
      sourceDocument: { source: 'jxj' as const, title: '合成并发公布文件' },
      records: [{ enterprise: { name: '合成并发企业', uscc: '91330211255994457P' }, titleCode: 'specialized_sme', events: [{ eventType: 'award' as const, year: 2022 }] }],
    } },
  }
  try {
    const receipt = commitRosterImport(db, request)
    expect(receipt.status).toBe('committed')
    expect(attempted).toBe(true)
    expect(contenderCode).toBe('SQLITE_BUSY')
    expect(readImportReceipt(db, 'get', { idempotencyKey: request.idempotencyKey })).toMatchObject({ status: 'committed' })
    expect(commitRosterImport(db, request)).toEqual(receipt)
  } finally {
    db.$client.prepare = prepare
    db.$client.transaction = nativeTransaction
    contender.close(); db.$client.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
