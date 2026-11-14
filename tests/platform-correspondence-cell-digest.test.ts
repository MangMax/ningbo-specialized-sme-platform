import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { correspondenceCellDigest } from '../upgrade/correspondence'

it('preserves original references, nulls and every SQLite cell while transferring correspondence owners', () => {
  const source = new Database(':memory:'), target = new Database(':memory:')
  const payload = Buffer.from([0, 255, 65]), audit = '{"relationId":7,"original":"kept"}'
  try {
    for(const [db, column, reference] of [[source, 'relation_id', 7], [target, 'observation_id', 900]] as const) {
      db.exec(`CREATE TABLE record_correspondence(id INTEGER PRIMARY KEY,${column} INTEGER,note TEXT,payload BLOB,score REAL);
        CREATE TABLE record_correspondence_audit(id INTEGER PRIMARY KEY,correspondence_id INTEGER,body TEXT);
        CREATE TABLE platform_legacy_relation_alias(old_id INTEGER PRIMARY KEY,observation_id INTEGER UNIQUE);
        INSERT INTO platform_legacy_relation_alias VALUES(7,900)`)
      db.prepare('INSERT INTO record_correspondence VALUES(?,?,?,?,?)').run(1, reference, '原文\u0000尾', payload, 1.25)
      db.prepare('INSERT INTO record_correspondence VALUES(?,?,?,?,?)').run(2, null, '', null, null)
      db.prepare('INSERT INTO record_correspondence_audit VALUES(?,?,?)').run(1, 1, audit)
    }
    const original = correspondenceCellDigest(source)
    expect(correspondenceCellDigest(target)).toBe(original)
    target.prepare('UPDATE record_correspondence SET payload=? WHERE id=1').run(Buffer.from([0, 254, 65]))
    expect(correspondenceCellDigest(target)).not.toBe(original)
    target.prepare('UPDATE record_correspondence SET payload=? WHERE id=1').run(payload)
    target.exec('UPDATE record_correspondence SET payload=cast(payload as text) WHERE id=1')
    expect(correspondenceCellDigest(target)).not.toBe(original)
    target.prepare('UPDATE record_correspondence SET payload=? WHERE id=1').run(payload)
    target.prepare('UPDATE record_correspondence_audit SET body=? WHERE id=1').run('changed original audit')
    expect(correspondenceCellDigest(target)).not.toBe(original)
    target.prepare('UPDATE record_correspondence_audit SET body=? WHERE id=1').run(audit)
    target.prepare('UPDATE record_correspondence SET note=? WHERE id=1').run('原文\u0000改')
    expect(correspondenceCellDigest(target)).not.toBe(original)
    target.prepare('UPDATE record_correspondence SET note=? WHERE id=1').run('原文\u0000尾')
    target.prepare('UPDATE record_correspondence SET score=? WHERE id=1').run(1.2500000000000002)
    expect(correspondenceCellDigest(target)).not.toBe(original)
    target.prepare('UPDATE record_correspondence SET score=? WHERE id=1').run(1.25)
    target.prepare('UPDATE record_correspondence SET note=? WHERE id=2').run('retained without relation')
    expect(correspondenceCellDigest(target)).not.toBe(original)
  } finally { source.close(); target.close() }
})
