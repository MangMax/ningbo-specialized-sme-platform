#!/usr/bin/env node
/** #85 M3. Compiled Nitro, real loopback REST and MCP JSON-RPC tools/call. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { createFixture } from './perf85-fixture.mjs'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1] }
const verify = args.includes('--verify')
const scale = Number(option('--fixture-scale', '1'))
const concurrency = Number(option('--concurrency', '1'))
const rounds = Number(option('--rounds', verify ? '1' : '20'))
assert.ok([1, 2, 5].includes(concurrency) && Number.isInteger(rounds) && rounds > 0 && rounds <= 1000)
const externalDb = option('--db', null), externalManifest = option('--manifest', null)
assert.equal(Boolean(externalDb), Boolean(externalManifest), '--db and --manifest must be paired')
const created = externalDb ? null : createFixture(scale)
const manifest = externalManifest ? JSON.parse(readFileSync(externalManifest, 'utf8')) : created
const dbPath = resolve(externalDb ?? created.dbPath)
assert.ok(existsSync(dbPath) && manifest.synthetic === true && manifest.targetCount === 120 && manifest.ids.length === 120)
assert.deepEqual(manifest.ids.map(x => x.id), [...manifest.ids.map(x => x.id)].sort((a, b) => a - b))
const probe = new Database(dbPath, { readonly: true, fileMustExist: true })
try {
  for (const [table, expected] of Object.entries(manifest.counts)) assert.equal(probe.prepare(`select count(*) n from ${table}`).get().n, expected, `${table} fixture count changed`)
  assert.equal(probe.prepare("select count(*) n from record_correspondence where enterprise_id=? and title_code=? and type=? and role=? and rule_version=?").get(manifest.filters.enterpriseId, manifest.filters.titleCode, manifest.filters.type, manifest.filters.role, manifest.filters.ruleVersion).n, manifest.targetCount)
  assert.equal(probe.prepare("select count(*) n from record_correspondence where enterprise_id<>? and type='event_process'").get(manifest.targetEnterpriseId).n, manifest.unrelatedCount)
} finally { probe.close() }
const artifact = resolve('.output/server/index.mjs')
assert.ok(existsSync(artifact), 'run pnpm build on this exact source tree first')
const sourceHead = process.env.PERF85_SOURCE_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const cgroup = process.env.PERF85_CONTAINER_LIMITED === '1'
  ? { cpuMax: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(), memoryMax: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim() }
  : null
if (cgroup) {
  const [quota, period] = cgroup.cpuMax.split(' ').map(Number)
  assert.ok(Number.isFinite(quota) && Number.isFinite(period) && quota / period <= 1, '1 CPU cgroup limit required')
  assert.equal(Number(cgroup.memoryMax), 4 * 1024 ** 3, '4 GiB cgroup limit required')
}
const dir = mkdtempSync(join(tmpdir(), 'perf85-transport-'))
const telemetry = join(dir, 'telemetry.mjs')
writeFileSync(telemetry, `import {monitorEventLoopDelay} from 'node:perf_hooks';import {getHeapStatistics} from 'node:v8';
const lag=monitorEventLoopDelay({resolution:10});lag.enable();let peakHeap=0,peakRss=0,baseHeap=0;process.send?.({kind:'loaded'});
const sample=()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss)};
setInterval(sample,10).unref();process.on('message',m=>{if(m==='reset'){lag.reset();baseHeap=process.memoryUsage().heapUsed;peakHeap=baseHeap;peakRss=process.memoryUsage().rss;process.send?.({kind:'reset'})}if(m==='sample'){sample();process.send?.({kind:'sample',baseHeap,peakHeap,peakRss,heapLimit:getHeapStatistics().heap_size_limit,loopP95Ms:lag.percentile(95)/1e6,loopMaxMs:lag.max/1e6,loopSamples:lag.count})}});`)
let rpcId = 0
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const expectedRow = (row, known) => {
  assert.equal(row.id, known.id)
  assert.equal(row.eventId, known.eventId)
  assert.equal(row.relationId, known.relationId)
  assert.equal(row.status, known.status)
  assert.equal(row.revision, known.revision)
  assert.equal(row.requiresRevalidation, known.status === 'confirmed')
  assert.equal(row.ruleId, 'perf85')
  assert.equal(row.ruleVersion, 'v1')
  assert.equal(row.role, 'context_only')
  assert.equal(row.titleCode, 'specialized_sme')
  assert.equal(row.decidedAt, known.status === 'candidate' ? null : '2026-10-20T01:00:00Z')
}
// Negative controls ensure status/revalidation/source loss would fail the verifier.
assert.throws(() => expectedRow({ ...manifest.ids[0], requiresRevalidation: false, ruleId: 'perf85', ruleVersion: 'v1', role: 'context_only', titleCode: 'specialized_sme', decidedAt: '2026-10-20T01:00:00Z' }, manifest.ids[0]))
assert.throws(() => expectedRow({ ...manifest.ids[0], status: 'candidate', requiresRevalidation: true, ruleId: 'perf85', ruleVersion: 'v1', role: 'context_only', titleCode: 'specialized_sme', decidedAt: '2026-10-20T01:00:00Z' }, manifest.ids[0]))
function samePublicSummary(summary, full) {
  const { event, predecessorEvent, relation, exportRow, ...edge } = full
  assert.deepEqual(summary, edge)
  assert.equal('event' in summary || 'relation' in summary || 'exportRow' in summary, false)
}
assert.throws(() => samePublicSummary({ id: 1 }, { id: 1, status: 'confirmed', event: { id: 2 } }))

async function start() {
  const port = await reserveLoopbackPort()
  const base = `http://127.0.0.1:${port}`
  const messages = []
  const server = fork(artifact, [], { execArgv: ['--max-old-space-size=2048', '--import', telemetry], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: dir, NUXT_API_TOKEN: '', NUXT_MCP_TOKEN: '', NUXT_MIIT_COOKIE: '', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let logTail = ''
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logTail = (logTail + data).slice(-1000) })
  server.on('message', message => messages.push(message))
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw Error(`compiled server exited: ${logTail}`)
    try { if ((await fetch(base + '/api/health')).ok) return { server, base, messages, logTail: () => logTail } } catch {}
    await sleep(100)
  }
  await stopOwnedChild(server)
  throw Error(`compiled server readiness timeout: ${logTail}`)
}
async function message(service, kind) {
  const before = service.messages.length
  service.server.send(kind)
  for (let i = 0; i < 100; i++) {
    const found = service.messages.slice(before).find(x => x.kind === kind)
    if (found) return found
    await sleep(10)
  }
  throw Error(`server telemetry ${kind} timed out (exit=${service.server.exitCode}, messages=${JSON.stringify(service.messages.slice(-5))}, log=${service.logTail()})`)
}
async function request(service, transport, route, tool, input) {
  const begin = performance.now()
  const response = transport === 'rest'
    ? await fetch(service.base + route + (input ? `?${new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)]))}` : ''), { headers: { 'accept-encoding': 'identity' } })
    : await fetch(service.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'accept-encoding': 'identity' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: input ?? {} } }) })
  // arrayBuffer is the decompressed body; content-length can describe compressed wire bytes.
  const bytes = Buffer.from(await response.arrayBuffer())
  const ms = performance.now() - begin
  let envelope
  try { const raw = bytes.toString('utf8'); envelope = JSON.parse(raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? raw) }
  catch { throw Error(`${transport} ${route || tool}: invalid JSON, status ${response.status}`) }
  if (response.status !== 200) return { status: response.status, error: envelope.error ?? envelope, decompressedBytes: bytes.length, ms }
  if (transport === 'rest') {
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: 200, value: envelope, decompressedBytes: bytes.length, ms, encoding: response.headers.get('content-encoding') }
  }
  assert.ok(!envelope.error && !envelope.result?.isError, `MCP ${tool} failed`)
  const text = envelope.result.content.find(x => x.type === 'text')?.text
  assert.equal(typeof text, 'string', `MCP ${tool} text content missing`)
  const value = JSON.parse(text)
  const structured = envelope.result.structuredContent
  if (structured !== undefined) assert.deepEqual(structured, value, `MCP ${tool} text/structuredContent diverged`)
  return { status: 200, value, decompressedBytes: bytes.length, textBytes: Buffer.byteLength(text), structuredBytes: structured === undefined ? null : Buffer.byteLength(JSON.stringify(structured)), mcpResultKeys: Object.keys(envelope.result), mcpContentTypes: envelope.result.content.map(x => x.type), ms, encoding: response.headers.get('content-encoding') }
}
const listRoute = '/api/roster/correspondences'
function listInput(page, pageSize, view) { return { ...manifest.filters, page, pageSize, ...(view ? { view } : {}) } }
async function list(service, transport, page, pageSize, view) { return request(service, transport, listRoute, 'list_record_correspondences', listInput(page, pageSize, view)) }
function assertPage(response, page, pageSize) {
  assert.equal(response.status, 200)
  assert.equal(response.value.total, manifest.targetCount)
  assert.equal(response.value.page, page)
  assert.equal(response.value.pageSize, pageSize)
  assert.deepEqual(response.value.rows.map(row => row.id), manifest.ids.slice((page - 1) * pageSize, page * pageSize).map(row => row.id))
  response.value.rows.forEach((row, index) => expectedRow(row, manifest.ids[(page - 1) * pageSize + index]))
}
async function verifyEvidence(service, rows) {
  for (const row of rows) {
    const id = row.id
    const urls = [
      [`${listRoute}/${id}`, 'get_record_correspondence', { id }, row],
      [`${listRoute}/events/${row.eventId}`, 'get_record_correspondence_source', { kind: 'event', id: row.eventId }, row.event],
      [`${listRoute}/relations/${row.relationId}`, 'get_record_correspondence_source', { kind: 'relation', id: row.relationId }, row.relation],
    ]
    for (const [route, tool, input, expected] of urls) {
      const rest = await request(service, 'rest', route, tool, null)
      const mcp = await request(service, 'mcp', route, tool, input)
      assert.equal(rest.status, 200); assert.equal(mcp.status, 200)
      assert.deepEqual(rest.value, mcp.value)
      if (tool === 'get_record_correspondence') assert.deepEqual(rest.value, expected)
      else {
        assert.deepEqual(rest.value.source, expected)
        assert.ok(rest.value.correspondences.some(link => link.id === id))
      }
    }
  }
  const first = rows[0]
  const route = `${listRoute}/${first.id}/audit`
  const rest = await request(service, 'rest', route, 'get_record_correspondence_audit', { page: 1, pageSize: 1 })
  const mcp = await request(service, 'mcp', route, 'get_record_correspondence_audit', { id: first.id, page: 1, pageSize: 1 })
  assert.deepEqual(rest.value, mcp.value)
  assert.equal(rest.value.total, 1)
  assert.equal(rest.value.rows[0].toStatus, first.status)
  assert.match(rest.value.rows[0].evidence.original, /^SYNTHETIC_AUDIT_/)
  const exportInput = { enterpriseId: manifest.targetEnterpriseId, titleCode: 'specialized_sme', type: 'event_export_context', role: 'current_snapshot_context', ruleVersion: 'v1', page: 1, pageSize: 1 }
  const exportLists = {}
  for (const transport of ['rest', 'mcp']) for (const view of ['default', 'summary']) {
    const found = await request(service, transport, listRoute, 'list_record_correspondences', { ...exportInput, ...(view === 'summary' ? { view } : {}) })
    assert.equal(found.status, 200)
    assert.equal(found.value.total, 1)
    assert.equal(found.value.rows[0].id, manifest.exportEdge.id)
    exportLists[`${transport}-${view}`] = found.value.rows[0]
  }
  assert.deepEqual(exportLists['rest-default'], exportLists['mcp-default'])
  assert.deepEqual(exportLists['rest-summary'], exportLists['mcp-summary'])
  samePublicSummary(exportLists['rest-summary'], exportLists['rest-default'])
  const exportPoint = exportLists['rest-default']
  assert.equal(exportPoint.exportRowId, manifest.exportEdge.exportRowId)
  assert.match(exportPoint.exportRow.rawFields.original, /^SYNTHETIC_SOURCE_/)
  for (const transport of ['rest', 'mcp']) {
    const point = await request(service, transport, `${listRoute}/${exportPoint.id}`, 'get_record_correspondence', { id: exportPoint.id })
    const source = await request(service, transport, `${listRoute}/export-rows/${exportPoint.exportRowId}`, 'get_record_correspondence_source', { kind: 'export_row', id: exportPoint.exportRowId })
    assert.deepEqual(point.value, exportPoint)
    assert.deepEqual(source.value.source, exportPoint.exportRow)
    assert.ok(source.value.correspondences.some(link => link.id === exportPoint.id))
  }
}

const report = { sourceHead, m1Merge: '6422c4e', lane: 'compiled local HTTP and MCP; isolated synthetic SQLite', synthetic: true, scale: manifest.scale, counts: manifest.counts, selected: manifest.targetCount, unrelated: manifest.unrelatedCount, filters: manifest.filters, node: process.version, hostCpu: cpus()[0]?.model, hostCpuCount: cpus().length, hostMemoryBytes: totalmem(), heapLimitFlagMiB: 2048, containerLimited: Boolean(cgroup), cgroup, concurrency, rounds, coldDefinition: 'first business call on a fresh compiled Node process; OS cache not purged', samples: [] }
try {
  const evidenceRows = new Map(), summaryRows = new Map()
  for (const transport of ['rest', 'mcp']) for (const view of ['default', 'summary']) {
    const service = await start()
    try {
      // Each case receives a fresh server. Discovery does not touch the list route.
      if (transport === 'mcp') {
        const response = await fetch(service.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} }) })
        const body = await response.text()
        const envelope = JSON.parse(body.split('\n').find(x => x.startsWith('data: '))?.slice(6) ?? body)
        assert.ok(envelope.result.tools.some(tool => tool.name === 'list_record_correspondences'))
      }
      await message(service, 'reset')
      const cold = await list(service, transport, 1, 50, view === 'summary' ? 'summary' : undefined)
      assertPage(cold, 1, 50)
      const coldMetrics = await message(service, 'sample')
      if (view === 'summary') {
        assert.ok(cold.decompressedBytes <= 256 * 1024, `${transport} summary frame exceeds frozen 256KiB target`)
        for (const row of cold.value.rows) assert.equal('event' in row || 'relation' in row || 'exportRow' in row, false)
        summaryRows.set(transport, cold.value.rows)
      } else {
        assert.ok(cold.decompressedBytes > 256 * 1024, 'representative full evidence must exercise payload pressure')
        for (const row of cold.value.rows) {
          assert.match(row.relation.rawFields.original, /^SYNTHETIC_SOURCE_/)
          assert.equal(row.event.evidence[0].page, manifest.ids.find(x => x.id === row.id).eventId)
          assert.equal(row.relation.query.rawResponse, undefined)
          assert.equal(row.relation.query.collectionEvidence.rows, undefined)
        }
        evidenceRows.set(transport, cold.value.rows)
      }
      const deep = await list(service, transport, 100, 1, view === 'summary' ? 'summary' : undefined)
      assertPage(deep, 100, 1)
      if (view === 'default') assert.deepEqual(deep.value.rows[0], (await request(service, transport, `${listRoute}/${deep.value.rows[0].id}`, 'get_record_correspondence', { id: deep.value.rows[0].id })).value)
      if (view === 'summary') {
        const point = await request(service, transport, `${listRoute}/${deep.value.rows[0].id}`, 'get_record_correspondence', { id: deep.value.rows[0].id })
        samePublicSummary(deep.value.rows[0], point.value)
      }
      const candidate = await request(service, transport, listRoute, 'list_record_correspondences', { ...listInput(1, 50, view === 'summary' ? 'summary' : undefined), status: 'candidate' })
      assert.equal(candidate.value.total, manifest.ids.filter(row => row.status === 'candidate').length)
      assert.deepEqual(candidate.value.rows.map(row => row.id), manifest.ids.filter(row => row.status === 'candidate').slice(0, 50).map(row => row.id))
      if (verify && transport === 'rest' && view === 'default') {
        await verifyEvidence(service, cold.value.rows)
        const badRest = await request(service, 'rest', listRoute, 'list_record_correspondences', { ...listInput(1, 50), view: 'invalid' })
        assert.equal(badRest.status, 400)
        const badMcp = await fetch(service.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'list_record_correspondences', arguments: { ...listInput(1, 50), view: 'invalid' } } }) })
        const raw = await badMcp.text(); const envelope = JSON.parse(raw.split('\n').find(x => x.startsWith('data: '))?.slice(6) ?? raw)
        assert.ok(envelope.error || envelope.result?.isError, 'invalid MCP view must fail')
      }
      await message(service, 'reset')
      const hot = []
      for (let i = 0; i < rounds; i += concurrency) hot.push(...await Promise.all(Array.from({ length: Math.min(concurrency, rounds - i) }, () => list(service, transport, 1, 50, view === 'summary' ? 'summary' : undefined))))
      const metrics = await message(service, 'sample')
      for (const sample of hot) { assertPage(sample, 1, 50); assert.equal(hash(sample.value), hash(cold.value)) }
      const sorted = hot.map(x => x.ms).sort((a, b) => a - b)
      const percentile = p => sorted[Math.ceil(p * sorted.length) - 1]
      report.samples.push({ transport, view, coldMs: cold.ms, coldDecompressedBytes: cold.decompressedBytes, coldTextBytes: cold.textBytes ?? null, coldStructuredBytes: cold.structuredBytes ?? null, mcpResultKeys: cold.mcpResultKeys ?? null, mcpContentTypes: cold.mcpContentTypes ?? null, coldMetrics, deepMs: deep.ms, deepDecompressedBytes: deep.decompressedBytes, hotSamples: hot.length, hotMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) }, hotDecompressedBytes: hot[0].decompressedBytes, peakHeapBytes: metrics.peakHeap, incrementalHeapBytes: metrics.peakHeap - metrics.baseHeap, peakRssBytes: metrics.peakRss, eventLoopP95Ms: metrics.loopP95Ms, eventLoopMaxMs: metrics.loopMaxMs, eventLoopSamples: metrics.loopSamples, resultSha256: hash(cold.value) })
    } finally { await stopOwnedChild(service.server) }
  }
  const defaults = report.samples.filter(x => x.view === 'default')
  const summaries = report.samples.filter(x => x.view === 'summary')
  assert.equal(defaults[0].resultSha256, defaults[1].resultSha256)
  assert.equal(summaries[0].resultSha256, summaries[1].resultSha256)
  const full = evidenceRows.get('rest')
  const mcpFull = evidenceRows.get('mcp')
  assert.deepEqual(full, mcpFull)
  assert.deepEqual(summaryRows.get('rest'), summaryRows.get('mcp'))
  for (let i = 0; i < full.length; i++) samePublicSummary(summaryRows.get('rest')[i], full[i])
  report.passed = true
  console.log(JSON.stringify(report, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
  if (created) rmSync(created.dir, { recursive: true, force: true })
}
