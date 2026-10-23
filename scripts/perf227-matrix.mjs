#!/usr/bin/env node
// Freeze private IDs from a qualified, isolated clone. Output must stay outside Git.
// node scripts/perf227-matrix.mjs /private/baseline.db /private/NEW-matrix.json
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const [dbPath, target] = process.argv.slice(2).map(p => resolve(p))
assert.ok(dbPath !== target && !existsSync(target), 'new private matrix required')
const Database = createRequire(process.env.PERF227_ENTRY ?? import.meta.url)('better-sqlite3')
const db = new Database(dbPath, { readonly: true, fileMustExist: true })
db.pragma('query_only=ON')
const cells = [], missing = []
const add = (name, path, args = {}, tool, mcpArgs = args, options = {}) => cells.push({ name, path, args, tool, mcpArgs, method: 'GET', expectedStatus: 200, ...options })
const base = '/api/roster/correspondences'
// Select by actual archive history, then report actual discovery totals separately.
// This history proxy does not assert candidate or coverage equivalence.
const qkeys = new Map(db.prepare('select query_key,count(*) n from platform_query group by query_key').all().map(r => [r.query_key, r.n]))
const rel = new Map(db.prepare('select enterprise_id,count(distinct query_id) n from platform_relation where enterprise_id is not null group by enterprise_id').all().map(r => [r.enterprise_id, r.n]))
const aliases = new Map()
for (const r of db.prepare("select enterprise_id,name_norm from enterprise_alias where verification_status='confirmed' order by id").all()) {
  const a = aliases.get(r.enterprise_id) ?? []; a.push(r.name_norm); aliases.set(r.enterprise_id, a)
}
const events = db.prepare(`select e.id,e.event_type,r.title_code,r.enterprise_id,coalesce(r.uscc_raw,en.uscc_norm,'') identity,en.name_norm
  from record_event e join record r on e.record_id=r.id join enterprise en on en.id=r.enterprise_id
  where r.source='jxj' and e.event_type in ('award','review') order by e.id`).all()
for (const e of events) {
  const identity = e.identity.replace(/[\s\u200b\u200c\u200d\ufeff]/gu, '').toUpperCase()
  e.historyProxy = (qkeys.get(identity) ?? 0) + (qkeys.get('name:' + e.name_norm) ?? 0) + (rel.get(e.enterprise_id) ?? 0)
  for (const name of aliases.get(e.enterprise_id) ?? []) e.historyProxy += qkeys.get('name:' + name) ?? 0
}
const selected = []
for (const title of ['innovative_sme', 'specialized_sme', 'little_giant']) for (const type of ['award', 'review']) {
  const group = events.filter(e => e.title_code === title && e.event_type === type)
  if (!group.length) { missing.push({ dimension: `${title}/${type}`, reason: 'no actual official events' }); continue }
  group.sort((a, b) => b.historyProxy - a.historyProxy || a.id - b.id)
  const heavy = group[0], light = [...group].reverse().find(e => e.historyProxy > 0 && e.id !== heavy.id), none = group.find(e => e.historyProxy === 0)
  for (const [stratum, event] of [['heavy', heavy], ['light', light], ['none-proxy', none]]) {
    if (!event) { missing.push({ dimension: `${title}/${type}/${stratum}`, reason: 'no distinct actual sample under archive-history proxy' }); continue }
    const name = `discover-${title}-${type}-${stratum}`
    selected.push({ name, eventId: event.id, enterpriseId: event.enterprise_id, title, type, historyProxy: event.historyProxy })
    add(name, base + '/discover', { eventId: event.id, page: 1, pageSize: 25, queryPage: 1, queryPageSize: 25 }, 'discover_event_archive_candidates', undefined, { method: 'POST', discovery: true })
  }
}
const heavy = selected.find(e => e.title === 'specialized_sme' && e.type === 'award' && e.name.endsWith('-heavy'))
assert.ok(heavy)
for (const [name, extra] of [['deep-candidates', { page: 2, pageSize: 1 }], ['deep-coverage', { queryPage: 2, queryPageSize: 1 }], ['past-end', { page: 10000, queryPage: 10000 }]])
  add('discover-' + name, base + '/discover', { eventId: heavy.eventId, page: 1, pageSize: 25, queryPage: 1, queryPageSize: 25, ...extra }, 'discover_event_archive_candidates', undefined, { method: 'POST', discovery: true })
