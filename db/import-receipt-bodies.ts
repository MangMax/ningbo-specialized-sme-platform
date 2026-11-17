import type Database from 'better-sqlite3'

/** Explicit offline expansion; runtime opens never change schema. */
export function expandImportReceiptBodies(db: Database.Database) {
  if (!db.prepare('PRAGMA table_info(import_receipt)').all().some(row => (row as { name: string }).name === 'body_receipt_id')) {
    db.exec('ALTER TABLE import_receipt ADD COLUMN body_receipt_id INTEGER REFERENCES import_receipt(id)')
  }
  db.exec('CREATE INDEX IF NOT EXISTS import_receipt_body_owner_idx ON import_receipt(batch_id,request_hash,id) WHERE body_receipt_id IS NULL')
}

/** One receipt per transaction: killing the process leaves only complete switches.
 * Owners always remain inline; hashes locate candidates, bytes decide equality.
 */
export function migrateImportReceiptBodies(db: Database.Database, limit = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive safe integer')
  expandImportReceiptBodies(db)
  let reclaimedBytes = 0
  let migrated = 0
  let after = 0
  const next = db.prepare('SELECT id FROM import_receipt WHERE id > ? AND body_receipt_id IS NULL ORDER BY id LIMIT 1')
  while (migrated < limit) {
    const row = next.get(after) as { id: number } | undefined
    if (!row) break
    after = row.id
    const bytes = db.transaction(() => {
      const pair = db.prepare(`SELECT owner.id, length(CAST(r.request_body AS BLOB)) AS bytes
        FROM import_receipt r JOIN import_receipt owner ON owner.batch_id=r.batch_id
        AND owner.request_hash=r.request_hash AND owner.id<r.id AND owner.body_receipt_id IS NULL
        AND CAST(owner.request_body AS BLOB)=CAST(r.request_body AS BLOB)
        WHERE r.id=? AND r.body_receipt_id IS NULL ORDER BY owner.id LIMIT 1`).get(row.id) as { id: number; bytes: number } | undefined
      if (!pair) return undefined
      db.prepare("UPDATE import_receipt SET body_receipt_id=?, request_body='' WHERE id=?").run(pair.id, row.id)
      return pair.bytes
    }).immediate()
    if (bytes !== undefined) { migrated++; reclaimedBytes += bytes }
  }
  return { migrated, reclaimedBytes }
}
