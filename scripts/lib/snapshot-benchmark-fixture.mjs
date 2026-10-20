import assert from 'node:assert/strict'
import { chmodSync, constants, copyFileSync, existsSync, realpathSync, renameSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function stageSnapshotTemplate(source, template, prepared) {
  assert.notEqual(resolve(source), resolve(template)); assert.ok(!existsSync(template), 'new owned template required')
  const sourceStat = statSync(source)
  if (prepared) {
    assert.ok(resolve(prepared).startsWith('/tmp/node-results/precloned94-'))
    assert.notEqual(realpathSync(prepared), realpathSync(source))
    assert.notEqual(statSync(prepared).ino, sourceStat.ino)
    assert.equal(statSync(prepared).dev, statSync(dirname(template)).dev, 'prepared template requires same-filesystem rename')
    renameSync(prepared, template)
  } else copyFileSync(source, template, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
  assert.notEqual(realpathSync(template), realpathSync(source)); assert.notEqual(statSync(template).ino, sourceStat.ino)
  const copiedMode = statSync(template).mode & 0o777
  chmodSync(template, 0o600)
  return { copiedMode, sourceMode: sourceStat.mode & 0o777, ownedWriteMode: statSync(template).mode & 0o777 }
}

/** Only call on a newly owned, disposable snapshot benchmark copy. */
export function resetSnapshotFixture(db) {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'fixture reset requires FK enforcement')
  const quote = value => `"${value.replaceAll('"', '""')}"`
  for (const { name } of db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all()) {
    for (const fk of db.pragma(`foreign_key_list(${quote(name)})`)) {
      if (fk.table === 'import_receipt') throw Error(`unexpected receipt child graph: ${name}.${fk.from}`)
      if (fk.table !== 'import_batch') continue
      if (name === 'import_receipt') {
        assert.equal(fk.from, 'batch_id'); assert.equal(fk.to, 'id')
      } else {
        const dependent = db.prepare(`select count(*) n from ${quote(name)} where ${quote(fk.from)} in (select id from import_batch where idempotency_key like 'synthetic:bench:%')`).get().n
        assert.equal(dependent, 0, `unexpected dependency beyond owned receipts: ${name}.${fk.from}`)
      }
    }
  }
  let removedOwnedReceiptRows = 0, removedOwnedBatchRows = 0
  db.transaction(() => {
    db.prepare("DELETE FROM platform_export_row WHERE batch_id=(SELECT id FROM platform_export_batch WHERE sha256='synthetic-benchmark' AND year=2094) AND source_row_no>=10000").run()
    removedOwnedReceiptRows = db.prepare("DELETE FROM import_receipt WHERE batch_id IN (SELECT id FROM import_batch WHERE idempotency_key LIKE 'synthetic:bench:%')").run().changes
    removedOwnedBatchRows = db.prepare("DELETE FROM import_batch WHERE idempotency_key LIKE 'synthetic:bench:%'").run().changes
  })()
  const integrity = db.pragma('integrity_check', { simple: true })
  const foreignKeyViolations = db.pragma('foreign_key_check').length
  assert.equal(integrity, 'ok'); assert.equal(foreignKeyViolations, 0)
  return { removedOwnedReceiptRows, removedOwnedBatchRows, integrity, foreignKeyViolations, foreignKeysOn: 1 }
}