// Caller-provided scout anchor, fixed before timing; never substitute a faster ID.
const anchor = events.find(e => e.id === Number(process.env.PERF227_ANCHOR_EVENT))
if (anchor) add('discover-reported-anchor', base + '/discover', { eventId: anchor.id }, 'discover_event_archive_candidates', undefined, { method: 'POST', discovery: true })
// Select actual archived error/empty/partial owners to retain status coverage.
for (const status of ['failed', 'partial', 'no_record', 'not_queried']) {
  const keys = new Set(db.prepare('select distinct query_key from platform_query where status=?').all(status).map(r => r.query_key))
  const e = events.find(e => keys.has(e.identity.replace(/\s/gu, '').toUpperCase()) || keys.has('name:' + e.name_norm) || (aliases.get(e.enterprise_id) ?? []).some(a => keys.has('name:' + a)))
  if (e) add('discover-status-' + status, base + '/discover', { eventId: e.id }, 'discover_event_archive_candidates', undefined, { method: 'POST', discovery: true })
  else missing.push({ dimension: 'discovery/' + status, reason: 'no actual direct-key/confirmed-alias official sample' })
}
for (const [name, args] of [['all', { page: 1, pageSize: 25 }], ['query-deep', { kind: 'query', page: 500, pageSize: 25 }], ['official', { kind: 'official_document', page: 1, pageSize: 25 }], ['exports', { kind: 'export_batch', page: 1, pageSize: 25 }]])
  add('catalog-' + name, '/api/roster/record-comparison/sources', args)
add('enterprises-page', '/api/roster/enterprises', { page: 1, pageSize: 25 }, 'list_enterprises')
add('enterprises-deep', '/api/roster/enterprises', { page: 200, pageSize: 25 }, 'list_enterprises')
for (const stratum of ['heavy', 'light']) {
  const e = selected.find(e => e.title === 'specialized_sme' && e.type === 'award' && e.name.endsWith('-' + stratum))
  if (!e) continue
  add('enterprise-' + stratum, `/api/roster/enterprises/${e.enterpriseId}`, {}, 'get_enterprise_detail', { enterpriseId: e.enterpriseId })
  add('event-' + stratum, `/api/roster/events/${e.eventId}`, {}, 'get_official_event', { eventId: e.eventId })
  add('original-event-' + stratum, `${base}/events/${e.eventId}`, {}, 'get_record_correspondence_source', { kind: 'event', id: e.eventId })
}
const largest = db.prepare('select id,query_id from platform_relation order by length(cast(raw_fields as blob)) desc,id limit 1').get()
const exportRow = db.prepare('select id from platform_export_row order by id limit 1').get()
if (largest) add('original-relation-largest', `${base}/relations/${largest.id}`, {}, 'get_record_correspondence_source', { kind: 'relation', id: largest.id })
if (exportRow) add('original-export-row', `${base}/export-rows/${exportRow.id}`, {}, 'get_record_correspondence_source', { kind: 'export_row', id: exportRow.id })
add('correspondence-page', base, { page: 1, pageSize: 25 }, 'list_record_correspondences')
add('correspondence-deep', base, { page: 20, pageSize: 25, view: 'summary' }, 'list_record_correspondences')
for (const status of ['candidate', 'confirmed', 'rejected', 'unlinked']) {
  const row = db.prepare('select id from record_correspondence where status=? order by id limit 1').get(status)
  if (row) add('correspondence-' + status, `${base}/${row.id}`, {}, 'get_record_correspondence', { id: row.id })
  else missing.push({ dimension: 'correspondence/' + status, reason: 'no actual rows' })
}
const audit = db.prepare('select correspondence_id,count(*) n from record_correspondence_audit group by correspondence_id order by n desc,correspondence_id limit 1').get()
if (audit) {
  add('audit-history', `${base}/${audit.correspondence_id}/audit`, { page: 1, pageSize: 25 }, 'get_record_correspondence_audit', { id: audit.correspondence_id, page: 1, pageSize: 25 })
  add('audit-deep', `${base}/${audit.correspondence_id}/audit`, { page: audit.n, pageSize: 1 }, 'get_record_correspondence_audit', { id: audit.correspondence_id, page: audit.n, pageSize: 1 })
}
const document = db.prepare("select id from source_document where source='jxj' order by id limit 1").get()
const queryId = db.prepare('select id from platform_query order by length(cast(raw_response as blob)) desc,id limit 1').get().id
if (document) for (const [name, q] of [['scoped', largest.query_id], ['largest-archive', queryId]]) {
  const input = { queryIds: [q], exportBatchIds: [], officialSourceDocumentIds: [document.id], enterpriseId: heavy.enterpriseId, asOf: '2026-10-23T07:37:55.395Z', page: 1, pageSize: 25 }
  add('comparison-' + name, '/api/roster/record-comparison', input, 'list_record_comparison')
}
else missing.push({ dimension: 'comparison', reason: 'no actual jxj source_document' })
// A source_document can exist without any official rows. Include a source that
// actually evidences the selected event; negative refs are public read identities.
const actualDocument = db.prepare(`select coalesce((select min(s.id) from source_document s where s.source='jxj' and s.path=v.source_file),
  -(select min(v2.id) from record_evidence v2 join record_event ev on ev.id=v2.record_event_id join record rr on rr.id=ev.record_id where rr.source='jxj' and ev.event_type in ('award','review') and v2.source_file=v.source_file)) id
  from record_evidence v where v.record_event_id=? order by v.id limit 1`).get(heavy.eventId)
