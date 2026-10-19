#!/usr/bin/env node
// Characterization of the #89 candidate, not an implemented cache acceptance test.
// Only synthetic temporary SQLite and loopback production artifacts; no remote traffic.
import assert from 'node:assert/strict'
import { fork, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { reserveLoopbackPort, stopOwnedChild, waitForHttp } from './lib/isolated-local-services.mjs'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { useDb, schema } = await createJiti(import.meta.url).import('../db/client.ts')
const dir = mkdtempSync(join(tmpdir(), 'platform-cache-safety-89-'))
const dbPath = join(dir, 'fixture.sqlite')
const checks = []
const children = []
let writer, observer
let rpcId = 0

async function start(path, credential) {
  const port = await reserveLoopbackPort()
  const child = fork('.output/server/index.mjs', [], {
    execArgv: ['--max-old-space-size=2048'],
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: path,
      NUXT_DB_READONLY: '1', NUXT_FILES_DIR: dir, NUXT_INCOMING_DIR: dir,
      NUXT_API_TOKEN: '', NUXT_MCP_TOKEN: '', NUXT_OCR_TOKEN: credential,
      NUXT_MIIT_COOKIE: '', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '',
      PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  children.push(child)
  const base = `http://127.0.0.1:${port}`
  await waitForHttp(`${base}/api/health`, { child, timeoutMs: 30_000 })
  return { base, child, credential }
}

async function read(server, transport, args) {
  const response = transport === 'http'
    ? await fetch(`${server.base}/api/platform/queries?${new URLSearchParams(Object.entries(args).map(([key, value]) => [key, String(value)]))}`)
    : await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'list_platform_queries', arguments: args } }),
    })
  assert.equal(response.status, 200)
  if (transport === 'mcp') assert.equal(response.headers.get('cache-control'), 'no-store')
  else assert.equal(response.headers.get('cache-control'), null, 'preserve existing list header policy')
  const text = await response.text()
  const body = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text)
  if (transport === 'http') return body
  assert.ok(!body.error)
  assert.ok(!body.result.isError)
  return JSON.parse(body.result.content[0].text)
}

async function both(servers, args, oracle) {
  const results = await Promise.all(servers.flatMap(server => ['http', 'mcp'].map(transport => read(server, transport, args))))
  for (const result of results) { oracle(result); assert.deepEqual(result, results[0]) }
  return results[0]
}

