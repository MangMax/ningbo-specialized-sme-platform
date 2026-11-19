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
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%migration%'
        AND name NOT IN ('title','platform_runtime_capability','platform_runtime_completion','platform_legacy_alias_sequence',
          'enterprise_kernel_completion','enterprise_region','enterprise_industry','enterprise_source_channel','enterprise_source_list_type')`).all() as {name:string}[]
      for (const {name} of tables) db.exec('delete from "'+name.replaceAll('"','""')+'"')
      for (const {sql} of triggers) db.exec(sql)
    })()
  } finally { db.pragma('foreign_keys = ON') }
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Fixture reset violated foreign keys')
}