if (actualDocument) {
  const batches = db.prepare('select id from platform_export_batch order by id limit 1').all().map(r => r.id)
  for (const [name, exportBatchIds] of [['selected-document', []], ['with-export-scope', batches]]) {
    // Unknown document dates cannot qualify a historical asOf selection. The
    // immutable DB itself freezes the current-state comparison consistently.
    const input = { queryIds: [largest.query_id], exportBatchIds, officialSourceDocumentIds: [actualDocument.id], enterpriseId: heavy.enterpriseId, page: 1, pageSize: 25 }
    add('comparison-' + name, '/api/roster/record-comparison', input, 'list_record_comparison')
  }
}
const raw = Buffer.from(db.prepare('select raw_response from platform_query where id=?').get(queryId).raw_response)
for (let offset = 0, i = 0; offset < raw.length; offset += 65536, i++) {
  const args = { field: 'rawResponse', offset, length: 65536 }
  add('original-largest-archive-chunk-' + i, `/api/platform/queries/${queryId}/evidence`, args, 'get_platform_query_evidence', { queryId, ...args }, { expectedChunkSha256: createHash('sha256').update(raw.subarray(offset, offset + 65536)).digest('hex') })
}
// Real task routes initialize housekeeping: give each cell an independent RW copy.
add('task-list', '/api/task-center', { page: 1, pageSize: 25 }, undefined, undefined, { mutable: true })
const task = db.prepare("select id from job where kind='platform-query-batch' order by id limit 1").get()
if (task) add('task-detail', `/api/task-center/${task.id}`, {}, undefined, undefined, { mutable: true })
missing.push({ dimension: 'candidate-task-read', reason: 'no production event-archive-candidates jobs' })
const distributions = {}
for (const [key, sql] of Object.entries({ events: "select r.title_code,e.event_type,count(*) n from record_event e join record r on r.id=e.record_id where r.source='jxj' group by 1,2", queries: 'select interface,status,count(*) n from platform_query group by 1,2', correspondences: 'select status,count(*) n from record_correspondence group by 1', tasks: 'select kind,state,count(*) n from job group by 1,2', raw: 'select max(length(cast(raw_response as blob))) maxQueryBytes,sum(length(cast(raw_response as blob))) totalQueryBytes from platform_query' })) distributions[key] = db.prepare(sql).all()
db.close()
const matrix = { version: 1, selection: 'actual IDs; archive-history proxy heavy=max, light=min-positive-distinct, none=zero; actual totals recorded on execution', selected, missing, distributions, cells }
writeFileSync(target, JSON.stringify(matrix, null, 2), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ cells: cells.length, discovery: cells.filter(c => c.discovery).length, sha256: createHash('sha256').update(JSON.stringify(matrix)).digest('hex'), missing }))