try {
  const db = useDb({ dbPath, readOnly: false })
  const statuses = ['failed', 'partial', 'no_record', 'not_queried', 'success']
  const ids = statuses.map((status, index) => db.insert(schema.platformQuery).values({
    interface: 'recognized_list', queryKey: 'synthetic:cache-safety', rdjb: '2',
    queriedAt: `2026-10-19T00:00:0${index}Z`, status,
    rawResponse: 'synthetic raw A', collectionEvidence: { pages: [], titleScope: { rdjb: ['2'] } },
  }).returning().get().id)
  db.insert(schema.platformRelation).values({ queryId: ids[0], sequenceNo: 1, rawFields: { synthetic: 'A' } }).run()
  db.$client.close()
  writer = new Database(dbPath)
  writer.pragma('foreign_keys = ON')
  observer = new Database(dbPath, { readonly: true })
  const ownVersion = writer.pragma('data_version', { simple: true })
  const otherVersion = observer.pragma('data_version', { simple: true })
  const a = await start(dbPath, 'synthetic-instance-A')
  const b = await start(dbPath, 'synthetic-instance-B')
  const args = { queryKey: 'synthetic:cache-safety', view: 'summary', page: 1, pageSize: 25 }
  const baseline = await both([a, b], args, result => {
    assert.equal(result.total, 5)
    assert.deepEqual(result.counts, { success: 1, failed: 1, partial: 1, no_record: 1, not_queried: 1 })
    assert.deepEqual(result.rows.map(row => row.query.id), [...ids].reverse())
    assert.equal(result.rows.find(row => row.query.id === ids[0]).query.status, 'failed')
    for (const row of result.rows) {
      assert.equal(row.relationsIncluded, false)
      assert.deepEqual(row.relations, [])
      assert.equal(Object.hasOwn(row.query, 'collectionEvidence'), false)
      assert.equal(Object.hasOwn(row.query, 'rawResponse'), false)
    }
  })
  checks.push('cold_and_repeated_summary_preserves_five_states_http_equals_mcp')

  writer.exec('BEGIN IMMEDIATE')
  writer.prepare('UPDATE platform_query SET status=? WHERE id=?').run('no_record', ids[0])
  await both([a, b], args, result => assert.deepEqual(result, baseline))
  writer.exec('ROLLBACK')
  await both([a, b], args, result => assert.deepEqual(result, baseline))
  assert.equal(observer.pragma('data_version', { simple: true }), otherVersion)
  checks.push('uncommitted_and_rolled_back_changes_are_never_published')

  writer.exec('BEGIN IMMEDIATE')
  writer.prepare('UPDATE platform_query SET status=?,raw_response=? WHERE id=?').run('partial', 'synthetic raw B', ids[0])
  writer.prepare('INSERT INTO platform_relation(query_id,sequence_no,raw_fields,created_at) VALUES(?,?,?,?)').run(ids[0], 2, '{"synthetic":"B"}', '2026-10-19')
  writer.exec('COMMIT')
  const committed = await both([a, b], args, result => {
    assert.equal(result.total, 5)
    assert.deepEqual(result.counts, { success: 1, partial: 2, no_record: 1, not_queried: 1 })
    const row = result.rows.find(row => row.query.id === ids[0])
    assert.equal(row.query.status, 'partial')
    assert.equal(row.query.relationCount, 2)
  })
  assert.equal(writer.pragma('data_version', { simple: true }), ownVersion)
  assert.notEqual(observer.pragma('data_version', { simple: true }), otherVersion)
  checks.push('commit_is_immediately_visible_in_both_instances_and_transports')
  checks.push('data_version_is_connection_local_not_a_global_commit_generation')

  for (const server of [a, b]) {
    const evidence = await fetch(`${server.base}/api/platform/queries/${ids[0]}/evidence?field=rawResponse`)
    assert.equal(evidence.headers.get('cache-control'), 'no-store')
    assert.equal(Buffer.from((await evidence.json()).data, 'base64').toString(), 'synthetic raw B')
    const reveal = await fetch(`${server.base}/api/settings/credentials/ocrToken/reveal`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(reveal.status, 200)
    assert.equal(reveal.headers.get('cache-control'), 'no-store')
    assert.equal((await reveal.json()).value, server.credential)
  }
  checks.push('raw_no_store_and_synthetic_credential_isolation_are_preserved')

  const bursts = await Promise.all(Array.from({ length: 20 }, (_, index) => read(index % 2 ? a : b, index % 3 ? 'http' : 'mcp', args)))
  for (const result of bursts) assert.deepEqual(result, committed)
  checks.push('concurrent_repeated_reads_match_the_committed_result_without_a_cache')
  await stopOwnedChild(a.child)
  const restarted = await start(dbPath, 'synthetic-instance-A-restarted')
  await both([restarted, b], args, result => assert.deepEqual(result, committed))
  checks.push('restarted_instance_reads_current_committed_result')

  await stopOwnedChild(restarted.child)
  const otherPath = join(dir, 'other.sqlite')
  const otherDb = useDb({ dbPath: otherPath, readOnly: false })
  otherDb.insert(schema.platformQuery).values({ id: ids[0], interface: 'recognized_list', queryKey: 'synthetic:cache-safety', queriedAt: '2026-10-19', status: 'no_record' }).run()
  otherDb.$client.close()
  const other = await start(otherPath, 'synthetic-other-dataset')
  await both([other], args, result => {
    assert.equal(result.total, 1)
    assert.equal(result.rows[0].query.id, ids[0])
    assert.equal(result.rows[0].query.status, 'no_record')
    assert.equal(result.rows[0].query.relationCount, 0)
  })
  await both([b], args, result => assert.deepEqual(result, committed))
  checks.push('same_ids_and_parameters_in_another_database_do_not_share_results')
  console.log(JSON.stringify({
    passed: true, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    lane: 'synthetic SQLite + two local production instances + real HTTP/MCP', checks,
    newQueryCache: false, cacheEvictionTtlStampedeAndSustainedMemory: 'not implemented or accepted',
    productionChanged: false,
  }))
} finally {
  if (writer?.inTransaction) writer.exec('ROLLBACK')
  writer?.close()
  observer?.close()
  await Promise.all(children.map(stopOwnedChild))
  rmSync(dir, { recursive: true, force: true })
}
