#!/usr/bin/env node
// #177: synthetic isolated SQLite + real built application HTTP. No live platform calls.
import assert from 'node:assert/strict'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { useDb, schema } = await createJiti(import.meta.url).import('../db/client.ts')
const dir = mkdtempSync(join(tmpdir(), 'issue177-evidence-'))
const dbPath = join(dir, 'synthetic.sqlite')
const db = useDb({ dbPath })
const enterpriseId = db.insert(schema.enterprise).values({ name: '合成大型证据企业', nameNorm: '合成大型证据企业' }).returning().get().id
for (let n = 0; n < 52; n++) db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: 'synthetic:177', queriedAt: `2026-10-20T00:00:${String(n).padStart(2, '0')}Z`, status: ['failed', 'not_queried', 'no_record', 'success'][n % 4], failureReason: n % 4 === 0 ? '合成失败原因' : null, rawResponse: n % 2 ? '' : null }).run()
const raw = '原文🙂\\n"精确尾部'.repeat(11000)
const collection = { titleScope: { rdjb: ['2'] }, pages: [{ rdjb: '2', page: 1, status: 'failed', failureReason: '合成部分失败' }], rows: [], untouched: '大档🙂'.repeat(540000) }
const id = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'synthetic:177', queriedAt: '2026-10-22T00:00:00Z', status: 'partial', failureReason: '合成第二来源失败', rdjb: '2', rawResponse: raw, collectionEvidence: collection }).returning().get().id
const relations = []
// Deliberately insert in reverse sequence; names, nulls and duplicate keys must survive.
for (let sequenceNo = 27; sequenceNo >= 1; sequenceNo--) relations.push(db.insert(schema.platformRelation).values({ queryId: id, sequenceNo, enterpriseId, relationKey: 'same-key', nameRaw: `原名称${sequenceNo}🙂`, aliasNameRaw: sequenceNo === 2 ? '' : null, status: sequenceNo === 3 ? null : '原状态', sourceText: '来源原文', rawFields: { original: sequenceNo, unknownField: null, text: sequenceNo === 1 ? '跨段🙂'.repeat(15000) : `原字段${sequenceNo}` } }).returning().get())
relations.sort((a, b) => a.sequenceNo - b.sequenceNo)
db.$client.close()
const port = await reserveLoopbackPort()
const base = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_RECONCILE_PATH: join(dir, 'absent.json'), NUXT_API_TOKEN: '', NUXT_MCP_TOKEN: '', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
const log = []
child.stdout.on('data', b => log.push(String(b))); child.stderr.on('data', b => log.push(String(b)))
let requests = 0
async function get(path) { requests++; const r = await fetch(base + path); assert.equal(r.status, 200, `${path}: ${r.status}`); return r.json() }
async function chunks(field, relationId) {
  const bytes = []; let offset = 0; let total
  for (;;) {
    const c = await get(`/api/platform/queries/${id}/evidence?` + new URLSearchParams({ field, offset: String(offset), ...(relationId ? { relationId: String(relationId) } : {}) }))
    const b = Buffer.from(c.data, 'base64')
    assert.equal(c.queryId, id); assert.equal(c.field, field); assert.equal(c.offset, offset); assert.equal(c.byteLength, b.length)
    assert.ok(b.length <= 65536); if (total !== undefined) assert.equal(c.totalBytes, total)
    total = c.totalBytes; bytes.push(b); offset += b.length
    assert.equal(c.hasMore, offset < total)
    if (!c.hasMore) { assert.equal(offset, total); return Buffer.concat(bytes) }
    assert.ok(b.length > 0)
  }
}
try {
  let ready = false
  for (let n = 0; n < 120; n++) { if (child.exitCode !== null) throw Error(log.join('').slice(-2000)); try { ready = (await fetch(`${base}/api/health`)).ok } catch {} if (ready) break; await sleep(100) }
  assert.ok(ready, 'isolated built application did not start')
  const full = await fetch(`${base}/api/platform/queries?queryId=${id}`)
  assert.equal(full.status, 413)
  const summary = await get('/api/platform/queries?queryKey=synthetic:177&view=summary&pageSize=50')
  assert.equal(summary.total, 53); assert.equal(summary.rows[0].query.id, id)
  assert.equal(summary.rows[0].relationsIncluded, false); assert.equal(summary.rows[0].query.relationCount, 27)
  assert.equal('collectionEvidence' in summary.rows[0].query, false); assert.equal('rawResponse' in summary.rows[0].query, false)
  assert.deepEqual(summary.rows[0].relations, [])
  const second = await get('/api/platform/queries?queryKey=synthetic:177&view=summary&pageSize=50&page=2')
  assert.equal(second.rows.length, 3)
  const filtered = await get(`/api/platform/queries?enterpriseId=${enterpriseId}&queryKey=synthetic:177&view=summary`)
  assert.equal(filtered.total, 1)
  const directory = []
  for (let page = 1; directory.length < 27; page++) {
    const result = await get(`/api/platform/queries/${id}/evidence?field=relations&pageSize=25&page=${page}`)
    assert.equal(result.total, 27); assert.equal(result.page, page); directory.push(...result.rows)
  }
  assert.deepEqual(directory, relations.map(r => ({ id: r.id, sequenceNo: r.sequenceNo })))
  for (const expected of relations) assert.deepEqual(JSON.parse((await chunks('relation', expected.id)).toString('utf8')), expected)
  const actualRaw = await chunks('rawResponse'); assert.deepEqual(actualRaw, Buffer.from(raw))
  const actualCollection = await chunks('collectionEvidence'); assert.deepEqual(actualCollection, Buffer.from(JSON.stringify(collection)))
  const sha256 = b => createHash('sha256').update(b).digest('hex')
  const report = { passed: true, lane: 'synthetic SQLite + built Nuxt HTTP', base, dbPath, queryId: id, enterpriseId, pageUrl: `${base}/platform-queries?queryKey=synthetic:177`, fullStatus: 413, summaryStatus: 200, queries: 53, orderedRelations: 27, relationFields: 'all persisted columns deepEqual per row', rawBytes: actualRaw.length, rawSHA256: sha256(actualRaw), collectionBytes: actualCollection.length, collectionSHA256: sha256(actualCollection), requests, productionChanged: false }
  writeFileSync(join(dir, 'http-report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(dir, 'server.log'), log.join(''))
  console.log(JSON.stringify({ ...report, artifacts: dir }))
  if (process.argv.includes('--serve')) { console.log('Fixture kept running for browser; SIGINT stops only this owned server.'); await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) }) }
} finally { await stopOwnedChild(child); writeFileSync(join(dir, 'server.log'), log.join('')) }
