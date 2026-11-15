import type Database from 'better-sqlite3'

// Only disposable suite databases. The host stays connected to the same file.
// Clear immutable test facts atomically and restore every guard before publishing.
export function resetExportRows(db: Database.Database) {
  const active = db.prepare("select id from job where state in ('queued','running')").all()
  if (active.length) throw new Error('Cannot isolate export case with active jobs')
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      const triggers = db.prepare("select name,sql from sqlite_master where type='trigger'").all() as {name:string;sql:string}[]
      for (const {name} of triggers) db.exec('drop trigger "'+name.replaceAll('"','""')+'"')
      const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '%migration%' and name not in ('title','platform_runtime_capability','platform_runtime_completion','platform_legacy_alias_sequence')").all() as {name:string}[]
      for (const {name} of tables) db.exec('delete from "'+name.replaceAll('"','""')+'"')
      for (const {sql} of triggers) db.exec(sql)
    })()
  } finally { db.pragma('foreign_keys = ON') }
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Fixture reset violated foreign keys')
}
