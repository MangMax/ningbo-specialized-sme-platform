// Aggregate metadata only: never emit row values, SQL parameters or credentials.
import Database from 'better-sqlite3'
import { statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: node profile.mjs ISOLATED_DB OUTPUT_JSON')
if (resolve(input).includes('/production-docker/')) throw new Error('Use an isolated copy')
const db = new Database(input, { readonly: true, fileMustExist: true })
const quantiles = xs => { const sorted = xs.sort((a, b) => a - b); return Object.fromEntries([0, .5, .95, .99, 1].map(q => [`p${q * 100}`, sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0])) }
const tables = {}
for (const { name, sql } of db.prepare("select name,sql from sqlite_master where type='table' and name not like 'sqlite_%'").all()) {
  const columns = db.prepare(`pragma table_info("${name}")`).all()
  const text = {}
  // service credentials have no distribution value for this investigation.
  if (name !== 'service_credential') for (const col of columns.filter(c => c.type.toUpperCase() === 'TEXT')) {
    const sizes = db.prepare(`select length(cast("${col.name}" as blob)) as n from "${name}" where "${col.name}" is not null`).all().map(x => x.n)
    text[col.name] = { nonnull: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0), ...quantiles(sizes) }
  }
  tables[name] = { rows: db.prepare(`select count(*) n from "${name}"`).get().n, schema: sql, columns, text,
    indexes: db.prepare(`pragma index_list("${name}")`).all().map(i => ({ ...i, columns: db.prepare(`pragma index_info("${i.name}")`).all() })),
    foreignKeys: db.prepare(`pragma foreign_key_list("${name}")`).all() }
}
const plans = {}
for (const [name, sql] of Object.entries({
  platform_all: 'select * from platform_query order by queried_at desc,id desc',
  platform_key_id: 'select id from platform_query where interface=? and query_key=? and rdjb=? and queried_at=?',
  relation_key: 'select id,enterprise_id,raw_fields from platform_relation where query_id=? and sequence_no=?',
  event_id: 'select * from record_event where id=?',
  relations_query: 'select * from platform_relation where query_id=?',
  correspondence_enterprise: 'select * from record_correspondence where enterprise_id=?',
})) plans[name] = db.prepare(`explain query plan ${sql}`).all(...Array(sql.split('?').length - 1).fill(1))
const result = { kind: 'aggregate-only', dbBytes: statSync(input).size, walBytes: (() => { try { return statSync(input + '-wal').size } catch { return 0 } })(),
  sqlite: db.prepare('select sqlite_version() version').get(), journal: db.pragma('journal_mode', { simple: true }),
  pageSize: db.pragma('page_size', { simple: true }), pageCount: db.pragma('page_count', { simple: true }),
  tempStore: db.pragma('temp_store', { simple: true }), cacheSize: db.pragma('cache_size', { simple: true }),
  freePages: db.pragma('freelist_count', { simple: true }), tables, plans,
  queryStatuses: db.prepare('select status,count(*) n from platform_query group by status').all(),
  queryInterfaces: db.prepare('select interface,count(*) n from platform_query group by interface').all(),
  storedFileBytes: (() => { const sizes = db.prepare('select bytes n from stored_file').all().map(x => x.n); return { count: sizes.length, total: sizes.reduce((a, b) => a + b, 0), ...quantiles(sizes) } })(),
  ocrPagesPerFile: quantiles(db.prepare('select count(*) n from ocr_result group by file_id').all().map(x => x.n)),
  relationsPerQuery: quantiles(db.prepare('select count(*) n from platform_relation group by query_id').all().map(x => x.n)) }
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
db.close()
console.log(JSON.stringify({ output, bytes: result.dbBytes, tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.rows])) }))
