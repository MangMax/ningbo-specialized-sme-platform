#!/usr/bin/env node
// Local production artifact, real HTTP + MCP, synthetic temporary SQLite only.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti'), jiti = createJiti(import.meta.url)
const { useDb, schema: s } = await jiti.import('../db/client.ts')
const dir = mkdtempSync(join(tmpdir(), 'enterprise-read-verify-'))
const dbPath = process.argv[2] ?? join(dir, 'synthetic.sqlite'), db = useDb({ dbPath })
assert.equal(db.$client.prepare('select count(*) n from enterprise').get().n, 0, 'use a new synthetic DB')
const fixed = db.insert(s.enterprise).values({ name: '合成双称号企业', nameNorm: '合成双称号企业', usccNorm: 'SYNTHETIC84', district: '海曙区' }).returning().get().id
for (let i = 0; i < 125; i++) {
 const id = i === 0 ? fixed : db.insert(s.enterprise).values({ name: `合成翻页企业${String(i).padStart(3, '0')}`, nameNorm: `合成翻页企业${String(i).padStart(3, '0')}`, usccNorm: `SYNTHETIC84-${i}`, district: i % 2 ? '海曙区' : '鄞州区' }).returning().get().id
 for (const titleCode of i === 0 ? ['little_giant', 'specialized_sme'] : ['innovative_sme']) {
  const recordId = db.insert(s.record).values({ enterpriseId: id, titleCode, source: i % 5 ? 'miit' : 'jxj' }).returning().get().id
  const eventId = db.insert(s.recordEvent).values({ recordId, eventType: 'award', year: i === 0 ? 2022 : 2020, decidedYear: i === 0 ? 2022 : 2020 }).returning().get().id
  db.insert(s.recordEvidence).values({ recordEventId: eventId, sourceFile: 'synthetic.pdf', page: 3 }).run()
  if (i === 0) db.insert(s.recordEvent).values({ recordId, eventType: 'review', year: 2025, decidedYear: 2025, reviewOutcome: 'passed' }).run()
 }
}
for (const [name, verificationStatus] of [['已确认旧名', 'confirmed'], ['待核旧名', 'pending']]) db.insert(s.enterpriseAlias).values({ enterpriseId: fixed, name, nameNorm: name, sourceKind: 'manual', sourceRefId: 0, verificationStatus }).run()
for (const [i, status] of ['failed', 'partial', 'no_record', 'success', 'not_queried'].entries()) {
 const queryId = db.insert(s.platformQuery).values({ interface: i === 1 ? 'recognized_list' : 'apply_list', queryKey: i === 1 ? ' sYnThEtIc84 ' : 'name:合成双称号企业', rdjb: String(i), queriedAt: `2026-10-${10+i}`, status, rawResponse: '合成完整原文'.repeat(10), collectionEvidence: { titleScope: { rdjb: ['2'] }, pages: [{ rdjb: '2', page: 4, fetchedCount: 2, status: 'success' }] } }).returning().get().id
 if (i === 1) for (const sequenceNo of [2, 1]) db.insert(s.platformRelation).values({ queryId, sequenceNo, enterpriseId: sequenceNo === 1 ? fixed : null, rawFields: { original: `原行${sequenceNo}` }, nameRaw: `原名${sequenceNo}` }).run()
}
// Exercise historical export membership, name fallback and duplicate-name priority.
for (const year of [2023, 2025]) {
 const batchId = db.insert(s.platformExportBatch).values({ titleCode: 'innovative_sme', year, sha256: `synthetic${year}`, originalFilename: 'synthetic.xlsx', collectedOn: '2026-10-19' }).returning().get().id
 db.insert(s.platformExportRow).values({ batchId, sourceRowNo: 1, usccRaw: ' SYNTHETIC84-1 ', nameRaw: 'wrong fallback', rawFields: { preserved: true } }).run()
 db.insert(s.platformExportRow).values({ batchId, sourceRowNo: 2, nameRaw: ' 合成翻页企业002，' }).run()
}
const duplicates = []
for (let i = 0; i < 2; i++) {
 const enterpriseId = db.insert(s.enterprise).values({ name: '合成同名企业', nameNorm: '合成同名企业' }).returning().get().id
 duplicates.push(enterpriseId)
 db.insert(s.record).values({ enterpriseId, titleCode: 'innovative_sme', source: 'miit' }).run()
}
const oldBatch = db.select().from(s.platformExportBatch).all().find(batch => batch.year === 2023)
db.insert(s.platformExportRow).values({ batchId: oldBatch.id, sourceRowNo: 3, usccRaw: 'UNMATCHED', nameRaw: ' 合成（同名）企业，' }).run()
// Characterize SQL selection against the original business calculations:
// first-year ties across sources, undated awards, review-only histories,
// termination/re-award and null-USCC two-direction differences.
const edges = []
db.insert(s.enterprise).values({ name: '替换\uFFFD企业', nameNorm: '替换\uFFFD企业', district: '替换\uFFFD属地' }).run()
for (const [index, name] of ['正名𠀀企业', '别名匹配企业', '统代匹配企业', '待核别名企业'].entries()) {
 const id = db.insert(s.enterprise).values({ name, nameNorm: name, ...(index === 2 ? { usccNorm: 'SYN𠀀84' } : {}) }).returning().get().id
 if (index === 1 || index === 3) db.insert(s.enterpriseAlias).values({ enterpriseId: id, name: '旧名𠀀', nameNorm: '旧名𠀀', sourceKind: 'manual', sourceRefId: 0, verificationStatus: index === 1 ? 'confirmed' : 'pending' }).run()
}
for (let i = 0; i < 6; i++) {
 const enterpriseId = db.insert(s.enterprise).values({ name: `汇总边界企业${i}`, nameNorm: `汇总边界企业${i}`, usccNorm: i === 5 ? null : `EDGE84${i}` }).returning().get().id
 edges.push(enterpriseId)
 for (const source of ['jxj', 'miit']) {
  const recordId = db.insert(s.record).values({ enterpriseId, titleCode: 'specialized_sme', source, district: '北仑区' }).returning().get().id
  const events = i === 0 ? [['award', 2021, null], ['award', 2021, null]] : i === 1 ? [['award', null, null], ['award', 2022, null]] : i === 2 ? [['award', null, null]] : i === 3 ? [['review', 2024, 'passed']] : i === 4 ? [['award', 2020, null], ['review', 2023, 'passed'], ['review', 2024, 'failed'], ['award', 2025, null]] : [['nurture', 2020, null]]
  for (const [n, [eventType, year, reviewOutcome]] of events.entries()) {
   const eventId = db.insert(s.recordEvent).values({ recordId, eventType, year, decidedYear: year, reviewOutcome }).returning().get().id
   if (!(i === 0 && source === 'jxj' && n === 0)) db.insert(s.recordEvidence).values({ recordEventId: eventId, sourceFile: 'boundary.pdf', page: 1 }).run()
  }
 }
}
// The old source is used only for small-fixture semantic equivalence; no large legacy load.
const baselinePath = join(dir, 'baseline.ts')
const source = execFileSync('git', ['show', 'd198a09:lib/roster/enterprise-roster.ts'], { encoding: 'utf8' }).replace(/from '([.][^']+)'/g, (_, path) => `from '${resolve('lib/roster', path)}'`)
writeFileSync(baselinePath, source)
const baseline = await jiti.import(baselinePath)
if (process.argv.includes('--prepare-only')) { db.$client.pragma('wal_checkpoint(TRUNCATE)'); db.$client.close(); console.log(JSON.stringify({ dbPath, fixed, synthetic: true })); process.exit(0) }
const port = await reserveLoopbackPort(), base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['--max-old-space-size=2048', '.output/server/index.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: dir, MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
let output = '', rpcId = 0
for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { output = (output + data).slice(-2000) })
async function rpc(method, params) {
 const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
 const text = await response.text()
 return { response, body: JSON.parse(text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text) }
}
async function call(name, args) { const { response, body } = await rpc('tools/call', { name, arguments: args }); assert.equal(response.status, 200); assert.ok(!body.error && !body.result?.isError); return JSON.parse(body.result.content[0].text) }
try {
 let ready = false
 for (let i = 0; i < 200; i++) { if (server.exitCode !== null) throw Error(output); try { ready = (await fetch(`${base}/api/health`)).ok } catch {} if (ready) break; await sleep(100) }
 assert.ok(ready, 'local artifact readiness')
 const { body: tools } = await rpc('tools/list', {})
 for (const name of ['list_enterprises', 'get_enterprise_detail']) assert.ok(tools.result.tools.some(tool => tool.name === name))
 const filters = [{}, { q: '已确认旧名' }, { q: '待核旧名' }, { q: 'synthetic84' }, { title: ['little_giant'], firstYear: [2022] }, { title: ['innovative_sme'], firstYear: [2022] }, { firstStatus: ['confirmed'] }, { rosterState: 'removed_platform_only' }, { district: '海曙区', page: 2, pageSize: 10 }, { page: 100, pageSize: 10 }, { source: ['jxj'], eventType: ['award'], year: [2025] }, { sort: 'name' }, { sort: 'title' }, { diffStatus: ['not_queried'] }, { diffStatus: ['none'] }]
 for (const sort of ['recognition', 'name', 'title']) for (const page of [1, 2, 100]) for (const firstStatus of [undefined, ['confirmed'], ['pending']]) filters.push({ q: '汇总（边界）', sort, page, pageSize: 2, firstStatus })
 filters.push({ q: '汇总边界', title: ['specialized_sme'], firstYear: [2021, 2022], firstStatus: ['pending'] }, { q: '汇总边界', source: ['miit'], eventType: ['review'], year: [2023, 2024] }, { q: '汇总边界', diffStatus: ['none', 'not_queried'] }, { district: '北仑区', firstStatus: ['pending'] }, { q: '\uD800' }, { district: '替换\uD800属地' })
 filters.push(...['𠀀', '\uD840', '\uDC00', '\uD841', '\uDC01', '\uFFFD'].map(q => ({ q })))
 const mcpKeys = new Set(['q', 'title', 'district', 'rosterState', 'firstYear', 'firstStatus', 'page', 'pageSize'])
 for (const filter of filters) {
  // JSON/MCP preserves isolated UTF-16; URLSearchParams substitutes U+FFFD.
  // Compare the actual MCP input with the original JS filter at that seam.
  if (Object.values(filter).some(value => typeof value === 'string' && !value.isWellFormed())) {
   assert.deepEqual(await call('list_enterprises', filter), baseline.listRosterEnterprises(db, filter))
   continue
  }
  const params = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)]))
  const response = await fetch(`${base}/api/roster/enterprises?${params}`); assert.equal(response.status, 200)
  const result = await response.json(); assert.deepEqual(result, baseline.listRosterEnterprises(db, filter))
  if (Object.keys(filter).every(key => mcpKeys.has(key))) assert.deepEqual(await call('list_enterprises', filter), result)
 }
 for (const enterpriseId of [fixed, fixed + 1, fixed + 2, fixed + 124, ...duplicates, ...edges]) {
  const response = await fetch(`${base}/api/roster/enterprises/${enterpriseId}`); assert.equal(response.status, 200)
  const result = await response.json(); assert.deepEqual(result, baseline.getRosterEnterpriseDetail(db, enterpriseId)); assert.deepEqual(await call('get_enterprise_detail', { enterpriseId }), result)
 }
 const detail = await call('get_enterprise_detail', { enterpriseId: fixed })
 assert.equal(detail.enterprise.nextReviewYear, 2028)
 assert.deepEqual(detail.platform.relations.map(r => [r.sequenceNo, r.enterpriseId, r.rawFields, r.sourcePage]), [[1, fixed, { original: '原行1' }, 4], [2, null, { original: '原行2' }, 4]])
 assert.deepEqual(new Set(detail.platform.queries.map(q => q.status)), new Set(['failed', 'partial', 'no_record', 'success', 'not_queried']))
 for (const query of ['sort=garbage', 'title=garbage', 'firstStatus=garbage']) assert.equal((await fetch(`${base}/api/roster/enterprises?${query}`)).status, 400)
 assert.equal((await fetch(`${base}/api/roster/enterprises/invalid`)).status, 400)
 assert.equal((await fetch(`${base}/api/roster/enterprises/999999`)).status, 404)
 const missing = await rpc('tools/call', { name: 'get_enterprise_detail', arguments: { enterpriseId: 999999 } }); assert.ok(missing.body.error || missing.body.result?.isError)
 console.log(JSON.stringify({ passed: true, lane: 'production artifact HTTP + real MCP', baseline: 'd198a09', filterCases: filters.length, detailCases: 6 + edges.length, synthetic: true, productionChanged: false }))
} finally { await stopOwnedChild(server); db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
