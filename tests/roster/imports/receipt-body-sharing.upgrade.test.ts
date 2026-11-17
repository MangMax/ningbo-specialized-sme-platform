import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { migrateImportReceiptBodies } from '../../../db/import-receipt-bodies'
it('resumes exact byte sharing without merging hash collisions or lexical variants', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys=ON')
    db.exec(`CREATE TABLE import_receipt(id INTEGER PRIMARY KEY,batch_id INTEGER,request_hash TEXT,request_body TEXT NOT NULL)`)
    const bodies = [' {"中文":1}\n', ' {"中文":1}\n', '{"中文":1}', ' {"中文":1}\n', '', '']
    bodies.forEach((body, i) => db.prepare('INSERT INTO import_receipt VALUES(?,1,?,?)').run(i+1, 'collision', body))
    const read = () => db.prepare(`SELECT CAST(COALESCE(o.request_body,r.request_body) AS BLOB) AS body FROM import_receipt r LEFT JOIN import_receipt o ON o.id=r.body_receipt_id ORDER BY r.id`).all().map(row => (row as { body: Buffer }).body)
    expect(migrateImportReceiptBodies(db, 1)).toEqual({ migrated: 1, reclaimedBytes: 14 })
    expect(read()).toEqual(bodies.map(body => Buffer.from(body)))
    expect(migrateImportReceiptBodies(db)).toEqual({ migrated: 2, reclaimedBytes: 14 })
    expect(read()).toEqual(bodies.map(body => Buffer.from(body)))
    expect(migrateImportReceiptBodies(db)).toEqual({ migrated: 0, reclaimedBytes: 0 })
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally { db.close() }
})
it('keeps committed switches after interruption and resumes remaining receipts', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE import_receipt(id INTEGER PRIMARY KEY,batch_id INTEGER,request_hash TEXT,request_body TEXT NOT NULL);
      INSERT INTO import_receipt VALUES(1,1,'same','正文'),(2,1,'same','正文'),(3,1,'same','正文');
      CREATE TRIGGER interrupt_switch BEFORE UPDATE ON import_receipt WHEN NEW.id=3 BEGIN SELECT RAISE(ABORT,'interrupted'); END;`)
    expect(() => migrateImportReceiptBodies(db)).toThrow('interrupted')
    expect(db.prepare('SELECT request_body FROM import_receipt ORDER BY id').all()).toEqual([{request_body:'正文'},{request_body:''},{request_body:'正文'}])
    db.exec('DROP TRIGGER interrupt_switch')
    expect(migrateImportReceiptBodies(db)).toEqual({ migrated: 1, reclaimedBytes: 6 })
    expect(migrateImportReceiptBodies(db)).toEqual({ migrated: 0, reclaimedBytes: 0 })
  } finally { db.close() }
})
