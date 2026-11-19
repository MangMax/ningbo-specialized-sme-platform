import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'

it('adds lead list tables to an existing enterprise kernel without changing enterprise IDs or source rows', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    createRuntimeSchema(db)
    db.prepare('INSERT INTO enterprise (id,name,name_norm) VALUES (71,?,?)').run('留存企业', '留存企业')
    db.prepare("INSERT INTO enterprise_source (id,module,business_table,version_key,channel_code,list_type_code,series) VALUES (19,'core','enterprise','71','direct','direct','直接添加')").run()
    db.prepare('INSERT INTO enterprise_source_link VALUES (71,19)').run()
    const upgrade = db.transaction(() => installLeadListSchema(db))
    upgrade()
    upgrade()
    expect(db.prepare('SELECT id,name FROM enterprise').all()).toEqual([{ id: 71, name: '留存企业' }])
    expect(db.prepare('SELECT enterprise_id,source_id FROM enterprise_source_link').all()).toEqual([{ enterprise_id: 71, source_id: 19 }])
    expect(db.prepare("SELECT name FROM enterprise_source_list_type WHERE code='lead'").pluck().get()).toBe('线索名单')
    expect(db.prepare('SELECT count(*) FROM lead_list_version').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM lead_list_row').pluck().get()).toBe(0)
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally {
    db.close()
  }
})
