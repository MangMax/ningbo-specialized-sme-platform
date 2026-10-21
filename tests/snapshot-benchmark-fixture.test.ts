import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetSnapshotFixture, stageSnapshotTemplate } from '../scripts/lib/snapshot-benchmark-fixture.mjs'

it('makes only the independent owned template writable from a frozen source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-template-test-'))
  try {
    const source = join(dir, 'frozen.sqlite'), template = join(dir, 'owned.sqlite')
    writeFileSync(source, 'synthetic snapshot bytes'); chmodSync(source, 0o400)
    stageSnapshotTemplate(source, template)
    expect(statSync(template).mode & 0o777).toBe(0o600)
    expect(statSync(source).mode & 0o777).toBe(0o400)
    expect(statSync(template).ino).not.toBe(statSync(source).ino)
    expect(readFileSync(template)).toEqual(readFileSync(source))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('resets owned receipts and generated rows with FK enforcement while preserving other imports', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE import_batch(id INTEGER PRIMARY KEY,idempotency_key TEXT NOT NULL);
      CREATE TABLE import_receipt(id INTEGER PRIMARY KEY,batch_id INTEGER REFERENCES import_batch(id));
      CREATE TABLE platform_export_batch(id INTEGER PRIMARY KEY,sha256 TEXT,year INTEGER);
      CREATE TABLE platform_export_row(id INTEGER PRIMARY KEY,batch_id INTEGER REFERENCES platform_export_batch(id),source_row_no INTEGER);
      INSERT INTO import_batch VALUES(1,'synthetic:bench:2'),(2,'existing-business-import');
      INSERT INTO import_receipt VALUES(11,1),(12,1),(21,2);
      INSERT INTO platform_export_batch VALUES(1,'synthetic-benchmark',2094),(2,'business',2026);
      INSERT INTO platform_export_row VALUES(1,1,3),(2,1,10000),(3,2,10000);`)
    resetSnapshotFixture(db)
    expect(db.prepare('select id from import_batch order by id').all()).toEqual([{ id: 2 }])
    expect(db.prepare('select id from import_receipt order by id').all()).toEqual([{ id: 21 }])
    expect(db.prepare('select id from platform_export_row order by id').all()).toEqual([{ id: 1 }, { id: 3 }])
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  } finally { db.close() }
})
